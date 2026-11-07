"use client";

import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Info,
  AlertTriangle,
} from "lucide-react";
import { useCallback, useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getLogger } from "@/lib/logging/logger";

interface Log {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  component: string;
  user_id?: string;
  user_email?: string;
  metadata?: string | Record<string, unknown>;
  error_stack?: string;
}

const PAGE_SIZE = 50;

export function LogsViewer() {
  const [page, setPage] = useState(0);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [componentFilter, setComponentFilter] = useState<string | null>(null);
  const [userFilter, setUserFilter] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [requestIdFilter, setRequestIdFilter] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; email: string }>>([]);
  const [components, setComponents] = useState<string[]>([]);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["logs", page, levelFilter, componentFilter, userFilter, categoryFilter, requestIdFilter],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: PAGE_SIZE.toString(),
        offset: (page * PAGE_SIZE).toString(),
      });

      if (levelFilter) params.append("level", levelFilter);
      if (componentFilter) params.append("component", componentFilter);
      if (userFilter) params.append("userId", userFilter);
      if (categoryFilter) params.append("category", categoryFilter);
      if (requestIdFilter.trim()) params.append("requestId", requestIdFilter.trim());

      const res = await fetch(`/api/logs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load logs`);
      const data = await res.json();
      return data.data;
    },
    staleTime: 5000,
    refetchInterval: 10000,
  });

  // Fetch unique users and components for filter dropdowns
  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const [usersRes, componentsRes] = await Promise.all([
          fetch("/api/logs/users"),
          fetch("/api/logs/components"),
        ]);
        if (usersRes.ok) {
          const data = await usersRes.json();
          setUsers(data.data || []);
        }
        if (componentsRes.ok) {
          const data = await componentsRes.json();
          setComponents(data.data || []);
        }
      } catch (error) {
        getLogger("client").event("client.ui.failed", { what: "Failed to fetch filters", err: error });
      }
    };
    fetchFilters();
  }, []);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const getLevelIcon = (level: string) => {
    switch (level) {
      case "error":
        return <AlertCircle className="h-4 w-4 text-red-600" />;
      case "warn":
        return <AlertTriangle className="h-4 w-4 text-amber-600" />;
      case "info":
        return <Info className="h-4 w-4 text-blue-600" />;
      default:
        return <Info className="h-4 w-4 text-gray-600" />;
    }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "error":
        return "bg-red-50 dark:bg-red-900/20";
      case "warn":
        return "bg-amber-50 dark:bg-amber-900/20";
      case "info":
        return "bg-blue-50 dark:bg-blue-900/20";
      default:
        return "bg-gray-50 dark:bg-gray-900/20";
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <p className="text-xs text-muted-foreground">
        You see your own entries and the system&apos;s warnings and errors. Entering a reference
        from an error shows what became of that request. Administrators see everyone&apos;s.
      </p>
      <div className="flex gap-2 items-center flex-wrap">
        <Select
          value={levelFilter || "all"}
          onValueChange={(v) => {
            setLevelFilter(v === "all" ? null : v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Filter by level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="warn">Warning</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={categoryFilter || "all"}
          onValueChange={(v) => {
            setCategoryFilter(v === "all" ? null : v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Filter by kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {[
              "validation",
              "authentication",
              "authorization",
              "not_found",
              "conflict",
              "business_rule",
              "workflow",
              "rate_limit",
              "integration",
              "database",
              "configuration",
              "internal",
            ].map((category) => (
              <SelectItem key={category} value={category}>
                {category.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-64"
          placeholder="Reference from an error"
          aria-label="Find a request by its reference"
          value={requestIdFilter}
          onChange={(e) => {
            setRequestIdFilter(e.target.value);
            setPage(0);
          }}
        />

        {components.length > 0 && (
          <Select
            value={componentFilter || "all"}
            onValueChange={(v) => {
              setComponentFilter(v === "all" ? null : v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by component" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All components</SelectItem>
              {components.map((component) => (
                <SelectItem key={component} value={component}>
                  {component}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {users.length > 0 && (
          <Select
            value={userFilter || "all"}
            onValueChange={(v) => {
              setUserFilter(v === "all" ? null : v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by user" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All users</SelectItem>
              {users.map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  {user.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isLoading}
          className="gap-2"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="max-h-96 overflow-auto">
          <Table>
            <TableHeader className="bg-muted sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-12">Level</TableHead>
                <TableHead className="w-32">Timestamp</TableHead>
                <TableHead className="w-40">User</TableHead>
                <TableHead className="w-40">Component</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    Loading logs...
                  </TableCell>
                </TableRow>
              ) : !data?.logs || data.logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                    No logs found
                  </TableCell>
                </TableRow>
              ) : (
                data.logs.map((log: Log) => (
                  <TableRow key={log.id} className={getLevelColor(log.level)}>
                    <TableCell className="w-12">
                      <div title={log.level}>{getLevelIcon(log.level)}</div>
                    </TableCell>
                    <TableCell className="w-40 text-xs font-mono">
                      {new Date(log.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell className="w-40 text-sm">
                      <Badge variant="outline" className="text-xs">
                        {log.user_email || "system"}
                      </Badge>
                    </TableCell>
                    <TableCell className="w-40 text-sm">
                      <Badge variant="outline" className="text-xs">
                        {log.component}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm flex-1">
                      <div className="space-y-1">
                        <div className="font-medium">{log.message}</div>
                        {(() => {
                          let parsedMetadata: Record<string, unknown> | null = null;
                          try {
                            if (typeof log.metadata === "string") {
                              parsedMetadata = JSON.parse(log.metadata);
                            } else if (typeof log.metadata === "object") {
                              parsedMetadata = log.metadata;
                            }
                          } catch (e) {
                            parsedMetadata = null;
                          }

                          return (
                            <>
                              {parsedMetadata?.sql && (
                                <details className="mt-1" open>
                                  <summary className="text-xs text-violet-600 dark:text-violet-400 cursor-pointer font-medium">
                                    SQL Query
                                  </summary>
                                  <pre className="text-xs bg-violet-50 dark:bg-violet-900/20 p-2 rounded mt-1 overflow-auto max-h-40 border border-violet-200 dark:border-violet-800">
                                    {parsedMetadata.sql as string}
                                  </pre>
                                </details>
                              )}
                              {parsedMetadata && (
                                <details className="mt-1">
                                  <summary className="text-xs text-blue-600 dark:text-blue-400 cursor-pointer">
                                    Metadata
                                  </summary>
                                  <pre className="text-xs bg-black/5 dark:bg-white/5 p-2 rounded mt-1 overflow-auto max-h-32">
                                    {JSON.stringify(
                                      Object.fromEntries(
                                        Object.entries(parsedMetadata).filter(
                                          ([key]) => key !== "sql"
                                        )
                                      ),
                                      null,
                                      2
                                    )}
                                  </pre>
                                </details>
                              )}
                            </>
                          );
                        })()}
                        {log.error_stack && (
                          <details className="mt-1">
                            <summary className="text-xs text-red-600 dark:text-red-400 cursor-pointer">
                              Stack trace
                            </summary>
                            <pre className="text-xs bg-black/5 dark:bg-white/5 p-2 rounded mt-1 overflow-auto max-h-32">
                              {log.error_stack}
                            </pre>
                          </details>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Pagination */}
      {data?.pagination && (
        <div className="flex items-center justify-between">
          <div className="text-tremor-default text-tremor-content">
            Page {page + 1} • {data.pagination.totalCount} total logs
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={!data.pagination.hasMore}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
