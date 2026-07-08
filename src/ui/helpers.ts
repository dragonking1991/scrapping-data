import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import type { ContinueRunMode, RunPayload, StartPayload } from "./types.js";

const VALID_CONTINUE_RUN_MODES: ContinueRunMode[] = [
  "sold",
  "purchased-hasCode",
  "purchased-noCode",
  "purchased-initCode",
];

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }

  const inline = args.find((v) => v.startsWith(`${flag}=`));
  if (inline) {
    return inline.substring(flag.length + 1);
  }

  return undefined;
}

export function getDefaultOutPath(): string {
  return parseArgValue("--out") ?? "./DANH-SACH-HOA-DON.xlsx";
}

export function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GDT_")) {
      delete env[key];
    }
  }
  return env;
}

export function validatePayload(payload: RunPayload): string | null {
  if (!["sold", "purchase"].includes(payload.direction)) {
    return "Loai hoa don khong hop le.";
  }
  return null;
}

export function validateStartPayload(payload: StartPayload): string | null {
  if (!["sold", "purchase"].includes(payload.direction)) {
    return "Loai hoa don khong hop le.";
  }
  return null;
}

export function validateContinueRunMode(runMode: string | undefined): string | null {
  if (!runMode) {
    return null;
  }

  if (!VALID_CONTINUE_RUN_MODES.includes(runMode as ContinueRunMode)) {
    return "Run mode khong hop le.";
  }

  return null;
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", (err) => reject(err));
  });
}
