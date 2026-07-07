import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { readBody, validateStartPayload, writeJson } from "./helpers.js";
import { addLog } from "./logging.js";
import { startJob } from "./jobs-core.js";
import { activeSessions, CONTINUE_READY_MARKER, jobs } from "./state.js";
import type { ContinuePayload, DebugActionPayload, StartPayload } from "./types.js";

function isWaitingForContinueSignal(output: string): boolean {
  return output.includes(CONTINUE_READY_MARKER) || output.includes("Dang cho tin hieu tiep tuc");
}

export async function handleControlRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "POST" && url.pathname === "/start") {
    const raw = await readBody(req);
    let payload: StartPayload;

    try {
      payload = JSON.parse(raw) as StartPayload;
    } catch {
      addLog("ui-api", "/start parse error", { raw });
      writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
      return true;
    }

    const validationError = validateStartPayload(payload);
    if (validationError) {
      addLog("ui-api", "/start validation error", { error: validationError, payload });
      writeJson(res, 400, { ok: false, output: validationError });
      return true;
    }

    const job = startJob(payload);
    addLog("ui-api", "/start job created", { jobId: job.id, payload });
    writeJson(res, 200, { ok: true, jobId: job.id });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/run") {
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

    const active =
      (payload.jobId ? activeSessions.get(payload.jobId) : undefined) ??
      Array.from(activeSessions.values()).at(-1);

    if (!active) {
      addLog("ui-api", "/run session not found", { jobId: payload.jobId });
      writeJson(res, 400, {
        ok: false,
        output: "Khong tim thay browser session dang cho tiep tuc. Vui long bam Bat dau lai.",
      });
      return true;
    }

    const activeJob = jobs.get(active.jobId);
    if (!activeJob) {
      addLog("ui-api", "/run job record missing", { jobId: active.jobId });
      writeJson(res, 400, {
        ok: false,
        output: "Session da het han hoac da bi dong. Vui long bam Bat dau de tao session moi.",
      });
      return true;
    }

    if (activeJob.status === "success" || activeJob.status === "failed") {
      addLog("ui-api", "/run ignored finished job", { jobId: active.jobId, status: activeJob.status });
      writeJson(res, 400, {
        ok: false,
        output: "Session nay da ket thuc. Vui long bam Bat dau de mo session moi.",
      });
      return true;
    }

    if (activeJob.status === "running" && !isWaitingForContinueSignal(activeJob.output)) {
      addLog("ui-api", "/run ignored already running", { jobId: active.jobId });
      writeJson(res, 200, {
        ok: true,
        jobId: active.jobId,
        status: "running",
        output: "Flow dang chay, khong can gui tiep tuc.",
      });
      return true;
    }

    if (activeJob.status === "paused") {
      activeJob.status = "running";
      activeJob.output += "\n[UI] Tiep tuc flow dang tam dung tu session hien tai.\n";
    }

    addLog("ui-api", "/run signal sent", {
      jobId: active.jobId,
      signalFile: active.continueSignalFile,
      waitingForContinue: isWaitingForContinueSignal(activeJob.output),
    });
    await fs.writeFile(active.continueSignalFile, "continue", "utf8");
    writeJson(res, 200, {
      ok: true,
      jobId: active.jobId,
      status: "running",
      output: "Da gui tin hieu tiep tuc.",
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/debug-action") {
    const raw = await readBody(req);
    let payload: DebugActionPayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as DebugActionPayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return true;
      }
    }

    const action = String(payload.action || "").trim().toLowerCase();
    const valid =
      action === "debug-read-pagination" ||
      action === "debug-next-page" ||
      action === "debug-open-invoice" ||
      /^debug-select-row:\d+$/.test(action);
    if (!valid) {
      writeJson(res, 400, { ok: false, output: "Debug action khong hop le" });
      return true;
    }

    const active =
      (payload.jobId ? activeSessions.get(payload.jobId) : undefined) ??
      Array.from(activeSessions.values()).at(-1);

    if (!active) {
      writeJson(res, 400, {
        ok: false,
        output: "Khong tim thay browser session dang mo de gui test action.",
      });
      return true;
    }

    addLog("ui-api", "/debug-action signal sent", {
      jobId: active.jobId,
      action,
      signalFile: active.continueSignalFile,
    });
    await fs.writeFile(active.continueSignalFile, action, "utf8");
    writeJson(res, 200, { ok: true, jobId: active.jobId, action });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
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

    const job =
      (payload.jobId ? jobs.get(payload.jobId) : undefined) ??
      Array.from(jobs.values())
        .filter((j) => j.status === "running" || j.status === "paused")
        .sort((a, b) => b.startedAt - a.startedAt)[0];

    if (!job || (job.status !== "running" && job.status !== "paused")) {
      addLog("ui-api", "/stop no running job", { jobId: payload.jobId });
      writeJson(res, 400, { ok: false, output: "Khong co job dang chay de dung." });
      return true;
    }

    addLog("ui-api", "/stop pausing job flow", { jobId: job.id });
    job.stopped = true;

    if (job.status === "running") {
      job.status = "paused";
      job.output += "\n[UI] Da tam dung flow hien tai theo yeu cau. Browser va session duoc giu nguyen.\n";
    }

    const session = activeSessions.get(job.id);
    if (session) {
      await fs.writeFile(session.continueSignalFile, "stop-current-flow", "utf8");
    }

    writeJson(res, 200, { ok: true, jobId: job.id });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/close-session") {
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
      writeJson(res, 400, { ok: false, output: "Khong tim thay session dang mo de tat." });
      return true;
    }

    const job = jobs.get(session.jobId);
    if (!job) {
      activeSessions.delete(session.jobId);
      await fs.unlink(session.continueSignalFile).catch(() => undefined);
      writeJson(res, 200, { ok: true, jobId: session.jobId });
      return true;
    }

    addLog("ui-api", "/close-session requested", { jobId: job.id });
    job.stopped = true;
    job.output += "\n[UI] Session da bi tat theo yeu cau nguoi dung.\n";

    await fs.writeFile(session.continueSignalFile, "stop-current-flow", "utf8").catch(() => undefined);

    const pid = job.child?.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          job.child?.kill("SIGTERM");
        } catch {
          // ignore kill errors
        }
      }

      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // process group may already be closed
        }
      }, 1500);
    }

    job.status = "failed";
    job.finishedAt = Date.now();
    activeSessions.delete(session.jobId);
    await fs.unlink(session.continueSignalFile).catch(() => undefined);
    writeJson(res, 200, { ok: true, jobId: session.jobId });
    return true;
  }

  return false;
}
