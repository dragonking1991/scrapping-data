import { promises as fs } from "node:fs";
import { currentSessionLogFile, logsDir, preferredPort, sessionId, sessionLogs } from "./state.js";

export async function ensureLogsDir(): Promise<void> {
  await fs.mkdir(logsDir, { recursive: true }).catch(() => undefined);
}

export function addLog(source: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, source, message, data };
  sessionLogs.push(JSON.stringify(entry));
  fs.appendFile(currentSessionLogFile, JSON.stringify(entry) + "\n").catch(() => undefined);
}

export function initServerLog(): void {
  addLog("ui-server", "Server started", {
    port: preferredPort,
    sessionId,
    logFile: currentSessionLogFile,
  });
}
