import { useEffect, useState } from "react";
import { getLogger } from "@/lib/logging/logger";

interface UISettings {
  tableRowStripeColor: string;
}

const DEFAULT_SETTINGS: UISettings = {
  tableRowStripeColor: "var(--muted)",
};

export function useUISettings(): UISettings {
  const [settings, setSettings] = useState<UISettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    // Load from localStorage
    const saved = localStorage.getItem("uiSettings");
    if (saved) {
      try {
        setSettings(JSON.parse(saved));
      } catch (e) {
        getLogger("client").note("error", "Failed to parse UI settings:", { err: e });
        setSettings(DEFAULT_SETTINGS);
      }
    }
    setIsLoaded(true);

    // Listen for storage changes from other tabs/windows
    const handleStorageChange = () => {
      const updated = localStorage.getItem("uiSettings");
      if (updated) {
        try {
          setSettings(JSON.parse(updated));
        } catch (e) {
          getLogger("client").note("error", "Failed to parse updated UI settings:", { err: e });
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  return isLoaded ? settings : DEFAULT_SETTINGS;
}
