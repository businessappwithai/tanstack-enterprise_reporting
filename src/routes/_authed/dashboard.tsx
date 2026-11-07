import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  Activity,
  BarChart3,
  Database,
  FileText,
  Filter,
  Layers,
  LayoutDashboard,
  MessageSquare,
  Play,
  Settings,
  Shield,
  SquareTerminal,
  Terminal,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BarList } from "@/components/ui/bar-list";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { Legend } from "@/components/ui/legend";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tracker, type TrackerColor } from "@/components/ui/tracker";
import { Text } from "@/components/ui/typography";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { getDb } from "@/lib/db/config";
import type { ResourceType } from "@/types/database";
import { getLogger } from "@/lib/logging/logger";

const getDashboardStatsFn = createServerFn({ method: "GET" }).handler(async () => {
  const db = getDb();

  const safeCount = async (tableName: string) => {
    try {
      // dynamic table name
      const result = await (db as any)
        .selectFrom(tableName)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirst();
      return Number((result as Record<string, unknown>)?.count || 0);
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes("no such table")) {
        return 0;
      }
      getLogger("client").note("error", `Error counting ${tableName}:`, { err: error });
      return 0;
    }
  };

  const getScheduledJobsCount = async () => {
    try {
      const result = await db
        .selectFrom("job_definitions")
        .where("schedule_cron", "is not", null)
        .select(db.fn.countAll().as("count"))
        .executeTakeFirst();
      return Number((result as Record<string, unknown>)?.count || 0);
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes("no such table")) {
        return 0;
      }
      getLogger("client").note("error", "Error counting scheduled jobs:", { err: error });
      return 0;
    }
  };

  /** Last 30 job runs, newest last — drives the Tremor tracker. */
  const getRecentExecutions = async () => {
    try {
      const rows = await db
        .selectFrom("job_executions")
        .select(["id", "status", "started_at", "completed_at", "created_at", "error_message"])
        .orderBy("created_at", "desc")
        .limit(30)
        .execute();
      return rows.reverse();
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes("no such table")) {
        return [];
      }
      getLogger("client").note("error", "Error loading recent executions:", { err: error });
      return [];
    }
  };

  const getRecentActivity = async () => {
    try {
      return await db
        .selectFrom("audit_log")
        .select(["id", "action", "resource_type", "resource_id", "created_at"])
        .orderBy("created_at", "desc")
        .limit(6)
        .execute();
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes("no such table")) {
        return [];
      }
      getLogger("client").note("error", "Error loading recent activity:", { err: error });
      return [];
    }
  };

  const [
    reports,
    charts,
    dashboards,
    queries,
    filters,
    dataSources,
    users,
    roles,
    scheduledJobs,
    recentExecutions,
    recentActivity,
  ] = await Promise.all([
    safeCount("report_definitions"),
    safeCount("chart_definitions"),
    safeCount("dashboard_layouts"),
    safeCount("saved_queries"),
    safeCount("filter_definitions"),
    safeCount("data_sources"),
    safeCount("users"),
    safeCount("roles"),
    getScheduledJobsCount(),
    getRecentExecutions(),
    getRecentActivity(),
  ]);

  return {
    reports,
    charts,
    dashboards,
    queries,
    filters,
    dataSources,
    users,
    roles,
    jobs: scheduledJobs,
    recentExecutions,
    recentActivity,
  };
});

export const Route = createFileRoute("/_authed/dashboard")({
  loader: () => getDashboardStatsFn(),
  component: DashboardPage,
});

/**
 * Every module the application exposes, with the permission that gates it.
 * `permissionKey: null` means the module is always available.
 */
const workspaceModules: Array<{
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
  permissionKey: ResourceType | null;
}> = [
  {
    title: "SQL Editor",
    description: "Write and execute SQL queries",
    href: "/sql-editor",
    icon: Terminal,
    permissionKey: "query",
  },
  {
    title: "Saved Queries",
    description: "Reuse queries you have saved",
    href: "/queries",
    icon: Database,
    permissionKey: "query",
  },
  {
    title: "Reports",
    description: "View and manage reports",
    href: "/reports",
    icon: FileText,
    permissionKey: "report",
  },
  {
    title: "Charts",
    description: "Create data visualisations",
    href: "/charts",
    icon: BarChart3,
    permissionKey: "chart",
  },
  {
    title: "Dashboards",
    description: "Build interactive dashboards",
    href: "/dashboards",
    icon: LayoutDashboard,
    permissionKey: "dashboard",
  },
  {
    title: "Filters",
    description: "Define reusable report filters",
    href: "/filters",
    icon: Filter,
    permissionKey: "filter",
  },
  {
    title: "Jobs",
    description: "Schedule and run background jobs",
    href: "/jobs",
    icon: Play,
    permissionKey: "job",
  },
  {
    title: "Monitoring",
    description: "Track thresholds and breaches",
    href: "/monitoring",
    icon: Activity,
    permissionKey: "monitoring_rule",
  },
  {
    title: "NL Query",
    description: "Ask questions in plain language",
    href: "/nl-query",
    icon: MessageSquare,
    permissionKey: "nl_query",
  },
  {
    title: "Report Generator",
    description: "Generate a report from a description",
    href: "/reports/generate",
    icon: FileText,
    permissionKey: "report",
  },
];

