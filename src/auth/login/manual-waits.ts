import { promises as fs } from "node:fs";
import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import type { ContinueAction } from "./shared.js";
import { hasManualSearchResults } from "./ui-manual.js";
import { readContinueAction } from "./rescan-common.js";

async function waitForManualLoginToken(
  page: Page,
  timeoutMs: number,
  getToken: () => Promise<string | null>,
): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const token = await getToken();
    if (token) {
      return token;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function waitForManualSearchReady(page: Page, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasManualSearchResults(page)) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error(
    "Da dang nhap thanh cong nhung chua thay bang ket qua tra cuu. Vui long mo dung trang tra cuu, chon ngay va bam tim kiem truoc khi he thong tiep tuc.",
  );
}

async function waitForContinueSignal(
  page: Page,
  continueSignalFile?: string,
): Promise<ContinueAction> {
  if (!continueSignalFile) {
    return "continue";
  }

  const startedAt = Date.now();
  const continueTimeoutMs = Number(process.env.GDT_CONTINUE_TIMEOUT_MS ?? 7200000);
  logger.info("Da san sang. Vui long bam Lay thong tin trong UI de tiep tuc crawl tu cung browser session.");

  while (Date.now() - startedAt < continueTimeoutMs) {
    try {
      await fs.access(continueSignalFile);
      const action = await readContinueAction(continueSignalFile);
      await fs.unlink(continueSignalFile).catch(() => undefined);
      return action;
    } catch {
      await page.waitForTimeout(1000);
    }
  }

  throw new Error("Het thoi gian cho tin hieu tiep tuc tu UI");
}

export { waitForManualLoginToken, waitForManualSearchReady, waitForContinueSignal };
