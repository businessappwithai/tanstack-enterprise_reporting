/**
 * Record Editor Component
 *
 * Form for creating and editing entity data records.
 * Uses TanStack Form with dynamic field rendering.
 */

import { useForm } from "@tanstack/react-form";
import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEntity, useEntityRecords } from "@/hooks/metadata/use-metadata-queries";
import type { MetadataEntityWithFields } from "@/types/database";
import { RelationshipPicker } from "../RelationshipPicker";
import { getLogger } from "@/lib/logging/logger";

interface RecordEditorProps {
  dataSourceId: string;
  entityId: string;
  recordId?: string | number;
  onSave?: () => void;
  onCancel?: () => void;
}

export function RecordEditor({
  dataSourceId,
  entityId,
  recordId,
  onSave,
  onCancel,
}: RecordEditorProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch entity metadata
  const { data: entityData, isLoading: isLoadingEntity } = useEntity(entityId);
  const entity = entityData?.data as MetadataEntityWithFields;

  // Fetch record if editing
  const { data: recordsData, isLoading: isLoadingRecord } = useEntityRecords(
    dataSourceId,
    entityId,
    recordId ? { page: 1, limit: 1 } : { page: 1, limit: 0 }
  );

  const record = recordId
    ? (recordsData?.data?.records?.[0] as Record<string, unknown> | undefined)
    : undefined;

  // Build initial default values from record or empty object
  const defaultValues: Record<string, unknown> = record || {};

  const form = useForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      setIsSubmitting(true);
      try {
        const url = recordId
          ? `/api/data-sources/${dataSourceId}/entities/${entityId}/records/${recordId}`
          : `/api/data-sources/${dataSourceId}/entities/${entityId}/records/${Date.now()}`;

        const method = recordId ? "PUT" : "POST";

        const response = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || "Failed to save record");
        }

        onSave?.();
      } catch (error) {
        getLogger("client").event("client.ui.failed", { what: "Error saving record", err: error });
        throw error;
      } finally {
        setIsSubmitting(false);
      }
    },
  });

  // Update form when record data is loaded
  useEffect(() => {
    if (record) {
      form.reset(record);
    }
  }, [record, form]);

  if (isLoadingEntity || (recordId && isLoadingRecord)) {
    return (
      <Card className="w-full">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!entity) {
    return (
      <Card className="w-full">
        <CardContent className="flex items-center justify-center py-12">
          <p className="text-tremor-content">Entity not found</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>
          {recordId ? "Edit" : "Create"} {entity.entity_name} Record
        </CardTitle>
        <CardDescription>
          {recordId ? "Update record data." : "Fill in the fields to create a new record."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
          className="space-y-6"
        >
          {entity.fields.map((field) => (
            <form.Field key={field.id} name={field.field_name}>
              {(fieldApi) => (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    {field.description || field.field_name}
                    {field.is_primary_key && <Badge variant="secondary">PK</Badge>}
                    {field.is_foreign_key && <Badge variant="outline">FK</Badge>}
                    {!field.is_nullable && <span className="text-destructive">*</span>}
                  </Label>
                  {field.is_foreign_key && field.relationship_ui_type ? (
                    <RelationshipPicker
                      dataSourceId={dataSourceId}
                      entity={entity}
                      field={field}
                      value={fieldApi.state.value as string | number | null}
                      onChange={fieldApi.handleChange}
                    />
                  ) : field.data_type.toLowerCase().includes("bool") ? (
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id={field.id}
                        checked={Boolean(fieldApi.state.value)}
                        onCheckedChange={(checked) => fieldApi.handleChange(checked)}
                      />
                      <label htmlFor={field.id} className="text-tremor-default text-tremor-content">
                        {fieldApi.state.value ? "True" : "False"}
                      </label>
                    </div>
                  ) : field.data_type.toLowerCase().includes("text") ||
                    field.data_type.toLowerCase().includes("string") ? (
                    <Textarea
                      placeholder={`Enter ${field.field_name}`}
                      value={String(fieldApi.state.value || "")}
                      onChange={(e) => fieldApi.handleChange(e.target.value)}
                      onBlur={fieldApi.handleBlur}
                      rows={3}
                    />
                  ) : (
                    <Input
                      type={getFieldInputType(field.data_type)}
                      placeholder={`Enter ${field.field_name}`}
                      value={String(fieldApi.state.value || "")}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (getFieldInputType(field.data_type) === "number") {
                          fieldApi.handleChange(val === "" ? null : Number(val));
                        } else {
                          fieldApi.handleChange(val);
                        }
                      }}
                      onBlur={fieldApi.handleBlur}
                    />
                  )}
                  {field.description && (
                    <p className="text-tremor-default text-tremor-content">{field.description}</p>
                  )}
                  {fieldApi.state.meta.errors.length > 0 && (
                    <p className="text-sm text-destructive">{fieldApi.state.meta.errors[0]}</p>
                  )}
                </div>
              )}
            </form.Field>
          ))}

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={isSubmitting || form.state.isSubmitting}>
              {(isSubmitting || form.state.isSubmitting) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <Save className="mr-2 h-4 w-4" />
              Save Record
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function getFieldInputType(dataType: string): string {
  const type = dataType.toLowerCase();
  if (
    type.includes("int") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("real")
  ) {
    return "number";
  }
  if (type.includes("date")) {
    return "datetime-local";
  }
  if (type.includes("bool")) {
    return "checkbox";
  }
  return "text";
}
