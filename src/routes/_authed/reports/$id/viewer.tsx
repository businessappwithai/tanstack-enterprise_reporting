import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Download, Edit, Eye, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/layout/breadcrumb";
import { RecordViewDialog } from "@/components/nl-query/RecordViewDialog";
import { DataTable } from "@/components/reporting/data-table";
import { FilterBar } from "@/components/reporting/filter-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ColumnDef } from "@tanstack/react-table";
import { readApiError, retryUnlessRefused } from "@/lib/reporting/api-error";
import { formatCellValue } from "@/lib/reporting/format-cell";
import { parseRecordLinkConfig } from "@/lib/reporting/record-link";
import type { ColumnDefinition, ReportDefinition } from "@/types/database";

export const Route = createFileRoute("/_authed/reports/$id/viewer")({
  component: ReportViewerPage,
});

interface ReportRow {
  [key: string]: unknown;
}

function ReportViewerPage() {
  const { id: reportId } = Route.useParams();
  const queryClient = useQueryClient();
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  // The row whose read-only detail is open, or null. Held here rather than in
  // DataTable so the table stays a presentation component.
  const [detailRow, setDetailRow] = useState<ReportRow | null>(null);

  const { data: report, isLoading: isLoadingReport } = useQuery<ReportDefinition>({
    queryKey: ["report", reportId],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${reportId}`);
      const data = await res.json();
      return data.data;
    },
  });

  const {
    data: reportData,
    isLoading: isLoadingData,
    error: dataError,
  } = useQuery({
    queryKey: ["report-data", reportId, pageIndex, pageSize],
    queryFn: async () => {
      const res = await fetch(
        `/api/reports/${reportId}/data?page=${pageIndex}&pageSize=${pageSize}`
      );
      // A refusal (403 naming the tables) or a failure must reach the screen, not become
      // "No data": the body of an error has no `data`.
      if (!res.ok) throw await readApiError(res, "Failed to load report data");
      const data = await res.json();
      return data.data;
    },
    enabled: !!report,
    retry: retryUnlessRefused,
  });

  const exportMutation = useMutation({
    mutationFn: async (format: "csv" | "xlsx" | "html" | "pdf") => {
      const res = await fetch(`/api/reports/${reportId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;

      // Build filename: matches server-side buildFilename logic
      let filename = report?.name || "report";
      if (report?.filename_template && reportData?.rows && reportData.rows.length > 0) {
        try {
          const template = JSON.parse(report.filename_template);
          const firstRow = reportData.rows[0];
          if (template.field1 && firstRow[template.field1]) {
            filename += String(firstRow[template.field1]);
          }
          if (template.field2 && firstRow[template.field2]) {
            filename += String(firstRow[template.field2]);
          }
        } catch {
          // Use default filename if template parsing fails
        }
      }

      const ext = format === "xlsx" ? "xlsx" : format;
      a.download = `${filename}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: () => {
      toast.error("Failed to export report");
    },
  });

  // The report's record link, if an administrator configured one. Drives both
  // the per-row detail action below and the button inside the detail dialog.
  const recordLink = useMemo(
    () => parseRecordLinkConfig(report?.record_link_config ?? null),
    [report?.record_link_config]
  );

  const columns: ColumnDef<ReportRow>[] = useMemo(() => {
    if (!report) return [];

    /**
     * Fall back to the result set's own columns when the report has no usable
     * `column_config`. Without this a report saved with an empty (or fully
     * hidden) column config renders as an empty frame: the row count, search
     * box and pager all appear, wrapped around a table with no columns.
     */
    /**
     * Prepend the "view record" action.
     *
     * Only when a record link is configured. A report without one has nowhere
     * to traverse to, and the raw row is already on screen — so an action that
     * reopens the same values in a dialog would be noise on every report in the
     * installation.
     */
    const withDetailAction = (cols: ColumnDef<ReportRow>[]): ColumnDef<ReportRow>[] => {
      if (!recordLink?.enabled) return cols;
      return [
        {
          id: "__view_record",
          header: "",
          enableSorting: false,
          cell: ({ row }: { row: { original: ReportRow } }) => (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label="View record"
              onClick={() => setDetailRow(row.original)}
            >
              <Eye className="h-4 w-4" />
            </Button>
          ),
        },
        ...cols,
      ];
    };

    const columnsFromData = (): ColumnDef<ReportRow>[] => {
      const firstRow = reportData?.rows?.[0];
      if (!firstRow) return [];
      return Object.keys(firstRow).map((field) => ({
        id: field,
        accessorKey: field,
        header: field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        cell: (info: { getValue: () => unknown }) => formatCellValue(info.getValue()) ?? "-",
      }));
    };

    try {
      const columnConfig = JSON.parse(report.column_config || "[]");
      const configured = columnConfig
        .filter((col: ColumnDefinition) => col.visible)
        .map((col: ColumnDefinition) => ({
          id: col.id || col.field,
          accessorKey: col.field,
          header: col.header || col.field || col.id,
          cell: (info: { getValue: () => unknown }) =>
            formatCellValue(info.getValue(), col.formatter) ?? "-",
        }));
      return withDetailAction(configured.length > 0 ? configured : columnsFromData());
    } catch {
      return withDetailAction(columnsFromData());
    }
  }, [report, reportData, recordLink]);

  if (isLoadingReport) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Report not found</p>
          <Link to="/reports">
            <Button>Back to Reports</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: "Reports", href: "/reports" }, { label: report.name }]} />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/reports">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="font-semibold text-2xl text-tremor-content-strong">{report.name}</h1>
            {report.description && (
              <p className="mt-1 text-tremor-default text-tremor-content">{report.description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["report-data", reportId] })}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>

          {(() => {
            const formats = report.export_formats ? JSON.parse(report.export_formats) : {};
            return (
              <>
                {formats.csv && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportMutation.mutate("csv")}
                    disabled={exportMutation.isPending}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    CSV
                  </Button>
                )}
                {formats.xlsx && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportMutation.mutate("xlsx")}
                    disabled={exportMutation.isPending}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Excel
                  </Button>
                )}
                {formats.html && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportMutation.mutate("html")}
                    disabled={exportMutation.isPending}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    HTML
                  </Button>
                )}
                {formats.pdf && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => exportMutation.mutate("pdf")}
                    disabled={exportMutation.isPending}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    PDF
                  </Button>
                )}
              </>
            );
          })()}

          <Link to="/reports/$id/editor" params={{ id: reportId }}>
            <Button size="sm">
              <Edit className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Report Data</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingData ? (
            <Skeleton className="h-96 w-full" />
          ) : dataError ? (
            <Alert variant="destructive" data-testid="report-data-error">
              <AlertTitle>This report could not be run</AlertTitle>
              <AlertDescription>{(dataError as Error).message}</AlertDescription>
            </Alert>
          ) : reportData?.rows?.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No data available for this report</p>
            </div>
          ) : (
            <DataTable
              data={reportData?.rows || []}
              columns={columns}
              isLoading={isLoadingData}
              totalRows={reportData?.totalRows}
              pageSize={pageSize}
              pageIndex={pageIndex}
              serverSide={true}
              onPaginationChange={(pagination) => {
                setPageIndex(pagination.pageIndex);
                setPageSize(pagination.pageSize);
              }}
              colorTheme={report.color_theme ? JSON.parse(report.color_theme) : null}
            />
          )}
        </CardContent>
      </Card>

      {detailRow && (
        // entityId is empty and no entityMeta is passed: a report's result set
        // is the shape of its query, not of one catalogued entity, so the
        // dialog renders the row's own columns. That path is already its
        // documented fallback rather than something added for this.
        <RecordViewDialog
          open={!!detailRow}
          onClose={() => setDetailRow(null)}
          dataSourceId=""
          entityId=""
          record={detailRow}
          recordLink={recordLink}
        />
      )}
    </div>
  );
}
