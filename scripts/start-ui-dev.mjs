import { execSync, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();
const tsxCliPath = join(rootDir, "node_modules", "tsx", "dist", "cli.mjs");
const logPath = join(rootDir, ".ui-dev.log");

if (!existsSync(tsxCliPath)) {
  console.error("[dev-ui-bg] Missing tsx CLI. Run 'npm install' first.");
  process.exit(1);
}

execSync("node scripts/clean-dev-ports.mjs", {
  cwd: rootDir,
  stdio: "inherit",
});

const logFd = openSync(logPath, "a");
const child = spawn(process.execPath, [tsxCliPath, "src/ui/server.ts"], {
  cwd: rootDir,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  env: process.env,
});

child.unref();
console.log(`[dev-ui-bg] Started UI server in background on http://localhost:4173 (pid ${child.pid}).`);
console.log(`[dev-ui-bg] Log file: ${logPath}`);
