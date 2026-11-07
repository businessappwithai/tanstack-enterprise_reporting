import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Database,
  Edit,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  ConnectionFormFields,
  type ConnectionFormState,
  isTestConnectionDisabled,
} from "@/components/data-sources/connection-form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/utils";
import type { DataSource } from "@/types/database";
import { PageHeader } from "@/components/layout/page-header";

import { CopilotKit } from "@copilotkit/react-core";
import { copilotRuntimeUrl, onCopilotError } from "@/lib/copilot/runtime-url";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { getLogger } from "@/lib/logging/logger";
export const Route = createFileRoute("/_authed/data-sources/")({
  component: DataSourcesPage,
});

const DEFAULT_FORM: ConnectionFormState = {
  name: "",
  description: "",
  clientType: "pg",
  host: "",
  port: "",
  database: "",
  user: "",
  password: "",
  fileName: "",
  connectionString: "",
  useConnectionString: false,
};

function buildConnectionConfig(state: ConnectionFormState) {
  if (state.clientType === "sqlite3") {
    return { filename: state.fileName };
  }
  if (state.useConnectionString && state.connectionString) {
    return { connectionString: state.connectionString };
  }
  return {
    host: state.host,
    port: state.port ? parseInt(state.port, 10) : undefined,
    database: state.database,
    user: state.user,
    password: state.password || undefined,
  };
}

