import { promises as fs } from "node:fs";
import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { captureHtml, dumpToolbarButtons, emitEvent, readContinueAction } from "./rescan-common.js";
import { findAndMarkViewInvoiceButton } from "./toolbar-view.js";
import {
  tryExtractDetailFromNetwork,
  extractInvoiceDetail,
  waitForInvoiceDetailReady,
  closeInvoiceModal,
} from "./detail.js";
import { readPaginationState, goToNextPage } from "./pagination.js";

interface ScrapedInvoice {
  stt: string;
  mst: string;
  khmshdon: string;
  khhdon: string;
  shdon: string;
  ngay: string;
  info: Record<string, string>;
  lineItems: Array<Record<string, string>>;
  itemNames: string[];
}

/**
 * New flow requested by the user: for each invoice row, click it to enable the
 * toolbar icons, click "Xem hóa đơn" to open the detail modal, read the
 * "Tên hàng hóa, dịch vụ" column, associate it with the row's invoice number,
 * then close the modal and continue. Paginates across all result pages.
 * Results are written to `${outDir}/invoice-items.json`. Returns the count scraped.
 */
async function scrapeInvoiceItemsAllPages(page: Page, outDir: string, continueSignalFile?: string): Promise<number> {
  await fs.mkdir(outDir, { recursive: true });

  const perRowDelayMs = Number(process.env.GDT_XML_ROW_DELAY_MS ?? 500);
  const modalTimeoutMs = Number(process.env.GDT_MODAL_TIMEOUT_MS ?? 15000);
  const results: ScrapedInvoice[] = [];
  const outFile = `${outDir}/invoice-items.json`;
  let dumpedOnce = false;
  let pageIndex = 0;

  // Safety cap on pages to avoid infinite loops.
  const maxPages = Number(process.env.GDT_MAX_PAGES ?? 200);
  const continueTimeoutMs = Number(process.env.GDT_CONTINUE_TIMEOUT_MS ?? 7200000);
  let stopRequested = false;
  let resumeRowIndex: number | null = null;

  const persistResults = async (): Promise<void> => {
    await fs.writeFile(outFile, JSON.stringify(results, null, 2), "utf8");
  };

  // Ensure output file exists immediately, then update it after each invoice.
  await persistResults();

  const consumeStopSignal = async (): Promise<boolean> => {
    if (!continueSignalFile) {
      return false;
    }

    try {
      await fs.access(continueSignalFile);
      const action = await readContinueAction(continueSignalFile);
      await fs.unlink(continueSignalFile).catch(() => undefined);
      if (action === "stop-current-flow") {
        return true;
      }

      // If continue arrives slightly before we enter paused wait mode,
      // preserve it so waitForResumeSignal can consume it.
      await fs.writeFile(continueSignalFile, action, "utf8").catch(() => undefined);
      return false;
    } catch {
      return false;
    }
  };

  const waitForResumeSignal = async (): Promise<boolean> => {
    if (!continueSignalFile) {
      return false;
    }

    logger.info("[VIEW] Da tam dung. Vui long bam Lay thong tin de tiep tuc voi list hien tai.");
    emitEvent("stopped", "Dang cho tin hieu tiep tuc tu UI");

    const startedAt = Date.now();
    while (Date.now() - startedAt < continueTimeoutMs) {
      try {
        await fs.access(continueSignalFile);
        const action = await readContinueAction(continueSignalFile);
        await fs.unlink(continueSignalFile).catch(() => undefined);

        if (action === "continue") {
          logger.info("[VIEW] Tiep tuc flow dang tam dung tu session hien tai.");
          emitEvent("resumed", "Tiep tuc flow dang tam dung tu session hien tai.");
          return true;
        }

        if (action === "stop-current-flow") {
          // Already paused; keep waiting for explicit continue.
          continue;
        }

        // Preserve non-related command for the proper consumer.
        await fs.writeFile(continueSignalFile, action, "utf8").catch(() => undefined);
      } catch {
        await page.waitForTimeout(1000);
      }
    }

    logger.warn("[VIEW] Het thoi gian cho tin hieu tiep tuc, dung luong lay thong tin.");
    emitEvent("stopped", "Het thoi gian cho tiep tuc, ket thuc luong Lay thong tin");
    return false;
  };

  const selectRowForDetail = async (row: ReturnType<Page["locator"]>, rowNumber: number, invoiceNo: string): Promise<boolean> => {
    const isSelected = async (): Promise<boolean> =>
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
    }

    if (!(await isSelected())) {
      const checkboxWrap = row.locator(".ant-checkbox-wrapper, .ant-checkbox").first();
      if (await checkboxWrap.count()) {
        await checkboxWrap.click().catch(() => undefined);
        await page.waitForTimeout(150);
      }
    }

    const selected = await isSelected();
    if (!selected) {
      emitEvent("row-error", `Trang ${pageIndex} #${rowNumber}: khong chon duoc row ${invoiceNo || "(unknown)"}`);
      logger.warn(
        `[VIEW] Trang ${pageIndex} #${rowNumber}: khong chon duoc row ${invoiceNo || "(unknown)"} (thieu ant-selected-row)`,
      );
    }
    return selected;
  };

  for (;;) {
    if (await consumeStopSignal()) {
      logger.warn("[VIEW] Da nhan yeu cau dung. Tam dung luong Lay thong tin va giu nguyen session.");
      emitEvent("stopped", "Da nhan yeu cau dung. Tam dung Lay thong tin tai trang hien tai.");
      stopRequested = true;
    }

    if (stopRequested) {
      const resumed = await waitForResumeSignal();
      if (resumed) {
        stopRequested = false;
        continue;
      }
      break;
    }

    const resumedInCurrentPage = resumeRowIndex != null;
    if (!resumedInCurrentPage) {
      pageIndex += 1;
    }

    let rows = page.locator(".ant-table-tbody tr.ant-table-row");
    let rowCount = await rows.count();
    if (rowCount === 0) {
      rows = page.locator(".ant-table-tbody tr");
      rowCount = await rows.count();
    }

    if (rowCount === 0) {
      logger.warn("[VIEW] Khong tim thay hoa don nao tren bang ket qua.");
      emitEvent("no-rows", "Khong tim thay hoa don nao tren bang ket qua");
      break;
    }

    logger.info(`[VIEW] Trang ${pageIndex}: ${rowCount} hoa don`);
    const tableHtml = await captureHtml(page, ".ant-table-tbody");
    const pageState = await readPaginationState(page);
    if (pageState) {
      logger.info(
        `[VIEW] Phan trang: trang ${pageState.current}/${pageState.total}` +
          (pageState.pageSize ? `, ${pageState.pageSize} hoa don/trang` : ""),
      );
      emitEvent(
        "rows-found",
        `Trang ${pageState.current}/${pageState.total} • ${rowCount} hoa don` +
          (pageState.pageSize ? ` (${pageState.pageSize}/trang)` : ""),
        tableHtml,
      );
    } else {
      emitEvent("rows-found", `Trang ${pageIndex}: ${rowCount} hoa don`, tableHtml);
    }

    const startRowIndex: number = resumeRowIndex ?? 0;
    resumeRowIndex = null;

    for (let r: number = startRowIndex; r < rowCount; r += 1) {
      if (await consumeStopSignal()) {
        logger.warn("[VIEW] Da nhan yeu cau dung. Tam dung truoc khi xu ly hoa don tiep theo.");
        emitEvent("stopped", `Tam dung truoc hoa don #${r + 1} trang ${pageIndex}`);
        stopRequested = true;
        resumeRowIndex = r;
        break;
      }

      const row = rows.nth(r);

      try {
        // Read the row cells first so we know which invoice we are viewing.
        const cells: string[] = await row
          .evaluate((tr) =>
            Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent || "").replace(/\s+/g, " ").trim()),
          )
          .catch(() => [] as string[]);

        // Columns: [STT, MST, KyHieuMauSo, KyHieuHoaDon, SoHoaDon, NgayLap]
        const record: ScrapedInvoice = {
          stt: cells[0] ?? "",
          mst: cells[1] ?? "",
          khmshdon: cells[2] ?? "",
          khhdon: cells[3] ?? "",
          shdon: cells[4] ?? "",
          ngay: cells[5] ?? "",
          info: {},
          lineItems: [],
          itemNames: [],
        };

        // Step 1: click the row to enable the toolbar icons.
        const rowHtml = await row.evaluate((node) => (node as HTMLElement).outerHTML).catch(() => "");
        const selected = await selectRowForDetail(row, r + 1, record.shdon);
        if (!selected) {
          continue;
        }
        await page.waitForTimeout(perRowDelayMs);
        emitEvent("click-row", `Trang ${pageIndex} #${r + 1}: chon hoa don so ${record.shdon}`, rowHtml);

        // Step 2: locate the "Xem hóa đơn" icon (enabled after row click).
        const found = await findAndMarkViewInvoiceButton(page);
        if (!found) {
          if (!dumpedOnce) {
            await dumpToolbarButtons(page);
            dumpedOnce = true;
          }
          const toolbarHtml = await captureHtml(page, ".ant-table-wrapper, .ant-table, header, [class*='toolbar']");
          emitEvent("icon-not-found", `Khong tim thay icon 'Xem hoa don' tai row #${r + 1}, bo qua row nay`, toolbarHtml);
          logger.warn(`[VIEW] Trang ${pageIndex} #${r + 1}: khong tim thay icon 'Xem hoa don', bo qua row nay.`);
          continue;
        }

        // Step 3: click "Xem hóa đơn" to open the detail modal.
        const detailFromNetworkPromise = tryExtractDetailFromNetwork(page, record, modalTimeoutMs + 3000);
        let modalOpened = false;
        for (let clickTry = 1; clickTry <= 2; clickTry += 1) {
          if (clickTry > 1) {
            // Re-select invoice row to ensure toolbar action is enabled/highlighted.
            await row.click().catch(() => undefined);
            await page.waitForTimeout(220);
            emitEvent("click-row", `Retry select row so ${record.shdon} truoc khi bam icon`);
          }

          const viewBtn = page.locator('[data-gdt-view="1"]').first();
          const clickable = viewBtn.locator(
            "xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]",
          );
          if (await clickable.count()) {
            await clickable.first().click().catch(() => undefined);
          } else {
            await viewBtn.click().catch(() => undefined);
          }
          emitEvent("click-view", `Click icon lan ${clickTry} cho so ${record.shdon}`);

          modalOpened = await page
            .waitForSelector(".ant-modal-body, .ant-modal", { timeout: 4000, state: "visible" })
            .then(() => true)
            .catch(() => false);
          if (modalOpened) {
            break;
          }
        }

        if (!modalOpened) {
          emitEvent("detail-modal", `So ${record.shdon}: bam icon 2 lan nhung modal chua mo`);
          logger.warn(`[VIEW] So ${record.shdon}: khong mo duoc modal sau 2 lan click icon`);
          continue;
        }

        // Step 4: wait for the modal to render.
        const ready = await waitForInvoiceDetailReady(page, modalTimeoutMs);
        if (!ready) {
          emitEvent("detail-modal", `Modal so ${record.shdon}: chua san sang sau timeout, se thu doc co retry`);
        }
        const modalHtml = await captureHtml(page, ".ant-modal-body");
        emitEvent("detail-modal", `Modal chi tiet hoa don so ${record.shdon}`, modalHtml);

        // Step 5: extract full invoice detail (prefer API response, fallback to DOM).
        let detail = (await detailFromNetworkPromise) ?? (await extractInvoiceDetail(page));
        if (detail.itemNames.length) {
          emitEvent("items-extracted", `So ${record.shdon}: lay tu API detail (${detail.itemNames.length} muc)`);
        }
        if (!detail.itemNames.length) {
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            await page.waitForTimeout(350 * attempt);
            detail = await extractInvoiceDetail(page);
            if (detail.itemNames.length) {
              emitEvent("items-extracted", `So ${record.shdon}: retry#${attempt} thanh cong`);
              break;
            }
          }
        }
        record.info = detail.info;
        record.lineItems = detail.lineItems;
        record.itemNames = detail.itemNames;
        if (record.itemNames.length) {
          logger.info(
            `[VIEW] So ${record.shdon}: ${record.itemNames.length} muc → ${record.itemNames.join(" | ").slice(0, 120)}`,
          );
          emitEvent("items-extracted", `So ${record.shdon}: ${record.itemNames.join(" | ").slice(0, 150)}`);
        } else {
          logger.warn(`[VIEW] So ${record.shdon}: khong doc duoc 'Ten hang hoa, dich vu'.`);
          emitEvent("items-empty", `So ${record.shdon}: khong doc duoc ten hang hoa`);
        }

        // Step 6: close the modal before the next row.
        await closeInvoiceModal(page);
        await page.waitForTimeout(250);
        emitEvent("modal-closed", `Dong modal so ${record.shdon}`);

        results.push(record);
        await persistResults();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[VIEW] Trang ${pageIndex} #${r + 1}: loi: ${msg.slice(0, 150)}`);
        emitEvent("row-error", `Trang ${pageIndex} #${r + 1}: ${msg.slice(0, 120)}`);
        await closeInvoiceModal(page).catch(() => undefined);
      }
    }

    // Continue waiting/resuming at loop start so both page-boundary and row-boundary stop behave the same.

    if (stopRequested) {
      continue;
    }

    if (pageIndex >= maxPages) {
      logger.warn(`[VIEW] Da dat gioi han ${maxPages} trang, dung.`);
      break;
    }

    const moved = await goToNextPage(page);
    if (!moved) {
      const endState = await readPaginationState(page);
      if (endState && endState.current < endState.total) {
        logger.warn(
          `[VIEW] Dung o trang ${endState.current}/${endState.total} nhung khong bam duoc trang sau.`,
        );
        emitEvent(
          "pagination-end",
          `Dung o trang ${endState.current}/${endState.total} — khong bam duoc trang sau`,
        );
      } else {
        const where = endState ? `trang ${endState.current}/${endState.total}` : "trang cuoi";
        logger.info(`[VIEW] Da het trang (${where}). Hoan tat.`);
        emitEvent("pagination-end", `Da het trang (${where})`);
      }
      break;
    }
    emitEvent("next-page", `Chuyen sang trang ${pageIndex + 1}`);
  }

  // Persist results.
  await persistResults();
  if (stopRequested) {
    logger.warn(`[VIEW] Da tam dung theo yeu cau. Da ghi tam ${results.length} hoa don vao ${outFile}`);
    emitEvent("saved", `Da tam dung. Da ghi tam ${results.length} hoa don vao invoice-items.json`);
  } else {
    logger.info(`[VIEW] Da ghi ${results.length} hoa don vao ${outFile}`);
    emitEvent("saved", `Da ghi ${results.length} hoa don vao invoice-items.json`);
  }

  return results.length;
}

export type { ScrapedInvoice };
export { scrapeInvoiceItemsAllPages };

