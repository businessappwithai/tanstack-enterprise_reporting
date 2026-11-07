import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SchemaInfo } from "@/types/api";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLogger } from "@/hooks/useLogger";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MonacoSQLEditorWrapper } from "@/components/sql-editor/monaco-editor-wrapper";
import { QueryResults } from "@/components/sql-editor/query-results";
import { SchemaBrowser } from "@/components/sql-editor/schema-browser";
import { sqlEditorConfig } from "@/lib/config/pagination";
import type { SQLExecutionResponse } from "@/types/api";
import type { DataSource } from "@/types/database";
import { PageHeader } from "@/components/layout/page-header";
import { CopilotKit } from "@copilotkit/react-core";
import { copilotRuntimeUrl, onCopilotError } from "@/lib/copilot/runtime-url";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { getLogger } from "@/lib/logging/logger";

export const Route = createFileRoute("/_authed/sql-editor")({
  component: SQLEditorPage,
});

function SQLEditorContent() {
  const search = Route.useSearch() as { queryId?: string };
  const queryClient = useQueryClient();
  const logger = useLogger({ component: "SQL Editor" });
  const [sqlContent, setSqlContent] = useState("");
  const [selectedDataSource, setSelectedDataSource] = useState<string>("");
  const [queryResult, setQueryResult] = useState<SQLExecutionResponse | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<{
    isValid: boolean;
    errors: Array<{ message: string; line?: number; column?: number }>;
    warnings: Array<{ message: string; type: string }>;
  } | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [dataSourceCollapsed, setDataSourceCollapsed] = useState(false);
  const [schemaBrowserCollapsed, setSchemaBrowserCollapsed] = useState(false);

  const [accumulatedRows, setAccumulatedRows] = useState<Record<string, unknown>[]>([]);
  const [currentOffset, setCurrentOffset] = useState(0);
  const [_totalRows, setTotalRows] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, _setIsLoadingMore] = useState(false);
  const [warning, setWarning] = useState<{ message: string; suggestion: string } | null>(null);

  const [saveQueryModal, setSaveQueryModal] = useState(false);
  const [queryName, setQueryName] = useState("");
  const [queryDescription, setQueryDescription] = useState("");
  const [editingQueryId, setEditingQueryId] = useState<string | null>(null);

  // Load query from URL parameter
  useEffect(() => {
    const queryId = search.queryId;
    if (queryId) {
      setEditingQueryId(queryId);
      fetch(`/api/queries/${queryId}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load query`);
          return res.json();
        })
        .then((data) => {
          if (data.success) {
            const query = data.data;
            setSqlContent(query.sql_content);
            setSelectedDataSource(query.data_source_id);
            setQueryName(query.name);
            setQueryDescription(query.description || "");
          }
        })
        .catch((error) => {
          getLogger("client").note("error", "Failed to load query:", { err: error });
        });
    } else {
      setEditingQueryId(null);
    }
  }, [search.queryId]);

  const [activeTab, setActiveTab] = useState<"results" | "errors" | "logs">("results");
  const [queryLogs, setQueryLogs] = useState<string[]>([]);

  const saveQueryMutation = useMutation({
    mutationFn: async ({ name, description }: { name: string; description?: string }) => {
      const url = editingQueryId ? `/api/queries/${editingQueryId}` : "/api/queries";
      const method = editingQueryId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          dataSourceId: selectedDataSource,
          sqlContent: sqlContent,
        }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setSaveQueryModal(false);
        setQueryName("");
        setQueryDescription("");
        if (!editingQueryId && data.data?.id) {
          setEditingQueryId(data.data.id);
        }
      }
    },
  });

  const { data: dataSources, isLoading: isLoadingDataSources } = useQuery<DataSource[]>({
    queryKey: ["data-sources", "active"],
    queryFn: async () => {
      const res = await fetch("/api/data-sources");
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load data sources`);
      const data = await res.json();
      const sources = data.items || data.data?.items || [];
      return sources.filter((ds: DataSource) => ds.is_active);
    },
    staleTime: 60000,
    gcTime: 300000,
  });

  const { data: schema, isLoading: isLoadingSchema } = useQuery<
    SchemaInfo & { logs?: string[]; warning?: string }
  >({
    queryKey: ["schema", selectedDataSource],
    queryFn: async () => {
      const res = await fetch(`/api/sql/schema/${selectedDataSource}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}: Failed to load schema`);
      }
      const data = await res.json();
      if (!data.success) throw new Error(data.error?.message || "Failed to load schema");
      return data.data;
    },
    enabled: !!selectedDataSource,
    retry: 2,
    retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
    staleTime: 300000,
    gcTime: 600000,
  });

  const executeMutation = useMutation({
    mutationFn: async ({ sql }: { sql: string }) => {
      const res = await fetch("/api/sql/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql,
          dataSourceId: selectedDataSource,
          limit: sqlEditorConfig.serverPageSize,
          offset: 0,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}: Query execution failed`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      const timestamp = new Date().toISOString();
      setQueryLogs((prev) => [`[${timestamp}] Executing query...`, ...prev]);
      if (data.success) {
        const result = data.data;
        logger.info("Query executed", {
          rowCount: result.rowCount,
          totalRows: result.totalRows,
          executionTime: result.executionTime,
        });
        if (result.warning) {
          setWarning(result.warning);
          setQueryResult(null);
          setExecutionError(null);
          setAccumulatedRows([]);
          setCurrentOffset(0);
          setTotalRows(null);
          setHasMore(false);
          logger.warn("Query warning", { warning: result.warning.message });
          setQueryLogs((prev) => [`[${timestamp}] Warning: ${result.warning.message}`, ...prev]);
          setActiveTab("logs");
        } else {
          setAccumulatedRows(result.rows || []);
          setCurrentOffset(0);
          setTotalRows(result.totalRows || null);
          setHasMore(result.pagination?.hasMore || false);
          setWarning(null);
          setExecutionError(null);
          const finalResult = { ...result, rows: result.rows || [] };
          setQueryResult(finalResult);
          setQueryLogs((prev) => [
            `[${timestamp}] Query executed successfully`,
            `[${timestamp}] Returned ${result.rowCount} rows${result.totalRows ? ` of ${result.totalRows} total` : ""} in ${result.executionTime}ms`,
            ...prev,
          ]);
          setActiveTab("results");
        }
      } else {
        const errorMessage = data.error?.message || "Query execution failed";
        setExecutionError(errorMessage);
        setQueryResult(null);
        setWarning(null);
        logger.error("Query execution failed", { error: errorMessage });
        setQueryLogs((prev) => [`[${timestamp}] Error: ${errorMessage}`, ...prev]);
        setActiveTab("errors");
      }
    },
    onError: (error) => {
      const timestamp = new Date().toISOString();
      setExecutionError(error instanceof Error ? error.message : "Unknown error");
      setQueryResult(null);
      setWarning(null);
      setQueryLogs((prev) => [
        `[${timestamp}] Exception: ${error instanceof Error ? error.message : "Unknown error"}`,
        ...prev,
      ]);
      setActiveTab("errors");
    },
  });

  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDataSource || !sqlContent) throw new Error("No data source or query");
      const nextOffset = currentOffset + (accumulatedRows.length || 0);
      const res = await fetch("/api/sql/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: sqlContent,
          dataSourceId: selectedDataSource,
          limit: sqlEditorConfig.serverPageSize,
          offset: nextOffset,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || `HTTP ${res.status}: Failed to load more rows`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success && !data.data.warning) {
        const newRows = data.data.rows || [];
        const nextOffset = currentOffset + accumulatedRows.length;
        setAccumulatedRows((prev) => [...prev, ...newRows]);
        setCurrentOffset(nextOffset);
        setHasMore(data.data.pagination?.hasMore || false);
        setTotalRows(data.data.pagination?.totalRows || null);
        setQueryResult((prev) =>
          prev
            ? {
                ...prev,
                rows: [...accumulatedRows, ...newRows],
                rowCount: [...accumulatedRows, ...newRows].length,
              }
            : null
        );
      }
    },
  });

  const _handleLoadMore = useCallback(() => {
    if (hasMore && !isLoadingMore && accumulatedRows.length < sqlEditorConfig.maxClientRows) {
      loadMoreMutation.mutate();
    }
  }, [hasMore, isLoadingMore, accumulatedRows.length, loadMoreMutation.mutate]);

  const handleExecute = useCallback(() => {
    if (!selectedDataSource) {
      setExecutionError("Please select a data source");
      return;
    }
    executeMutation.mutate({ sql: sqlContent });
  }, [sqlContent, selectedDataSource, executeMutation]);

  const handleRefreshSchema = useCallback(() => {
    if (selectedDataSource) {
      queryClient.invalidateQueries({ queryKey: ["schema", selectedDataSource] });
    }
  }, [selectedDataSource, queryClient]);

  const handlePageChange = useCallback(
    async (offset: number) => {
      if (!selectedDataSource || !sqlContent) return;
      const res = await fetch("/api/sql/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: sqlContent,
          dataSourceId: selectedDataSource,
          limit: sqlEditorConfig.serverPageSize,
          offset,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && !data.data.warning) {
        setQueryResult({ ...data.data, rows: data.data.rows || [] });
        setCurrentOffset(offset);
        setHasMore(data.data.pagination?.hasMore || false);
      }
    },
    [sqlContent, selectedDataSource]
  );

  const handleValidate = useCallback(async () => {
    if (!sqlContent.trim()) {
      setValidationResult({
        isValid: false,
        errors: [{ message: "SQL query cannot be empty" }],
        warnings: [],
      });
      return;
    }
    setIsValidating(true);
    try {
      const res = await fetch("/api/sql/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sqlContent, dataSourceId: selectedDataSource }),
      });
      const data = await res.json();
      if (data.success) {
        setValidationResult(data.data);
      } else {
        setValidationResult({
          isValid: false,
          errors: [{ message: data.error?.message || "Validation failed" }],
          warnings: [],
        });
      }
    } catch (error) {
      setValidationResult({
        isValid: false,
        errors: [{ message: error instanceof Error ? error.message : "Unknown error" }],
        warnings: [],
      });
    } finally {
      setIsValidating(false);
    }
  }, [sqlContent, selectedDataSource]);

  const handleTableClick = (tableName: string) => {
    setSqlContent(`SELECT * FROM ${tableName} LIMIT 100;`);
  };

  const handleColumnClick = (tableName: string, columnName: string) => {
    setSqlContent((prev) => {
      const insertion = `${tableName}.${columnName}`;
      return prev + (prev.endsWith(" ") || prev.endsWith("\n") ? "" : " ") + insertion;
    });
  };

  const handleSaveQuery = () => {
    if (!queryName.trim()) return;
    saveQueryMutation.mutate({ name: queryName, description: queryDescription });
  };

  // ── CopilotKit context ──────────────────────────────────────────────────
  useCopilotReadable({
    description: "Available data sources for SQL queries",
    value: (dataSources ?? []).map((ds) => ({ id: ds.id, name: ds.name, type: ds.client_type })),
  });
  useCopilotReadable({
    description: "Currently selected data source ID",
    value: selectedDataSource,
  });
  useCopilotReadable({
    description: "Current SQL in the editor",
    value: sqlContent || "(empty)",
  });

  useCopilotAction({
    name: "applySQL",
    description:
      "Insert generated SQL into the editor. Generate the SQL first based on the user's description and the schema context, then call this to apply it.",
    parameters: [
      { name: "sql", type: "string", description: "Complete SQL query to insert", required: true },
    ],
    handler: async ({ sql }) => {
      setSqlContent(sql);
      return "SQL applied to the editor. The user can now click 'Run Query' to execute it.";
    },
  });
  useCopilotAction({
    name: "selectDataSource",
    description: "Select a data source by ID so the user can run queries against it.",
    parameters: [
      {
        name: "dataSourceId",
        type: "string",
        description: "Data source ID from the available list",
        required: true,
      },
    ],
    handler: async ({ dataSourceId }) => {
      setSelectedDataSource(dataSourceId);
      return `Data source ${dataSourceId} selected.`;
    },
  });
  useCopilotAction({
    name: "executeQuery",
    description: "Execute the current SQL query in the editor.",
    parameters: [],
    handler: async () => {
      if (!selectedDataSource) return "No data source selected — ask the user to pick one first.";
      if (!sqlContent.trim()) return "Editor is empty — apply SQL first.";
      handleExecute();
      return "Query execution triggered.";
    },
  });
  // ────────────────────────────────────────────────────────────────────────

  const SQL_EDITOR_INSTRUCTIONS = `You are an AI SQL assistant embedded in a SQL editor.
Your job is to help the user write, understand, and run SQL queries against their database.

WORKFLOW:
1. When the user describes what data they want, generate correct SQL and call applySQL to insert it.
2. If no data source is selected, call selectDataSource first using the available data sources list.
3. After applying SQL, offer to execute it by calling executeQuery.
4. Explain what each query does in simple terms.
5. Help debug errors by rewriting the SQL when the user pastes error messages.

RULES:
- Always write safe SELECT queries unless the user explicitly asks for DML.
- Use LIMIT clauses on large tables (suggest LIMIT 100 as default).
- Never fabricate column names — use only what appears in the schema context.`;

  return (
    <CopilotSidebar
      onError={onCopilotError}
      instructions={SQL_EDITOR_INSTRUCTIONS}
      defaultOpen={false}
      labels={{
        title: "SQL Assistant",
        initial:
          "Hi! Describe what data you want and I'll write the SQL for you. You can also paste errors for me to fix.",
        placeholder: "Describe what you need or paste an error…",
      }}
    >
      <div className="p-3 sm:p-6">
        {/* Header — stacks on mobile, row on sm+ */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <PageHeader title="SQL Editor" description="Write and execute SQL queries" />
          {/* Action buttons — full-width on mobile, auto on sm+ */}
          <div className="grid grid-cols-3 gap-2 sm:flex sm:gap-2">
            <button
              type="button"
              onClick={handleValidate}
              disabled={isValidating}
              className="px-3 py-2 text-sm bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isValidating ? "Validating…" : "Validate"}
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={executeMutation.isPending}
              className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {executeMutation.isPending ? "Running…" : "Run Query"}
            </button>
            <button
              type="button"
              onClick={() => setSaveQueryModal(true)}
              disabled={!selectedDataSource || !sqlContent.trim()}
              className="px-3 py-2 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>

        {validationResult && (
          <div
            className={`mb-4 border rounded p-3 ${
              validationResult.isValid && validationResult.errors.length === 0
                ? "border-emerald-300 bg-emerald-50"
                : "border-red-300 bg-red-50"
            }`}
          >
            {validationResult.isValid && validationResult.errors.length === 0 ? (
              <div className="text-sm text-emerald-700">
                <p className="font-medium">SQL is valid</p>
                {validationResult.warnings.length > 0 && (
                  <div className="mt-2">
                    <p className="font-medium">Warnings:</p>
                    <ul className="list-disc list-inside ml-2">
                      {validationResult.warnings.map((warning) => (
                        <li key={warning.message + (warning.type ?? "")} className="text-xs">
                          {warning.message} ({warning.type})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-red-700">
                <p className="font-medium">SQL has errors:</p>
                <ul className="list-disc list-inside ml-2">
                  {validationResult.errors.map((error) => (
                    <li key={error.message + (error.line ?? "")}>
                      {error.message}
                      {error.line !== undefined && ` (line ${error.line})`}
                    </li>
                  ))}
                </ul>
                {validationResult.warnings.length > 0 && (
                  <div className="mt-2">
                    <p className="font-medium">Warnings:</p>
                    <ul className="list-disc list-inside ml-2">
                      {validationResult.warnings.map((warning) => (
                        <li key={warning.message + (warning.type ?? "")} className="text-xs">
                          {warning.message} ({warning.type})
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => setValidationResult(null)}
              className="mt-2 text-xs underline text-gray-600 hover:text-gray-800"
            >
              Dismiss
            </button>
          </div>
        )}

        {!dataSourceCollapsed ? (
          <div className="border rounded p-3 mb-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Data Source</p>
              <button
                type="button"
                onClick={() => setDataSourceCollapsed(true)}
                className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
              >
                ▲ collapse
              </button>
            </div>
            <div className="flex gap-2 items-center">
              {isLoadingDataSources && (
                <p className="text-tremor-label text-tremor-content">Loading…</p>
              )}
              {!isLoadingDataSources && dataSources && dataSources.length > 0 && (
                <Select value={selectedDataSource} onValueChange={setSelectedDataSource}>
                  <SelectTrigger className="w-full sm:w-72">
                    <SelectValue placeholder="Select a data source…" />
                  </SelectTrigger>
                  <SelectContent>
                    {dataSources.map((ds) => (
                      <SelectItem key={ds.id} value={ds.id}>
                        {ds.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {!isLoadingDataSources && (!dataSources || dataSources.length === 0) && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  No data sources configured.{" "}
                  <a href="/data-sources" className="underline hover:no-underline">
                    Create one
                  </a>
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="border rounded p-2 mb-4">
            <button
              type="button"
              onClick={() => setDataSourceCollapsed(false)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 w-full"
            >
              <ChevronDown className="h-4 w-4" />
              <span className="font-medium">
                {selectedDataSource
                  ? dataSources?.find((ds) => ds.id === selectedDataSource)?.name ||
                    "Select Data Source"
                  : "Select Data Source"}
              </span>
            </button>
          </div>
        )}

        {/* Editor — taller on tablets to give more working space */}
        <MonacoSQLEditorWrapper
          value={sqlContent}
          onChange={setSqlContent}
          onExecute={handleExecute}
          height="min(400px, 40vh)"
          className="border"
          schema={null}
        />

        {!schemaBrowserCollapsed ? (
          <div className="mt-4 border rounded p-3 sm:p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">
                Schema Browser
                <span className="ml-1 text-muted-foreground font-normal">
                  (
                  {isLoadingSchema
                    ? "loading…"
                    : selectedDataSource
                      ? `${schema?.tables.length || 0} tables, ${schema?.views.length || 0} views`
                      : "select a data source"}
                  )
                </span>
              </p>
              <div className="flex items-center gap-2">
                {selectedDataSource && (
                  <button
                    type="button"
                    onClick={handleRefreshSchema}
                    className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 flex items-center gap-1"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span className="hidden sm:inline">Refresh</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setSchemaBrowserCollapsed(true)}
                  className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
                >
                  ▼ collapse
                </button>
              </div>
            </div>
            <div className="max-h-60 sm:max-h-72 overflow-auto">
              {selectedDataSource ? (
                <SchemaBrowser
                  schema={schema || null}
                  isLoading={isLoadingSchema}
                  onTableClick={handleTableClick}
                  onColumnClick={handleColumnClick}
                />
              ) : (
                <p className="text-tremor-default text-tremor-content">
                  Select a data source to view schema
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 border rounded p-2">
            <button
              type="button"
              onClick={() => setSchemaBrowserCollapsed(false)}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400"
            >
              <span>▲</span>
              <span className="font-medium">
                Schema Browser
                <span className="ml-1 text-muted-foreground font-normal">
                  (
                  {isLoadingSchema
                    ? "loading…"
                    : selectedDataSource
                      ? `${schema?.tables.length || 0} tables, ${schema?.views.length || 0} views`
                      : "select a data source"}
                  )
                </span>
              </span>
            </button>
          </div>
        )}

        <div className="mt-4 border rounded">
          {/* Tab bar — compact on mobile */}
          <div className="flex border-b overflow-x-auto">
            {(["results", "errors", "logs"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`flex-shrink-0 px-4 py-2 text-sm font-medium capitalize transition-colors ${
                  activeTab === tab
                    ? tab === "results"
                      ? "bg-blue-50 text-blue-700 border-b-2 border-blue-600 dark:bg-blue-900/20 dark:text-blue-400"
                      : tab === "errors"
                        ? "bg-red-50 text-red-700 border-b-2 border-red-600 dark:bg-red-900/20 dark:text-red-400"
                        : "bg-gray-50 text-gray-700 border-b-2 border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                    : "text-gray-600 hover:text-gray-800 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="p-3 sm:p-4">
            {activeTab === "results" && (
              <div>
                {queryResult && (
                  <div className="overflow-auto max-h-80 sm:max-h-96">
                    <QueryResults
                      result={queryResult}
                      isLoading={false}
                      error={null}
                      onPageChange={handlePageChange}
                    />
                  </div>
                )}
                {!queryResult && !executeMutation.isPending && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    Run a query to see results here.
                  </div>
                )}
                {executeMutation.isPending && (
                  <div className="text-center py-8">
                    <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
                    <p className="text-tremor-default text-tremor-content">Executing query…</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "errors" && (
              <div className="space-y-3">
                {executionError && (
                  <div className="border border-red-300 bg-red-50 dark:bg-red-900/20 rounded p-3">
                    <h3 className="font-semibold text-red-700 dark:text-red-400 mb-1 text-sm">
                      Query Error
                    </h3>
                    <pre className="text-sm text-red-600 dark:text-red-300 whitespace-pre-wrap overflow-auto">
                      {executionError}
                    </pre>
                  </div>
                )}
                {warning && (
                  <div className="border border-amber-300 bg-amber-50 dark:bg-amber-900/20 rounded p-3">
                    <h3 className="font-semibold text-amber-700 dark:text-amber-400 mb-1 text-sm">
                      Warning
                    </h3>
                    <p className="text-sm text-amber-600 dark:text-amber-300">{warning.message}</p>
                    <p className="text-sm text-amber-600 dark:text-amber-300 mt-1">
                      Suggestion: {warning.suggestion}
                    </p>
                  </div>
                )}
                {!executionError && !warning && (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    No errors recorded.
                  </div>
                )}
              </div>
            )}

            {activeTab === "logs" && (
              <div>
                {queryLogs.length > 0 ? (
                  <div className="bg-gray-50 dark:bg-gray-900 rounded p-3 max-h-80 sm:max-h-96 overflow-auto">
                    <pre className="text-xs font-mono">
                      {queryLogs.map((log) => (
                        <div key={log} className="whitespace-pre-wrap">
                          {log}
                        </div>
                      ))}
                    </pre>
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    No logs yet. Run a query to see execution logs.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {saveQueryModal && (
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center"
            style={{ zIndex: 99999 }}
          >
            <div className="bg-background p-6 w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto border">
              <h2 className="text-xl font-bold mb-4">
                {editingQueryId ? "Update Query" : "Save Query"}
              </h2>
              <div className="space-y-4">
                <div>
                  <label htmlFor="queryName" className="block text-sm font-medium mb-1">
                    Query Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="queryName"
                    type="text"
                    value={queryName}
                    onChange={(e) => setQueryName(e.target.value)}
                    className="w-full px-3 py-2 border"
                    placeholder="Enter query name"
                  />
                  {queryName.trim().length === 0 && (
                    <p className="text-xs text-red-500 mt-1">Query name is required</p>
                  )}
                </div>
                <div>
                  <label htmlFor="queryDescription" className="block text-sm font-medium mb-1">
                    Description <span className="text-tremor-content">(optional)</span>
                  </label>
                  <textarea
                    id="queryDescription"
                    value={queryDescription}
                    onChange={(e) => setQueryDescription(e.target.value)}
                    className="w-full px-3 py-2 border"
                    placeholder="Enter a description for this query"
                    rows={3}
                  />
                </div>
                <div className="text-xs text-muted-foreground bg-background p-2 border">
                  <p>
                    Data Source:{" "}
                    <strong>
                      {dataSources?.find((ds) => ds.id === selectedDataSource)?.name || "None"}
                    </strong>
                  </p>
                  <p>
                    Query Length: <strong>{sqlContent.length}</strong> characters
                  </p>
                </div>
              </div>
              <div className="flex gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setSaveQueryModal(false);
                    setQueryName("");
                    setQueryDescription("");
                  }}
                  className="flex-1 px-4 py-2 border hover:bg-gray-100 dark:hover:bg-gray-800 text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveQuery}
                  disabled={saveQueryMutation.isPending || !queryName.trim()}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
                >
                  {saveQueryMutation.isPending ? "Saving..." : editingQueryId ? "Update" : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </CopilotSidebar>
  );
}

function SQLEditorPage() {
  return (
    <CopilotKit runtimeUrl={copilotRuntimeUrl()} showDevConsole={false}>
      <SQLEditorContent />
    </CopilotKit>
  );
}
