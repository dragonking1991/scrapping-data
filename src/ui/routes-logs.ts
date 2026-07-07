import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { currentSessionLogFile, logsDir, sessionId, sessionLogs } from "./state.js";

export async function handleLogRoutes(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/logs") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const logsData = sessionLogs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line, timestamp: new Date().toISOString() };
      }
    });
    res.end(JSON.stringify(logsData, null, 2));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/export-logs") {
    const invoiceItemsPath = join(process.cwd(), ".gdt-xml-export", "invoice-items.json");
    try {
      const content = await fs.readFile(invoiceItemsPath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"invoice-items.json\"");
      res.end(content);
    } catch {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=\"invoice-items.json\"");
      res.end("[]");
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/log-files") {
    try {
      const files = await fs.readdir(logsDir);
      const jsonlFiles = files
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ files: jsonlFiles, current: `session-${sessionId}.jsonl` }));
    } catch {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ files: [], current: `session-${sessionId}.jsonl` }));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/download-log") {
    const filename = url.searchParams.get("file");
    if (!filename || !filename.endsWith(".jsonl")) {
      res.statusCode = 400;
      res.end("Invalid filename");
      return true;
    }

    const filepath = join(logsDir, filename);
    if (!filepath.startsWith(logsDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return true;
    }

    try {
      const content = await fs.readFile(filepath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("File not found");
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/session-log-file") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ file: currentSessionLogFile }));
    return true;
  }

  return false;
}