const adminModules: Array<{
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
  permissionKey: ResourceType | null;
}> = [
  {
    title: "Data Sources",
    description: "Manage database connections",
    href: "/data-sources",
    icon: Database,
    permissionKey: "data_source",
  },
  {
    title: "Queue Management",
    description: "Inspect the job queue",
    href: "/trigger-board",
    icon: Layers,
    permissionKey: "queue",
  },
  {
    title: "System Logs",
    description: "Review application logs",
    href: "/logs",
    icon: SquareTerminal,
    permissionKey: "log",
  },
  {
    title: "Users",
    description: "Manage user accounts",
    href: "/admin/users",
    icon: Users,
    permissionKey: "user",
  },
  {
    title: "Roles",
    description: "Manage roles and grants",
    href: "/admin/roles",
    icon: Shield,
    permissionKey: "role",
  },
  {
    title: "Permissions",
    description: "Review resource-level grants",
    href: "/admin/permissions",
    icon: Shield,
    permissionKey: "user",
  },
  {
    title: "Settings",
    description: "Configure the application",
    href: "/settings",
    icon: Settings,
    permissionKey: "setting",
  },
];

const executionColors: Record<string, TrackerColor> = {
  completed: "emerald",
  running: "blue",
  pending: "gray",
  cancelled: "amber",
  failed: "red",
};

