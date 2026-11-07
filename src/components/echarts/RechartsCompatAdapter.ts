/**
 * Adapter that converts existing Recharts-style chart configs into ECharts configs.
 * This allows existing charts saved in the database to render with the new ECharts engine.
 */

import type { ChartConfig, ChartType, DataMapping } from "@/types/database";
import type {
  EChartsConfig,
  ChartType as WasmChartType,
  DataMapping as WasmDataMapping,
} from "@/types/charts";

const CHART_TYPE_MAP: Record<string, WasmChartType> = {
  bar: "bar",
  line: "line",
  area: "area",
  pie: "pie",
  scatter: "scatter",
  column: "bar", // horizontal bar
  doughnut: "doughnut",
  composed: "bar", // fallback
};

/**
 * Convert a Recharts-style chart config + data mapping to an EChartsConfig.
 */
export function convertRechartsToECharts(
  chartType: ChartType,
  chartConfig: ChartConfig | null | undefined,
  dataMapping: DataMapping | null | undefined
): EChartsConfig {
  const type: WasmChartType = CHART_TYPE_MAP[chartType] ?? "bar";

  const echartsMapping: WasmDataMapping = {
    x: dataMapping?.xAxis?.field ?? undefined,
    y:
      dataMapping?.yAxis && dataMapping.yAxis.length > 0
        ? dataMapping.yAxis.map((f) => f.field)
        : undefined,
    group: dataMapping?.groupBy || undefined,
    color: dataMapping?.colorBy || undefined,
  };

  // Extract series-specific colors from dataMapping.yAxis[].color
  const seriesColors = dataMapping?.yAxis
    ?.map((series) => series.color)
    .filter((color): color is string => Boolean(color));

  const result = {
    type,
    title: chartConfig?.title?.text ?? undefined,
    colors: chartConfig?.colors ?? undefined,
    seriesColors: seriesColors && seriesColors.length > 0 ? seriesColors : undefined,
    dataMapping: echartsMapping,
    animation: chartConfig?.animation ?? true,
    stacked: chartConfig?.stacked === true,
    tooltip: chartConfig?.tooltip?.enabled !== false ? { trigger: "axis" as const } : false,
    legend:
      chartConfig?.legend?.show !== false
        ? {
            orient: "horizontal" as const,
            top: chartConfig?.legend?.position === "top" ? "top" : "bottom",
          }
        : false,
    xAxis: chartConfig?.xAxis
      ? {
          name: chartConfig.xAxis.label || undefined,
        }
      : undefined,
    yAxis: chartConfig?.yAxis
      ? {
          name: chartConfig.yAxis.label || undefined,
        }
      : undefined,
  };


  return result;
}
