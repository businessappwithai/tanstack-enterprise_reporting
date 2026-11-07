import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { chartTypeSchema } from "@/lib/schemas/charts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AreaChart,
  BarChart3,
  Edit,
  Eye,
  LineChart,
  MoreHorizontal,
  PieChart,
  Plus,
  Trash,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CopilotKit } from "@copilotkit/react-core";
import { copilotRuntimeUrl, onCopilotError } from "@/lib/copilot/runtime-url";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { nlBuildPreview, nlSaveChart, nlBuilderListDataSources } from "@/server-fns/admin-builder";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCanCreate, useCanDelete, useCanEdit } from "@/lib/hooks/usePermissions";
import { formatDateTime } from "@/lib/utils";
import type { ChartDefinition, ChartType, SavedQuery } from "@/types/database";
import { PageHeader } from "@/components/layout/page-header";

export const Route = createFileRoute("/_authed/charts/")({
  component: ChartsPage,
});

function ChartsPage() {
  return (
    <CopilotKit runtimeUrl={copilotRuntimeUrl()} showDevConsole={false}>
      <ChartsContent />
    </CopilotKit>
  );
}

function ChartsContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newChartName, setNewChartName] = useState("");
  const [newChartType, setNewChartType] = useState<ChartType>("bar");
  const [selectedQueryId, setSelectedQueryId] = useState("");

  const canCreateChart = useCanCreate("chart");
  const canEditCharts = useCanEdit("chart");
  const canDeleteCharts = useCanDelete("chart");

  const chartTypeIcons = useMemo<Record<ChartType, React.ReactNode>>(
    () => ({
      bar: <BarChart3 className="h-4 w-4" />,
      line: <LineChart className="h-4 w-4" />,
      area: <AreaChart className="h-4 w-4" />,
      pie: <PieChart className="h-4 w-4" />,
      scatter: <BarChart3 className="h-4 w-4" />,
      composed: <BarChart3 className="h-4 w-4" />,
      column: <BarChart3 className="h-4 w-4" />,
      doughnut: <PieChart className="h-4 w-4" />,
    }),
    []
  );

  const { data: charts, isLoading } = useQuery<ChartDefinition[]>({
    queryKey: ["charts"],
    queryFn: async () => {
      const res = await fetch("/api/charts");
      const data = await res.json();
      return data.data?.items || [];
    },
  });

  const { data: queries } = useQuery<SavedQuery[]>({
    queryKey: ["queries"],
    queryFn: async () => {
      const res = await fetch("/api/queries");
      const data = await res.json();
      return data.data?.items || [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/charts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newChartName,
          chart_type: newChartType,
          saved_query_id: selectedQueryId || undefined,
          chart_config: { legend: { show: true }, tooltip: { enabled: true } },
          data_mapping: { xAxis: { field: "" }, yAxis: [] },
        }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Chart created successfully");
        queryClient.invalidateQueries({ queryKey: ["charts"] });
        setCreateDialogOpen(false);
        setNewChartName("");
        setNewChartType("bar");
        setSelectedQueryId("");
        navigate({ to: "/charts/editor/$id", params: { id: data.data.id } });
      } else {
        toast.error(data.error?.message || "Failed to create chart");
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/charts/${id}`, { method: "DELETE" });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Chart deleted successfully");
        queryClient.invalidateQueries({ queryKey: ["charts"] });
      } else {
        toast.error(data.error?.message || "Failed to delete chart");
      }
    },
  });

  // ── CopilotKit context ────────────────────────────────────────────────────
  const { data: dataSources } = useQuery({
    queryKey: ["data-sources-for-nl"],
    queryFn: () => nlBuilderListDataSources(),
  });

  useCopilotReadable({
    description: "Available data sources the AI can query to build charts",
    value: (dataSources ?? []).map((ds) => ({ id: ds.id, name: ds.name, type: ds.client_type })),
  });
  useCopilotReadable({
    description: "Existing chart definitions",
    value: (charts ?? []).map((c) => ({ id: c.id, name: c.name, chartType: c.chart_type })),
  });

  useCopilotAction({
    name: "createChartFromNL",
    description:
      "Generate SQL from a natural language description, preview data, then save it as a chart definition. Use when the user describes a visualization they want.",
    parameters: [
      {
        name: "chartName",
        type: "string",
        description: "Short title for the chart",
        required: true,
      },
      {
        name: "description",
        type: "string",
        description: "What data the chart should visualize",
        required: true,
      },
      {
        name: "dataSourceId",
        type: "string",
        description: "UUID of the data source from available list",
        required: true,
      },
      {
        name: "chartType",
        type: "string",
        description: "Chart type: bar, line, area, pie, scatter, or composed",
        required: false,
      },
    ],
    handler: async ({ chartName, description, dataSourceId, chartType }) => {
      const type = (chartType ?? "bar") as z.infer<typeof chartTypeSchema>;
      const preview = await nlBuildPreview({ data: { nlDescription: description, dataSourceId } });
      if (!preview.success) return { success: false, error: preview.error };

      const result = await nlSaveChart({
        data: { name: chartName, description, dataSourceId, sql: preview.sql!, chartType: type },
      });
      queryClient.invalidateQueries({ queryKey: ["charts"] });
      toast.success(`Chart "${chartName}" created`);
      navigate({ to: "/charts/editor/$id", params: { id: result.chartId } });
      return {
        success: true,
        message: `Chart "${chartName}" (${type}) created. Preview shows ${preview.rows?.length ?? 0} rows. Opening the chart editor so you can configure axes and styling.`,
        chartId: result.chartId,
        columns: preview.columns,
        rowCount: preview.rows?.length ?? 0,
      };
    },
  });

  useCopilotAction({
    name: "openChartEditor",
    description: "Open the chart editor for an existing chart by ID.",
    parameters: [
      { name: "chartId", type: "string", description: "The chart ID to edit", required: true },
    ],
    handler: async ({ chartId }) => {
      navigate({ to: "/charts/editor/$id", params: { id: chartId } });
      return { success: true, message: `Opened chart editor for ${chartId}` };
    },
  });
  // ─────────────────────────────────────────────────────────────────────────

  const CHARTS_AI_INSTRUCTIONS = `You are an AI chart builder assistant for an enterprise reporting platform.

WORKFLOW:
1. When the user describes a chart they want, call createChartFromNL with a name, description of the data, a dataSourceId from the list, and an appropriate chartType.
2. Check available data sources from context before choosing one.
3. After creating the chart, the editor will open automatically for axis/styling configuration.
4. If the user asks to edit an existing chart, call openChartEditor with its ID.

CHART TYPE GUIDANCE:
- Bar chart: comparisons between categories (sales by region, users by plan)
- Line chart: trends over time (revenue per month, signups per week)
- Area chart: cumulative trends (total revenue over time)
- Pie chart: proportions/shares (market share, budget breakdown) — works best with <10 slices
- Scatter: correlation between two numeric variables

RULES:
- Ask for clarification if the description is vague.
- Confirm the chart type with the user if it's not obvious from their description.
- Never fabricate data source IDs — always pick from the available list.`;

  return (
    <CopilotSidebar
      onError={onCopilotError}
      instructions={CHARTS_AI_INSTRUCTIONS}
      defaultOpen={false}
      labels={{
        title: "Chart Builder AI",
        initial: "Describe the chart you want and I'll generate the SQL and create it for you.",
        placeholder: "e.g. Bar chart of monthly revenue by product category…",
      }}
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <PageHeader title="Charts" description="Create and manage data visualizations" />

          <div className="flex gap-2">
            {canCreateChart && (
              <Link to="/charts/editor/$id" params={{ id: "new" }}>
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Open Chart Editor
                </Button>
              </Link>
            )}
            {canCreateChart && (
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">
                    <Plus className="h-4 w-4 mr-2" />
                    Quick Create
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Chart</DialogTitle>
                    <DialogDescription>
                      Create a new chart visualization from a saved query.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label htmlFor="name">Name</Label>
                      <Input
                        id="name"
                        value={newChartName}
                        onChange={(e) => setNewChartName(e.target.value)}
                        placeholder="My Chart"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="type">Chart Type</Label>
                      <Select
                        value={newChartType}
                        onValueChange={(v) => setNewChartType(v as ChartType)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="bar">Bar Chart</SelectItem>
                          <SelectItem value="line">Line Chart</SelectItem>
                          <SelectItem value="area">Area Chart</SelectItem>
                          <SelectItem value="pie">Pie Chart</SelectItem>
                          <SelectItem value="scatter">Scatter Plot</SelectItem>
                          <SelectItem value="composed">Composed Chart</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="query">Data Source Query</Label>
                      <Select value={selectedQueryId} onValueChange={setSelectedQueryId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a query" />
                        </SelectTrigger>
                        <SelectContent>
                          {queries?.map((query) => (
                            <SelectItem key={query.id} value={query.id}>
                              {query.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      onClick={() => createMutation.mutate()}
                      disabled={!newChartName || createMutation.isPending}
                    >
                      {createMutation.isPending ? "Creating..." : "Create Chart"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              All Charts
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading charts...</div>
            ) : charts?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No charts created yet. Create your first chart to get started.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Query</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {charts?.map((chart) => (
                    <TableRow key={chart.id}>
                      <TableCell className="font-medium">{chart.name}</TableCell>
                      <TableCell>
                        {chart.saved_query_id ? (
                          <Badge variant="secondary">Linked</Badge>
                        ) : (
                          <Badge variant="outline">No Query</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-tremor-content">
                        {formatDateTime(chart.created_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="flex items-center gap-1 w-fit">
                          {chartTypeIcons[chart.chart_type]}
                          {chart.chart_type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link to="/charts/viewer/$id" params={{ id: chart.id }}>
                                <Eye className="h-4 w-4 mr-2" />
                                View
                              </Link>
                            </DropdownMenuItem>
                            {canEditCharts && (
                              <DropdownMenuItem asChild>
                                <Link to="/charts/editor/$id" params={{ id: chart.id }}>
                                  <Edit className="h-4 w-4 mr-2" />
                                  Edit
                                </Link>
                              </DropdownMenuItem>
                            )}
                            {canDeleteCharts && (
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => deleteMutation.mutate(chart.id)}
                              >
                                <Trash className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
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
