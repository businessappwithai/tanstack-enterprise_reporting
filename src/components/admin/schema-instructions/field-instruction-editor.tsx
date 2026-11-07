import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { saveFieldInstruction, getSchemaInstructions } from "@/server-fns/schema-instructions";
import type { FieldInstruction } from "@/server-fns/schema-instructions";
import { getLogger } from "@/lib/logging/logger";

interface FieldInstructionEditorProps {
  dataSourceId?: string;
  tableName?: string;
  fieldName?: string;
  onSaved: () => void;
}

interface FieldMetadata {
  fieldType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  foreignKeyTable?: string;
  foreignKeyField?: string;
}

export function FieldInstructionEditor({
  dataSourceId,
  tableName,
  fieldName,
  onSaved,
}: FieldInstructionEditorProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState(false);
  const [fieldMetadata, setFieldMetadata] = useState<FieldMetadata | undefined>();
  const [existingInstruction, setExistingInstruction] = useState<FieldInstruction | undefined>();

  // Fetch existing instructions and field metadata
  useEffect(() => {
    if (!dataSourceId || !tableName || !fieldName) {
      setExistingInstruction(undefined);
      setFieldMetadata(undefined);
      return;
    }

    const fetchInstructions = async () => {
      try {
        const result = await getSchemaInstructions({
          data: { dataSourceId },
        });
        if (result.success && result.data) {
          const found = result.data.fieldInstructions.find(
            (fi: any) => fi.table_name === tableName && fi.field_name === fieldName
          );
          if (found) {
            setExistingInstruction({
              id: found.id,
              dataSourceId: found.data_source_id,
              tableName: found.table_name,
              fieldName: found.field_name,
              fieldType: found.field_type || "",
              isNullable: found.is_nullable ?? true,
              isPrimaryKey: found.is_primary_key ?? false,
              isForeignKey: found.is_foreign_key ?? false,
              foreignKeyTable: found.foreign_key_table ?? undefined,
              foreignKeyField: found.foreign_key_field ?? undefined,
              description: found.description ?? undefined,
              llmInstructions: found.llm_instructions ?? undefined,
              exampleValues: found.example_values ?? undefined,
              constraints: found.constraints ?? undefined,
              businessMeaning: found.business_meaning ?? undefined,
            });

            setFieldMetadata({
              fieldType: found.field_type || "",
              isNullable: found.is_nullable ?? true,
              isPrimaryKey: found.is_primary_key ?? false,
              isForeignKey: found.is_foreign_key ?? false,
              foreignKeyTable: found.foreign_key_table ?? undefined,
              foreignKeyField: found.foreign_key_field ?? undefined,
            });
          } else {
            setExistingInstruction(undefined);
          }
        }
      } catch (err) {
        getLogger("client").note("error", "Failed to fetch instructions:", { err: err });
      }
    };

    fetchInstructions();
  }, [dataSourceId, tableName, fieldName]);

  const form = useForm({
    defaultValues: {
      description: existingInstruction?.description || "",
      businessMeaning: existingInstruction?.businessMeaning || "",
      llmInstructions: existingInstruction?.llmInstructions || "",
      exampleValues: existingInstruction?.exampleValues || "",
      constraints: existingInstruction?.constraints || "",
    },
    onSubmit: async ({ value: values }) => {
      if (!dataSourceId || !tableName || !fieldName) {
        setError("Please select a data source, table, and field");
        return;
      }

      setLoading(true);
      setError(undefined);
      setSuccess(false);

      try {
        const result = await saveFieldInstruction({
          data: {
            id: existingInstruction?.id,
            dataSourceId,
            tableName,
            fieldName,
            fieldType: fieldMetadata?.fieldType || "unknown",
            isNullable: fieldMetadata?.isNullable ?? true,
            isPrimaryKey: fieldMetadata?.isPrimaryKey ?? false,
            isForeignKey: fieldMetadata?.isForeignKey ?? false,
            foreignKeyTable: fieldMetadata?.foreignKeyTable,
            foreignKeyField: fieldMetadata?.foreignKeyField,
            description: values.description || undefined,
            businessMeaning: values.businessMeaning || undefined,
            llmInstructions: values.llmInstructions || undefined,
            exampleValues: values.exampleValues || undefined,
            constraints: values.constraints || undefined,
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

  if (!dataSourceId || !tableName || !fieldName) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Select a field to view or edit instructions
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
            Field instructions saved successfully
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="field-name">Field Name</Label>
          <Input id="field-name" value={fieldName} disabled className="bg-muted" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="field-type">Field Type</Label>
          <Input
            id="field-type"
            value={fieldMetadata?.fieldType || ""}
            disabled
            className="bg-muted"
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="flex items-center space-x-2">
          <Checkbox id="nullable" checked={fieldMetadata?.isNullable ?? true} disabled />
          <Label htmlFor="nullable" className="text-sm cursor-pointer">
            Nullable
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox id="primary-key" checked={fieldMetadata?.isPrimaryKey ?? false} disabled />
          <Label htmlFor="primary-key" className="text-sm cursor-pointer">
            Primary Key
          </Label>
        </div>

        <div className="flex items-center space-x-2">
          <Checkbox id="foreign-key" checked={fieldMetadata?.isForeignKey ?? false} disabled />
          <Label htmlFor="foreign-key" className="text-sm cursor-pointer">
            Foreign Key
          </Label>
        </div>
      </div>

      {fieldMetadata?.isForeignKey && (
        <div className="grid grid-cols-2 gap-4 p-3 bg-muted rounded">
          <div className="space-y-2">
            <Label htmlFor="fk-table" className="text-sm">
              FK Table
            </Label>
            <Input
              id="fk-table"
              value={fieldMetadata?.foreignKeyTable || ""}
              disabled
              className="bg-background text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fk-field" className="text-sm">
              FK Field
            </Label>
            <Input
              id="fk-field"
              value={fieldMetadata?.foreignKeyField || ""}
              disabled
              className="bg-background text-xs"
            />
          </div>
        </div>
      )}

      <form.Field name="description">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="What does this field represent? E.g., 'Customer email address used for notifications and login'"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="businessMeaning">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="business-meaning">Business Meaning</Label>
            <Textarea
              id="business-meaning"
              placeholder="Business context and interpretation. E.g., 'Represents the primary contact email. Must be unique and verified'"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
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
              placeholder="Detailed instructions for the LLM. E.g., 'This field contains formatted email addresses. When filtering, use LOWER() for case-insensitive matching'"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={4}
            />
          </div>
        )}
      </form.Field>

      <form.Field name="exampleValues">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="example-values">Example Values (JSON array)</Label>
            <Textarea
              id="example-values"
              placeholder={`["user@example.com", "admin@company.org", "support@domain.net"]`}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={2}
              className="font-mono text-xs"
            />
          </div>
        )}
      </form.Field>

      <form.Field name="constraints">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor="constraints">Constraints (JSON)</Label>
            <Textarea
              id="constraints"
              placeholder={`{"pattern": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", "maxLength": 255, "allowedValues": ["active", "inactive"]}`}
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
            <p className="text-tremor-label text-tremor-content">
              Validation rules, patterns, and constraints as JSON
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
          "Save Field Instructions"
        )}
      </Button>
    </form>
  );
}
