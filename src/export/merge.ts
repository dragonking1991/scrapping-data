import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import {
  type InvoiceBuyerNameMap,
  type InvoiceCrawlMetadataMap,
  type InvoiceNameMap,
} from "../shared/types.js";

interface MergeResult {
  output: Buffer;
  unmatchedRows: number;
  matchedRows: number;
  matchedInvoiceKeys: string[];
  unmatchedInvoiceKeys: string[];
}

interface ExtractedInvoiceLike {
  khhdon?: string;
  shdon?: string;
  info?: Record<string, unknown>;
  lineItems?: Array<Record<string, unknown>>;
  itemNames?: string[];
}

type ExtractedInvoiceMode = "sold" | "purchased";

interface BuildDetailMapOptions {
  mode?: ExtractedInvoiceMode;
}

interface MergeOptions {
  metadata?: InvoiceCrawlMetadataMap;
  buyerNames?: InvoiceBuyerNameMap;
}

const DETAIL_HEADER = "Chi tiết hoá đơn";
const BUYER_NAME_HEADER = "Họ tên người mua hàng";

function normalize(value: unknown): string {
  if (value == null) {
    return "";
  }

  if (typeof value === "object") {
    const obj = value as { text?: unknown; richText?: Array<{ text?: unknown }> };
    if (typeof obj.text === "string") {
      return obj.text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[đĐ]/g, "d")
        .toLowerCase()
        .trim();
    }

    if (Array.isArray(obj.richText)) {
      const merged = obj.richText.map((part) => String(part.text ?? "")).join("");
      return merged
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[đĐ]/g, "d")
        .toLowerCase()
        .trim();
    }
  }

  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .trim();
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) {
    return "";
  }

  if (typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }

  return String(value).trim();
}

function detailCellText(value: unknown): string {
  if (value == null) {
    return "";
  }

  return String(value).trim();
}

function joinDetailFields(fields: string[]): string {
  return fields
    .map((field) => field.trim())
    .filter(Boolean)
    .join(" - ");
}

function toPercentText(raw: string): string {
  const v = raw.trim();
  if (!v) {
    return "";
  }

  if (v.endsWith("%")) {
    return v;
  }

  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n > 0 && n < 1) {
      return `${(n * 100).toFixed(0)}%`;
    }
    return `${n.toFixed(0)}%`;
  }

  return v;
}

