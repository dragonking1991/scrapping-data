import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { buildCliEnv, getDefaultOutPath, randomId } from "./helpers.js";
import { activeSessions, jobs } from "./state.js";
import type { Job, RunPayload } from "./types.js";

export function trimJobs(limit = 20): void {
  const all = Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      jobs.delete(stale.id);
    }
  }
}

export function startJob(payload: RunPayload): Job {
  const id = randomId();
  const job: Job = {
    id,
    status: "running",
    output: "",
    startedAt: Date.now(),
  };

  jobs.set(id, job);
  trimJobs();

  const continueSignalFile = join(process.cwd(), `.gdt-continue-${id}.signal`);
  const args = ["run", "dev:cli", "--", "--direction", payload.direction, "--manual-first", "--continue-signal-file", continueSignalFile];
  const outPath = payload.out?.trim() || getDefaultOutPath();

  if (payload.verifyOnly) {
    args.push("--verify-only");
  } else {
    args.push("--out", outPath);
  }

  if (payload.autoExportXml) {
    args.push("--auto-export-xml");
  }

  const child = spawn("npm", args, {
    cwd: process.cwd(),
    env: buildCliEnv(),
    detached: true,
  });

  job.child = child;
  activeSessions.set(id, { jobId: id, continueSignalFile });

  const append = (chunk: Buffer | string): void => {
    job.output += chunk.toString();
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);

  child.on("close", (code) => {
    job.status = job.stopped ? "failed" : code === 0 ? "success" : "failed";
    if (job.stopped) {
      job.output += "\n[UI] Da dung job theo yeu cau nguoi dung (giu browser mo de thu lai).\n";
    }
    job.finishedAt = Date.now();
    job.child = undefined;
    const session = activeSessions.get(id);
    if (session) {
      activeSessions.delete(id);
      fs.unlink(session.continueSignalFile).catch(() => undefined);
    }
  });

  return job;
}
