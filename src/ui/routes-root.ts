import type { IncomingMessage, ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { URL } from "node:url";
import { renderHtml } from "./html.js";
import { writeJson } from "./helpers.js";
import { defaults, activeSessions, jobs } from "./state.js";

export async function handleRootRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await renderHtml(defaults));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/web/app.js") {
    try {
      const filePath = join(process.cwd(), "src", "ui", "web", "app.js");
      const content = await fs.readFile(filePath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("Not Found");
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const list = Array.from(activeSessions.values())
      .map((s) => {
        const job = jobs.get(s.jobId);
        return {
          jobId: s.jobId,
          status: job?.status ?? "unknown",
          startedAt: job?.startedAt ?? 0,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
    writeJson(res, 200, { ok: true, sessions: list });
    return true;
  }

  return false;
}