function firstNonEmpty(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = detailCellText(item[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizeTinhChat(raw: string): string {
  const v = raw.trim();
  if (v === "1") {
    return "Hàng hóa, dịch vụ";
  }
  if (v === "4") {
    return "Ghi chú, diễn giải";
  }
  return v;
}

function normalizeMoney(raw: string): string {
  const v = raw.trim();
  if (!v) {
    return "";
  }

  const isNegative = v.startsWith("-");
  const digits = v.replace(/[^0-9]/g, "");
  if (!digits) {
    return "";
  }

  const normalizedDigits = digits.replace(/^0+(?=\d)/, "");
  const formatted = normalizedDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return isNegative && formatted !== "0" ? `-${formatted}` : formatted;
}

function normalizeQuantity(raw: string): string {
  const v = raw.trim().replace(/\s+/g, "");
  if (!v) {
    return "";
  }

  if (/^-?\d+$/.test(v)) {
    return v;
  }

  const hasComma = v.includes(",");
  const hasDot = v.includes(".");

  if (hasComma && hasDot) {
    const lastComma = v.lastIndexOf(",");
    const lastDot = v.lastIndexOf(".");
    const decimalIdx = Math.max(lastComma, lastDot);
    const intPart = v.slice(0, decimalIdx).replace(/[.,]/g, "");
    const fracPart = v.slice(decimalIdx + 1).replace(/[.,]/g, "");
    return fracPart ? `${intPart || "0"}.${fracPart}` : intPart;
  }

  if (hasComma) {
    return v.replace(/,/g, ".");
  }

  return v;
}

function formatLineItemRecord(item: Record<string, unknown>): string {
  const ten = firstNonEmpty(item, ["ten", "Tên hàng hóa, dịch vụ", "Ten hang hoa, dich vu"]);
  const sluong = normalizeQuantity(firstNonEmpty(item, ["sluong", "Số lượng", "So luong"]));
  const dvtinh = firstNonEmpty(item, ["dvtinh", "Đơn vị tính", "Don vi tinh"]);
  const dgia = normalizeMoney(firstNonEmpty(item, ["dgia", "Đơn giá", "Don gia"]));
  const thtien = normalizeMoney(
    firstNonEmpty(item, ["thtien", "Thành tiền chưa có thuế GTGT", "Thanh tien chua co thue GTGT"]),
  );
  const ltsuat = firstNonEmpty(item, ["ltsuat", "Thuế suất", "Thue suat"]) || toPercentText(firstNonEmpty(item, ["tsuat"]));

  return joinDetailFields([ten, sluong, dvtinh, dgia, thtien, ltsuat]);
}

function formatPurchasedLineItemRecord(item: Record<string, unknown>): string {
  const tinhChat = normalizeTinhChat(firstNonEmpty(item, ["Tính chất", "Tinh chat", "tinhchat", "tchat"]));
  const ten = firstNonEmpty(item, ["Tên hàng hóa, dịch vụ", "Ten hang hoa, dich vu", "ten"]);
  const soLuong = normalizeQuantity(firstNonEmpty(item, ["Số lượng", "So luong", "sluong"]));
  const donViTinh = firstNonEmpty(item, ["Đơn vị tính", "Don vi tinh", "dvtinh"]);
  const donGia = normalizeMoney(firstNonEmpty(item, ["Đơn giá", "Don gia", "dgia"]));
  const thanhTien = normalizeMoney(
    firstNonEmpty(item, ["Thành tiền chưa có thuế GTGT", "Thanh tien chua co thue GTGT", "thtien"]),
  );
  const thueSuat = firstNonEmpty(item, ["Thuế suất", "Thue suat", "ltsuat"]) || toPercentText(firstNonEmpty(item, ["tsuat"]));

  return joinDetailFields([tinhChat, ten, soLuong, donViTinh, donGia, thanhTien, thueSuat]);
}

function buildDetailTextFromLineItems(lineItems: Array<Record<string, unknown>>, mode: ExtractedInvoiceMode): string {
  const formatter = mode === "purchased" ? formatPurchasedLineItemRecord : formatLineItemRecord;
  return lineItems.map(formatter).filter(Boolean).join("\n");
}

function numberDetailLines(detail: string): string {
  const lines = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return lines[0] ?? "";
  }

  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

function formatItemNameAsDetailLine(name: string, mode: ExtractedInvoiceMode): string {
  const ten = detailCellText(name);
  if (!ten) {
    return "";
  }

  if (mode === "purchased") {
    return joinDetailFields(["", ten, "", "", "", "", ""]);
  }

  return joinDetailFields([ten, "", "", "", "", ""]);
}

function extractBuyerFullName(info?: Record<string, unknown>): string {
  if (!info) {
    return "";
  }

  const direct = detailCellText(info.nmtnmua);
  if (direct) {
    return direct;
  }

  for (const [key, value] of Object.entries(info)) {
    const normalizedKey = normalize(key);
    if (normalizedKey.includes("ho ten nguoi mua hang")) {
      const text = detailCellText(value);
      if (text) {
        return text;
      }
    }
  }

  return "";
}

function storeBuyerName(map: InvoiceBuyerNameMap, shdon: string, khhdon: string, buyerFullName: string): void {
  if (!buyerFullName) {
    return;
  }

  map.byNumberOnly.set(shdon, buyerFullName);
  if (khhdon) {
    map.byComposite.set(`${khhdon}|${shdon}`, buyerFullName);
  }
}

function detectOrCreateDetailColumn(headerRow: ExcelJS.Row): number {
  let detailCol: number | null = null;
  let legacyResultCol: number | null = null;

  headerRow.eachCell((cell, col) => {
    const normalized = normalize(cell.value);
    if (normalized.includes("chi tiet hoa don") && detailCol == null) {
      detailCol = col;
    }
    if (normalized.includes("ket qua kiem tra hoa don") && legacyResultCol == null) {
      legacyResultCol = col;
    }
  });

  const targetCol = detailCol ?? legacyResultCol ?? (headerRow.cellCount + 1);
  headerRow.getCell(targetCol).value = DETAIL_HEADER;
  return targetCol;
}

function detectColumns(headerRow: ExcelJS.Row): { numberCol: number; symbolCol: number | null } {
  let numberCol = -1;
  let symbolCol: number | null = null;

  headerRow.eachCell((cell, col) => {
    const normalized = normalize(cell.value);
    if (normalized.includes("so hoa don") && numberCol === -1) {
      numberCol = col;
    }

    if (normalized.includes("ky hieu hoa don") && symbolCol == null) {
      symbolCol = col;
    }
  });

  if (numberCol === -1) {
    throw new Error("Khong tim thay cot 'So hoa don' trong file xlsx goc");
  }

  return { numberCol, symbolCol };
}

function findHeaderRow(sheet: ExcelJS.Worksheet): number {
  const maxScan = Math.min(sheet.rowCount, 20);
  for (let i = 1; i <= maxScan; i += 1) {
    const row = sheet.getRow(i);
    const values = row.values as unknown[];
    const hasInvoiceNumber = values.some((v) => normalize(v).includes("so hoa don"));
    if (hasInvoiceNumber) {
      return i;
    }
  }

  throw new Error("Khong xac dinh duoc dong header cua file xlsx");
}

function ensureBuyerNameColumn(headerRow: ExcelJS.Row): number {
  let buyerNameCol: number | null = null;
  let detailCol: number | null = null;

  headerRow.eachCell((cell, col) => {
    const normalized = normalize(cell.value);
    if (normalized.includes("ho ten nguoi mua hang") && buyerNameCol == null) {
      buyerNameCol = col;
    }
    if (normalized.includes("chi tiet hoa don") && detailCol == null) {
      detailCol = col;
    }
  });

  if (buyerNameCol != null) {
    headerRow.getCell(buyerNameCol).value = BUYER_NAME_HEADER;
    return buyerNameCol;
  }

  const insertAt = detailCol ?? headerRow.cellCount + 1;
  headerRow.worksheet.spliceColumns(insertAt, 0, []);
  headerRow.getCell(insertAt).value = BUYER_NAME_HEADER;
  return insertAt;
}

export function buildDetailMapFromExtractedInvoices(
  records: ExtractedInvoiceLike[],
  options: BuildDetailMapOptions = {},
): InvoiceNameMap {
  const mode = options.mode ?? "sold";
  const byComposite = new Map<string, string>();
  const byNumberOnly = new Map<string, string>();

  for (const record of records) {
    const shdon = detailCellText(record.shdon);
    if (!shdon) {
      continue;
    }

    const khhdon = detailCellText(record.khhdon).toUpperCase();
    const fromLines = buildDetailTextFromLineItems((record.lineItems ?? []).filter(Boolean), mode);
    const fromNames = (record.itemNames ?? []).map((name) => formatItemNameAsDetailLine(name, mode)).filter(Boolean).join("\n");
    const detail = numberDetailLines(fromLines || fromNames);

    if (!detail) {
      continue;
    }

    byNumberOnly.set(shdon, detail);
    if (khhdon) {
      byComposite.set(`${khhdon}|${shdon}`, detail);
    }
  }

  return { byComposite, byNumberOnly };
}

export function buildBuyerNameMapFromExtractedInvoices(records: ExtractedInvoiceLike[]): InvoiceBuyerNameMap {
  const map: InvoiceBuyerNameMap = {
    byComposite: new Map<string, string>(),
    byNumberOnly: new Map<string, string>(),
  };

  for (const record of records) {
    const shdon = detailCellText(record.shdon);
    if (!shdon) {
      continue;
    }

    const khhdon = detailCellText(record.khhdon).toUpperCase();
    const buyerFullName = extractBuyerFullName(record.info);
    storeBuyerName(map, shdon, khhdon, buyerFullName);
  }

  return map;
}

export async function mergeNamesIntoWorkbook(
  input: Uint8Array,
  map: InvoiceNameMap,
  buyerNames?: InvoiceBuyerNameMap,
): Promise<MergeResult> {
  const workbook = new ExcelJS.Workbook();
  const stream = new PassThrough();
  stream.end(Buffer.from(input));
  await workbook.xlsx.read(stream);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("File xlsx khong co worksheet nao");
  }

  const headerRowIndex = findHeaderRow(sheet);
  const headerRow = sheet.getRow(headerRowIndex);
  const { numberCol, symbolCol } = detectColumns(headerRow);

  const buyerNameCol = ensureBuyerNameColumn(headerRow);
  const targetCol = detectOrCreateDetailColumn(headerRow);

  let unmatchedRows = 0;
  let matchedRows = 0;
  const matchedInvoiceKeys: string[] = [];
  const unmatchedInvoiceKeys: string[] = [];

  for (let rowIndex = headerRowIndex + 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    const shdon = cellText(row.getCell(numberCol).value).trim();
    if (!shdon) {
      continue;
    }

    const symbol = symbolCol ? cellText(row.getCell(symbolCol).value).trim().toUpperCase() : "";
    const compositeKey = symbol ? `${symbol}|${shdon}` : "";
    const invoiceKey = symbol ? `${symbol}|${shdon}` : shdon;
    const byComposite = compositeKey ? map.byComposite.get(compositeKey) : undefined;
    const byNumber = map.byNumberOnly.get(shdon);
    const name = byComposite ?? byNumber;
    const buyerName =
      (compositeKey ? buyerNames?.byComposite.get(compositeKey) : undefined) ?? buyerNames?.byNumberOnly.get(shdon);

    row.getCell(buyerNameCol).value = buyerName ?? "";
    row.getCell(buyerNameCol).alignment = { wrapText: true, vertical: "top" };

    if (name) {
      row.getCell(targetCol).value = name;
      row.getCell(targetCol).alignment = { wrapText: true, vertical: "top" };
      matchedRows += 1;
      matchedInvoiceKeys.push(invoiceKey);
    } else {
      row.getCell(targetCol).value = "";
      row.getCell(targetCol).alignment = { wrapText: true, vertical: "top" };
      unmatchedRows += 1;
      unmatchedInvoiceKeys.push(invoiceKey);
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return {
    output: Buffer.from(output),
    unmatchedRows,
    matchedRows,
    matchedInvoiceKeys,
    unmatchedInvoiceKeys,
  };
}

export async function mergeNamesIntoWorkbookWithMetadata(
  input: Uint8Array,
  map: InvoiceNameMap,
  options: MergeOptions = {},
): Promise<MergeResult> {
  const workbook = new ExcelJS.Workbook();
  const stream = new PassThrough();
  stream.end(Buffer.from(input));
  await workbook.xlsx.read(stream);

  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("File xlsx khong co worksheet nao");
  }

  const headerRowIndex = findHeaderRow(sheet);
  const headerRow = sheet.getRow(headerRowIndex);
  const { numberCol, symbolCol } = detectColumns(headerRow);

  const buyerNameCol = ensureBuyerNameColumn(headerRow);
  const detailCol = detectOrCreateDetailColumn(headerRow);

  let unmatchedRows = 0;
  let matchedRows = 0;
  const matchedInvoiceKeys: string[] = [];
  const unmatchedInvoiceKeys: string[] = [];

  for (let rowIndex = headerRowIndex + 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    const shdon = cellText(row.getCell(numberCol).value).trim();
    if (!shdon) {
      continue;
    }

    const symbol = symbolCol ? cellText(row.getCell(symbolCol).value).trim().toUpperCase() : "";
    const compositeKey = symbol ? `${symbol}|${shdon}` : "";
    const invoiceKey = symbol ? `${symbol}|${shdon}` : shdon;
    const byComposite = compositeKey ? map.byComposite.get(compositeKey) : undefined;
    const byNumber = map.byNumberOnly.get(shdon);
    const name = byComposite ?? byNumber;
    const buyerName =
      (compositeKey ? options.buyerNames?.byComposite.get(compositeKey) : undefined) ??
      options.buyerNames?.byNumberOnly.get(shdon);

    row.getCell(buyerNameCol).value = buyerName ?? "";
    row.getCell(buyerNameCol).alignment = { wrapText: true, vertical: "top" };

    if (name) {
      row.getCell(detailCol).value = name;
      row.getCell(detailCol).alignment = { wrapText: true, vertical: "top" };
      matchedRows += 1;
      matchedInvoiceKeys.push(invoiceKey);
    } else {
      row.getCell(detailCol).value = "";
      row.getCell(detailCol).alignment = { wrapText: true, vertical: "top" };
      unmatchedRows += 1;
      unmatchedInvoiceKeys.push(invoiceKey);
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return {
    output: Buffer.from(output),
    unmatchedRows,
    matchedRows,
    matchedInvoiceKeys,
    unmatchedInvoiceKeys,
  };
}