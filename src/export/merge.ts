import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { type InvoiceCrawlMetadataMap, type InvoiceNameMap } from "../shared/types.js";

interface MergeResult {
  output: Buffer;
  unmatchedRows: number;
  matchedRows: number;
}

function normalize(value: unknown): string {
  if (value == null) {
    return "";
  }

  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
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

  const targetCol = headerRow.cellCount + 1;
  headerRow.getCell(targetCol).value = "Tên hàng hóa, dịch vụ";

  let unmatchedRows = 0;
  let matchedRows = 0;

  for (let rowIndex = headerRowIndex + 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    const shdon = cellText(row.getCell(numberCol).value).trim();
    if (!shdon) {
      continue;
    }

    const symbol = symbolCol ? cellText(row.getCell(symbolCol).value).trim().toUpperCase() : "";
    const byComposite = symbol ? map.byComposite.get(`${symbol}|${shdon}`) : undefined;
    const byNumber = map.byNumberOnly.get(shdon);
    const name = byComposite ?? byNumber;

    if (name) {
      row.getCell(targetCol).value = name;
      matchedRows += 1;
    } else {
      row.getCell(targetCol).value = "";
      unmatchedRows += 1;
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return {
    output: Buffer.from(output),
    unmatchedRows,
    matchedRows,
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

  const startCol = headerRow.cellCount + 1;
  const nameCol = startCol;
  const sourceCol = startCol + 1;
  const crawledAtCol = startCol + 2;
  const pageCol = startCol + 3;
  const itemCountCol = startCol + 4;
  const statusCol = startCol + 5;

  headerRow.getCell(nameCol).value = "Tên hàng hóa, dịch vụ";
  headerRow.getCell(sourceCol).value = "Nguon du lieu";
  headerRow.getCell(crawledAtCol).value = "Thoi diem crawl";
  headerRow.getCell(pageCol).value = "Trang";
  headerRow.getCell(itemCountCol).value = "So luong dong hang hoa";
  headerRow.getCell(statusCol).value = "Tinh trang crawl";

  let unmatchedRows = 0;
  let matchedRows = 0;

  for (let rowIndex = headerRowIndex + 1; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    const shdon = cellText(row.getCell(numberCol).value).trim();
    if (!shdon) {
      continue;
    }

    const symbol = symbolCol ? cellText(row.getCell(symbolCol).value).trim().toUpperCase() : "";
    const compositeKey = symbol ? `${symbol}|${shdon}` : "";
    const byComposite = symbol ? map.byComposite.get(compositeKey) : undefined;
    const byNumber = map.byNumberOnly.get(shdon);
    const name = byComposite ?? byNumber;

    const metadata =
      (compositeKey ? options.metadata?.byComposite.get(compositeKey) : undefined) ??
      options.metadata?.byNumberOnly.get(shdon);

    if (name) {
      row.getCell(nameCol).value = name;
      matchedRows += 1;
    } else {
      row.getCell(nameCol).value = "";
      unmatchedRows += 1;
    }

    row.getCell(sourceCol).value = metadata?.source ?? "api";
    row.getCell(crawledAtCol).value = metadata?.crawledAt ?? "";
    row.getCell(pageCol).value = metadata?.page ?? "";
    row.getCell(itemCountCol).value = metadata?.itemCount ?? 0;
    row.getCell(statusCol).value = metadata?.status ?? (name ? "success" : "failed");
  }

  const output = await workbook.xlsx.writeBuffer();
  return {
    output: Buffer.from(output),
    unmatchedRows,
    matchedRows,
  };
}
