import { createFileRoute } from "@tanstack/react-router";
import { serverFailure } from "@/lib/errors/app-error";
import { withApiHandler } from "@/lib/http/with-api-handler";
import { sql as kyselySql } from "kysely";
import { json } from "@/lib/server/response";
import { decideQueryRun } from "@/lib/permissions/runnable-query";
import type { ColumnDefinition, DataSource, ReportColorTheme } from "@/types/database";

async function getSession(request: Request) {
  const { auth } = await import("@/lib/auth/config");
  return auth(request);
}

function hexToARGB(hex: string | undefined): string {
  if (!hex) return "FFE0E0E0";
  const cleanHex = hex.replace("#", "");
  if (cleanHex.length === 8) return cleanHex.toUpperCase();
  if (cleanHex.length === 6) return `FF${cleanHex}`.toUpperCase();
  if (cleanHex.length === 3) {
    const expanded = cleanHex
      .split("")
      .map((c) => c + c)
      .join("");
    return `FF${expanded}`.toUpperCase();
  }
  return "FFE0E0E0";
}

function hexToRGB(hex: string | undefined): { r: number; g: number; b: number } {
  if (!hex) return { r: 240, g: 240, b: 240 };
  const cleanHex = hex.replace("#", "");
  if (cleanHex.length === 6) {
    return {
      r: parseInt(cleanHex.substring(0, 2), 16),
      g: parseInt(cleanHex.substring(2, 4), 16),
      b: parseInt(cleanHex.substring(4, 6), 16),
    };
  }
  if (cleanHex.length === 3) {
    const expanded = cleanHex
      .split("")
      .map((c) => c + c)
      .join("");
    return {
      r: parseInt(expanded.substring(0, 2), 16),
      g: parseInt(expanded.substring(2, 4), 16),
      b: parseInt(expanded.substring(4, 6), 16),
    };
  }
  return { r: 240, g: 240, b: 240 };
}

function parseColorTheme(colorThemeStr: string | null): ReportColorTheme | null {
  if (!colorThemeStr) return null;
  try {
    const theme = JSON.parse(colorThemeStr) as ReportColorTheme;
    return theme;
  } catch {
    return null;
  }
}

function isValidHexColor(color: string | undefined): color is string {
  if (!color) return false;
  return /^#([0-9A-F]{3}){1,2}$/i.test(color);
}

/** The theme colour when it is a valid hex value, else the fallback. */
function hexOr(color: string | undefined, fallback: string): string {
  return isValidHexColor(color) ? color : fallback;
}

function buildFilename(
  reportName: string,
  templateStr: string | null,
  firstRow: Record<string, unknown> | undefined,
  ext: string
): string {
  let filename = reportName;
  if (templateStr && firstRow) {
    try {
      const template = JSON.parse(templateStr);
      if (template.field1 && firstRow[template.field1]) {
        filename += String(firstRow[template.field1]);
      }
      if (template.field2 && firstRow[template.field2]) {
        filename += String(firstRow[template.field2]);
      }
    } catch {
      // Fall back to just report name
    }
  }
  return `${filename}.${ext}`;
}

