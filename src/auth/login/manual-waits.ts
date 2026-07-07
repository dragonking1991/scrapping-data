import { promises as fs } from "node:fs";
import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import type { ContinueAction } from "./shared.js";
import { hasManualSearchResults } from "./ui-manual.js";
import { findAndMarkViewInvoiceButton } from "./toolbar-view.js";
import { goToNextPage, readPaginationState } from "./pagination.js";
import { emitEvent, readContinueAction } from "./rescan-common.js";

async function ensureAnyRowSelected(page: Page): Promise<boolean> {
  const row = page
    .locator(".ant-table-tbody tr.ant-selected-row")
    .first();
  if (await row.count()) {
    return true;
  }

  let rows = page.locator(".ant-table-tbody tr.ant-table-row");
  let rowCount = await rows.count();
  if (rowCount === 0) {
    rows = page.locator(".ant-table-tbody tr");
    rowCount = await rows.count();
  }
  if (rowCount === 0) {
    return false;
  }

  const first = rows.first();
  await first.click().catch(() => undefined);
  await page.waitForTimeout(160);

  const selected = page.locator(".ant-table-tbody tr.ant-selected-row").first();
  if (await selected.count()) {
    return true;
  }

  const firstCell = first.locator("td").first();
  if (await firstCell.count()) {
    await firstCell.click().catch(() => undefined);
    await page.waitForTimeout(160);
  }

  if (await selected.count()) {
    return true;
  }

  const checkboxWrap = first.locator(".ant-checkbox-wrapper, .ant-checkbox").first();
  if (await checkboxWrap.count()) {
    await checkboxWrap.click().catch(() => undefined);
    await page.waitForTimeout(180);
  }

  return (await selected.count()) > 0;
}

