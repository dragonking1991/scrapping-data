import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import type { RescanDataset } from "./shared.js";

async function clickLookupTab(page: Page, dataset: RescanDataset): Promise<boolean> {
  const targetTexts =
    dataset === "sold"
      ? ["tra cuu hoa don dien tu ban ra", "hoa don dien tu ban ra"]
      : ["tra cuu hoa don dien tu mua vao", "hoa don dien tu mua vao"];

  const result = await page
    .evaluate((texts) => {
      const normalize = (value: string): string =>
        value
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[đĐ]/g, "d")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const targets = texts.map((text) => normalize(text));
      const nodes = Array.from(
        document.querySelectorAll("a, li, div, span, button, [role='tab'], .ant-tabs-tab"),
      ) as HTMLElement[];

      const matches = nodes.filter((el) => {
        const text = normalize(el.textContent || "");
        return Boolean(text) && targets.some((target) => text === target || text.includes(target));
      });

      if (matches.length) {
        // Prefer a real tab-like element, otherwise the smallest (leaf) match so
        // the click lands on the actual control and still bubbles to handlers.
        const preferred =
          matches.find(
            (el) =>
              el.getAttribute("role") === "tab" ||
              /tab/i.test(el.className?.toString?.() || "") ||
              el.tagName.toLowerCase() === "a" ||
              el.tagName.toLowerCase() === "li",
          ) ??
          matches.reduce((best, el) =>
            (el.textContent || "").length < (best.textContent || "").length ? el : best,
          );

        preferred.click();
        return { clicked: true, text: (preferred.textContent || "").trim().slice(0, 60), tabs: [] as string[] };
      }

      const tabTexts = nodes
        .filter((el) => /tab/i.test(el.className?.toString?.() || "") || el.getAttribute("role") === "tab")
        .map((el) => (el.textContent || "").trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 25);

      return { clicked: false, text: "", tabs: tabTexts };
    }, targetTexts)
    .catch(() => ({ clicked: false, text: "", tabs: [] as string[] }));

  if (result.clicked) {
    logger.info(`[RESCAN][${dataset}] Da chuyen tab: "${result.text}"`);
    await page.waitForTimeout(500);
    await page
      .waitForFunction(() => !document.querySelector(".ant-spin-spinning"), { timeout: 8000 })
      .catch(() => undefined);
    return true;
  }

  logger.warn(
    `[RESCAN][${dataset}] Khong tim thay tab tra cuu. Cac tab thay duoc: ${JSON.stringify(result.tabs)}`,
  );
  return false;
}

export { clickLookupTab };

