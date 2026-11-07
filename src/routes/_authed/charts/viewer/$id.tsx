import { readApiError, retryUnlessRefused } from "@/lib/reporting/api-error";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import { Download, RefreshCw, Settings } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ChartRenderer } from "@/components/charts/chart-renderer";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { FilterBar } from "@/components/reporting/filter-bar";
import { ShareDialog } from "@/components/share/ShareDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ChartConfig, ChartDefinition, DataMapping } from "@/types/database";

export const Route = createFileRoute("/_authed/charts/viewer/$id")({
  component: ChartViewerPage,
});

function ChartViewerPage() {
  const { id: chartId } = Route.useParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [shareDialogOpen, setShareDialogOpen] = useState(false);

  const { data: chart, isLoading: isLoadingChart } = useQuery<ChartDefinition>({
    queryKey: ["chart", chartId],
    queryFn: async () => {
      const res = await fetch(`/api/charts/${chartId}`);
      const data = await res.json();
      return data.data;
    },
  });

  const { data: chartFilters } = useQuery({
    queryKey: ["chart-filters", chartId],
    queryFn: async () => {
      const res = await fetch(`/api/charts/${chartId}/filters`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!chartId,
  });

  const {
    data: chartData,
    isLoading: isLoadingData,
    refetch,
    error: dataError,
  } = useQuery({
    queryKey: ["chart-data", chartId, location.search],
    queryFn: async () => {
      const url = new URL(`/api/charts/${chartId}/data`, window.location.origin);
      for (const [key, value] of Object.entries(location.search)) {
        if (key.startsWith("filter_") && value != null) {
          url.searchParams.set(key, String(value));
        }
      }
      const res = await fetch(url.toString());
      if (!res.ok) throw await readApiError(res, "Failed to load chart data");
      const data = await res.json();
      return data.data;
    },
    enabled: !!chartId,
    retry: retryUnlessRefused,
    refetchInterval: chart?.refresh_interval ? chart.refresh_interval * 1000 : undefined,
  });

  const handleExport = async (_format: "png" | "svg") => {
    toast.info("Export feature coming soon");
  };

  if (isLoadingChart) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-tremor-content">Loading chart...</div>
      </div>
    );
  }

  if (!chart) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-tremor-content">Chart not found</div>
      </div>
    );
  }

  let chartConfig: ChartConfig | null = null;
  let dataMapping: DataMapping | null = null;

  try {
    let configStr = chart.chart_config;
    if (typeof configStr === "object" && configStr !== null) {
      chartConfig = configStr;
    } else if (typeof configStr === "string") {
      if (configStr.startsWith('"') && configStr.includes('\\"')) {
        configStr = JSON.parse(configStr);
      }
      chartConfig = JSON.parse(configStr);
    }
  } catch (_e) {
    chartConfig = null;
  }

  try {
    let mappingStr = chart.data_mapping;
    if (typeof mappingStr === "object" && mappingStr !== null) {
      dataMapping = mappingStr;
    } else if (typeof mappingStr === "string") {
      if (mappingStr.startsWith('"') && mappingStr.includes('\\"')) {
        mappingStr = JSON.parse(mappingStr);
      }
      dataMapping = JSON.parse(mappingStr);
    }
  } catch (_e) {
    dataMapping = null;
  }

  const isStacked = chartConfig?.stacked === true;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Charts", href: "/charts" }, { label: chart.name }]} />

      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-2xl text-tremor-content-strong">{chart.name}</h1>
          {chart.description && <p className="text-tremor-content">{chart.description}</p>}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShareDialogOpen(true)}>
            Share
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("png")}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/charts/editor/$id" params={{ id: chartId }}>
              <Settings className="h-4 w-4 mr-2" />
              Configure
            </Link>
          </Button>
        </div>
      </div>

      {chartFilters && chartFilters.length > 0 && (
        <FilterBar chartId={chartId} filters={chartFilters} type="chart" />
      )}

      <Card>
        <CardHeader>
          <CardTitle>{chartConfig?.title?.text || chart.name}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingData ? (
            <div className="flex items-center justify-center h-[400px]">
              <div className="text-tremor-content">Loading data...</div>
            </div>
          ) : dataError ? (
            <div className="flex items-center justify-center h-[400px]">
              <div className="text-destructive">
                Error loading chart data: {(dataError as Error).message}
              </div>
            </div>
          ) : !chartData || chartData.rows?.length === 0 ? (
            <div className="flex items-center justify-center h-[400px]">
              <div className="text-tremor-content">No data available for this chart</div>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground mb-3 pb-2 border-b">
                <span>📊 {chartData.rows?.length || 0} rows</span>
                <span>
                  X-Axis:{" "}
                  <strong>
                    {dataMapping?.xAxis?.label || dataMapping?.xAxis?.field || "none"}
                  </strong>
                </span>
                <span>
                  Y-Axis: <strong>{dataMapping?.yAxis?.length || 0}</strong> series
                </span>
                <span>
                  Stacked:{" "}
                  <strong className={isStacked ? "text-primary" : "text-muted-foreground"}>
                    {isStacked ? "✓ Yes" : "✗ No"}
                  </strong>
                </span>
                <span>
                  Type: <strong>{chart.chart_type}</strong>
                </span>
              </div>
              <ChartRenderer
                data={chartData.rows || []}
                chartType={chart.chart_type}
                chartConfig={chartConfig ?? undefined}
                dataMapping={dataMapping ?? undefined}
                height={400}
              />
            </>
          )}
        </CardContent>
      </Card>

      <ShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        resourceId={chartId}
        resourceType="chart"
        isPublic={chart?.is_public || false}
        onTogglePublic={(newState) => {
          if (chart) {
            chart.is_public = newState;
            queryClient.invalidateQueries({ queryKey: ["chart", chartId] });
          }
        }}
      />
    </div>
  );
}
