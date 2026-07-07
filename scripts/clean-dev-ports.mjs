import { execSync } from "node:child_process";

const PORTS = [4173, 4174, 4175];

function getPidsOnPort(port) {
  try {
    const output = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!output) {
      return [];
    }

    return [...new Set(output.split(/\s+/).filter(Boolean))];
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    process.kill(Number(pid), "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function main() {
  const killed = [];

  for (const port of PORTS) {
    const pids = getPidsOnPort(port);
    for (const pid of pids) {
      if (killPid(pid)) {
        killed.push({ port, pid });
      }
    }
  }

  if (killed.length === 0) {
    console.log("[dev-clean] No old UI instance found on ports 4173-4175.");
    return;
  }

  const summary = killed.map((x) => `${x.pid}@${x.port}`).join(", ");
  console.log(`[dev-clean] Killed old UI instance(s): ${summary}`);
}

main();
