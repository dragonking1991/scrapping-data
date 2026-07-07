import { promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  buildBuyerNameMapFromExtractedInvoices,
  buildDetailMapFromExtractedInvoices,
  mergeNamesIntoWorkbookWithMetadata,
} from "../export/merge.js";
import { pathExists, randomId } from "./helpers.js";
import { aggregateJobs } from "./state.js";
import type { AggregateFileProgress, AggregateJob } from "./types.js";

export function createAggregateJob(): AggregateJob {
  const id = randomId();
  const blank: AggregateFileProgress = {
    status: "pending",
    message: "Dang cho",
    matchedRows: 0,
    unmatchedRows: 0,
    matchedInvoiceKeys: [],
    unmatchedInvoiceKeys: [],
  };
  const job: AggregateJob = {
    id,
    status: "running",
    startedAt: Date.now(),
    files: {
      sold: { ...blank },
      purchased: { ...blank },
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
  job: AggregateJob,
  key: "sold" | "purchased",
  jsonPath: string,
  sourceXlsxPath: string,
  outputDir: string,
): Promise<void> {
  const slot = job.files[key];
  slot.status = "running";
  slot.message = "Dang tong hop...";
  slot.matchedRows = 0;
  slot.unmatchedRows = 0;
  slot.matchedInvoiceKeys = [];
  slot.unmatchedInvoiceKeys = [];
  slot.outputPath = undefined;

  const hasJson = await pathExists(jsonPath);
  const hasXlsx = await pathExists(sourceXlsxPath);
  if (!hasJson || !hasXlsx) {
    slot.status = "skipped";
    slot.message = !hasJson && !hasXlsx ? "Khong tim thay JSON va XLSX" : !hasJson ? "Khong tim thay file JSON" : "Khong tim thay file XLSX";
    return;
  }

  try {
    const rawJson = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
      throw new Error("File JSON khong phai array");
    }

    const records = parsed as Array<Record<string, unknown>>;
    const detailMap = buildDetailMapFromExtractedInvoices(records, {
      mode: key === "purchased" ? "purchased" : "sold",
    });
    const buyerNames = buildBuyerNameMapFromExtractedInvoices(records);
    const xlsxBuffer = await fs.readFile(sourceXlsxPath);
    const merged = await mergeNamesIntoWorkbookWithMetadata(xlsxBuffer, detailMap, { buyerNames });
    await fs.mkdir(outputDir, { recursive: true });
    const outputFileName = `${basename(sourceXlsxPath, extname(sourceXlsxPath))}_merged${extname(sourceXlsxPath)}`;
    const outputPath = join(outputDir, outputFileName);
    await fs.writeFile(outputPath, merged.output);

    slot.status = "success";
    slot.message = `Da xuat file moi: ${outputPath} (${merged.matchedRows} khop, ${merged.unmatchedRows} khong khop)`;
    slot.matchedRows = merged.matchedRows;
    slot.unmatchedRows = merged.unmatchedRows;
    slot.matchedInvoiceKeys = merged.matchedInvoiceKeys;
    slot.unmatchedInvoiceKeys = merged.unmatchedInvoiceKeys;
    slot.outputPath = outputPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    slot.status = "failed";
    slot.message = message.slice(0, 200);
  }
}

export async function runAggregateJob(job: AggregateJob): Promise<void> {
  const soldJson = join(process.cwd(), ".gdt-xml-export", "hd_sold.json");
  const purchasedJson = join(process.cwd(), ".gdt-xml-export", "hd_purchased.json");
  const soldXlsx = join(process.cwd(), "src", "xlsx", "hd_sold.xlsx");
  const purchasedXlsx = join(process.cwd(), "src", "xlsx", "hd_purchased.xlsx");
  const outputDir = join(process.cwd(), "gdt-aggregated-xlsx");

  await processAggregateFile(job, "sold", soldJson, soldXlsx, outputDir);
  await processAggregateFile(job, "purchased", purchasedJson, purchasedXlsx, outputDir);

  const statuses = [job.files.sold.status, job.files.purchased.status];
  const hasFailed = statuses.includes("failed");
  const hasSuccess = statuses.includes("success");
  job.status = hasFailed ? "failed" : hasSuccess ? "success" : "failed";
  job.finishedAt = Date.now();
  trimAggregateJobs();
}
