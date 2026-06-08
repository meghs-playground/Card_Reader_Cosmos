/**
 * Export Engine
 * -------------
 * Builds CSV / XLSX / JSON exports of approved leads in the exact Cosmos CRM
 * column order. Guarantees from the spec:
 *   - Export always contains ALL approved leads matching the filter.
 *   - Never overwrites previous exports: each export is written to a new,
 *     timestamped file and recorded in the `exports` table.
 *
 * Multi-contact cards expand into multiple rows (primary + extras) so every
 * person on a card lands in the CRM.
 */

const fs = require("fs");
const path = require("path");
const { stringify } = require("csv-stringify/sync");
const ExcelJS = require("exceljs");
const {
  COSMOS_COLUMNS,
  mapLeadToCosmos,
  mapAdditionalContacts,
} = require("./crmMapping");

const EXPORT_DIR = process.env.EXPORT_DIR || path.resolve("exports/output");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampedName(format) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `cosmos_leads_${ts}.${format}`;
}

/** Expand leads -> ordered array-of-objects rows in Cosmos column order. */
function buildRows(leads, opts) {
  const rows = [];
  for (const lead of leads) {
    rows.push(mapLeadToCosmos(lead, opts));
    rows.push(...mapAdditionalContacts(lead, opts));
  }
  return rows;
}

function toCSV(rows) {
  // Explicit columns => stable order, headers exactly as Cosmos expects.
  return stringify(rows, { header: true, columns: COSMOS_COLUMNS });
}

async function toXLSX(rows, filePath) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leads");
  ws.columns = COSMOS_COLUMNS.map((c) => ({ header: c, key: c, width: 22 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: "pattern", pattern: "solid", fgColor: { argb: "FF0A1F44" },
  };
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  rows.forEach((r) => ws.addRow(r));
  await wb.xlsx.writeFile(filePath);
}

function toJSON(rows) {
  return JSON.stringify(rows, null, 2);
}

/**
 * @param {Array}  leads  approved leads (with contacts + company included)
 * @param {string} format "CSV" | "XLSX" | "JSON"
 * @param {object} opts   mapping options (defaults, salesBranchBySource)
 * @returns {{ filePath, fileName, rowCount }}
 */
async function generateExport(leads, format, opts = {}) {
  ensureDir(EXPORT_DIR);
  const rows = buildRows(leads, opts);
  const ext = format.toLowerCase();
  const fileName = timestampedName(ext);
  const filePath = path.join(EXPORT_DIR, fileName);

  if (format === "CSV") {
    fs.writeFileSync(filePath, toCSV(rows), "utf8");
  } else if (format === "XLSX") {
    await toXLSX(rows, filePath);
  } else if (format === "JSON") {
    fs.writeFileSync(filePath, toJSON(rows), "utf8");
  } else {
    throw new Error(`Unsupported export format: ${format}`);
  }

  return { filePath, fileName, rowCount: rows.length };
}

module.exports = { generateExport, buildRows, COSMOS_COLUMNS };
