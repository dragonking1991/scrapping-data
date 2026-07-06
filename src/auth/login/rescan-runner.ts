import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import type { RescanDataset, RescanDatasetCounters } from "./shared.js";
import { emitRescanStatus, buildRescanCandidates, writeJsonAtomic, readContinueAction } from "./rescan-common.js";
import { clickLookupTab } from "./lookup-tab.js";
import {
  fillInvoiceNumberFilter,
  fillInvoiceDateFilter,
  clickSearchByInvoice,
  findRowIndexByInvoiceNumber,
} from "./search-filters.js";
import { tryExtractDetailFromNetwork, extractInvoiceDetail, closeInvoiceModal } from "./detail.js";
import { findAndMarkViewInvoiceButton, clearViewInvoiceMark } from "./toolbar-view.js";

/**
 * Click the matching invoice row in the result list and confirm it becomes
 * active/selected (highlighted/bold) before continuing. Retries a few times
 * because the table may still be settling right after the search finishes.
 * Always returns after clicking; the boolean reports whether the row was
 * detected as active (some tables never add a selected class).
 */
async function selectResultRow(page: Page, row: Locator): Promise<boolean> {
  let active = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // Click a real cell so the row's click handlers fire and it highlights.
    const target = (await row.locator("td").count().catch(() => 0)) ? row.locator("td").first() : row;
    await target.click().catch(() => undefined);
    await page.waitForTimeout(250 * attempt);

    active = await row
      .evaluate((tr) => {
        const el = tr as HTMLElement;
        const cls = el.className || "";
        const highlighted =
          /ant-table-row-selected|selected|active|row-active/i.test(cls) ||
          el.getAttribute("aria-selected") === "true";
        const hasCheckedBox = Boolean(
          el.querySelector("input[type='checkbox']:checked, .ant-checkbox-checked, .ant-radio-checked"),
        );
        return highlighted || hasCheckedBox;
      })
      .catch(() => false);

    if (active) {
      break;
    }
  }

  return active;
}

function emitDatasetProgress(dataset: RescanDataset, status: "running" | "success" | "failed", counters: RescanDatasetCounters): void {
  emitRescanStatus({
    dataset,
    status,
    queued: counters.queued,
    processing: counters.processing,
    success: counters.success,
    failed: counters.failed,
    skipped: counters.skipped,
    currentKey: counters.currentKey,
    message: counters.message,
  });
}

