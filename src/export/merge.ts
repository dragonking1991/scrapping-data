import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { type InvoiceCrawlMetadataMap, type InvoiceNameMap } from "../shared/types.js";

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
  lineItems?: Array<Record<string, unknown>>;
  itemNames?: string[];
}

type ExtractedInvoiceMode = "sold" | "purchased";

interface BuildDetailMapOptions {
  mode?: ExtractedInvoiceMode;
}

const DETAIL_HEADER = "Chi tiết hoá đơn";

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
  const ten = detailCellText(item.ten);
  const sluong = detailCellText(item.sluong);
  const dvtinh = detailCellText(item.dvtinh);
  const dgia = detailCellText(item.dgia);
  const thtien = detailCellText(item.thtien);
  const ltsuat = detailCellText(item.ltsuat) || toPercentText(detailCellText(item.tsuat));

  const fields = [ten, sluong, dvtinh, dgia, thtien, ltsuat];
  if (fields.every((field) => field === "")) {
    return "";
  }

  return fields.join(",");
}

function formatPurchasedLineItemRecord(item: Record<string, unknown>): string {
  const tinhChat = normalizeTinhChat(
    firstNonEmpty(item, ["Tính chất", "Tinh chat", "tinhchat", "tchat"]),
  );
  const ten = firstNonEmpty(item, ["Tên hàng hóa, dịch vụ", "Ten hang hoa, dich vu", "ten"]);
  const soLuong = normalizeQuantity(firstNonEmpty(item, ["Số lượng", "So luong", "sluong"]));
  const donViTinh = firstNonEmpty(item, ["Đơn vị tính", "Don vi tinh", "dvtinh"]);
  const donGia = normalizeMoney(firstNonEmpty(item, ["Đơn giá", "Don gia", "dgia"]));
  const thanhTien = normalizeMoney(
    firstNonEmpty(item, ["Thành tiền chưa có thuế GTGT", "Thanh tien chua co thue GTGT", "thtien"]),
  );
  const thueSuat =
    firstNonEmpty(item, ["Thuế suất", "Thue suat", "ltsuat"]) ||
    toPercentText(firstNonEmpty(item, ["tsuat"]));

  const fields = [tinhChat, ten, soLuong, donViTinh, donGia, thanhTien, thueSuat];
  if (fields.every((field) => field === "")) {
    return "";
  }

  return fields.join(",");
}

function buildDetailTextFromLineItems(lineItems: Array<Record<string, unknown>>, mode: ExtractedInvoiceMode): string {
  const formatter = mode === "purchased" ? formatPurchasedLineItemRecord : formatLineItemRecord;
  return lineItems.map(formatter).filter(Boolean).join("\n");
}

function formatItemNameAsDetailLine(name: string, mode: ExtractedInvoiceMode): string {
  const ten = detailCellText(name);
  if (!ten) {
    return "";
  }

  if (mode === "purchased") {
    // Ordered as: Tinh chat, Ten hang hoa, So luong, Don vi tinh, Don gia, Thanh tien, Thue suat
    return ["", ten, "", "", "", "", ""].join(",");
  }

  // Sold format: ten, sluong, dvtinh, dgia, thtien, ltsuat
  return [ten, "", "", "", "", ""].join(",");
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
    const detail = fromLines || fromNames;

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

export async function mergeNamesIntoWorkbook(input: Uint8Array, map: InvoiceNameMap): Promise<MergeResult> {
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
    const invoiceKey = symbol ? `${symbol}|${shdon}` : shdon;
    const byComposite = symbol ? map.byComposite.get(`${symbol}|${shdon}`) : undefined;
    const byNumber = map.byNumberOnly.get(shdon);
    const name = byComposite ?? byNumber;

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

interface MergeOptions {
  metadata?: InvoiceCrawlMetadataMap;
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
    const byComposite = symbol ? map.byComposite.get(compositeKey) : undefined;
    const byNumber = map.byNumberOnly.get(shdon);
    const name = byComposite ?? byNumber;

    const metadata =
      (compositeKey ? options.metadata?.byComposite.get(compositeKey) : undefined) ??
      options.metadata?.byNumberOnly.get(shdon);

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

    void metadata;
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
