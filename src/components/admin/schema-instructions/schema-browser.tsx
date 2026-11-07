import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Database, Table } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listDataSources } from "@/server-fns/data-sources";
import { introspectSchema } from "@/server-fns/sql";
import { getLogger } from "@/lib/logging/logger";

interface DataSource {
  id: string;
  name: string;
  database_type: string;
}

interface SchemaTable {
  name: string;
  columns: string[];
}

interface SchemaBrowserProps {
  onSelectDataSource: (id: string | undefined) => void;
  onSelectTable: (table: string | undefined) => void;
  onSelectField: (field: string | undefined) => void;
}

export function SchemaInstructionsBrowser({
  onSelectDataSource,
  onSelectTable,
  onSelectField,
}: SchemaBrowserProps) {
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [schemas, setSchemas] = useState<Record<string, SchemaTable[]>>({});
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [selectedDataSource, setSelectedDataSource] = useState<string | undefined>();
  const [selectedTable, setSelectedTable] = useState<string | undefined>();
  const [selectedField, setSelectedField] = useState<string | undefined>();

  // Fetch data sources
  useEffect(() => {
    const fetchDataSources = async () => {
      try {
        const result = await listDataSources();
        if (result.items) {
          setDataSources(result.items as unknown as DataSource[]);
        }
      } catch (error) {
        getLogger("client").note("error", "Failed to fetch data sources:", { err: error });
      }
    };

    fetchDataSources();
  }, []);

  // Fetch schema for selected data source
  useEffect(() => {
    if (!selectedDataSource) return;

    const fetchSchema = async () => {
      try {
        const result = await introspectSchema({ data: { dataSourceId: selectedDataSource } });
        if (result.tables) {
          const tables: SchemaTable[] = result.tables.map((t) => ({
            name: t.name,
            columns: (t.columns ?? []).map((c) => c.name),
          }));
          setSchemas((prev) => ({
            ...prev,
            [selectedDataSource]: tables,
          }));
        }
      } catch (error) {
        getLogger("client").note("error", "Failed to fetch schema:", { err: error });
      }
    };

    fetchSchema();
  }, [selectedDataSource]);

  const toggleSourceExpanded = (id: string) => {
    const newExpanded = new Set(expandedSources);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedSources(newExpanded);
  };

  const toggleTableExpanded = (tableKey: string) => {
    const newExpanded = new Set(expandedTables);
    if (newExpanded.has(tableKey)) {
      newExpanded.delete(tableKey);
    } else {
      newExpanded.add(tableKey);
    }
    setExpandedTables(newExpanded);
  };

  const handleSelectDataSource = (id: string) => {
    setSelectedDataSource(id);
    setSelectedTable(undefined);
    setSelectedField(undefined);
    onSelectDataSource(id);
    onSelectTable(undefined);
    onSelectField(undefined);
  };

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName);
    setSelectedField(undefined);
    onSelectTable(tableName);
    onSelectField(undefined);
  };

  const handleSelectField = (fieldName: string) => {
    setSelectedField(fieldName);
    onSelectField(fieldName);
  };

  return (
    <div className="space-y-2 max-h-[600px] overflow-y-auto">
      {dataSources.length === 0 ? (
        <div className="text-sm text-muted-foreground p-4 text-center">
          No data sources available
        </div>
      ) : (
        dataSources.map((ds) => (
          <div key={ds.id} className="border rounded">
            <Button
              variant={selectedDataSource === ds.id ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                handleSelectDataSource(ds.id);
                toggleSourceExpanded(ds.id);
              }}
            >
              {expandedSources.has(ds.id) ? (
                <ChevronDown className="mr-2 h-4 w-4" />
              ) : (
                <ChevronRight className="mr-2 h-4 w-4" />
              )}
              <Database className="mr-2 h-4 w-4" />
              <span className="truncate text-xs">{ds.name}</span>
            </Button>

            {expandedSources.has(ds.id) && (
              <div className="pl-4 py-2 space-y-1 bg-muted/50">
                {(schemas[ds.id] || []).map((table) => {
                  const tableKey = `${ds.id}:${table.name}`;
                  const isExpanded = expandedTables.has(tableKey);

                  return (
                    <div key={tableKey}>
                      <Button
                        variant={selectedTable === table.name ? "secondary" : "ghost"}
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => {
                          handleSelectTable(table.name);
                          toggleTableExpanded(tableKey);
                        }}
                      >
                        {isExpanded ? (
                          <ChevronDown className="mr-2 h-4 w-4" />
                        ) : (
                          <ChevronRight className="mr-2 h-4 w-4" />
                        )}
                        <Table className="mr-2 h-4 w-4" />
                        <span className="truncate text-xs">{table.name}</span>
                      </Button>

                      {isExpanded && (
                        <div className="pl-4 py-1 space-y-0.5">
                          {table.columns.map((col) => (
                            <Button
                              key={col}
                              variant={selectedField === col ? "secondary" : "ghost"}
                              size="sm"
                              className="w-full justify-start text-xs"
                              onClick={() => handleSelectField(col)}
                            >
                              <span className="w-4" />
                              <span className="truncate text-xs">{col}</span>
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
