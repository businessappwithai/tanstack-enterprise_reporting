import { Link, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Filter,
  Home,
  Layers,
  LayoutDashboard,
  SquareTerminal,
  MessageSquare,
  Play,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanView, usePermissions } from "@/lib/hooks/usePermissions";
import { cn } from "@/lib/utils";

interface SidebarProps {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}

const mainNavItems = [
  { href: "/", label: "Dashboard", icon: Home, permissionKey: null },
  { href: "/sql-editor", label: "SQL Editor", icon: Terminal, permissionKey: "query" as const },
  { href: "/queries", label: "Saved Queries", icon: Database, permissionKey: "query" as const },
  { href: "/reports", label: "Reports", icon: FileText, permissionKey: "report" as const },
  { href: "/charts", label: "Charts", icon: BarChart3, permissionKey: "chart" as const },
  {
    href: "/dashboards",
    label: "Dashboards",
    icon: LayoutDashboard,
    permissionKey: "dashboard" as const,
  },
  { href: "/filters", label: "Filters", icon: Filter, permissionKey: "filter" as const },
  { href: "/jobs", label: "Jobs", icon: Play, permissionKey: "job" as const },
  {
    href: "/monitoring",
    label: "Monitoring",
    icon: Activity,
    permissionKey: "monitoring_rule" as const,
  },
  { href: "/nl-query", label: "NL Query", icon: MessageSquare, permissionKey: "nl_query" as const },
  {
    href: "/intelligent-ui",
    label: "Intelligent UI",
    icon: Sparkles,
    permissionKey: "nl_query" as const,
  },
  {
    href: "/reports/generate",
    label: "Report Generator",
    icon: FileText,
    permissionKey: "report" as const,
  },
];

const adminNavItems = [
  {
    href: "/data-sources",
    label: "Data Sources",
    icon: Database,
    permissionKey: "data_source" as const,
  },
  { href: "/trigger-board", label: "Trigger Board", icon: Layers, permissionKey: "queue" as const },
  { href: "/logs", label: "System Logs", icon: SquareTerminal, permissionKey: "log" as const },
  { href: "/admin/users", label: "Users", icon: Users, permissionKey: "user" as const },
  { href: "/admin/roles", label: "Roles", icon: Shield, permissionKey: "role" as const },
  {
    href: "/admin/permissions",
    label: "Permissions",
    icon: Shield,
    permissionKey: "user" as const,
  },
  { href: "/settings", label: "Settings", icon: Settings, permissionKey: "setting" as const },
];

