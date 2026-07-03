import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { logger } from "../../shared/logger.js";
import type { RescanDataset, RescanDatasetCounters } from "./shared.js";
import { emitRescanStatus, buildRescanCandidates, writeJsonAtomic } from "./rescan-common.js";
import { clickLookupTab } from "./lookup-tab.js";
import {
  fillInvoiceNumberFilter,
  fillInvoiceDateFilter,
  clickSearchByInvoice,
  findRowIndexByInvoiceNumber,
} from "./search-filters.js";
import { tryExtractDetailFromNetwork, extractInvoiceDetail, closeInvoiceModal } from "./detail.js";
import { findAndMarkViewInvoiceButton } from "./toolbar-view.js";

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

  for (const candidate of candidates) {
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
      await row.click().catch(() => undefined);
      await page.waitForTimeout(220);

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

      await page.locator('[data-gdt-view="1"]').first().click().catch(() => undefined);
      await page.waitForSelector(".ant-modal-body, .ant-modal", { timeout: 15000, state: "visible" }).catch(() => undefined);

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

  emitDatasetProgress(dataset, counters.failed > 0 ? "failed" : "success", {
    ...counters,
    processing: 0,
    currentKey: undefined,
    message:
      counters.failed > 0
        ? `Hoan tat voi loi (${counters.success} thanh cong, ${counters.failed} that bai)`
        : `Hoan tat (${counters.success}/${counters.queued} thanh cong)`,
  });
}

async function rescanEmptyLineItemsFromJson(page: Page, baseDir: string): Promise<void> {
  const soldPath = join(baseDir, "hd_sold.json");
  const purchasedPath = join(baseDir, "hd_purchased.json");

  await rescanDataset(page, "sold", soldPath);
  await rescanDataset(page, "purchased", purchasedPath);
}

export { emitDatasetProgress, rescanDataset, rescanEmptyLineItemsFromJson };

