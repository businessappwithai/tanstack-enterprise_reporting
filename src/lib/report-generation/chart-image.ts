import { getLogger } from "@/lib/logging/logger";
/**
 * Chart image rendering for generated artifacts: ECharts SSR → SVG → sharp → PNG.
 *
 * Lives apart from the report worker so anything that needs a chart picture (the
 * worker's Excel/PDF artifacts, the Intelligent UI export) does not have to load the
 * worker's email, notification and RBAC dependencies to get one.
 */

export async function renderChartPng(
  rows: Record<string, unknown>[],
  columns: string[],
  chartType: string,
  metrics: string[],
  dimensions: string[]
): Promise<Buffer | null> {
  if (chartType === "none" || rows.length === 0) return null;

  try {
    const echarts = await import("echarts");

    const chart = echarts.init(null, null, {
      renderer: "svg",
      ssr: true,
      width: 900,
      height: 450,
    });

    const xCol = dimensions[0] ?? columns[0];
    const yCols = metrics.length > 0 ? metrics : columns.filter((c) => c !== xCol);

    const option: Record<string, any> = {
      backgroundColor: "#ffffff",
      tooltip: { trigger: "axis" },
      legend: { data: yCols, top: 10 },
      grid: { top: 50, bottom: 30, left: 60, right: 20 },
      xAxis: { type: "category", data: rows.map((r) => String(r[xCol] ?? "")) },
      yAxis: { type: "value" },
      series: yCols.map((col) => ({
        name: col,
        type: chartType === "area" ? "line" : chartType,
        data: rows.map((r) => Number(r[col]) || 0),
        areaStyle: chartType === "area" ? {} : undefined,
      })),
    };

    if (chartType === "pie") {
      const yCol = yCols[0] ?? columns[1];
      option.xAxis = undefined;
      option.yAxis = undefined;
      option.grid = undefined;
      option.series = [
        {
          type: "pie",
          radius: "60%",
          data: rows.slice(0, 20).map((r) => ({
            name: String(r[xCol] ?? ""),
            value: Number(r[yCol]) || 0,
          })),
        },
      ];
    }

    chart.setOption(option);
    const svgStr = chart.renderToSVGString();
    chart.dispose();

    // Convert SVG → PNG using sharp (prebuilt binaries, works on Alpine)
    const sharp = (await import("sharp")).default;
    const pngBuffer = (await sharp(Buffer.from(svgStr) as any)
      .resize(1800, 900)
      .png()
      .toBuffer()) as Buffer;

    return pngBuffer;
  } catch (err) {
    getLogger("report").note("warn", "[report-worker] Chart rendering failed, reports will be generated without charts:", { err: err });
    return null;
  }
}
