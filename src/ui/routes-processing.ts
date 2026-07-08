import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { createAggregateJob, runAggregateJob } from "./jobs-aggregate.js";
import { createRescanJob, runRescanJob } from "./jobs-rescan.js";
import { readBody, sseWrite, writeJson, pathExists } from "./helpers.js";
import { CONTINUE_READY_MARKER, activeSessions, aggregateJobs, jobs, rescanJobs } from "./state.js";
import type { ContinuePayload } from "./types.js";

export async function handleProcessingRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/aggregate") {
    const running = Array.from(aggregateJobs.values()).find((job) => job.status === "running");
    if (running) {
      writeJson(res, 200, { ok: true, jobId: running.id });
      return true;
    }

    const job = createAggregateJob();
    void runAggregateJob(job);
    writeJson(res, 200, { ok: true, jobId: job.id });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/rescan") {
    const raw = await readBody(req);
    let payload: ContinuePayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as ContinuePayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return true;
      }
    }

    const session =
      (payload.jobId ? activeSessions.get(payload.jobId) : undefined) ??
      Array.from(activeSessions.values()).at(-1);

    if (!session) {
      writeJson(res, 400, {
        ok: false,
        output: "Khong tim thay session browser dang mo. Vui long bam Bat dau truoc.",
      });
      return true;
    }

    const soldJson = join(process.cwd(), "gdt-xml-export", "hd_sold.json");
    const purchasedJson = join(process.cwd(), "gdt-xml-export", "hd_purchased.json");
    const purchasedHasCodeJson = join(process.cwd(), "gdt-xml-export", "hd_purchased_hasCode.json");
    const purchasedNoCodeJson = join(process.cwd(), "gdt-xml-export", "hd_purchased_noCode.json");
    const purchasedInitCodeJson = join(process.cwd(), "gdt-xml-export", "hd_purchased_initCode.json");
    const hasSold = await pathExists(soldJson);
    const hasPurchasedLegacy = await pathExists(purchasedJson);
    const hasPurchasedHasCode = await pathExists(purchasedHasCodeJson);
    const hasPurchasedNoCode = await pathExists(purchasedNoCodeJson);
    const hasPurchasedInitCode = await pathExists(purchasedInitCodeJson);
    const hasPurchased =
      hasPurchasedLegacy || hasPurchasedHasCode || hasPurchasedNoCode || hasPurchasedInitCode;
    if (!hasSold || !hasPurchased) {
      writeJson(res, 400, {
        ok: false,
        output:
          "Thieu file nguon gdt-xml-export/hd_sold.json hoac bo purchased (hd_purchased.json / hd_purchased_hasCode.json / hd_purchased_noCode.json / hd_purchased_initCode.json)",
      });
      return true;
    }

    const running = Array.from(rescanJobs.values()).find((job) => job.status === "running" && job.sourceJobId === session.jobId);
    if (running) {
      writeJson(res, 200, { ok: true, jobId: running.id, sourceJobId: running.sourceJobId });
      return true;
    }

    const sourceJob = jobs.get(session.jobId);
    if (!sourceJob || sourceJob.status !== "running") {
      writeJson(res, 400, {
        ok: false,
        output: "Session browser khong con hoat dong. Vui long bam Bat dau de mo session moi.",
      });
      return true;
    }

    if (!sourceJob.output.includes(CONTINUE_READY_MARKER)) {
      writeJson(res, 409, {
        ok: false,
        output:
          "Session chua san sang de ra lai. Vui long dang nhap GDT, chon ngay, bam Tim kiem den khi co bang ket qua roi thu lai.",
      });
      return true;
    }

    const rescanJob = createRescanJob(session.jobId);
    void runRescanJob(rescanJob, session);
    writeJson(res, 200, { ok: true, jobId: rescanJob.id, sourceJobId: rescanJob.sourceJobId });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/aggregate-status") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = aggregateJobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job tong hop" });
      return true;
    }

    writeJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        files: job.files,
      },
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/rescan-status") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = rescanJobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job ra lai" });
      return true;
    }

    writeJson(res, 200, {
      ok: true,
      job: {
        id: job.id,
        sourceJobId: job.sourceJobId,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        files: job.files,
      },
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = jobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job" });
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    sseWrite(res, "status", { status: job.status });

    let cursor = 0;
    const interval = setInterval(() => {
      const current = jobs.get(jobId);
      if (!current) {
        clearInterval(interval);
        res.end();
        return;
      }

      if (current.output.length > cursor) {
        const chunk = current.output.slice(cursor);
        cursor = current.output.length;
        sseWrite(res, "log", { chunk });
      }

      sseWrite(res, "status", { status: current.status });
      if (current.status === "success" || current.status === "failed") {
        clearInterval(interval);
        setTimeout(() => res.end(), 50);
      }
    }, 250);

    req.on("close", () => {
      clearInterval(interval);
    });
    return true;
  }

  return false;
}
