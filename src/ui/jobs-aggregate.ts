import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import ExcelJS from "exceljs";
import {
  buildBuyerNameMapFromExtractedInvoices,
  buildDetailMapFromExtractedInvoices,
  mergeNamesIntoWorkbookWithMetadata,
} from "../export/merge.js";
import { pathExists, randomId } from "./helpers.js";
import { aggregateJobs } from "./state.js";
import type { AggregateFileProgress, AggregateJob, PurchasedAggregateType } from "./types.js";

const PURCHASED_TYPES: PurchasedAggregateType[] = ["hasCode", "noCode", "initCode"];

function createBlankProgress(): AggregateFileProgress {
  return {
    status: "pending",
    message: "Dang cho",
    matchedRows: 0,
    unmatchedRows: 0,
    matchedInvoiceKeys: [],
    unmatchedInvoiceKeys: [],
  };
}

export function createAggregateJob(): AggregateJob {
  const id = randomId();
  const blank = createBlankProgress();
  const job: AggregateJob = {
    id,
    status: "running",
    startedAt: Date.now(),
    files: {
      sold: { ...blank },
      purchased: { ...blank },
      purchasedTypes: {
        hasCode: { ...blank },
        noCode: { ...blank },
        initCode: { ...blank },
      },
    },
  };
  aggregateJobs.set(id, job);
  return job;
}

export function trimAggregateJobs(limit = 20): void {
  const all = Array.from(aggregateJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      aggregateJobs.delete(stale.id);
    }
  }
}

async function processAggregateFile(
  keyLabel: string,
  jsonPath: string,
  sourceXlsxPath: string,
  mode: "sold" | "purchased",
): Promise<{ progress: AggregateFileProgress; mergedOutput?: Buffer }> {
  const slot = createBlankProgress();
  slot.status = "running";
  slot.message = "Dang tong hop...";

  const hasJson = await pathExists(jsonPath);
  const hasXlsx = await pathExists(sourceXlsxPath);
  if (!hasJson || !hasXlsx) {
    slot.status = "skipped";
    slot.message = !hasJson && !hasXlsx ? "Khong tim thay JSON va XLSX" : !hasJson ? "Khong tim thay file JSON" : "Khong tim thay file XLSX";
    return { progress: slot };
  }

  try {
    const rawJson = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
      throw new Error("File JSON khong phai array");
    }

    const records = parsed as Array<Record<string, unknown>>;
    const detailMap = buildDetailMapFromExtractedInvoices(records, { mode });
    const buyerNames = buildBuyerNameMapFromExtractedInvoices(records);
    const xlsxBuffer = await fs.readFile(sourceXlsxPath);
    const merged = await mergeNamesIntoWorkbookWithMetadata(xlsxBuffer, detailMap, { buyerNames });

    slot.status = "success";
    slot.message = `${keyLabel}: ${merged.matchedRows} khop, ${merged.unmatchedRows} khong khop`;
    slot.matchedRows = merged.matchedRows;
    slot.unmatchedRows = merged.unmatchedRows;
    slot.matchedInvoiceKeys = merged.matchedInvoiceKeys;
    slot.unmatchedInvoiceKeys = merged.unmatchedInvoiceKeys;
    return { progress: slot, mergedOutput: merged.output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    slot.status = "failed";
    slot.message = message.slice(0, 200);
    return { progress: slot };
  }
}

function copyWorksheetContent(source: ExcelJS.Worksheet, target: ExcelJS.Worksheet): void {
  source.columns.forEach((column, index) => {
    target.getColumn(index + 1).width = column.width;
  });

  for (let rowIndex = 1; rowIndex <= source.rowCount; rowIndex += 1) {
    const sourceRow = source.getRow(rowIndex);
    const targetRow = target.getRow(rowIndex);
    targetRow.height = sourceRow.height;

    sourceRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const outCell = targetRow.getCell(columnNumber);
      outCell.value = cell.value;
      outCell.style = { ...cell.style };
      outCell.numFmt = cell.numFmt;
    });
  }

  const merges = source.model?.merges ?? [];
  for (const mergeRef of merges) {
    target.mergeCells(String(mergeRef));
  }
}

