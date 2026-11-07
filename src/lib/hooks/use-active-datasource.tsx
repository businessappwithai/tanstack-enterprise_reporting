/**
 * Active Data Source Hook
 * Manages the currently active database connection for the session
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { getLogger } from "@/lib/logging/logger";

interface DataSource {
  id: string;
  name: string;
  description?: string;
  client_type: string;
  created_at: string;
}

interface ActiveDataSourceContextType {
  activeDataSource: DataSource | null;
  setActiveDataSource: (dataSource: DataSource | null) => void;
  isLoading: boolean;
  refreshActiveDataSource: () => Promise<void>;
}

const ActiveDataSourceContext = createContext<ActiveDataSourceContextType | undefined>(undefined);

export function ActiveDataSourceProvider({ children }: { children: ReactNode }) {
  const [activeDataSource, setActiveDataSourceState] = useState<DataSource | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const hasFetchedRef = useRef(false);

  const fetchActiveDataSource = useCallback(async () => {
    // Prevent duplicate fetches
    if (hasFetchedRef.current) {
      return;
    }
    hasFetchedRef.current = true;
    try {
      setIsLoading(true);
      const response = await fetch("/api/data-sources/active");
      if (!response.ok) {
        setActiveDataSourceState(null);
        return;
      }
      const data = await response.json();

      if (data.success && data.data.activeDataSource) {
        setActiveDataSourceState(data.data.activeDataSource);
      } else {
        setActiveDataSourceState(null);
      }
    } catch (error) {
      getLogger("client").event("client.ui.failed", { what: "Error fetching active data source", err: error });
      setActiveDataSourceState(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setActiveDataSource = async (dataSource: DataSource | null) => {
    if (!dataSource) {
      setActiveDataSourceState(null);
      return;
    }

    try {
      const response = await fetch("/api/data-sources/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataSourceId: dataSource.id }),
      });

      if (!response.ok)
        throw new Error(`HTTP ${response.status}: Failed to set active data source`);
      const data = await response.json();

      if (data.success) {
        setActiveDataSourceState(dataSource);
      } else {
        throw new Error(data.error?.message || "Failed to set active data source");
      }
    } catch (error) {
      getLogger("client").event("client.ui.failed", { what: "Error setting active data source", err: error });
      throw error;
    }
  };

  useEffect(() => {
    fetchActiveDataSource();
  }, [fetchActiveDataSource]);

  // Wrap refresh to reset the ref
  const refreshActiveDataSource = async () => {
    hasFetchedRef.current = false;
    await fetchActiveDataSource();
  };

  return (
    <ActiveDataSourceContext.Provider
      value={{
        activeDataSource,
        setActiveDataSource,
        isLoading,
        refreshActiveDataSource,
      }}
    >
      {children}
    </ActiveDataSourceContext.Provider>
  );
}

export function useActiveDataSource() {
  const context = useContext(ActiveDataSourceContext);

  if (context === undefined) {
    throw new Error("useActiveDataSource must be used within an ActiveDataSourceProvider");
  }

  return context;
}
