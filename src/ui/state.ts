import { join } from "node:path";
import type { AggregateJob, Job, RescanJob, UiDefaults } from "./types.js";

export const jobs = new Map<string, Job>();
export const activeSessions = new Map<string, { jobId: string; continueSignalFile: string }>();
export const aggregateJobs = new Map<string, AggregateJob>();
export const rescanJobs = new Map<string, RescanJob>();

export const CONTINUE_READY_MARKER =
  "Da san sang. Vui long bam Lay thong tin trong UI de tiep tuc crawl tu cung browser session.";

export const preferredPort = Number(process.env.UI_PORT ?? 4173);
export const maxPortAttempts = Number(process.env.UI_PORT_FALLBACK_MAX ?? 25);

export const sessionLogs: string[] = [];
export const logsDir = join(process.cwd(), ".gdt-logs");
export const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const currentSessionLogFile = join(logsDir, `session-${sessionId}.jsonl`);

export let activePort = preferredPort;

export const defaults: UiDefaults = {
  out: process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1] || "./DANH-SACH-HOA-DON.xlsx"
    : process.argv.find((v) => v.startsWith("--out="))?.slice("--out=".length) || "./DANH-SACH-HOA-DON.xlsx",
  direction:
    ((process.argv.includes("--direction")
      ? process.argv[process.argv.indexOf("--direction") + 1]
      : process.argv.find((v) => v.startsWith("--direction="))?.slice("--direction=".length)) as
      | "sold"
      | "purchase"
      | undefined) ?? "sold",
};

export function setActivePort(nextPort: number): void {
  activePort = nextPort;
}
