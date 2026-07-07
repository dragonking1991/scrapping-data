import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { UiDefaults } from "./types.js";

let cachedTemplate: string | null = null;

async function loadTemplate(): Promise<string> {
  if (cachedTemplate) {
    return cachedTemplate;
  }

  const file = join(process.cwd(), "src", "ui", "web", "index.html");
  cachedTemplate = await fs.readFile(file, "utf8");
  return cachedTemplate;
}

export async function renderHtml(defaults: UiDefaults): Promise<string> {
  const template = await loadTemplate();
  return template.replace("__DEFAULT_OUT_JSON__", JSON.stringify(defaults.out));
}