async function rescanDataset(
  page: Page,
  dataset: RescanDataset,
  jsonPath: string,
  continueSignalFile?: string,
): Promise<void> {
  const raw = await fs.readFile(jsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${jsonPath} khong phai JSON array`);
  }

  const records = parsed as Array<Record<string, unknown>>;
  const { candidates, skippedDuplicates } = buildRescanCandidates(records, dataset);
  const counters: RescanDatasetCounters = {
    queued: candidates.length,
    processing: 0,
    success: 0,
    failed: 0,
    skipped: skippedDuplicates,
    message: candidates.length ? "Dang cho xu ly" : "Khong co hoa don can ra lai",
  };
  emitDatasetProgress(dataset, "running", counters);

  if (!candidates.length) {
    emitDatasetProgress(dataset, "success", { ...counters, message: "Khong co hoa don can ra lai" });
    return;
  }

  const tabLabel =
    dataset === "sold" ? "Tra cuu hoa don dien tu ban ra" : "Tra cuu hoa don dien tu mua vao";
  logger.info(
    `[RESCAN][${dataset}] Danh sach ${candidates.length} hoa don thieu lineItems (bo qua ${skippedDuplicates} trung) - se tra cuu tai tab "${tabLabel}":`,
  );
  candidates.forEach((candidate, order) => {
    logger.info(
      `[RESCAN][${dataset}] #${order + 1} So hoa don: ${candidate.shdon} | Ngay: ${candidate.ngay || "?"} | Ky hieu: ${candidate.khhdon}`,
    );
  });

  const switched = await clickLookupTab(page, dataset);
  if (!switched) {
    emitDatasetProgress(dataset, "failed", { ...counters, message: "Khong tim thay tab tra cuu tuong ung" });
    return;
  }

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

      await fs.writeFile(continueSignalFile, action, "utf8").catch(() => undefined);
      return false;
    } catch {
      return false;
    }
  };

  let interrupted = false;

  for (const candidate of candidates) {
    if (await consumeStopSignal()) {
      interrupted = true;
      counters.currentKey = undefined;
      counters.message = "Da nhan yeu cau dung. Tam dung ra lai theo yeu cau.";
      break;
    }

    counters.processing += 1;
    counters.currentKey = `${candidate.khhdon}|${candidate.khmshdon}|${candidate.shdon}`;
    counters.message = `Dang xu ly so hoa don ${candidate.shdon}`;
    emitDatasetProgress(dataset, "running", counters);

    try {
      const filled = await fillInvoiceNumberFilter(page, candidate.shdon);
      if (!filled) {
        counters.failed += 1;
        counters.message = `Khong tim thay o nhap So hoa don cho ${candidate.shdon}`;
        emitDatasetProgress(dataset, "running", counters);
        counters.processing -= 1;
        continue;
      }

      if (candidate.ngay) {
        const dateFilled = await fillInvoiceDateFilter(page, candidate.ngay);
        if (!dateFilled) {
          counters.failed += 1;
          counters.message = `Khong tim thay o nhap ngay tim kiem cho ${candidate.shdon} (${candidate.ngay})`;
          emitDatasetProgress(dataset, "running", counters);
          counters.processing -= 1;
          continue;
        }
      }

      const searched = await clickSearchByInvoice(page);
      if (!searched) {
        counters.failed += 1;
        counters.message = `Khong bam duoc nut Tim kiem cho ${candidate.shdon}`;
        emitDatasetProgress(dataset, "running", counters);
        counters.processing -= 1;
        continue;
      }

      const rowIndex = await findRowIndexByInvoiceNumber(page, candidate.shdon, candidate.ngay || undefined);
      if (rowIndex < 0) {
        counters.failed += 1;
        counters.message = candidate.ngay
          ? `Khong tim thay ket qua khop So hoa don ${candidate.shdon} ngay ${candidate.ngay}`
          : `Khong tim thay ket qua khop So hoa don ${candidate.shdon}`;
        emitDatasetProgress(dataset, "running", counters);
        counters.processing -= 1;
        continue;
      }

      const row = page.locator(".ant-table-tbody tr").nth(rowIndex);

      // After search results render, we MUST click the matching invoice row in the
      // result list so it becomes active/selected before doing anything else.
      const rowSelected = await selectResultRow(page, row);
      emitDatasetProgress(dataset, "running", {
        ...counters,
        message: rowSelected
          ? `Da chon dong hoa don ${candidate.shdon} trong ket qua`
          : `Da click dong hoa don ${candidate.shdon} (chua thay highlight, van tiep tuc)`,
      });

      // Fresh search re-rendered the toolbar/table, so drop any stale mark from a
      // previous invoice before locating the "Xem hoa don" icon for this row.
      await clearViewInvoiceMark(page);
      const foundViewIcon = await findAndMarkViewInvoiceButton(page);
      if (!foundViewIcon) {
        counters.failed += 1;
        counters.message = `Khong tim thay icon Xem hoa don cho ${candidate.shdon}`;
        emitDatasetProgress(dataset, "running", counters);
        counters.processing -= 1;
        continue;
      }

      const networkDetail = tryExtractDetailFromNetwork(
        page,
        {
          shdon: candidate.shdon,
          khhdon: candidate.khhdon,
          khmshdon: candidate.khmshdon,
          mst: String(records[candidate.index]?.mst ?? ""),
        },
        18000,
      );

      let modalOpened = false;
      for (let clickTry = 1; clickTry <= 2; clickTry += 1) {
        if (clickTry > 1) {
          // Re-select the row and re-detect the icon (the mark may have gone stale).
          await selectResultRow(page, row);
          await clearViewInvoiceMark(page);
          await findAndMarkViewInvoiceButton(page);
          emitDatasetProgress(dataset, "running", {
            ...counters,
            message: `Retry click hoa don ${candidate.shdon} truoc khi bam icon`,
          });
        }

        // Click the actual clickable control (button/anchor ancestor), not a
        // possibly-detached inner <span>/<svg>.
        const viewBtn = page.locator('[data-gdt-view="1"]').first();
        const clickable = viewBtn.locator(
          'xpath=ancestor-or-self::*[self::button or self::a or @role="button"][1]',
        );
        if (await clickable.count()) {
          await clickable.first().click().catch(() => undefined);
        } else {
          await viewBtn.click().catch(() => undefined);
        }
        modalOpened = await page
          .waitForSelector(".ant-modal-body, .ant-modal", { timeout: 4000, state: "visible" })
          .then(() => true)
          .catch(() => false);
        if (modalOpened) {
          break;
        }
      }

      if (!modalOpened) {
        counters.failed += 1;
        counters.message = `Khong mo duoc modal cho ${candidate.shdon} sau 2 lan click icon`;
        emitDatasetProgress(dataset, "running", counters);
        counters.processing -= 1;
        continue;
      }

      let detail = (await networkDetail) ?? (await extractInvoiceDetail(page));
      if (!detail.lineItems.length) {
        for (let retry = 1; retry <= 2; retry += 1) {
          await page.waitForTimeout(250 * retry);
          detail = await extractInvoiceDetail(page);
          if (detail.lineItems.length) {
            break;
          }
        }
      }
      await closeInvoiceModal(page);

      if (!detail.lineItems.length) {
        counters.failed += 1;
        counters.message = `Khong lay duoc lineItems cho ${candidate.shdon}`;
        emitDatasetProgress(dataset, "running", counters);
        counters.processing -= 1;
        continue;
      }

      records[candidate.index] = {
        ...records[candidate.index],
        info: detail.info,
        lineItems: detail.lineItems,
        itemNames: detail.itemNames,
      };
      await writeJsonAtomic(jsonPath, records);

      counters.success += 1;
      counters.message = `Da cap nhat ${candidate.shdon} (${detail.lineItems.length} dong)`;
      emitDatasetProgress(dataset, "running", counters);
    } catch (error) {
      counters.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      counters.message = `Loi khi ra lai ${candidate.shdon}: ${message.slice(0, 120)}`;
      emitDatasetProgress(dataset, "running", counters);
      await closeInvoiceModal(page).catch(() => undefined);
    } finally {
      counters.processing = Math.max(0, counters.processing - 1);
    }
  }

  emitDatasetProgress(dataset, interrupted || counters.failed > 0 ? "failed" : "success", {
    ...counters,
    processing: 0,
    currentKey: undefined,
    message:
      interrupted
        ? `Da dung theo yeu cau (${counters.success}/${counters.queued} da cap nhat)`
        : counters.failed > 0
        ? `Hoan tat voi loi (${counters.success} thanh cong, ${counters.failed} that bai)`
        : `Hoan tat (${counters.success}/${counters.queued} thanh cong)`,
  });
}

async function rescanEmptyLineItemsFromJson(page: Page, baseDir: string, continueSignalFile?: string): Promise<void> {
  const soldPath = join(baseDir, "hd_sold.json");
  const purchasedPath = join(baseDir, "hd_purchased.json");

  await rescanDataset(page, "sold", soldPath, continueSignalFile);
  await rescanDataset(page, "purchased", purchasedPath, continueSignalFile);
}

export { emitDatasetProgress, rescanDataset, rescanEmptyLineItemsFromJson };

