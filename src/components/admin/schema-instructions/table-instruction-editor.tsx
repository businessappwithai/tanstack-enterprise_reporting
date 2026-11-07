import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { saveTableInstruction, getSchemaInstructions } from "@/server-fns/schema-instructions";
import type { TableInstruction } from "@/server-fns/schema-instructions";
import { getLogger } from "@/lib/logging/logger";

interface TableInstructionEditorProps {
  dataSourceId?: string;
  tableName?: string;
  onSaved: () => void;
}

export function TableInstructionEditor({
  dataSourceId,
  tableName,
  onSaved,
}: TableInstructionEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState(false);
  const [existingInstruction, setExistingInstruction] = useState<TableInstruction | undefined>();

  // Fetch existing instructions when selection changes
  useEffect(() => {
    if (!dataSourceId || !tableName) {
      setExistingInstruction(undefined);
      return;
    }

    const fetchInstructions = async () => {
      try {
        const result = await getSchemaInstructions({
          data: { dataSourceId },
        });
        if (result.success && result.data) {
          const found = result.data.tableInstructions.find(
            (ti: any) => ti.table_name === tableName
          );
          setExistingInstruction(
            found
              ? {
                  id: found.id,
                  dataSourceId: found.data_source_id,
                  tableName: found.table_name,
                  description: found.description ?? undefined,
                  llmInstructions: found.llm_instructions ?? undefined,
                  exampleQueries: found.example_queries ?? undefined,
                  businessDomain: found.business_domain ?? undefined,
                }
              : undefined
          );
        }
      } catch (err) {
        getLogger("client").event("client.ui.failed", { what: "Failed to fetch instructions", err: err });
      }
    };

    fetchInstructions();
  }, [dataSourceId, tableName]);

  const form = useForm({
    defaultValues: {
      description: existingInstruction?.description || "",
      llmInstructions: existingInstruction?.llmInstructions || "",
      exampleQueries: existingInstruction?.exampleQueries || "",
      businessDomain: existingInstruction?.businessDomain || "",
    },
    onSubmit: async ({ value: values }) => {
      if (!dataSourceId || !tableName) {
        setError("Please select a data source and table");
        return;
      }

      setLoading(true);
      setError(undefined);
      setSuccess(false);

      try {
        const result = await saveTableInstruction({
          data: {
            id: existingInstruction?.id,
            dataSourceId,
            tableName,
            description: values.description || undefined,
            llmInstructions: values.llmInstructions || undefined,
            exampleQueries: values.exampleQueries || undefined,
            businessDomain: values.businessDomain || undefined,
          },
        });

        if (result.success) {
          setSuccess(true);
          setTimeout(() => setSuccess(false), 3000);
          onSaved();
        } else {
          setError(result.error || "Failed to save");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
  });

  if (!dataSourceId || !tableName) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Select a table to view or edit instructions
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="space-y-6"
    >
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert className="border-emerald-500 bg-emerald-50">
          <Check className="h-4 w-4 text-emerald-600" />
          <AlertDescription className="text-emerald-800">
            Table instructions saved successfully
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="table-name">Table Name</Label>
        <Input id="table-name" value={tableName} disabled className="bg-muted" />
      </div>

      <form.Field name="description">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="What does this table represent? E.g., 'Stores customer information including contacts and addresses'"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="businessDomain">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="business-domain">Business Domain</Label>
            <Input
              id="business-domain"
              placeholder="E.g., 'Customer Management', 'Order Processing', 'Financial Reporting'"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="llmInstructions">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="llm-instructions">LLM Instructions</Label>
            <Textarea
              id="llm-instructions"
              placeholder="Detailed instructions for the LLM. E.g., 'This table uses soft deletes with is_deleted flag. Always filter WHERE is_deleted = false in queries'"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={4}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="exampleQueries">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="example-queries">Example Queries (JSON array)</Label>
            <Textarea
              id="example-queries"
              placeholder={`["SELECT * FROM table WHERE status = 'active'", "SELECT COUNT(*) FROM table GROUP BY category"]`}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
            <p className="text-tremor-label text-tremor-content">
              Provide JSON array of SQL patterns commonly used with this table
            </p>
          </div>
        )}
      </form.Field>

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          "Save Table Instructions"
        )}
      </Button>
    </form>
  );
}
