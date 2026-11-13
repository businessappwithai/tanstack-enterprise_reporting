import { useEffect, useState } from "react";
import { ActiveDataSourceProvider } from "@/lib/hooks/use-active-datasource";
import { cn } from "@/lib/utils";
import { Header } from "./header";
import { Sidebar } from "./sidebar";

interface User {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

interface AppShellProps {
  children: React.ReactNode;
  user: User;
}

/**
 * True when this page is shown inside the chat assistant's frame. There the
 * assistant is the navigation, so the sidebar and header are left out and the
 * page fills the frame. Decided in the browser: a frame knows it is one, and
 * that stays true as the person moves between pages inside it.
 */
function useEmbedded(): boolean {
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    try {
      setEmbedded(window.self !== window.top);
    } catch {
      // A cross-origin parent throws on access: that is a frame too.
      setEmbedded(true);
    }
  }, []);
  return embedded;
}

export function AppShell({ children, user }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const embedded = useEmbedded();

  if (embedded) {
    return (
      <ActiveDataSourceProvider>
        <div className="min-h-screen bg-tremor-background-muted" data-embedded="true">
          <main className="p-4 md:p-6">{children}</main>
        </div>
      </ActiveDataSourceProvider>
    );
  }

  return (
    <ActiveDataSourceProvider>
      <div className="flex min-h-screen flex-col bg-tremor-background-muted lg:flex-row">
        {/* Sidebar - Hidden on mobile, shown on lg and up */}
        <div className="hidden lg:block fixed h-screen">
          <Sidebar collapsed={sidebarCollapsed} onCollapse={setSidebarCollapsed} />
        </div>

        {/* Mobile sidebar overlay */}
        <button
          type="button"
          aria-label="Close navigation menu"
          className="lg:hidden fixed inset-0 z-40 bg-gray-900/50 transition-opacity duration-300"
          style={{
            opacity: mobileMenuOpen ? 1 : 0,
            pointerEvents: mobileMenuOpen ? "auto" : "none",
          }}
          onClick={() => setMobileMenuOpen(false)}
        />

        <div
          className="lg:hidden fixed left-0 top-0 h-screen z-50 w-64 transition-transform duration-300"
          style={{ transform: mobileMenuOpen ? "translateX(0)" : "translateX(-100%)" }}
        >
          <Sidebar collapsed={false} onCollapse={() => setMobileMenuOpen(false)} />
        </div>

        {/* Main content */}
        <div
          className={cn(
            "flex-1 flex flex-col w-full transition-all duration-300",
            "lg:ml-0",
            sidebarCollapsed ? "lg:ml-16" : "lg:ml-64"
          )}
        >
          <Header
            user={user}
            onMobileMenuToggle={() => setMobileMenuOpen(!mobileMenuOpen)}
            mobileMenuOpen={mobileMenuOpen}
          />
          <main className="flex-1 overflow-auto p-4 md:p-6">{children}</main>
        </div>
      </div>
    </ActiveDataSourceProvider>
  );
}
