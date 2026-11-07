import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { toast } from "sonner";
import { getLogger } from "@/lib/logging/logger";

interface UISettings {
  tableRowStripeColor: string;
}

const DEFAULT_SETTINGS: UISettings = {
  tableRowStripeColor: "#f5f5f5",
};

export const Route = createFileRoute("/_authed/settings/ui")({
  component: UISettingsPage,
});

function UISettingsPage() {
  const [settings, setSettings] = useState<UISettings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);

  // Load settings from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("uiSettings");
    if (saved) {
      try {
        setSettings(JSON.parse(saved));
      } catch (e) {
        getLogger("client").note("error", "Failed to parse UI settings:", { err: e });
      }
    }
  }, []);

  const handleSaveSettings = () => {
    setIsSaving(true);
    try {
      localStorage.setItem("uiSettings", JSON.stringify(settings));
      toast.success("UI Settings saved successfully");
    } catch (e) {
      toast.error("Failed to save UI settings");
      getLogger("client").note("error", "error", { err: e });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    setSettings(DEFAULT_SETTINGS);
    localStorage.removeItem("uiSettings");
    toast.success("UI Settings reset to defaults");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="UI Settings"
        description="Configure table display and appearance options"
      />

      <Card>
        <CardHeader>
          <CardTitle>Table Display</CardTitle>
          <CardDescription>Customize how data tables are displayed</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="stripe-color">Alternating Row Stripe Color</Label>
            <p className="text-tremor-default text-tremor-content">
              Color used for alternating rows in tables for better readability
            </p>
            <div className="flex gap-3 items-center">
              <Input
                id="stripe-color"
                type="color"
                value={settings.tableRowStripeColor}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    tableRowStripeColor: e.target.value,
                  }))
                }
                className="w-24 h-10 cursor-pointer"
              />
              <Input
                type="text"
                value={settings.tableRowStripeColor}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    tableRowStripeColor: e.target.value,
                  }))
                }
                placeholder="#ffffff"
                className="flex-1"
              />
              <div
                className="w-24 h-10 rounded border"
                style={{ backgroundColor: settings.tableRowStripeColor }}
                title="Preview"
              />
            </div>
          </div>

          <div className="flex gap-3 pt-4">
            <Button onClick={handleSaveSettings} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Settings"}
            </Button>
            <Button variant="outline" onClick={handleReset}>
              Reset to Defaults
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
