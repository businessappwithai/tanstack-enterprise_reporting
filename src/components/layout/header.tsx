import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell, Check, CheckCheck, Loader2, LogOut, Menu, Settings, User, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ThemeSelector } from "@/components/theme/theme-selector";
import { HelpButton } from "@/components/help/HelpButton";
import { purgeDatasetCache } from "@/lib/datasets/purge-cache";
import { logoutFn } from "@/server-fns/auth";
import {
  fetchNotificationsFn,
  markNotificationAsReadFn,
  markAllNotificationsAsReadFn,
  deleteNotificationFn,
} from "@/server-fns/notifications";
import { getLogger } from "@/lib/logging/logger";

interface AppUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface HeaderProps {
  user: AppUser;
  onMobileMenuToggle?: () => void;
  mobileMenuOpen?: boolean;
}

export function Header({ user, onMobileMenuToggle, mobileMenuOpen }: HeaderProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showReadNotifications, setShowReadNotifications] = useState(false);

  const initials =
    user.name
      ?.split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase() ||
    user.email?.[0].toUpperCase() ||
    "U";

  // Fetch notifications
  const { data: notifications = [], isLoading: isLoadingNotifications } = useQuery({
    queryKey: ["notifications", showReadNotifications],
    queryFn: async () => {
      try {
        const result = await fetchNotificationsFn({ data: { includeRead: showReadNotifications } });
        if (!result.success) {
          if (result.error !== "Unauthorized") {
            getLogger("client").note("warn", "Failed to fetch notifications:", { detail: [result.error] });
          }
          return [];
        }
        return result.data || [];
      } catch (error) {
        getLogger("client").note("error", "Error fetching notifications:", { err: error });
        return [];
      }
    },
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const safeNotifications = Array.isArray(notifications) ? notifications : [];
  // Get unread count
  const unreadCount = safeNotifications.filter((n: any) => !n.is_read).length;

  // Mark as read mutation
  const markAsReadMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await markNotificationAsReadFn({ data: { id } });
      if (!result.success) {
        throw new Error(result.error || "Failed to mark notification as read");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (error) => {
      getLogger("client").note("error", "Error marking notification as read:", { err: error });
    },
  });

  // Mark all as read mutation
  const markAllAsReadMutation = useMutation({
    mutationFn: async () => {
      const result = await markAllNotificationsAsReadFn();
      if (!result.success) {
        throw new Error(result.error || "Failed to mark all notifications as read");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("All notifications marked as read");
    },
    onError: (error) => {
      getLogger("client").note("error", "Error marking all notifications as read:", { err: error });
    },
  });

  // Delete notification mutation
  const deleteNotificationMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await deleteNotificationFn({ data: { id } });
      if (!result.success) {
        throw new Error(result.error || "Failed to delete notification");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("Notification deleted");
    },
    onError: (error) => {
      getLogger("client").note("error", "Error deleting notification:", { err: error });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      // Before the session ends, so a shared browser keeps no dataset rows after sign-out.
      await purgeDatasetCache();
      return logoutFn();
    },
    onSuccess: () => {
      // Clear cache and navigate on success
      queryClient.clear();
      navigate({ to: "/login" });
    },
    onError: (error) => {
      getLogger("client").note("error", "Logout error:", { err: error });
      // Fallback: still redirect even if there was an error
      queryClient.clear();
      navigate({ to: "/login" });
    },
  });

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case "error":
        return <X className="h-4 w-4 text-red-500" />;
      case "warning":
        return <div className="h-4 w-4 rounded-tremor-full bg-amber-500" />;
      case "success":
        return <Check className="h-4 w-4 text-emerald-500" />;
      default:
        return <div className="h-4 w-4 rounded-tremor-full bg-blue-500" />;
    }
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-tremor-border bg-tremor-background px-6">
      <div className="flex items-center gap-3">
        {/* Mobile Menu Toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden h-9 w-9"
          onClick={onMobileMenuToggle}
          aria-label="Toggle menu"
        >
          <Menu className={`h-5 w-5 transition-transform ${mobileMenuOpen ? "rotate-90" : ""}`} />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <ThemeSelector />

        <HelpButton />

        {/* Notifications */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative h-9 w-9 rounded-tremor-small">
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-tremor-full p-0 text-tremor-label"
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </Badge>
              )}
              <span className="sr-only">Notifications</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-80 p-0" align="end">
            <DropdownMenuLabel className="border-b border-tremor-border p-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Notifications</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-tremor-label"
                  onClick={() => setShowReadNotifications(!showReadNotifications)}
                >
                  {showReadNotifications ? "Hide Read" : "Show All"}
                </Button>
              </div>
            </DropdownMenuLabel>

            {isLoadingNotifications ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-tremor-content" />
              </div>
            ) : safeNotifications.length === 0 ? (
              <div className="py-8 text-center text-tremor-default text-tremor-content">
                No notifications
              </div>
            ) : (
              <>
                <ScrollArea className="h-96">
                  <div className="p-2">
                    {safeNotifications.map((notification: any) => (
                      <div
                        key={notification.id}
                        className={`mb-2 rounded-lg border p-3 transition-colors hover:bg-accent ${
                          !notification.is_read ? "bg-accent/50" : ""
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5">{getNotificationIcon(notification.type)}</div>
                          <div className="flex-1 space-y-1">
                            <p className="text-tremor-default font-medium leading-none text-tremor-content-strong">
                              {notification.title}
                            </p>
                            <p className="text-tremor-label text-tremor-content">
                              {notification.message}
                            </p>
                            <p className="text-tremor-label text-tremor-content">
                              {new Date(notification.created_at).toLocaleString()}
                            </p>
                          </div>
                          <div className="flex gap-1">
                            {!notification.is_read && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => markAsReadMutation.mutate(notification.id)}
                              >
                                <Check className="h-3 w-3" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => deleteNotificationMutation.mutate(notification.id)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                {unreadCount > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="p-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => markAllAsReadMutation.mutate()}
                      >
                        <CheckCheck className="mr-2 h-4 w-4" />
                        Mark all as read
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="relative h-9 w-9 rounded-tremor-small p-0">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user.image || undefined} alt={user.name || "User"} />
                <AvatarFallback className="rounded-tremor-small text-tremor-label">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="end" forceMount>
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-tremor-default font-medium leading-none text-tremor-content-strong">
                  {user.name}
                </p>
                <p className="text-tremor-label leading-none text-tremor-content">{user.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <User className="mr-2 h-4 w-4" />
              <span>Profile</span>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Settings className="mr-2 h-4 w-4" />
              <span>Settings</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              className="text-red-500 focus:text-red-600"
            >
              <LogOut className="mr-2 h-4 w-4" />
              <span>{logoutMutation.isPending ? "Logging out..." : "Log out"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
