import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Key, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
} from "@/components/ui/dialog";
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
import type { PermissionLevel, ResourceType } from "@/types/database";
import { PageHeader } from "@/components/layout/page-header";
import { getLogger } from "@/lib/logging/logger";

const RESOURCE_TYPES: { value: ResourceType; label: string }[] = [
  { value: "dashboard", label: "Dashboard" },
  { value: "chart", label: "Chart" },
  { value: "report", label: "Report" },
  { value: "query", label: "Query" },
  { value: "data_source", label: "Data Source" },
  { value: "filter", label: "Filter" },
  { value: "job", label: "Job" },
];

const PERMISSION_LEVELS: { value: PermissionLevel; label: string; description: string }[] = [
  { value: "view", label: "View", description: "Can only view the resource" },
  { value: "execute", label: "Execute", description: "Can execute/run the resource" },
  { value: "edit", label: "Edit", description: "Can modify the resource" },
  { value: "admin", label: "Admin", description: "Full control including delete" },
];

interface Permission {
  id: string;
  resource_type: ResourceType;
  resource_id: string;
  role_id: string;
  role_name: string;
  permission_level: PermissionLevel;
  created_at: string;
}

interface Role {
  id: string;
  name: string;
  description?: string;
}

interface Resource {
  id: string;
  name: string;
}

export const Route = createFileRoute("/_authed/admin/permissions/")({
  component: PermissionsManagementPage,
});