const executionBadges: Record<string, "success" | "info" | "neutral" | "warning" | "error"> = {
  completed: "success",
  running: "info",
  pending: "neutral",
  cancelled: "warning",
  failed: "error",
};

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function DashboardPage() {
  const stats = Route.useLoaderData();
  const { session } = Route.useRouteContext();
  const { data: permissions, isLoading: permissionsLoading } = usePermissions();

  const isAdmin = permissions?.isAdmin ?? false;

  /**
   * Mirrors the sidebar's gating: admins see everything, otherwise a module is
   * shown when the user's role grants `<resource>:view` (or a wildcard).
   */
  const canView = (permissionKey: ResourceType | null) => {
    if (permissionKey === null) return true;
    if (!permissions) return false;
    if (isAdmin) return true;
    return permissions.rolePermissions.some(
      (perm) => perm === `${permissionKey}:view` || perm === `${permissionKey}:*` || perm === "*:*"
    );
  };

  const visibleModules = workspaceModules.filter((module) => canView(module.permissionKey));
  const visibleAdminModules = adminModules.filter((module) => canView(module.permissionKey));

  // KPI tiles are themselves permission-gated — no counting what you cannot open.
  const kpis = [
    { label: "Reports", value: stats.reports, href: "/reports", icon: FileText, key: "report" },
    { label: "Charts", value: stats.charts, href: "/charts", icon: BarChart3, key: "chart" },
    {
      label: "Dashboards",
      value: stats.dashboards,
      href: "/dashboards",
      icon: LayoutDashboard,
      key: "dashboard",
    },
    { label: "Scheduled jobs", value: stats.jobs, href: "/jobs", icon: Play, key: "job" },
  ].filter((kpi) => canView(kpi.key as ResourceType));

  const contentBreakdown = [
    { name: "Reports", value: stats.reports, icon: FileText, key: "report" },
    { name: "Charts", value: stats.charts, icon: BarChart3, key: "chart" },
    { name: "Dashboards", value: stats.dashboards, icon: LayoutDashboard, key: "dashboard" },
    { name: "Saved queries", value: stats.queries, icon: Database, key: "query" },
    { name: "Filters", value: stats.filters, icon: Filter, key: "filter" },
  ].filter((item) => canView(item.key as ResourceType));

  const trackerData = stats.recentExecutions.map((execution) => ({
    key: execution.id,
    color: executionColors[execution.status] ?? "gray",
    tooltip: `${execution.status} · ${formatDateTime(execution.started_at ?? execution.created_at)}`,
  }));

  const failedRuns = stats.recentExecutions.filter((e) => e.status === "failed").length;
  const totalRuns = stats.recentExecutions.length;
  const successRate =
    totalRuns > 0
      ? Math.round(
          (stats.recentExecutions.filter((e) => e.status === "completed").length / totalRuns) * 100
        )
      : null;

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-semibold text-2xl text-tremor-content-strong">Dashboard</h1>
          <Text>
            Welcome to the Enterprise Reporting System
            {session?.user?.email ? ` — ${session.user.email}` : ""}
          </Text>
        </div>
        {permissionsLoading ? null : (
          <Badge variant={isAdmin ? "default" : "neutral"}>
            {isAdmin ? "Administrator" : "Standard access"}
          </Badge>
        )}
      </div>

      {/* ── KPIs ────────────────────────────────────────────────────────────── */}
      {kpis.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {kpis.map((kpi) => (
            <Link key={kpi.label} to={kpi.href} className="block">
              <KpiCard
                label={kpi.label}
                value={kpi.value.toLocaleString()}
                icon={kpi.icon}
                className="h-full transition-shadow hover:shadow-tremor-dropdown"
              />
            </Link>
          ))}
        </div>
      ) : null}

      {/* ── Job health + content breakdown ──────────────────────────────────── */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {canView("job") ? (
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>Job runs</CardTitle>
                  <CardDescription>
                    {totalRuns > 0
                      ? `Last ${totalRuns} execution${totalRuns === 1 ? "" : "s"}`
                      : "No job executions recorded yet"}
                  </CardDescription>
                </div>
                {successRate !== null ? (
                  <Badge variant={failedRuns > 0 ? "warning" : "success"}>
                    {successRate}% succeeded
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {totalRuns > 0 ? (
                <>
                  <Tracker data={trackerData} />
                  <Legend
                    categories={["Succeeded", "Running", "Cancelled", "Failed"]}
                    colors={["#10b981", "#3b82f6", "#f59e0b", "#ef4444"]}
                  />
                </>
              ) : (
                <Text>Schedule a job to start collecting run history.</Text>
              )}
            </CardContent>
          </Card>
        ) : null}

        {contentBreakdown.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Content by type</CardTitle>
              <CardDescription>What exists in your workspace today</CardDescription>
            </CardHeader>
            <CardContent>
              {contentBreakdown.some((item) => item.value > 0) ? (
                <BarList data={contentBreakdown} />
              ) : (
                <Text>Nothing created yet — start from a module below.</Text>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      {/* ── Accessible modules ──────────────────────────────────────────────── */}
      <div>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="font-medium text-tremor-title text-tremor-content-strong">
            Your workspace
          </h2>
          <span className="text-tremor-label text-tremor-content">
            {permissionsLoading
              ? "Checking permissions…"
              : `${visibleModules.length} of ${workspaceModules.length} modules available`}
          </span>
        </div>
        {permissionsLoading ? (
          <Text>Loading your access…</Text>
        ) : visibleModules.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleModules.map((module) => (
              <Link key={module.href} to={module.href} className="block">
                <Card className="h-full transition-shadow hover:shadow-tremor-dropdown">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <module.icon className="h-4 w-4 shrink-0 text-tremor-brand" />
                      <CardTitle className="text-tremor-default">{module.title}</CardTitle>
                    </div>
                    <CardDescription>{module.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-6">
              <Text>
                No modules are available to your account yet. Ask an administrator to grant access.
              </Text>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Administration (permission-gated) ───────────────────────────────── */}
      {visibleAdminModules.length > 0 ? (
        <div>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="font-medium text-tremor-title text-tremor-content-strong">
              Administration
            </h2>
            {isAdmin ? (
              <span className="text-tremor-label text-tremor-content">
                {stats.users.toLocaleString()} users · {stats.roles.toLocaleString()} roles ·{" "}
                {stats.dataSources.toLocaleString()} data sources
              </span>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleAdminModules.map((module) => (
              <Link key={module.href} to={module.href} className="block">
                <Card className="h-full transition-shadow hover:shadow-tremor-dropdown">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <module.icon className="h-4 w-4 shrink-0 text-tremor-content-subtle" />
                      <CardTitle className="text-tremor-default">{module.title}</CardTitle>
                    </div>
                    <CardDescription>{module.description}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Recent activity ─────────────────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {canView("job") ? (
          <Card>
            <CardHeader>
              <CardTitle>Recent job executions</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {stats.recentExecutions.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                      <TableHead>Finished</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...stats.recentExecutions]
                      .reverse()
                      .slice(0, 6)
                      .map((execution) => (
                        <TableRow key={execution.id}>
                          <TableCell>
                            <Badge variant={executionBadges[execution.status] ?? "neutral"}>
                              {execution.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {formatDateTime(execution.started_at ?? execution.created_at)}
                          </TableCell>
                          <TableCell>{formatDateTime(execution.completed_at)}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="p-6">
                  <Text>No recent job executions</Text>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {stats.recentActivity.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.recentActivity.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium text-tremor-content-strong">
                        {entry.action}
                      </TableCell>
                      <TableCell>{entry.resource_type}</TableCell>
                      <TableCell>{formatDateTime(entry.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-6">
                <Text>No recent activity</Text>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