function parseDebugRowAction(action: ContinueAction): number | null {
  const match = String(action).match(/^debug-select-row:(\d+)$/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

async function executeDebugAction(page: Page, action: ContinueAction): Promise<void> {
  if (action === "debug-read-pagination") {
    const state = await readPaginationState(page);
    if (!state) {
      logger.warn("[UI-TEST] Khong doc duoc phan trang hien tai.");
      emitEvent("pagination-state", "UI-TEST: khong doc duoc phan trang");
      return;
    }
    const where = `${state.current}/${state.total}`;
    const sourceTag = state.source ? ` source=${state.source}` : "";
    const fallbackTag = state.isFallback ? " (fallback)" : "";
    logger.info(`[UI-TEST] Phan trang hien tai: ${where}${fallbackTag}${sourceTag}`);
    emitEvent("pagination-state", `UI-TEST: trang ${where}${fallbackTag}${sourceTag}`);
    return;
  }

  if (action === "debug-next-page") {
    const moved = await goToNextPage(page);
    const state = await readPaginationState(page);
    if (moved) {
      const where = state ? `${state.current}/${state.total}` : "unknown";
      logger.info(`[UI-TEST] Chuyen trang thanh cong. Vi tri moi: ${where}`);
      emitEvent("next-page", `UI-TEST: chuyen trang thanh cong (${where})`);
      emitEvent("pagination-state", `UI-TEST: trang ${where}`);
    } else {
      const where = state ? `${state.current}/${state.total}` : "unknown";
      logger.warn(`[UI-TEST] Khong chuyen duoc trang. Vi tri hien tai: ${where}`);
      emitEvent("pagination-end", `UI-TEST: khong chuyen duoc trang (${where})`);
      emitEvent("pagination-state", `UI-TEST: trang ${where}`);
    }
    return;
  }

  if (action === "debug-open-invoice") {
    const selected = await ensureAnyRowSelected(page);
    if (!selected) {
      logger.warn("[UI-TEST] Chua co row nao duoc chon de mo hoa don.");
      emitEvent("row-error", "UI-TEST: chua chon duoc row nao truoc khi bam Xem hoa don");
      return;
    }

    const found = await findAndMarkViewInvoiceButton(page);
    if (!found) {
      logger.warn("[UI-TEST] Khong tim thay nut 'Xem hoa don'.");
      emitEvent("icon-not-found", "UI-TEST: khong tim thay nut Xem hoa don");
      return;
    }
    await page.locator('[data-gdt-view="1"]').first().click().catch(() => undefined);
    logger.info("[UI-TEST] Da bam nut 'Xem hoa don'.");
    emitEvent("click-view", "UI-TEST: da bam nut Xem hoa don");
    return;
  }

  const rowIndex = parseDebugRowAction(action);
  if (rowIndex == null) {
    return;
  }

  let rows = page.locator(".ant-table-tbody tr.ant-table-row");
  let rowCount = await rows.count();
  if (rowCount === 0) {
    rows = page.locator(".ant-table-tbody tr");
    rowCount = await rows.count();
  }

  if (rowCount === 0) {
    logger.warn("[UI-TEST] Khong tim thay row nao de chon.");
    emitEvent("no-rows", "UI-TEST: khong tim thay row nao de chon");
    return;
  }

  await page
    .evaluate(() => {
      document.querySelectorAll('[data-gdt-target-row="1"]').forEach((el) => el.removeAttribute("data-gdt-target-row"));
    })
    .catch(() => undefined);

  const marked = await page
    .evaluate((wantedStt) => {
      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
      const toStt = (s: string): string => norm(s).replace(/\./g, "");

      const allRows = Array.from(document.querySelectorAll(".ant-table-tbody tr.ant-table-row"));
      const expected = String(wantedStt);
      const matches: HTMLElement[] = [];

      for (const row of allRows) {
        if (!isVisible(row)) {
          continue;
        }

        const cells = Array.from(row.querySelectorAll("td"));
        const hasWantedStt = cells.some((cell) => toStt(cell.textContent || "") === expected);
        if (hasWantedStt) {
          matches.push(row as HTMLElement);
        }
      }

      if (matches.length) {
        // Ant table may render duplicate rows (fixed columns). Prefer the fullest row.
        matches.sort((a, b) => b.querySelectorAll("td").length - a.querySelectorAll("td").length);
        const target = matches[0];
        if (!target) {
          return false;
        }
        target.setAttribute("data-gdt-target-row", "1");
        return true;
      }

      // Fallback: if STT is not rendered on this page/viewport, treat input as
      // 1-based row position within current page so UI test still works.
      const visibleRows = allRows.filter((row) => isVisible(row));
      const fallback = visibleRows[wantedStt - 1];
      if (fallback) {
        (fallback as HTMLElement).setAttribute("data-gdt-target-row", "1");
        return true;
      }

      return false;
    }, rowIndex)
    .catch(() => false);

  if (!marked) {
    logger.warn(`[UI-TEST] Khong tim thay row co STT=${rowIndex}.`);
    emitEvent("row-error", `UI-TEST: khong tim thay row STT=${rowIndex}`);
    return;
  }

  const row = page.locator('[data-gdt-target-row="1"]').first();
  const isSelected = async () =>
    row
      .evaluate((el) => (el as HTMLElement).classList.contains("ant-selected-row"))
      .catch(() => false);

  if (!(await isSelected())) {
    await row.click().catch(() => undefined);
    await page.waitForTimeout(120);
  }

  if (!(await isSelected())) {
    const firstCell = row.locator("td").first();
    if (await firstCell.count()) {
      await firstCell.click().catch(() => undefined);
      await page.waitForTimeout(120);
    }

    if (!(await isSelected())) {
      const checkboxWrap = row.locator(".ant-checkbox-wrapper, .ant-checkbox").first();
      if (await checkboxWrap.count()) {
        await checkboxWrap.click().catch(() => undefined);
        await page.waitForTimeout(150);
      }
    }
  }

  if (!(await isSelected())) {
    logger.warn(`[UI-TEST] Chon row STT=${rowIndex} that bai (khong thay class ant-selected-row tren row do).`);
    emitEvent("row-error", `UI-TEST: row STT=${rowIndex} khong co class ant-selected-row`);
    return;
  }

  await row.evaluate((el) => {
    const node = el as HTMLElement;
    node.style.fontWeight = "700";
    node.style.outline = "2px solid #f59e0b";
  }).catch(() => undefined);
  logger.info(`[UI-TEST] Da chon row #${rowIndex} (co class ant-selected-row) va highlight dam.`);
  emitEvent("click-row", `UI-TEST: da chon row #${rowIndex} (ant-selected-row)`);
}

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

      if (
        action === "debug-read-pagination" ||
        action === "debug-next-page" ||
        action === "debug-open-invoice" ||
        String(action).startsWith("debug-select-row:")
      ) {
        await executeDebugAction(page, action);
        continue;
      }

      if (action === "stop-current-flow") {
        logger.warn("Da nhan yeu cau dung flow hien tai trong luc cho tiep tuc. Van tiep tuc cho den khi bam Lay thong tin.");
        continue;
      }
      return action;
    } catch {
      await page.waitForTimeout(1000);
    }
  }

  throw new Error("Het thoi gian cho tin hieu tiep tuc tu UI");
}

export { waitForManualLoginToken, waitForManualSearchReady, waitForContinueSignal };
