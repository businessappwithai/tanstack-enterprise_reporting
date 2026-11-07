import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Edit, Eye, Globe, Lock, Plus, RefreshCw, Save, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Layout } from "react-grid-layout";
import { toast } from "sonner";
import { ActiveFiltersBar } from "@/components/dashboard/ActiveFiltersBar";
import { AddWidgetDialog } from "@/components/dashboard/add-widget-dialog";
import { CrossFilterProvider } from "@/components/dashboard/CrossFilterProvider";
import { ConfigureWidgetDialog } from "@/components/dashboard/configure-widget-dialog";
import { useDashboardState } from "@/components/dashboard/DashboardState";
import { DashboardGrid } from "@/components/dashboard/dashboard-grid";
import { ShareDialog } from "@/components/share/ShareDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OfflineIndicator } from "@/components/wasm/OfflineIndicator";
import { isFeatureEnabled } from "@/lib/feature-flags";
import type { DashboardLayout, DashboardWidget } from "@/types/database";
import type { ActiveFilter as ActiveFilterType } from "@/types/filters";
import { getLogger } from "@/lib/logging/logger";

interface WidgetWithData extends DashboardWidget {
  title?: string;
}

function DashboardViewerContent({ dashboardId }: { dashboardId: string }) {
  const queryClient = useQueryClient();
  const { applyFilter } = useDashboardState();

  const [isEditing, setIsEditing] = useState(false);
  const [addWidgetDialogOpen, setAddWidgetDialogOpen] = useState(false);
  const [configureWidgetDialogOpen, setConfigureWidgetDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [selectedWidget, setSelectedWidget] = useState<
    (DashboardWidget & { dashboard_id: string }) | null
  >(null);
  const [layout, setLayout] = useState<Layout[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  // Fetch dashboard
  const { data: dashboard, isLoading: isLoadingDashboard } = useQuery<DashboardLayout>({
    queryKey: ["dashboard", dashboardId],
    queryFn: async () => {
      const res = await fetch(`/api/dashboards/${dashboardId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load dashboard`);
      const data = await res.json();
      return data.data;
    },
  });

  // Fetch widgets
  const { data: widgets = [], isLoading: isLoadingWidgets } = useQuery<DashboardWidget[]>({
    queryKey: ["dashboard-widgets", dashboardId],
    queryFn: async () => {
      const res = await fetch(`/api/dashboards/${dashboardId}/widgets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load widgets`);
      const data = await res.json();
      return data.data.items || [];
    },
  });

  // Mutation to add widget
  const addWidgetMutation = useMutation({
    mutationFn: async (widgetData: {
      widgetType: string;
      reportId?: string;
      chartId?: string;
      positionConfig: { x: number; y: number; w: number; h: number; minW: number; minH: number };
      widgetConfig?: { title?: string; content?: string };
    }) => {
      const res = await fetch(`/api/dashboards/${dashboardId}/widgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(widgetData),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error?.message || "Failed to add widget");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-widgets"] });
      toast.success("Widget added successfully");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to add widget");
    },
  });

  // Initialize layout from dashboard or widgets
  useEffect(() => {
    if (dashboard?.layout_config) {
      try {
        const layoutConfig = JSON.parse(dashboard.layout_config);
        if (layoutConfig.layouts?.lg) {
          setLayout(layoutConfig.layouts.lg);
        }
      } catch (error) {
        getLogger("client").event("client.ui.failed", { what: "Error parsing layout config", err: error });
      }
    } else if (widgets.length > 0) {
      // Build layout from widgets' position_config
      const builtLayout = widgets.map((widget) => {
        try {
          const position = JSON.parse(widget.position_config);
          return {
            i: widget.id,
            x: position.x || 0,
            y: position.y || 0,
            w: position.w || 4,
            h: position.h || 4,
            minW: position.minW || 2,
            minH: position.minH || 2,
          };
        } catch {
          return { i: widget.id, x: 0, y: 0, w: 4, h: 4, minW: 2, minH: 2 };
        }
      });
      setLayout(builtLayout);
    }
  }, [dashboard, widgets]);

  // Fetch data for each widget - use parallel queries for better performance
  const widgetsWithData = useMemo(() => {
    return widgets.map((widget: DashboardWidget): WidgetWithData => {
      // Extract title from widget config if available
      let title: string | undefined;
      try {
        const config = widget.widget_config ? JSON.parse(widget.widget_config) : {};
        title = config.title;
      } catch {
        // ignore
      }

      return { ...widget, title };
    });
  }, [widgets]);

  const handleLayoutChange = useCallback((newLayout: Layout[]) => {
    setLayout(newLayout);
    setHasChanges(true);
  }, []);

  const handleSaveLayout = async () => {
    try {
      // Save full grid layout to the dashboard record
      const res = await fetch(`/api/dashboards/${dashboardId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          layoutConfig: {
            cols: { lg: 12, md: 10, sm: 6, xs: 4 },
            rowHeight: 100,
            containerPadding: [10, 10],
            margin: [10, 10],
            layouts: { lg: layout },
          },
        }),
      });

      if (!res.ok) throw new Error("Failed to save layout");

      // Also persist each widget's individual position so size is preserved
      // even if the dashboard layout_config is later cleared.
      await Promise.all(
        layout.map((item) =>
          fetch(`/api/dashboards/${dashboardId}/widgets/${item.i}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              positionConfig: {
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW ?? 2,
                minH: item.minH ?? 2,
              },
            }),
          }).catch(() => {
            // Non-fatal — dashboard layout_config is the source of truth
          })
        )
      );

      toast.success("Layout saved");
      setHasChanges(false);
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-widgets", dashboardId] });
    } catch (_error) {
      toast.error("Failed to save layout");
    }
  };

  const handleRemoveWidget = async (widgetId: string) => {
    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to remove widget");

      toast.success("Widget removed successfully");
      queryClient.invalidateQueries({ queryKey: ["dashboard-widgets"] });
    } catch (_error) {
      toast.error("Failed to remove widget");
    }
  };

  const handleAddWidget = async (widgetData: {
    widgetType: string;
    reportId?: string;
    chartId?: string;
    positionConfig: { x: number; y: number; w: number; h: number; minW: number; minH: number };
    widgetConfig?: { title?: string; content?: string };
  }) => {
    // Auto-calculate Y position based on existing widgets
    const maxY = layout.length > 0 ? Math.max(...layout.map((l) => l.y + l.h)) : 0;
    const newPosition = {
      ...widgetData.positionConfig,
      y: maxY,
    };

    await addWidgetMutation.mutateAsync({
      ...widgetData,
      positionConfig: newPosition,
    });
  };

  // Handler for cross-filter application
  const handleFilterApply = useCallback(
    (filter: Omit<ActiveFilterType, "id" | "affectedWidgets">) => {
      applyFilter(filter);
    },
    [applyFilter]
  );

  if (isLoadingDashboard) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Dashboard not found</p>
          <Link to="/dashboards">
            <Button>Back to Dashboards</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Offline indicator (if enabled) */}
      {isFeatureEnabled("offlineEnabled") && <OfflineIndicator />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/dashboards">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-semibold text-2xl text-tremor-content-strong">
                {dashboard.name}
              </h1>
              {dashboard.is_public ? (
                <Badge variant="secondary" className="flex items-center gap-1">
                  <Globe className="h-3 w-3" />
                  Public
                </Badge>
              ) : (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Lock className="h-3 w-3" />
                  Private
                </Badge>
              )}
            </div>
            {dashboard.description && (
              <p className="text-tremor-default text-tremor-content">{dashboard.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: ["dashboard", "dashboard-widgets"] })
            }
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShareDialogOpen(true)}>
            <Share2 className="h-4 w-4 mr-2" />
            Share
          </Button>
          {/* Save Layout is always visible when there are pending changes */}
          {hasChanges && (
            <Button size="sm" onClick={handleSaveLayout}>
              <Save className="h-4 w-4 mr-2" />
              Save Layout
            </Button>
          )}
          {!isEditing ? (
            <Button
              size="sm"
              variant={hasChanges ? "outline" : "default"}
              onClick={() => setIsEditing(true)}
            >
              <Edit className="h-4 w-4 mr-2" />
              Edit Layout
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => setAddWidgetDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Widget
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>
                <Eye className="h-4 w-4 mr-2" />
                View
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Active filters bar (if cross-filtering is enabled) */}
      {isFeatureEnabled("crossFilterEnabled") && <ActiveFiltersBar />}

      {/* Empty state */}
      {widgetsWithData.length === 0 && !isLoadingWidgets ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="text-center">
              <p className="text-muted-foreground mb-4">No widgets added yet</p>
              <Button onClick={() => setAddWidgetDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Widget
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        /* Dashboard Grid */
        <DashboardGrid
          widgets={widgetsWithData}
          layout={layout}
          isEditing={isEditing}
          onLayoutChange={handleLayoutChange}
          onRemoveWidget={handleRemoveWidget}
          onConfigureWidget={(widgetId) => {
            const widget = widgets.find((w) => w.id === widgetId);
            if (widget) {
              setSelectedWidget({ ...widget, dashboard_id: dashboardId });
              setConfigureWidgetDialogOpen(true);
            }
          }}
          onFilterApply={handleFilterApply}
        />
      )}

      {/* Widget loading skeletons */}
      {isLoadingWidgets && widgetsWithData.length === 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-64 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Widget Dialog */}
      <AddWidgetDialog
        open={addWidgetDialogOpen}
        onOpenChange={setAddWidgetDialogOpen}
        onAddWidget={handleAddWidget}
      />

      {/* Configure Widget Dialog */}
      <ConfigureWidgetDialog
        open={configureWidgetDialogOpen}
        onOpenChange={setConfigureWidgetDialogOpen}
        widget={selectedWidget}
      />

      {/* Share Dialog */}
      <ShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        resourceId={dashboardId}
        resourceType="dashboard"
        isPublic={dashboard?.is_public || false}
        onTogglePublic={(newState) => {
          if (dashboard) {
            dashboard.is_public = newState;
          }
        }}
      />
    </div>
  );
}

export const Route = createFileRoute("/_authed/dashboards/$id/")({
  component: DashboardViewerPage,
});

function DashboardViewerPage() {
  const { id: dashboardId } = Route.useParams();

  // Build widget configurations for cross-filtering
  const widgetConfigs = useMemo(() => {
    // This would be populated from dashboard metadata
    // For now, return empty array - the provider will still work
    return [];
  }, []);

  // Always wrap with CrossFilterProvider to provide DashboardStateContext
  return (
    <CrossFilterProvider dashboardId={dashboardId} widgets={widgetConfigs}>
      <DashboardViewerContent dashboardId={dashboardId} />
    </CrossFilterProvider>
  );
}