export function Sidebar({ collapsed, onCollapse }: SidebarProps) {
  // Suppress hydration mismatch - don't use router state on server
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const routerState = useRouterState();
  const pathname = isMounted ? routerState.location.pathname : "/";

  const { data: permissions } = usePermissions();
  const canViewQuery = useCanView("query");
  const canViewReport = useCanView("report");
  const canViewChart = useCanView("chart");
  const canViewDashboard = useCanView("dashboard");
  const canViewFilter = useCanView("filter");
  const canViewJob = useCanView("job");
  const canViewDataSource = useCanView("data_source");
  const canViewQueue = useCanView("queue");
  const canViewUser = useCanView("user");
  const canViewRole = useCanView("role");
  const canViewNlQuery = useCanView("nl_query");
  const canViewMonitoring = useCanView("monitoring_rule");
  const canViewLog = useCanView("log");
  const canViewSetting = useCanView("setting");

  // Derive isAdmin directly from permissions to avoid duplicate queries
  const isAdminUser = permissions?.isAdmin ?? false;

  const canView = (permissionKey: string | null) => {
    // Always show items with no permission requirement
    if (permissionKey === null) return true;

    // When permissions are still loading, hide permission-required items
    if (permissions === undefined) return false;

    // Admin users can see everything
    if (isAdminUser) return true;

    // Check specific permission types
    switch (permissionKey) {
      case "query":
        return canViewQuery;
      case "report":
        return canViewReport;
      case "chart":
        return canViewChart;
      case "dashboard":
        return canViewDashboard;
      case "filter":
        return canViewFilter;
      case "job":
        return canViewJob;
      case "data_source":
        return canViewDataSource;
      case "queue":
        return canViewQueue;
      case "user":
        return canViewUser;
      case "role":
        return canViewRole;
      case "nl_query":
        return canViewNlQuery;
      case "monitoring_rule":
        return canViewMonitoring;
      case "log":
        return canViewLog;
      case "setting":
        return canViewSetting;
      default:
        return false;
    }
  };

  // A role that holds none of the administration permissions gets no Administration section at
  // all: a heading with nothing under it reads as a menu that failed to load.
  const visibleAdminNavItems = adminNavItems.filter((item) => canView(item.permissionKey));

  const NavItem = ({
    href,
    label,
    icon: Icon,
  }: {
    href: string;
    label: string;
    icon: React.ElementType;
  }) => {
    const isActive = pathname === href || pathname.startsWith(`${href}/`);

    const content = (
      <Link to={href}>
        <Button
          variant="ghost"
          className={cn(
            // Tremor navigation item: brand-faint surface + brand label when active
            "h-9 w-full justify-start rounded-tremor-small text-tremor-default font-medium",
            isActive
              ? "bg-tremor-brand-faint text-tremor-brand hover:bg-tremor-brand-faint"
              : "text-tremor-content hover:bg-tremor-background-subtle hover:text-tremor-content-emphasis",
            collapsed && "justify-center px-2"
          )}
        >
          <Icon className={cn("h-4 w-4 shrink-0", !collapsed && "mr-2")} />
          {!collapsed && <span className="truncate">{label}</span>}
        </Button>
      </Link>
    );

    if (collapsed) {
      return (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>{content}</TooltipTrigger>
          <TooltipContent side="right">
            <p>{label}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    return content;
  };

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 h-screen border-r border-tremor-border bg-tremor-background transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      <div className="flex h-14 items-center justify-between border-b border-tremor-border px-4">
        {!collapsed && (
          <Link to="/" className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-tremor-brand" />
            <span className="text-tremor-default font-medium text-tremor-content-strong">
              Enterprise Reports
            </span>
          </Link>
        )}
        {collapsed && (
          <Link to="/" className="mx-auto">
            <BarChart3 className="h-5 w-5 text-tremor-brand" />
          </Link>
        )}
      </div>

      <ScrollArea className="h-[calc(100vh-3.5rem)]">
        <div className="space-y-1 py-4">
          <div className="px-3 py-1">
            {!collapsed && (
              <h2 className="mb-2 px-2 text-tremor-label font-medium uppercase tracking-wide text-tremor-content-subtle">
                Main
              </h2>
            )}
            <nav className="space-y-0.5 px-2">
              {mainNavItems
                .filter((item) => canView(item.permissionKey))
                .map((item) => (
                  <NavItem key={item.href} {...item} />
                ))}
            </nav>
          </div>

          {visibleAdminNavItems.length > 0 && (
            <>
              <Separator className="my-2" />

              <div className="px-3 py-1">
                {!collapsed && (
                  <h2 className="mb-2 px-2 text-tremor-label font-medium uppercase tracking-wide text-tremor-content-subtle">
                    Administration
                  </h2>
                )}
                <nav className="space-y-0.5 px-2">
                  {visibleAdminNavItems.map((item) => (
                    <NavItem key={item.href} {...item} />
                  ))}
                </nav>
              </div>
            </>
          )}
        </div>
      </ScrollArea>

      <Button
        variant="ghost"
        size="icon"
        className="absolute -right-3 top-16 h-6 w-6 rounded-tremor-full border border-tremor-border bg-tremor-background p-0 text-tremor-content shadow-tremor-input hover:bg-tremor-background-muted"
        onClick={() => onCollapse(!collapsed)}
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </Button>
    </aside>
  );
}