async function buildPurchasedWorkbook(
  outputPath: string,
  sheets: Record<PurchasedAggregateType, Buffer | undefined>,
): Promise<void> {
  const outWorkbook = new ExcelJS.Workbook();

  for (const type of PURCHASED_TYPES) {
    const buffer = sheets[type];
    if (!buffer) {
      const empty = outWorkbook.addWorksheet(type);
      empty.getCell("A1").value = `Khong co du lieu cho ${type}`;
      continue;
    }

    const sourceWorkbook = new ExcelJS.Workbook();
    await sourceWorkbook.xlsx.load(Buffer.from(buffer) as any);
    const sourceSheet = sourceWorkbook.worksheets[0];
    const targetSheet = outWorkbook.addWorksheet(type);
    if (!sourceSheet) {
      targetSheet.getCell("A1").value = `Khong doc duoc du lieu cho ${type}`;
      continue;
    }

    copyWorksheetContent(sourceSheet, targetSheet);
  }

  const payload = await outWorkbook.xlsx.writeBuffer();
  await fs.writeFile(outputPath, Buffer.from(payload));
}

export async function runAggregateJob(job: AggregateJob): Promise<void> {
  const soldJson = join(process.cwd(), "gdt-xml-export", "hd_sold.json");
  const soldXlsx = join(process.cwd(), "src", "xlsx", "hd_sold.xlsx");
  const outputDir = join(process.cwd(), "gdt-aggregated-xlsx");
  await fs.mkdir(outputDir, { recursive: true });

  const soldResult = await processAggregateFile("hd_sold", soldJson, soldXlsx, "sold");
  job.files.sold = soldResult.progress;
  if (soldResult.progress.status === "success" && soldResult.mergedOutput) {
    const soldOutputPath = join(outputDir, `${basename(soldXlsx, extname(soldXlsx))}_merged${extname(soldXlsx)}`);
    await fs.writeFile(soldOutputPath, soldResult.mergedOutput);
    job.files.sold.outputPath = soldOutputPath;
    job.files.sold.message = `Da xuat file moi: ${soldOutputPath} (${job.files.sold.matchedRows} khop, ${job.files.sold.unmatchedRows} khong khop)`;
  }

  const purchasedSheets: Record<PurchasedAggregateType, Buffer | undefined> = {
    hasCode: undefined,
    noCode: undefined,
    initCode: undefined,
  };

  for (const type of PURCHASED_TYPES) {
    const jsonPath = join(process.cwd(), "gdt-xml-export", `hd_purchased_${type}.json`);
    const xlsxPath = join(process.cwd(), "src", "xlsx", `hd_purchased_${type}.xlsx`);
    const result = await processAggregateFile(`hd_purchased_${type}`, jsonPath, xlsxPath, "purchased");
    if (job.files.purchasedTypes) {
      job.files.purchasedTypes[type] = result.progress;
    }
    if (result.progress.status === "success") {
      purchasedSheets[type] = result.mergedOutput;
    }
  }

  const purchasedTypeStates = PURCHASED_TYPES.map((type) => job.files.purchasedTypes?.[type].status ?? "failed");
  const purchasedHasFailed = purchasedTypeStates.includes("failed");
  const purchasedHasSuccess = purchasedTypeStates.includes("success");
  const purchasedOutputPath = join(outputDir, "hd_purchased_merged.xlsx");

  const purchasedSummary = createBlankProgress();
  purchasedSummary.status = purchasedHasFailed ? "failed" : purchasedHasSuccess ? "success" : "failed";
  purchasedSummary.matchedRows = PURCHASED_TYPES.reduce(
    (total, type) => total + (job.files.purchasedTypes?.[type].matchedRows ?? 0),
    0,
  );
  purchasedSummary.unmatchedRows = PURCHASED_TYPES.reduce(
    (total, type) => total + (job.files.purchasedTypes?.[type].unmatchedRows ?? 0),
    0,
  );
  purchasedSummary.matchedInvoiceKeys = PURCHASED_TYPES.flatMap((type) =>
    (job.files.purchasedTypes?.[type].matchedInvoiceKeys ?? []).map((key) => `${type}:${key}`),
  );
  purchasedSummary.unmatchedInvoiceKeys = PURCHASED_TYPES.flatMap((type) =>
    (job.files.purchasedTypes?.[type].unmatchedInvoiceKeys ?? []).map((key) => `${type}:${key}`),
  );

  if (purchasedHasSuccess) {
    await buildPurchasedWorkbook(purchasedOutputPath, purchasedSheets);
    purchasedSummary.outputPath = purchasedOutputPath;
    purchasedSummary.message = `Da xuat file moi: ${purchasedOutputPath} (${purchasedSummary.matchedRows} khop, ${purchasedSummary.unmatchedRows} khong khop)`;
  } else {
    purchasedSummary.message = "Khong co du lieu purchased hop le de tong hop";
  }
  job.files.purchased = purchasedSummary;

  const statuses = [job.files.sold.status, job.files.purchased.status];
  const hasFailed = statuses.includes("failed");
  const hasSuccess = statuses.includes("success");
  job.status = hasFailed ? "failed" : hasSuccess ? "success" : "failed";
  job.finishedAt = Date.now();
  trimAggregateJobs();
}
