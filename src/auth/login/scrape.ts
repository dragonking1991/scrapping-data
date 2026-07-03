import { promises as fs } from "node:fs";
import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import { captureHtml, dumpToolbarButtons, emitEvent } from "./rescan-common.js";
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
async function scrapeInvoiceItemsAllPages(page: Page, outDir: string): Promise<number> {
  await fs.mkdir(outDir, { recursive: true });

  const perRowDelayMs = Number(process.env.GDT_XML_ROW_DELAY_MS ?? 500);
  const modalTimeoutMs = Number(process.env.GDT_MODAL_TIMEOUT_MS ?? 15000);
  const results: ScrapedInvoice[] = [];
  let dumpedOnce = false;
  let pageIndex = 0;

  // Safety cap on pages to avoid infinite loops.
  const maxPages = Number(process.env.GDT_MAX_PAGES ?? 200);

  for (;;) {
    pageIndex += 1;

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

    for (let r = 0; r < rowCount; r += 1) {
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
        await row.click().catch(() => undefined);
        await page.waitForTimeout(perRowDelayMs);
        emitEvent("click-row", `Trang ${pageIndex} #${r + 1}: click hoa don so ${record.shdon}`, rowHtml);

        // Step 2: locate the "Xem hóa đơn" icon (enabled after row click).
        const found = await findAndMarkViewInvoiceButton(page);
        if (!found) {
          if (!dumpedOnce) {
            await dumpToolbarButtons(page);
            dumpedOnce = true;
          }
          const toolbarHtml = await captureHtml(page, ".ant-table-wrapper, .ant-table, header, [class*='toolbar']");
          emitEvent("icon-not-found", "Khong tim thay icon 'Xem hoa don'", toolbarHtml);
          logger.warn("[VIEW] Khong tim thay icon 'Xem hoa don'. Bo qua trang nay.");
          break;
        }

        // Step 3: click "Xem hóa đơn" to open the detail modal.
        const detailFromNetworkPromise = tryExtractDetailFromNetwork(page, record, modalTimeoutMs + 3000);
        await page.locator('[data-gdt-view="1"]').first().click().catch(() => undefined);
        emitEvent("click-view", `Click 'Xem hoa don' cho so ${record.shdon}`);

        // Step 4: wait for the modal to render.
        await page
          .waitForSelector(".ant-modal-body, .ant-modal", { timeout: modalTimeoutMs, state: "visible" })
          .catch(() => undefined);
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[VIEW] Trang ${pageIndex} #${r + 1}: loi: ${msg.slice(0, 150)}`);
        emitEvent("row-error", `Trang ${pageIndex} #${r + 1}: ${msg.slice(0, 120)}`);
        await closeInvoiceModal(page).catch(() => undefined);
      }
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
  const outFile = `${outDir}/invoice-items.json`;
  await fs.writeFile(outFile, JSON.stringify(results, null, 2), "utf8");
  logger.info(`[VIEW] Da ghi ${results.length} hoa don vao ${outFile}`);
  emitEvent("saved", `Da ghi ${results.length} hoa don vao invoice-items.json`);

  return results.length;
}

export type { ScrapedInvoice };
export { scrapeInvoiceItemsAllPages };

