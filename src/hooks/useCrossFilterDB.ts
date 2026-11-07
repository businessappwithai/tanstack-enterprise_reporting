"use client";

/**
 * Cross-filter hook backed by TanStack DB
 * Provides reactive filtering with real-time sync via ElectricSQL
 *
 * This replaces the context-based useCrossFilter with TanStack DB collections
 * for better reactivity and offline support.
 */

import { useEffect, useMemo, useState } from "react";
import { nanoid } from "nanoid";
import { activeFiltersCollection } from "@/lib/tanstack-db/collections";
import type { ActiveFilter, CrossFilterConfig, WidgetFilterConfig } from "@/types/filters";
import { getLogger } from "@/lib/logging/logger";

interface UseCrossFilterReturn {
  activeFilters: ActiveFilter[];
  applyFilter: (filter: Omit<ActiveFilter, "id" | "affectedWidgets">) => void;
  removeFilter: (filterId: string) => void;
  clearFilters: () => void;
  getFilteredQuery: (widgetId: string, baseQuery: string) => string;
}

/**
 * Hook for managing cross-widget filtering backed by TanStack DB
 * Automatically syncs to server via ElectricSQL
 */
export function useCrossFilterDB(config: CrossFilterConfig): UseCrossFilterReturn {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  // Subscribe to collection changes
  useEffect(() => {
    const subscription = activeFiltersCollection.subscribeChanges(
      (changes) => {
        // Rebuild filter list from collection changes
        setActiveFilters((prev) => {
          const map = new Map(prev.map((f) => [f.id, f]));

          for (const change of changes) {
            if (change.type === "insert" || change.type === "update") {
              map.set(String(change.key), change.value);
            } else if (change.type === "delete") {
              map.delete(String(change.key));
            }
          }

          return Array.from(map.values());
        });
      },
      { includeInitialState: true }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Build widget map
  const widgetMap = useMemo(() => {
    const map = new Map<string, WidgetFilterConfig>();
    for (const w of config.widgets) {
      map.set(w.widgetId, w);
    }
    return map;
  }, [config.widgets]);

  /**
   * Apply a new filter or update existing
   * Inserts/updates in TanStack DB collection for automatic sync
   */
  const applyFilter = async (filter: Omit<ActiveFilter, "id" | "affectedWidgets">) => {
    // Determine affected widgets
    const affected: string[] = [];
    for (const widget of config.widgets) {
      if (widget.widgetId === filter.sourceWidgetId) continue;
      for (const link of widget.filterLinks) {
        if (link.sourceWidgetId === filter.sourceWidgetId) {
          affected.push(widget.widgetId);
          break;
        }
      }
    }

    const newFilter: ActiveFilter = {
      id: nanoid(),
      ...filter,
      affectedWidgets: affected,
    };

    // Check if we're updating an existing filter from same source on same column
    const existing = activeFilters.find(
      (f) => f.sourceWidgetId === filter.sourceWidgetId && f.column === filter.column
    );

    try {
      if (existing) {
        // Update existing filter
        await activeFiltersCollection.update(existing.id, () => newFilter);
      } else {
        // Insert new filter
        await activeFiltersCollection.insert(newFilter);
      }
    } catch (error) {
      getLogger("client").event("client.ui.failed", { what: "Failed to apply filter", err: error });
    }
  };

  /**
   * Remove a filter from the collection
   */
  const removeFilter = async (filterId: string) => {
    try {
      await activeFiltersCollection.delete(filterId);
    } catch (error) {
      getLogger("client").event("client.ui.failed", { what: "Failed to remove filter", err: error });
    }
  };

  /**
   * Clear all filters for this dashboard
   */
  const clearFilters = async () => {
    try {
      const dashboardWidgetIds = new Set(config.widgets.map((w) => w.widgetId));
      const filtersToDelete = activeFilters.filter((f) => dashboardWidgetIds.has(f.sourceWidgetId));

      for (const filter of filtersToDelete) {
        await activeFiltersCollection.delete(filter.id);
      }
    } catch (error) {
      getLogger("client").event("client.ui.failed", { what: "Failed to clear filters", err: error });
    }
  };

  /**
   * Generate SQL WHERE clause for a widget based on active filters
   * Same logic as original, but works with TanStack DB collection
   */
  const getFilteredQuery = (widgetId: string, baseQuery: string): string => {
    const widget = widgetMap.get(widgetId);
    if (!widget) return baseQuery;

    const clauses: string[] = [];

    for (const filter of activeFilters) {
      if (!filter.affectedWidgets.includes(widgetId)) continue;

      // Find column mapping for this widget
      const link = widget.filterLinks.find((l) => l.sourceWidgetId === filter.sourceWidgetId);
      if (!link) continue;

      const targetColumn = link.columnMapping[filter.column] ?? filter.column;

      if (filter.operator === "eq" && filter.values.length === 1) {
        const val =
          typeof filter.values[0] === "string"
            ? `'${filter.values[0].replace(/'/g, "''")}'`
            : filter.values[0];
        clauses.push(`"${targetColumn}" = ${val}`);
      } else if (filter.operator === "in") {
        const vals = filter.values
          .map((v) => (typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v))
          .join(", ");
        clauses.push(`"${targetColumn}" IN (${vals})`);
      } else if (filter.operator === "range" && filter.values.length === 2) {
        clauses.push(`"${targetColumn}" BETWEEN ${filter.values[0]} AND ${filter.values[1]}`);
      }
    }

    if (clauses.length === 0) return baseQuery;

    const whereClause = clauses.join(" AND ");
    return `SELECT * FROM (${baseQuery}) AS _sub WHERE ${whereClause}`;
  };

  return { activeFilters, applyFilter, removeFilter, clearFilters, getFilteredQuery };
}
