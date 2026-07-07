import "dotenv/config";
import { createServer } from "node:http";
import { URL } from "node:url";
import { handleControlRoutes } from "./routes-control.js";
import { handleLogRoutes } from "./routes-logs.js";
import { handleProcessingRoutes } from "./routes-processing.js";
import { handleRootRoutes } from "./routes-root.js";
import { ensureLogsDir, initServerLog } from "./logging.js";
import { activePort, maxPortAttempts, preferredPort, setActivePort } from "./state.js";

void ensureLogsDir();
initServerLog();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${activePort}`);

  if (await handleRootRoutes(req, res, url)) {
    return;
  }

  if (await handleControlRoutes(req, res, url)) {
    return;
  }

  if (await handleProcessingRoutes(req, res, url)) {
    return;
  }

  if (await handleLogRoutes(req, res, url)) {
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    const maxPort = preferredPort + maxPortAttempts;
    if (activePort < maxPort) {
      const nextPort = activePort + 1;
      console.warn(`Port ${activePort} dang duoc su dung, thu port ${nextPort}...`);
      setActivePort(nextPort);
      server.listen(nextPort);
      return;
    }
  }

  console.error(`Khong the khoi dong UI server: ${error.message}`);
  process.exit(1);
});

server.listen(activePort, () => {
  console.log(`UI server running at http://localhost:${activePort}`);
});