export const Route = createFileRoute("/api/reports/$id/export")({
  server: {
    handlers: {
      POST: withApiHandler("/api/reports/$id/export", async ({ request, params }) => {
        try {
          const session = await getSession(request);
          if (!session?.user) {
            return json(
              { success: false, error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
              { status: 401 }
            );
          }

          const { id } = params;
          const body = await request.json();
          const { format = "csv" } = body;

          const { getDb } = await import("@/lib/db/config");
          const { getConnection } = await import("@/lib/db/connection-manager");
          const db = getDb();

          const report = await db
            .selectFrom("report_definitions")
            .selectAll()
            .where("id", "=", id)
            .executeTakeFirst();

          if (!report) {
            return json(
              { success: false, error: { code: "NOT_FOUND", message: "Report not found" } },
              { status: 404 }
            );
          }

          let isFormatEnabled = true;
          if (report.export_formats) {
            try {
              const parsedFormats = JSON.parse(report.export_formats);
              if (Array.isArray(parsedFormats)) {
                isFormatEnabled = parsedFormats.includes(format);
              } else {
                isFormatEnabled = parsedFormats[format] !== false;
              }
            } catch {
              /* ignore */
            }
          }

          if (!isFormatEnabled) {
            return json(
              {
                success: false,
                error: {
                  code: "FORBIDDEN",
                  message: `${format.toUpperCase()} export is not enabled for this report`,
                },
              },
              { status: 403 }
            );
          }

          if (!report.saved_query_id) {
            return json(
              {
                success: false,
                error: { code: "NO_QUERY", message: "Report has no associated query" },
              },
              { status: 400 }
            );
          }

          const query = await db
            .selectFrom("saved_queries")
            .selectAll()
            .where("id", "=", report.saved_query_id)
            .executeTakeFirst();

          if (!query) {
            return json(
              {
                success: false,
                error: { code: "QUERY_NOT_FOUND", message: "Associated query not found" },
              },
              { status: 404 }
            );
          }

          const dataSource = await db
            .selectFrom("data_sources")
            .selectAll()
            .where("id", "=", query.data_source_id)
            .where("is_active", "=", true)
            .executeTakeFirst();

          if (!dataSource) {
            return json(
              {
                success: false,
                error: { code: "DATASOURCE_NOT_FOUND", message: "Data source not found" },
              },
              { status: 404 }
            );
          }

          /*
           * The read-only test was already here; the access test was not, so an
           * export was a way to read a report whose data the caller may not see
           * — and to receive it as a file. Both questions are now asked through
           * one gate, so this route cannot drift from the others that run
           * stored SQL. See src/lib/permissions/runnable-query.ts.
           */
          const decision = await decideQueryRun(
            session.user,
            query.sql_content,
            query.data_source_id
          );
          if (!decision.ok) {
            return json(
              { success: false, error: { code: decision.code, message: decision.message } },
              { status: decision.status }
            );
          }

          const connection = await getConnection(dataSource as unknown as DataSource);

          const maxExportRows = parseInt(process.env.EXPORT_PAGE_SIZE || "10000", 10);
          const sqlToRun = query.sql_content.replace(/;$/, "").trim();
          const limitedSql = /\bLIMIT\s+\d+/i.test(sqlToRun)
            ? sqlToRun
            : `${sqlToRun} LIMIT ${maxExportRows}`;
          const { rows } = await kyselySql.raw(limitedSql).execute(connection);

          const typedRows = rows as Record<string, unknown>[];
          let columnConfig: ColumnDefinition[] = [];
          if (report.column_config) {
            try {
              columnConfig = JSON.parse(report.column_config);
            } catch {
              /* ignore */
            }
          }

          let filteredRows = typedRows;
          let headers: string[] = [];

          if (columnConfig.length > 0) {
            const visibleColumns = columnConfig.filter((col) => col.visible);
            headers = visibleColumns.map((col) => col.header);
            filteredRows = typedRows.map((row) => {
              const filteredRow: Record<string, unknown> = {};
              visibleColumns.forEach((col) => {
                if (col.field in row) filteredRow[col.field] = row[col.field];
              });
              return filteredRow;
            });
          } else {
            if (typedRows.length > 0) headers = Object.keys(typedRows[0]);
          }

          if (format === "csv") {
            const csvRows = [
              headers.join(","),
              ...filteredRows.map((row) =>
                headers
                  .map((header) => {
                    const colDef = columnConfig.find((c) => c.header === header);
                    const field = colDef?.field || header;
                    const value = row[field];
                    const stringValue = value === null || value === undefined ? "" : String(value);
                    if (
                      stringValue.includes(",") ||
                      stringValue.includes('"') ||
                      stringValue.includes("\n")
                    ) {
                      return `"${stringValue.replace(/"/g, '""')}"`;
                    }
                    return stringValue;
                  })
                  .join(",")
              ),
            ];
            const csvFilename = buildFilename(
              report.name || "report",
              report.filename_template,
              typedRows[0],
              "csv"
            );
            return new Response(csvRows.join("\n"), {
              headers: {
                "Content-Type": "text/csv",
                "Content-Disposition": `attachment; filename="${csvFilename}"`,
              },
            });
          }

          if (format === "xlsx") {
            const colorTheme = parseColorTheme(report.color_theme ?? null);
            const ExcelJS = await import("exceljs");
            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet("Report Data");

            const headerRow = worksheet.addRow(headers);
            headerRow.eachCell((cell) => {
              cell.font = {
                bold:
                  colorTheme?.headerFontWeight === "bold" || colorTheme?.headerFontWeight === "700",
                color: { argb: hexToARGB(colorTheme?.headerTextColor) },
              };
              cell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: hexToARGB(colorTheme?.headerBackgroundColor) },
              };
              cell.border = {
                top: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                left: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                bottom: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                right: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
              };
            });

            filteredRows.forEach((row, rowIndex) => {
              const isAltRow = rowIndex % 2 !== 0;
              const values = headers.map((header) => {
                const colDef = columnConfig.find((c) => c.header === header);
                const field = colDef?.field || header;
                const value = row[field];
                return value === null || value === undefined ? "" : value;
              });
              const dataRow = worksheet.addRow(values);
              dataRow.eachCell((cell) => {
                cell.font = {
                  color: {
                    argb: hexToARGB(
                      isAltRow ? colorTheme?.alternatingRowTextColor : colorTheme?.rowTextColor
                    ),
                  },
                };
                cell.fill = {
                  type: "pattern",
                  pattern: "solid",
                  fgColor: {
                    argb: hexToARGB(
                      isAltRow
                        ? colorTheme?.alternatingRowBackgroundColor
                        : colorTheme?.rowBackgroundColor
                    ),
                  },
                };
                cell.border = {
                  top: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                  left: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                  bottom: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                  right: { style: "thin", color: { argb: hexToARGB(colorTheme?.borderColor) } },
                };
              });
            });

            worksheet.columns.forEach((column) => {
              if (!column) return;
              let maxLength = 0;
              column.eachCell?.({ includeEmpty: true }, (cell) => {
                const length = cell.value ? String(cell.value).length : 10;
                if (length > maxLength) maxLength = length;
              });
              column.width = maxLength < 10 ? 10 : maxLength + 2;
            });

            const buffer = await workbook.xlsx.writeBuffer();
            const xlsxFilename = buildFilename(
              report.name || "report",
              report.filename_template,
              filteredRows[0],
              "xlsx"
            );
            return new Response(Buffer.from(buffer), {
              headers: {
                "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "Content-Disposition": `attachment; filename="${xlsxFilename}"`,
              },
            });
          }

          if (format === "pdf") {
            const colorTheme = parseColorTheme(report.color_theme ?? null);
            const { jsPDF } = await import("jspdf");
            const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
            const pageWidth = doc.internal.pageSize.getWidth();
            const pageHeight = doc.internal.pageSize.getHeight();
            const margin = 10;
            const tableTop = 30;
            const rowHeight = 7;
            const cellPadding = 2;

            doc.setFontSize(16);
            doc.setFont("helvetica", "bold");
            doc.text(report.name || "Report", margin, 15);
            doc.setFontSize(8);
            doc.setFont("helvetica", "normal");
            doc.text(`Generated: ${new Date().toLocaleString()}`, margin, 22);

            const numColumns = headers.length;
            const columnWidth = (pageWidth - 2 * margin) / numColumns;
            let yPosition = tableTop;

            const drawCell = (
              x: number,
              y: number,
              width: number,
              _height: number,
              text: string,
              bgColor: { r: number; g: number; b: number },
              textColor: { r: number; g: number; b: number },
              isBold = false
            ) => {
              doc.setFillColor(bgColor.r, bgColor.g, bgColor.b);
              doc.rect(x, y - rowHeight + cellPadding, width, rowHeight, "F");
              doc.setTextColor(textColor.r, textColor.g, textColor.b);
              doc.setFont("helvetica", isBold ? "bold" : "normal");
              const maxWidth = width - 2 * cellPadding;
              let displayText = text;
              if (doc.getTextWidth(text) > maxWidth) {
                while (doc.getTextWidth(`${displayText}...`) > maxWidth && displayText.length > 0) {
                  displayText = displayText.slice(0, -1);
                }
                displayText = `${displayText}...`;
              }
              doc.text(displayText, x + cellPadding, y);
            };

            doc.setFontSize(8);
            const headerBgColor = hexToRGB(colorTheme?.headerBackgroundColor);
            const headerTextColor = hexToRGB(colorTheme?.headerTextColor);
            const headerFontBold =
              colorTheme?.headerFontWeight === "bold" || colorTheme?.headerFontWeight === "700";

            headers.forEach((header, index) => {
              drawCell(
                margin + index * columnWidth,
                yPosition,
                columnWidth,
                rowHeight,
                String(header),
                headerBgColor,
                headerTextColor,
                headerFontBold
              );
            });
            yPosition += rowHeight;

            filteredRows.forEach((row, rowIndex) => {
              const isAltRow = rowIndex % 2 !== 0;
              const rowBgColor = hexToRGB(
                isAltRow
                  ? colorTheme?.alternatingRowBackgroundColor
                  : colorTheme?.rowBackgroundColor
              );
              const rowTextColor = hexToRGB(
                isAltRow ? colorTheme?.alternatingRowTextColor : colorTheme?.rowTextColor
              );

              if (yPosition > pageHeight - margin) {
                doc.addPage();
                yPosition = tableTop;
                headers.forEach((header, index) => {
                  drawCell(
                    margin + index * columnWidth,
                    yPosition,
                    columnWidth,
                    rowHeight,
                    String(header),
                    headerBgColor,
                    headerTextColor,
                    headerFontBold
                  );
                });
                yPosition += rowHeight;
              }

              headers.forEach((header, colIndex) => {
                const colDef = columnConfig.find((c) => c.header === header);
                const field = colDef?.field || header;
                const value = row[field];
                const stringValue = value === null || value === undefined ? "" : String(value);
                drawCell(
                  margin + colIndex * columnWidth,
                  yPosition,
                  columnWidth,
                  rowHeight,
                  stringValue,
                  rowBgColor,
                  rowTextColor,
                  false
                );
              });
              yPosition += rowHeight;
            });

            const totalPages = doc.getNumberOfPages();
            for (let i = 1; i <= totalPages; i++) {
              doc.setPage(i);
              doc.setFontSize(8);
              doc.setFont("helvetica", "normal");
              doc.setTextColor(0, 0, 0);
              doc.text(
                `Page ${i} of ${totalPages} | Total rows: ${filteredRows.length}`,
                pageWidth / 2,
                pageHeight - 5,
                { align: "center" }
              );
            }

            const pdfBytes = doc.output("arraybuffer");
            const pdfFilename = buildFilename(
              report.name || "report",
              report.filename_template,
              filteredRows[0],
              "pdf"
            );
            return new Response(Buffer.from(pdfBytes), {
              headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${pdfFilename}"`,
              },
            });
          }

          if (format === "html") {
            const colorTheme = parseColorTheme(report.color_theme ?? null);
            const headerBg = hexOr(colorTheme?.headerBackgroundColor, "#1e293b");
            const headerText = hexOr(colorTheme?.headerTextColor, "#ffffff");
            const rowBg = hexOr(colorTheme?.rowBackgroundColor, "#ffffff");
            const rowText = hexOr(colorTheme?.rowTextColor, "#334155");
            const altRowBg = hexOr(colorTheme?.alternatingRowBackgroundColor, "#f8fafc");
            const altRowText = hexOr(colorTheme?.alternatingRowTextColor, "#334155");
            const borderColor = hexOr(colorTheme?.borderColor, "#e2e8f0");

            const dataJson = JSON.stringify(filteredRows)
              .replace(/</g, "\\u003c")
              .replace(/>/g, "\\u003e");
            const headersJson = JSON.stringify(headers)
              .replace(/</g, "\\u003c")
              .replace(/>/g, "\\u003e");
            const reportName = (report.name || "Report").replace(/"/g, "&quot;");
            const exportTime = new Date().toLocaleString();
            const exportedBy = session?.user?.email || "Unknown";

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${reportName}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; background-color: #f5f5f5; }
    .container { max-width: 1400px; margin: 0 auto; background-color: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .header-info { border-bottom: 2px solid ${borderColor}; padding-bottom: 15px; margin-bottom: 20px; }
    h1 { font-size: 24px; margin-bottom: 10px; color: #1a1a1a; }
    .meta { font-size: 12px; color: #666; }
    .meta-line { margin: 4px 0; }
    h2 { font-size: 14px; font-weight: 600; margin-top: 15px; color: #333; }
    .controls { display: flex; gap: 12px; margin: 20px 0; flex-wrap: wrap; align-items: center; }
    input, select { padding: 8px 12px; border: 1px solid ${borderColor}; border-radius: 4px; font-size: 14px; }
    button { padding: 8px 16px; background-color: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background-color: #2563eb; }
    .table-wrapper { overflow-x: auto; border: 1px solid ${borderColor}; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; }
    thead { background-color: ${headerBg}; color: ${headerText}; }
    th { padding: 12px; text-align: left; font-weight: 600; border: 1px solid ${borderColor}; color: ${headerText}; }
    tbody tr { border-bottom: 1px solid ${borderColor}; }
    tbody tr:nth-child(odd) { background-color: ${rowBg}; }
    tbody tr:nth-child(odd) td { color: ${rowText}; }
    tbody tr:nth-child(even) { background-color: ${altRowBg}; }
    tbody tr:nth-child(even) td { color: ${altRowText}; }
    td { padding: 12px; border: 1px solid ${borderColor}; }
    .pagination { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
    .pagination button { padding: 6px 12px; min-width: 40px; }
    .pagination button:disabled { background-color: #d1d5db; cursor: not-allowed; }
    .pagination span { padding: 0 8px; }
    .info { font-size: 12px; color: #666; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-info">
      <h1>${reportName}</h1>
      <div class="meta">
        <div class="meta-line"><strong>Exported:</strong> ${exportTime}</div>
        <div class="meta-line"><strong>Exported by:</strong> ${exportedBy}</div>
      </div>
    </div>
    <div class="controls">
      <input type="text" id="searchInput" placeholder="Search all columns...">
      <select id="pageSizeSelect">
        <option value="10">10 rows</option>
        <option value="20">20 rows</option>
        <option value="50" selected>50 rows</option>
        <option value="100">100 rows</option>
      </select>
    </div>
    <div class="table-wrapper">
      <table id="dataTable">
        <thead id="tableHead"></thead>
        <tbody id="tableBody"></tbody>
      </table>
    </div>
    <div class="pagination">
      <button id="firstBtn">First</button>
      <button id="prevBtn">Previous</button>
      <span>Page <span id="pageNum">1</span> of <span id="pageCount">1</span></span>
      <button id="nextBtn">Next</button>
      <button id="lastBtn">Last</button>
    </div>
    <div class="info">
      <p>Total rows: <span id="totalRows">${filteredRows.length}</span> | Showing <span id="showing">0</span>-<span id="showingEnd">0</span></p>
    </div>
  </div>
  <script>
    const data = ${dataJson};
    const headers = ${headersJson};
    let pageSize = 50;
    let currentPage = 1;
    let filteredData = [...data];

    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
      return String(text).replace(/[&<>"']/g, c => map[c]);
    }

    function renderTable() {
      const tableHead = document.getElementById('tableHead');
      const headerCells = headers.map(h => '<th>' + escapeHtml(h) + '</th>').join('');
      tableHead.textContent = '';
      const headerRow = document.createElement('tr');
      headerRow.innerHTML = headerCells;
      tableHead.appendChild(headerRow);

      const start = (currentPage - 1) * pageSize;
      const end = start + pageSize;
      const pageData = filteredData.slice(start, end);

      const tableBody = document.getElementById('tableBody');
      tableBody.textContent = '';
      pageData.forEach(row => {
        const tr = document.createElement('tr');
        const cells = headers.map(h => '<td>' + escapeHtml(row[h] || '') + '</td>').join('');
        tr.innerHTML = cells;
        tableBody.appendChild(tr);
      });

      const pageCount = Math.ceil(filteredData.length / pageSize);
      document.getElementById('pageNum').textContent = currentPage;
      document.getElementById('pageCount').textContent = pageCount;
      document.getElementById('showing').textContent = start + 1;
      document.getElementById('showingEnd').textContent = Math.min(end, filteredData.length);

      document.getElementById('firstBtn').disabled = currentPage === 1;
      document.getElementById('prevBtn').disabled = currentPage === 1;
      document.getElementById('nextBtn').disabled = currentPage >= pageCount;
      document.getElementById('lastBtn').disabled = currentPage >= pageCount;
    }

    document.getElementById('searchInput').addEventListener('input', (e) => {
      const search = e.target.value.toLowerCase();
      filteredData = data.filter(row =>
        Object.values(row).some(v => String(v || '').toLowerCase().includes(search))
      );
      currentPage = 1;
      renderTable();
    });

    document.getElementById('pageSizeSelect').addEventListener('change', (e) => {
      pageSize = parseInt(e.target.value);
      currentPage = 1;
      renderTable();
    });

    document.getElementById('firstBtn').addEventListener('click', () => {
      currentPage = 1;
      renderTable();
    });

    document.getElementById('prevBtn').addEventListener('click', () => {
      if (currentPage > 1) currentPage--;
      renderTable();
    });

    document.getElementById('nextBtn').addEventListener('click', () => {
      const pageCount = Math.ceil(filteredData.length / pageSize);
      if (currentPage < pageCount) currentPage++;
      renderTable();
    });

    document.getElementById('lastBtn').addEventListener('click', () => {
      currentPage = Math.ceil(filteredData.length / pageSize);
      renderTable();
    });

    renderTable();
  </script>
</body>
</html>`;

            const htmlFilename = buildFilename(
              report.name || "report",
              report.filename_template,
              filteredRows[0],
              "html"
            );
            return new Response(html, {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Disposition": `attachment; filename="${htmlFilename}"`,
              },
            });
          }

          return json(
            { success: false, error: { code: "INVALID_FORMAT", message: "Invalid export format" } },
            { status: 400 }
          );
        } catch (error) {
          throw serverFailure(error, "Failed to export report");
        }
      }),
    },
  },
});