function PermissionsManagementPage() {
  const queryClient = useQueryClient();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType>("dashboard");
  const [selectedResourceId, setSelectedResourceId] = useState<string>("");
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [selectedPermissionLevel, setSelectedPermissionLevel] = useState<PermissionLevel>("view");

  // Fetch permissions
  const { data: permissions, isLoading: isLoadingPermissions } = useQuery<Permission[]>({
    queryKey: ["admin-permissions"],
    queryFn: async () => {
      const res = await fetch("/api/admin/permissions");
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load permissions`);
      const data = await res.json();
      return data.data || [];
    },
  });

  // Fetch roles
  const { data: roles } = useQuery<Role[]>({
    queryKey: ["roles"],
    queryFn: async () => {
      const res = await fetch("/api/admin/roles");
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load roles`);
      const data = await res.json();
      return data.data || [];
    },
  });

  // Fetch resources based on type
  const { data: resources = [], isLoading: isLoadingResources } = useQuery<Resource[]>({
    queryKey: ["resources", selectedResourceType],
    queryFn: async () => {
      const endpoint =
        selectedResourceType === "data_source"
          ? "/api/data-sources"
          : selectedResourceType === "query"
            ? "/api/queries"
            : selectedResourceType === "dashboard"
              ? "/api/dashboards"
              : selectedResourceType === "chart"
                ? "/api/charts"
                : selectedResourceType === "report"
                  ? "/api/reports"
                  : selectedResourceType === "filter"
                    ? "/api/filters"
                    : selectedResourceType === "job"
                      ? "/api/jobs"
                      : null;

      if (!endpoint) return [];

      try {
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load resources`);
        const data = await res.json();
        // Handle different response formats:
        // - Paginated: { data: { items: [...] } }
        // - Simple: { data: [...] }
        // - Direct: [...]
        const items = data?.data?.items || data?.data || data?.items || data;
        return Array.isArray(items) ? items : [];
      } catch (error) {
        getLogger("client").event("client.ui.failed", { what: "Failed to fetch resources", err: error });
        return [];
      }
    },
    enabled: !!selectedResourceType,
  });

  // Create permission mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceType: selectedResourceType,
          resourceId: selectedResourceId,
          roleId: selectedRoleId,
          permissionLevel: selectedPermissionLevel,
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error?.message || "Failed to create permission");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Permission created successfully");
      queryClient.invalidateQueries({ queryKey: ["admin-permissions"] });
      setCreateDialogOpen(false);
      resetForm();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // Delete permission mutation
  const deleteMutation = useMutation({
    mutationFn: async (permissionId: string) => {
      const res = await fetch("/api/admin/permissions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: permissionId }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error?.message || "Failed to delete permission");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Permission deleted successfully");
      queryClient.invalidateQueries({ queryKey: ["admin-permissions"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const resetForm = () => {
    setSelectedResourceType("dashboard");
    setSelectedResourceId("");
    setSelectedRoleId("");
    setSelectedPermissionLevel("view");
  };

  const _getResourceName = (_type: ResourceType, id: string) => {
    if (!Array.isArray(resources)) return id;
    const resource = resources.find((r) => r.id === id);
    return resource?.name || id;
  };

  const getPermissionBadgeColor = (level: PermissionLevel) => {
    switch (level) {
      case "view":
        return "secondary";
      case "execute":
        return "outline";
      case "edit":
        return "default";
      case "admin":
        return "destructive";
      default:
        return "outline";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Permission Management"
          description="Manage resource-level permissions for roles"
        />
        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Assign Permission
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            All Permissions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoadingPermissions ? (
            <div className="text-center py-8 text-muted-foreground">Loading permissions...</div>
          ) : !permissions || permissions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No permissions found</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Resource Type</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Permission Level</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {permissions.map((permission) => (
                  <TableRow key={permission.id}>
                    <TableCell className="font-medium">
                      <Badge variant="outline">{permission.role_name}</Badge>
                    </TableCell>
                    <TableCell className="text-tremor-content">
                      {permission.resource_type ? permission.resource_type.replace(/_/g, " ") : "—"}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        // Try to find the resource name from fetched resources
                        if (!Array.isArray(resources)) return permission.resource_id;
                        const typeResources = resources.filter(
                          (r) => r.id === permission.resource_id
                        );
                        if (typeResources && typeResources.length > 0) {
                          return typeResources[0].name;
                        }
                        return permission.resource_id;
                      })()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getPermissionBadgeColor(permission.permission_level)}>
                        {permission.permission_level}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (confirm("Are you sure you want to delete this permission?")) {
                            deleteMutation.mutate(permission.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create Permission Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Permission</DialogTitle>
            <DialogDescription>Grant a role access to a specific resource</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="resource-type">Resource Type *</Label>
              <Select
                value={selectedResourceType}
                onValueChange={(value) => setSelectedResourceType(value as ResourceType)}
              >
                <SelectTrigger id="resource-type">
                  <SelectValue placeholder="Select resource type" />
                </SelectTrigger>
                <SelectContent>
                  {RESOURCE_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="resource">Resource *</Label>
              <Select
                value={selectedResourceId}
                onValueChange={setSelectedResourceId}
                disabled={isLoadingResources || !Array.isArray(resources) || resources.length === 0}
              >
                <SelectTrigger id="resource">
                  <SelectValue
                    placeholder={isLoadingResources ? "Loading resources..." : "Select resource"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {Array.isArray(resources) &&
                    resources.map((resource) => (
                      <SelectItem key={resource.id} value={resource.id}>
                        {resource.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {!isLoadingResources && Array.isArray(resources) && resources.length === 0 && (
                <p className="text-tremor-default text-tremor-content">
                  No resources available for this type
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role *</Label>
              <Select value={selectedRoleId} onValueChange={setSelectedRoleId}>
                <SelectTrigger id="role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {roles?.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="permission-level">Permission Level *</Label>
              <Select
                value={selectedPermissionLevel}
                onValueChange={(value) => setSelectedPermissionLevel(value as PermissionLevel)}
              >
                <SelectTrigger id="permission-level">
                  <SelectValue placeholder="Select permission level" />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSION_LEVELS.map((level) => (
                    <SelectItem key={level.value} value={level.value}>
                      <div className="flex flex-col">
                        <span>{level.label}</span>
                        <span className="text-tremor-label text-tremor-content">
                          {level.description}
                        </span>
                      </div>
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
              disabled={!selectedResourceId || !selectedRoleId || createMutation.isPending}
            >
              {createMutation.isPending ? "Assigning..." : "Assign Permission"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
