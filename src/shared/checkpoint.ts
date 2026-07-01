import { promises as fs } from "node:fs";
import path from "node:path";
import type { InvoiceCrawlMetadata, InvoiceCrawlMetadataMap, InvoiceNameMap, InvoiceType } from "./types.js";

export interface CrawlCheckpoint {
  version: 1;
  from: string;
  to: string;
  out: string;
  invoiceType: InvoiceType;
  endpointProfile: "standard" | "third-party";
  nextIndex: number;
  invoicesTotal: number;
  byCompositeEntries: Array<[string, string]>;
  byNumberEntries: Array<[string, string]>;
  metadataByCompositeEntries: Array<[string, InvoiceCrawlMetadata]>;
  metadataByNumberEntries: Array<[string, InvoiceCrawlMetadata]>;
  failedEntries: Array<[string, string]>;
  updatedAt: number;
  reason: "phase_progress" | "session_expired" | "manual_pause" | "before_persist" | "after_persist";
}

export interface CheckpointScope {
  from: string;
  to: string;
  out: string;
  invoiceType: InvoiceType;
  endpointProfile: "standard" | "third-party";
  invoicesTotal: number;
}

export interface CheckpointRuntimeState {
  nextIndex: number;
  map: InvoiceNameMap;
  metadata: InvoiceCrawlMetadataMap;
  failed: Array<{ key: string; shdon: string }>;
}

function toMetadataMap(entries: Array<[string, InvoiceCrawlMetadata]>): Map<string, InvoiceCrawlMetadata> {
  return new Map(entries.filter((entry) => entry && entry.length === 2));
}

function toStringMap(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries.filter((entry) => entry && entry.length === 2));
}

export async function readCheckpoint(filePath: string): Promise<CrawlCheckpoint | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CrawlCheckpoint>;
    if (!parsed || parsed.version !== 1) {
      return null;
    }

    if (
      typeof parsed.from !== "string" ||
      typeof parsed.to !== "string" ||
      typeof parsed.out !== "string" ||
      typeof parsed.invoiceType !== "string" ||
      typeof parsed.endpointProfile !== "string" ||
      typeof parsed.nextIndex !== "number" ||
      typeof parsed.invoicesTotal !== "number"
    ) {
      return null;
    }

    return {
      version: 1,
      from: parsed.from,
      to: parsed.to,
      out: parsed.out,
      invoiceType: parsed.invoiceType,
      endpointProfile: parsed.endpointProfile,
      nextIndex: parsed.nextIndex,
      invoicesTotal: parsed.invoicesTotal,
      byCompositeEntries: Array.isArray(parsed.byCompositeEntries) ? parsed.byCompositeEntries : [],
      byNumberEntries: Array.isArray(parsed.byNumberEntries) ? parsed.byNumberEntries : [],
      metadataByCompositeEntries: Array.isArray(parsed.metadataByCompositeEntries) ? parsed.metadataByCompositeEntries : [],
      metadataByNumberEntries: Array.isArray(parsed.metadataByNumberEntries) ? parsed.metadataByNumberEntries : [],
      failedEntries: Array.isArray(parsed.failedEntries) ? parsed.failedEntries : [],
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      reason: (parsed.reason as CrawlCheckpoint["reason"]) ?? "phase_progress",
    };
  } catch {
    return null;
  }
}

export function matchesScope(checkpoint: CrawlCheckpoint, scope: CheckpointScope): boolean {
  return (
    checkpoint.from === scope.from &&
    checkpoint.to === scope.to &&
    checkpoint.out === scope.out &&
    checkpoint.invoiceType === scope.invoiceType &&
    checkpoint.endpointProfile === scope.endpointProfile &&
    checkpoint.invoicesTotal === scope.invoicesTotal
  );
}

export function toRuntimeState(checkpoint: CrawlCheckpoint): CheckpointRuntimeState {
  return {
    nextIndex: Math.max(0, checkpoint.nextIndex),
    map: {
      byComposite: toStringMap(checkpoint.byCompositeEntries),
      byNumberOnly: toStringMap(checkpoint.byNumberEntries),
    },
    metadata: {
      byComposite: toMetadataMap(checkpoint.metadataByCompositeEntries),
      byNumberOnly: toMetadataMap(checkpoint.metadataByNumberEntries),
    },
    failed: checkpoint.failedEntries
      .filter((entry) => entry && entry.length === 2)
      .map(([key, shdon]) => ({ key, shdon })),
  };
}

export async function writeCheckpoint(filePath: string, checkpoint: CrawlCheckpoint): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const body = JSON.stringify(checkpoint, null, 2);
  await fs.writeFile(tmpPath, body, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

export async function clearCheckpoint(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore if file does not exist.
  }
}