function DataSourcesContent() {
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingDataSource, setEditingDataSource] = useState<DataSource | null>(null);
  const [formState, setFormState] = useState<ConnectionFormState>(DEFAULT_FORM);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [dataSourceToDelete, setDataSourceToDelete] = useState<DataSource | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [usageInfo, setUsageInfo] = useState<{
    queries: number;
    reports: number;
    charts: number;
  } | null>(null);
  const [inspectingDs, setInspectingDs] = useState<string | null>(null);

  const { data: dataSources, isLoading } = useQuery<DataSource[]>({
    queryKey: ["data-sources"],
    queryFn: async () => {
      const res = await fetch("/api/data-sources");
      const data = await res.json();
      return data.items || data.data?.items || [];
    },
    staleTime: 0,
  });

  const resetForm = () => {
    setFormState(DEFAULT_FORM);
    setConnectionTestResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileUpload = async (file: File) => {
    if (
      !file.name.endsWith(".db") &&
      !file.name.endsWith(".sqlite") &&
      !file.name.endsWith(".sqlite3")
    ) {
      toast.error("Please select a valid SQLite database file (.db, .sqlite, .sqlite3)");
      return;
    }
    setUploadingFile(true);
    setConnectionTestResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/data-sources/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (data.success) {
        setFormState((prev) => ({ ...prev, fileName: data.data.filename }));
        toast.success(data.data.message);
      } else {
        toast.error(data.error?.message || "Failed to upload file");
      }
    } catch {
      toast.error("Failed to upload file");
    } finally {
      setUploadingFile(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (
      file &&
      (file.name.endsWith(".db") || file.name.endsWith(".sqlite") || file.name.endsWith(".sqlite3"))
    ) {
      handleFileUpload(file);
    } else if (file) {
      toast.error("Please select a valid SQLite database file (.db, .sqlite, .sqlite3)");
    }
  };

  const testConnection = async () => {
    setTestingConnection(true);
    setConnectionTestResult(null);
    try {
      if (formState.clientType === "sqlite3" && !formState.fileName) {
        setConnectionTestResult({
          success: false,
          message: "Please upload a SQLite database file",
        });
        return;
      }
      if (formState.clientType !== "sqlite3") {
        if (formState.useConnectionString && !formState.connectionString) {
          setConnectionTestResult({
            success: false,
            message: "Please provide a connection string",
          });
          return;
        }
        if (
          !formState.useConnectionString &&
          (!formState.host || !formState.database || !formState.user)
        ) {
          setConnectionTestResult({
            success: false,
            message: "Please fill in Host, Database, and Username fields",
          });
          return;
        }
      }
      const res = await fetch("/api/data-sources/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientType: formState.clientType,
          connectionConfig: buildConnectionConfig(formState),
        }),
      });
      const data = await res.json();
      setConnectionTestResult({
        success: data.data?.connected || false,
        message: data.data?.message || data.error?.message || "Test failed",
      });
    } catch (error) {
      setConnectionTestResult({
        success: false,
        message: error instanceof Error ? error.message : "Connection test failed",
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/data-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formState.name,
          description: formState.description,
          clientType: formState.clientType,
          connectionConfig: buildConnectionConfig(formState),
        }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Data source created successfully");
        queryClient.invalidateQueries({ queryKey: ["data-sources"] });
        resetForm();
        setCreateDialogOpen(false);
      } else {
        toast.error(data.error?.message || "Failed to create data source");
      }
    },
  });

  const handleEdit = (ds: DataSource) => {
    setEditingDataSource(ds);
    let config: Record<string, unknown> = {};
    try {
      config = ds.connection_config ? JSON.parse(ds.connection_config) : {};
    } catch {
      /* ignore */
    }
    const fullPath = (config.filename as string) || "";
    const hasConnectionString = "connectionString" in config;
    setFormState({
      name: ds.name,
      description: ds.description || "",
      clientType: ds.client_type,
      host: (config.host as string) || "",
      port: config.port?.toString() || "",
      database: (config.database as string) || "",
      user: (config.user as string) || "",
      password: "",
      fileName: fullPath.split("/").pop() || fullPath,
      connectionString: (config.connectionString as string) || "",
      useConnectionString: hasConnectionString,
    });
    setConnectionTestResult(null);
    setEditDialogOpen(true);
  };

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingDataSource) throw new Error("No data source selected");
      const res = await fetch(`/api/data-sources/${editingDataSource.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formState.name,
          description: formState.description,
          clientType: formState.clientType,
          connectionConfig: buildConnectionConfig(formState),
        }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Data source updated successfully");
        queryClient.invalidateQueries({ queryKey: ["data-sources"] });
        resetForm();
        setEditDialogOpen(false);
        setEditingDataSource(null);
      } else {
        toast.error(data.error?.message || "Failed to update data source");
      }
    },
  });

  const handleDeleteClick = async (ds: DataSource) => {
    setDataSourceToDelete(ds);
    setUsageInfo(null);
    setDeleteDialogOpen(true);
    try {
      const res = await fetch(`/api/data-sources/${ds.id}/usage`);
      const data = await res.json();
      if (data.success) setUsageInfo(data.data);
    } catch {
      /* ignore */
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/data-sources/${id}`, { method: "DELETE" });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Data source deleted successfully");
        queryClient.invalidateQueries({ queryKey: ["data-sources"] });
        setDeleteDialogOpen(false);
        setDataSourceToDelete(null);
        setUsageInfo(null);
      } else {
        toast.error(data.error?.message || "Failed to delete data source");
      }
      setIsDeleting(false);
    },
    onError: () => {
      toast.error("Failed to delete data source");
      setIsDeleting(false);
    },
  });

  const inspectMutation = useMutation({
    mutationFn: async (dsId: string) => {
      const res = await fetch(`/api/data-sources/${dsId}/inspect`, { method: "POST" });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({
          error: { message: `HTTP ${res.status}` },
        }));
        throw new Error(
          errorData.error?.message || `Failed to inspect schema (HTTP ${res.status})`
        );
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success(
          `Schema imported successfully! Found ${data.data?.entities_count || 0} entities`
        );
        queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      } else {
        toast.error(data.error?.message || "Failed to inspect schema");
      }
      setInspectingDs(null);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : "Failed to inspect schema";
      toast.error(message);
      getLogger("client").event("client.ui.failed", { what: "Inspect error", detail: [message] });
      setInspectingDs(null);
    },
  });

  const sharedFileProps = {
    fileInputRef,
    uploading: uploadingFile,
    onFileSelect: handleFileSelect,
    onDragOver: handleDragOver,
    onDrop: handleDrop,
  };
  const testDisabled = isTestConnectionDisabled({ state: formState, testing: testingConnection });

  // ── CopilotKit ─────────────────────────────────────────────────────────
  useCopilotReadable({
    description: "Current data source connections configured in the system",
    value: (dataSources ?? []).map((ds) => ({
      id: ds.id,
      name: ds.name,
      type: ds.client_type,
      isActive: ds.is_active,
      isInspected: ds.is_inspected,
      lastInspectedAt: ds.last_inspected_at,
    })),
  });

  useCopilotAction({
    name: "openAddDataSourceForm",
    description:
      "Open the Add Data Source dialog, optionally pre-explaining what fields to fill in for a specific database type.",
    parameters: [
      {
        name: "dbType",
        type: "string",
        description:
          "Database type: pg (PostgreSQL), mysql (MySQL/MariaDB), mssql (SQL Server), sqlite3",
        required: false,
      },
      { name: "host", type: "string", description: "Database host", required: false },
      { name: "port", type: "string", description: "Database port", required: false },
      { name: "database", type: "string", description: "Database name", required: false },
      { name: "user", type: "string", description: "Database username", required: false },
    ],
    handler: async ({ dbType, host, port, database, user }) => {
      setCreateDialogOpen(true);
      if (dbType) {
        setFormState((prev) => ({
          ...prev,
          clientType: (dbType as ConnectionFormState["clientType"]) || prev.clientType,
          host: host || prev.host,
          port: port || prev.port,
          database: database || prev.database,
          user: user || prev.user,
        }));
      }
      return `Add Data Source dialog opened${dbType ? ` with type set to ${dbType}` : ""}. Fill in the remaining fields and click Save.`;
    },
  });
  useCopilotAction({
    name: "explainDatabaseSetup",
    description:
      "Explain what connection fields are required for a specific database type, and any tips for connecting.",
    parameters: [
      {
        name: "dbType",
        type: "string",
        description: "pg, mysql, mssql, or sqlite3",
        required: true,
      },
    ],
    handler: async ({ dbType }) => {
      const guides: Record<string, string> = {
        pg: "PostgreSQL: host (e.g. localhost), port (5432), database name, user, password. For cloud (Supabase, Neon, RDS), use the connection string option.",
        mysql:
          "MySQL/MariaDB: host, port (3306), database, user, password. Ensure the user has SELECT privileges on the target database.",
        mssql:
          "SQL Server: host, port (1433), database, user, password. Use Windows Auth by leaving user/password empty if server allows it.",
        sqlite3: "SQLite: upload the .db file using the file upload option. No host/user needed.",
      };
      return guides[dbType] || "Supported types: pg, mysql, mssql, sqlite3.";
    },
  });
  useCopilotAction({
    name: "inspectDataSource",
    description:
      "Trigger schema inspection for a data source to update table/column metadata used by SQL editor and NL query.",
    parameters: [
      {
        name: "dataSourceId",
        type: "string",
        description: "ID of the data source to inspect",
        required: true,
      },
    ],
    handler: async ({ dataSourceId }) => {
      setInspectingDs(dataSourceId);
      try {
        const res = await fetch(`/api/data-sources/${dataSourceId}/inspect`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          queryClient.invalidateQueries({ queryKey: ["data-sources"] });
          return `Schema inspection complete for data source ${dataSourceId}. Tables and columns are now updated.`;
        }
        return `Inspection failed: ${data.error?.message || "Unknown error"}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        setInspectingDs(null);
      }
    },
  });
  // ────────────────────────────────────────────────────────────────────────

  return (
    <CopilotSidebar
      onError={onCopilotError}
      instructions="You are a database connection assistant. Help users connect and manage data sources.\n\nWORKFLOW:\n1. When a user wants to add a data source, call explainDatabaseSetup to tell them what fields they need, then openAddDataSourceForm with the pre-filled values.\n2. After a data source is added, suggest running inspectDataSource to load schema metadata.\n3. Answer questions about connection troubleshooting (firewall rules, credentials, SSL, etc.).\n\nTIPS:\n- PostgreSQL default port: 5432\n- MySQL default port: 3306\n- SQL Server default port: 1433\n- For cloud databases, recommend using the connection string option."
      defaultOpen={false}
      labels={{
        title: "Data Source Assistant",
        initial:
          "I can help you connect a new database, troubleshoot connections, or explain what fields to fill in.",
        placeholder: "e.g. How do I connect a PostgreSQL database on AWS RDS?",
      }}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader
            title="Data Sources"
            description="Manage database connections for reports and queries"
          />

          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Data Source
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Add Data Source</DialogTitle>
                <DialogDescription>
                  Configure a new database connection for your reports.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <ConnectionFormFields
                  state={formState}
                  onChange={(patch) => setFormState((prev) => ({ ...prev, ...patch }))}
                  connectionTestResult={connectionTestResult}
                  idPrefix="create-"
                  {...sharedFileProps}
                />
              </div>
              <DialogFooter className="flex-col sm:flex-row gap-2">
                {connectionTestResult?.success && !formState.name && (
                  <div className="w-full flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/10 px-3 py-2 rounded-md">
                    <AlertCircle className="h-4 w-4" />
                    <span>
                      Connection verified! Please enter a Name above to enable the Create button.
                    </span>
                  </div>
                )}
                {connectionTestResult?.success && formState.name && (
                  <div className="w-full flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/10 px-3 py-2 rounded-md">
                    <Check className="h-4 w-4" />
                    <span>All set! Click Create to add your data source.</span>
                  </div>
                )}
                <div className="flex gap-2 w-full sm:w-auto">
                  <Button
                    variant="outline"
                    onClick={testConnection}
                    disabled={testDisabled}
                    className="flex-1 sm:flex-none"
                  >
                    {testingConnection && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Test Connection
                  </Button>
                  <Button
                    onClick={() => createMutation.mutate()}
                    disabled={
                      !formState.name || !connectionTestResult?.success || createMutation.isPending
                    }
                    className="flex-1 sm:flex-none"
                  >
                    {createMutation.isPending ? "Creating..." : "Create"}
                  </Button>
                </div>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Edit Data Source</DialogTitle>
                <DialogDescription>
                  Update the configuration for {editingDataSource?.name}.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <ConnectionFormFields
                  state={formState}
                  onChange={(patch) => setFormState((prev) => ({ ...prev, ...patch }))}
                  disableType
                  passwordPlaceholder="Leave empty to keep current"
                  connectionTestResult={connectionTestResult}
                  idPrefix="edit-"
                  {...sharedFileProps}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={testConnection} disabled={testDisabled}>
                  {testingConnection && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Test Connection
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditDialogOpen(false);
                    resetForm();
                    setEditingDataSource(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => updateMutation.mutate()}
                  disabled={!formState.name || updateMutation.isPending}
                >
                  {updateMutation.isPending ? "Updating..." : "Update"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Data Source</DialogTitle>
                <DialogDescription>
                  Are you sure you want to delete &ldquo;{dataSourceToDelete?.name}&rdquo;? This
                  action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                {usageInfo &&
                (usageInfo.queries > 0 || usageInfo.reports > 0 || usageInfo.charts > 0) ? (
                  <div className="p-4 rounded-md bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <h4 className="text-sm font-semibold text-red-800 dark:text-red-400">
                          Cannot Delete Data Source
                        </h4>
                        <p className="text-sm text-red-700 dark:text-red-400 mt-2">
                          This data source is currently in use:
                        </p>
                        <ul className="text-sm text-red-700 dark:text-red-400 mt-1 list-disc list-inside">
                          {usageInfo.queries > 0 && (
                            <li>
                              {usageInfo.queries} saved quer{usageInfo.queries === 1 ? "y" : "ies"}
                            </li>
                          )}
                          {usageInfo.reports > 0 && (
                            <li>
                              {usageInfo.reports} report{usageInfo.reports === 1 ? "" : "s"}
                            </li>
                          )}
                          {usageInfo.charts > 0 && (
                            <li>
                              {usageInfo.charts} chart{usageInfo.charts === 1 ? "" : "s"}
                            </li>
                          )}
                        </ul>
                        <p className="text-sm text-red-700 dark:text-red-400 mt-2">
                          Please delete or update these items first.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 rounded-md bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                          Warning
                        </h4>
                        <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                          This will soft delete the data source. It will be marked as deleted but
                          will remain in the database for audit purposes.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDeleteDialogOpen(false);
                    setDataSourceToDelete(null);
                    setUsageInfo(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (!dataSourceToDelete) return;
                    setIsDeleting(true);
                    deleteMutation.mutate(dataSourceToDelete.id);
                  }}
                  disabled={
                    !!(
                      usageInfo &&
                      (usageInfo.queries > 0 || usageInfo.reports > 0 || usageInfo.charts > 0)
                    ) || isDeleting
                  }
                >
                  {isDeleting ? "Deleting..." : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              All Data Sources
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading data sources...</div>
            ) : dataSources?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No data sources configured. Add your first data source to get started.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-[180px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dataSources?.map((ds) => (
                    <TableRow key={ds.id} className={ds.is_deleted ? "opacity-60" : ""}>
                      <TableCell className="font-medium">
                        {ds.name}
                        {!!ds.is_deleted && (
                          <Badge variant="destructive" className="ml-2 text-xs">
                            Deleted
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{ds.client_type}</Badge>
                      </TableCell>
                      <TableCell className="text-tremor-content">{ds.description || "-"}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={
                              ds.is_deleted ? "secondary" : ds.is_active ? "default" : "secondary"
                            }
                          >
                            {ds.is_deleted
                              ? "Inactive"
                              : ds.is_active
                                ? "Connected"
                                : "No Connection"}
                          </Badge>
                          {!!ds.is_inspected && !ds.is_deleted && (
                            <Badge
                              variant="outline"
                              className="text-emerald-600 border-emerald-600"
                            >
                              <Check className="h-3 w-3 mr-1" />
                              Inspected
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-tremor-content">
                        {formatDateTime(ds.created_at)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {!!ds.is_active && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setInspectingDs(ds.id);
                                inspectMutation.mutate(ds.id);
                              }}
                              disabled={inspectingDs === ds.id}
                              title="Import schema to enable entity metadata"
                              className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                            >
                              {inspectingDs === ds.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          {!!ds.is_active && (
                            <Link to="/metadata/entities" search={{ data_source_id: ds.id }}>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Manage Entity Metadata"
                                className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                              >
                                <Settings className="h-4 w-4" />
                              </Button>
                            </Link>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(ds)}
                            title="Edit data source"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteClick(ds)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            title="Delete data source"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </CopilotSidebar>
  );
}

function DataSourcesPage() {
  return (
    <CopilotKit runtimeUrl={copilotRuntimeUrl()} showDevConsole={false}>
      <DataSourcesContent />
    </CopilotKit>
  );
}
