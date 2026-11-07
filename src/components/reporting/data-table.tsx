"use client";

import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  Search,
  Settings2,
  X,
} from "lucide-react";
/** The CSS custom properties this table sets; CSSProperties cannot describe them. */
type TableCustomProperties = Record<
  | "--header-bg"
  | "--header-text"
  | "--header-font-weight"
  | "--row-bg"
  | "--row-text"
  | "--alt-row-bg"
  | "--alt-row-text"
  | "--border-color",
  string | undefined
>;

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import type { ReportColorTheme } from "@/types/database";

interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData>[];
  isLoading?: boolean;
  totalRows?: number;
  pageSize?: number;
  pageSizeOptions?: number[];
  onExport?: (format: "csv" | "xlsx" | "pdf") => void;
  serverSide?: boolean;
  onPaginationChange?: (pagination: PaginationState) => void;
  onSortingChange?: (sorting: SortingState) => void;
  onFilterChange?: (filters: ColumnFiltersState) => void;
  onSearchChange?: (search: string) => void;
  pageIndex?: number;
  colorTheme?: ReportColorTheme | null;
}

export function DataTable<TData>({
  data,
  columns,
  isLoading = false,
  totalRows,
  pageSize = 10,
  pageSizeOptions = [10, 20, 30, 50, 100],
  onExport,
  serverSide = false,
  onPaginationChange,
  onSortingChange,
  onFilterChange,
  onSearchChange,
  pageIndex: externalPageIndex = 0,
  colorTheme,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [internalPagination, setInternalPagination] = useState<PaginationState>({
    pageIndex: externalPageIndex,
    pageSize,
  });
  const [globalFilter, setGlobalFilter] = useState("");

  // Sync internal pagination state when external pageIndex changes (server-side)
  useEffect(() => {
    if (serverSide) {
      setInternalPagination({
        pageIndex: externalPageIndex,
        pageSize: internalPagination.pageSize,
      });
    }
  }, [externalPageIndex, serverSide, internalPagination.pageSize]);

  // For server-side pagination, use the external page index from parent
  // For client-side pagination, use internal state
  const pagination: PaginationState = serverSide
    ? { pageIndex: externalPageIndex, pageSize }
    : internalPagination;

  const handleSortingChange = (updater: SortingState | ((old: SortingState) => SortingState)) => {
    const newSorting = typeof updater === "function" ? updater(sorting) : updater;
    setSorting(newSorting);
    onSortingChange?.(newSorting);
  };

  const handleFilterChange = (
    updater: ColumnFiltersState | ((old: ColumnFiltersState) => ColumnFiltersState)
  ) => {
    const newFilters = typeof updater === "function" ? updater(columnFilters) : updater;
    setColumnFilters(newFilters);
    onFilterChange?.(newFilters);
  };

  const handlePaginationChange = (
    updater: PaginationState | ((old: PaginationState) => PaginationState)
  ) => {
    const newPagination = typeof updater === "function" ? updater(pagination) : updater;

    // Always update internal state to keep table in sync
    setInternalPagination(newPagination);

    // For server-side, notify parent to fetch new data
    if (serverSide) {
      onPaginationChange?.(newPagination);
    }
  };

  // Prepare styles based on color theme
  const tableStyle: TableCustomProperties = {
    "--header-bg": colorTheme?.headerBackgroundColor || undefined,
    "--header-text": colorTheme?.headerTextColor || undefined,
    "--header-font-weight": colorTheme?.headerFontWeight || undefined,
    "--row-bg": colorTheme?.rowBackgroundColor || undefined,
    "--row-text": colorTheme?.rowTextColor || undefined,
    "--alt-row-bg": colorTheme?.alternatingRowBackgroundColor || undefined,
    "--alt-row-text": colorTheme?.alternatingRowTextColor || undefined,
    "--border-color": colorTheme?.borderColor || undefined,
  } satisfies TableCustomProperties;

  const table = useReactTable({
    data,
    columns,
    pageCount: serverSide && totalRows ? Math.ceil(totalRows / pagination.pageSize) : undefined,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      pagination,
      globalFilter,
    },
    onSortingChange: handleSortingChange,
    onColumnFiltersChange: handleFilterChange,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: handlePaginationChange,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: serverSide ? undefined : getSortedRowModel(),
    getFilteredRowModel: serverSide ? undefined : getFilteredRowModel(),
    getPaginationRowModel: serverSide ? undefined : getPaginationRowModel(),
    manualPagination: serverSide,
    manualSorting: serverSide,
    manualFiltering: serverSide,
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground"
              onClick={() => {
                onSearchChange?.(globalFilter);
              }}
            />
            <Input
              placeholder="Search all columns..."
              value={globalFilter}
              onChange={(e) => {
                setGlobalFilter(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onSearchChange?.(globalFilter);
                }
              }}
              className="h-8 w-[200px] lg:w-[300px] pl-8 pr-8"
            />
            {globalFilter && (
              <X
                className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground cursor-pointer hover:text-foreground"
                onClick={() => {
                  setGlobalFilter("");
                  onSearchChange?.("");
                }}
              />
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => {
              onSearchChange?.(globalFilter);
            }}
          >
            <Search className="h-4 w-4 mr-2" />
            Search
          </Button>
          {globalFilter && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => {
                setGlobalFilter("");
                onSearchChange?.("");
              }}
            >
              <X className="h-4 w-4 mr-2" />
              Clear
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onExport && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="h-4 w-4 mr-2" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuCheckboxItem onClick={() => onExport("csv")}>
                  Export as CSV
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem onClick={() => onExport("xlsx")}>
                  Export as Excel
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem onClick={() => onExport("pdf")}>
                  Export as PDF
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Settings2 className="h-4 w-4 mr-2" />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px]">
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => {
                  return (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      checked={column.getIsVisible()}
                      onCheckedChange={(value) => column.toggleVisibility(!!value)}
                    >
                      {typeof column.columnDef.header === "string"
                        ? column.columnDef.header
                        : column.id}
                    </DropdownMenuCheckboxItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Table */}
      <div
        className="rounded-md border"
        style={{
          borderColor: tableStyle["--border-color"],
        }}
      >
        <Table style={tableStyle as React.CSSProperties}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className="whitespace-nowrap"
                    style={{
                      backgroundColor: tableStyle["--header-bg"],
                      color: tableStyle["--header-text"],
                      fontWeight: tableStyle["--header-font-weight"],
                    }}
                  >
                    {header.isPlaceholder ? null : (
                      <div
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ")
                            header.column.getToggleSortingHandler()?.(e);
                        }}
                        className={cn(
                          header.column.getCanSort() &&
                            "flex items-center gap-1 cursor-pointer select-none hover:text-foreground"
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() &&
                          (header.column.getIsSorted() === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : header.column.getIsSorted() === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-50" />
                          ))}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  No results.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row, index) => {
                const isAltRow = index % 2 !== 0;
                return (
                  <TableRow
                    key={row.id}
                    style={{
                      backgroundColor: isAltRow
                        ? tableStyle["--alt-row-bg"]
                        : tableStyle["--row-bg"],
                      color: isAltRow ? tableStyle["--alt-row-text"] : tableStyle["--row-text"],
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        style={{
                          color: isAltRow ? tableStyle["--alt-row-text"] : tableStyle["--row-text"],
                        }}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>
            Showing{" "}
            {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1} to{" "}
            {Math.min(
              (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
              totalRows || data.length
            )}{" "}
            of {totalRows || data.length} results
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm">Rows per page</span>
            <Select
              value={String(table.getState().pagination.pageSize)}
              onValueChange={(value) => {
                table.setPageSize(Number(value));
              }}
            >
              <SelectTrigger className="h-8 w-[70px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm px-2">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
