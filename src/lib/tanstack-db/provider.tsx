"use client";

import type React from "react";
import { useEffect } from "react";
import {
  activeFiltersCollection,
  chartDraftCollection,
  dashboardStateCollection,
  queryHistoryCollection,
  reportsCollection,
  chartsCollection,
  dashboardsCollection,
} from "./collections";
import { getLogger } from "@/lib/logging/logger";

// Initialize all collections on mount to ensure they're ready
export function TanStackDBWrapper({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Initialize collections if needed
    // Note: preload() is optional and only needed if sync is configured
    // For now, collections are initialized with local state only

    const collections = [
      activeFiltersCollection,
      chartDraftCollection,
      dashboardStateCollection,
      queryHistoryCollection,
      reportsCollection,
      chartsCollection,
      dashboardsCollection,
    ];

    // Safely attempt to preload collections
    // Skip if sync adapter isn't fully configured
    collections.forEach((collection) => {
      try {
        // Only preload if the collection has the method and it's safe to call
        if (collection.preload && typeof collection.preload === "function") {
          // Wrap in try-catch to prevent sync errors from blocking UI
          Promise.resolve(collection.preload()).catch((error) => {
            getLogger("client").note("warn", `Preload failed for collection, continuing with local state:`, { err: error });
          });
        }
      } catch (error) {
        // Silently continue - local state will work fine
        getLogger("client").note("debug", "Collection preload skipped:", { err: error });
      }
    });
  }, []);

  return <>{children}</>;
}
