import { promises as fs } from "node:fs";
import { randomId } from "./helpers.js";
import { jobs, rescanJobs } from "./state.js";
import type { ActiveSession, RescanFileProgress, RescanFileStatus, RescanJob } from "./types.js";

export function createRescanJob(sourceJobId: string): RescanJob {
  const id = randomId();
  const blank: RescanFileProgress = {
    status: "pending",
    queued: 0,
    processing: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    message: "Dang cho",
  };
  const job: RescanJob = {
    id,
    sourceJobId,
    status: "running",
    startedAt: Date.now(),
    files: {
      sold: { ...blank },
      purchased: { ...blank },
    },
  };
  rescanJobs.set(id, job);
  return job;
}

export function trimRescanJobs(limit = 20): void {
  const all = Array.from(rescanJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      rescanJobs.delete(stale.id);
    }
  }
}

function parseRescanStatusLines(chunk: string): Array<{
  dataset: "sold" | "purchased";
  status: RescanFileStatus;
  queued: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
  currentKey?: string;
  message?: string;
}> {
  const entries: Array<{
    dataset: "sold" | "purchased";
    status: RescanFileStatus;
    queued: number;
    processing: number;
    success: number;
    failed: number;
    skipped: number;
    currentKey?: string;
    message?: string;
  }> = [];

  for (const line of chunk.split(/\r?\n/)) {
    const marker = line.indexOf("[RESCAN-STATUS]");
    if (marker < 0) {
      continue;
    }
    const raw = line.slice(marker + "[RESCAN-STATUS]".length).trim();
    if (!raw) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const dataset = parsed.dataset === "purchased" ? "purchased" : parsed.dataset === "sold" ? "sold" : null;
      const status =
        parsed.status === "running" || parsed.status === "success" || parsed.status === "failed"
          ? parsed.status
          : null;
      if (!dataset || !status) {
        continue;
      }

      entries.push({
        dataset,
        status,
        queued: Number(parsed.queued ?? 0) || 0,
        processing: Number(parsed.processing ?? 0) || 0,
        success: Number(parsed.success ?? 0) || 0,
        failed: Number(parsed.failed ?? 0) || 0,
        skipped: Number(parsed.skipped ?? 0) || 0,
        currentKey: typeof parsed.currentKey === "string" ? parsed.currentKey : undefined,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
      });
    } catch {
      // ignore malformed status lines
    }
  }

  return entries;
}

function applyRescanProgress(
  job: RescanJob,
  entry: {
    dataset: "sold" | "purchased";
    status: RescanFileStatus;
    queued: number;
    processing: number;
    success: number;
    failed: number;
    skipped: number;
    currentKey?: string;
    message?: string;
  },
): void {
  const slot = job.files[entry.dataset];
  slot.status = entry.status;
  slot.queued = entry.queued;
  slot.processing = entry.processing;
  slot.success = entry.success;
  slot.failed = entry.failed;
  slot.skipped = entry.skipped;
  slot.currentKey = entry.currentKey;
  slot.message = entry.message ?? slot.message;
}

export async function runRescanJob(job: RescanJob, session: ActiveSession): Promise<void> {
  const sourceJob = jobs.get(session.jobId);
  if (!sourceJob || sourceJob.status !== "running") {
    job.status = "failed";
    job.finishedAt = Date.now();
    job.files.sold.status = "failed";
    job.files.purchased.status = "failed";
    job.files.sold.message = "Session browser khong con hoat dong";
    job.files.purchased.message = "Session browser khong con hoat dong";
    trimRescanJobs();
    return;
  }

  let cursor = sourceJob.output.length;
  await fs.writeFile(session.continueSignalFile, "rescan-empty-line-items", "utf8");

  const timeoutMs = Number(process.env.GDT_RESCAN_TIMEOUT_MS ?? 7200000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const current = jobs.get(session.jobId);
    if (!current) {
      break;
    }

    if (current.output.length > cursor) {
      const chunk = current.output.slice(cursor);
      cursor = current.output.length;
      const entries = parseRescanStatusLines(chunk);
      for (const entry of entries) {
        applyRescanProgress(job, entry);
      }
    }

    if (current.status !== "running") {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 350));
  }

  const sold = job.files.sold;
  const purchased = job.files.purchased;
  const receivedAnyStatus =
    sold.status !== "pending" ||
    purchased.status !== "pending" ||
    sold.message !== "Dang cho" ||
    purchased.message !== "Dang cho";

  if (!receivedAnyStatus) {
    sold.status = "failed";
    purchased.status = "failed";
    sold.message = sold.message || "Khong nhan duoc tien do ra lai tu session";
    purchased.message = purchased.message || "Khong nhan duoc tien do ra lai tu session";
    job.status = "failed";
  } else {
    const anyFailed = sold.failed > 0 || purchased.failed > 0 || sold.status === "failed" || purchased.status === "failed";
    job.status = anyFailed ? "failed" : "success";
  }

  job.finishedAt = Date.now();
  trimRescanJobs();
}
