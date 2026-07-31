import { dom } from "./dom.js";
import { appendLog } from "./log-utils.js";
import { state } from "./state.js";
import { applyControlState } from "./ui-controls.js";

function getAggregateStatusPresentation(status) {
  switch (status) {
    case "running":
      return {
        label: "Đang chạy",
        className: "rounded-full bg-amber-200 px-2 py-0.5 font-bold text-amber-800",
      };
    case "success":
      return {
        label: "Thành công",
        className: "rounded-full bg-emerald-200 px-2 py-0.5 font-bold text-emerald-800",
      };
    case "failed":
      return {
        label: "Lỗi",
        className: "rounded-full bg-rose-200 px-2 py-0.5 font-bold text-rose-800",
      };
    case "skipped":
      return {
        label: "Bỏ qua",
        className: "rounded-full bg-slate-300 px-2 py-0.5 font-bold text-slate-700",
      };
    default:
      return {
        label: "Chưa chạy",
        className: "rounded-full bg-slate-200 px-2 py-0.5 font-bold text-slate-700",
      };
  }
}

function renderAggregateFile(file, statusEl, msgEl) {
  if (!statusEl || !msgEl) return;
  const view = getAggregateStatusPresentation(file?.status || "pending");
  statusEl.textContent = view.label;
  statusEl.className = view.className;
  msgEl.textContent =
    file?.message ||
    (file?.status === "pending" ? "Chưa có trạng thái." : "Không có thông tin.");
}

function clearAggregatePolling() {
  if (state.aggregatePollTimer) {
    clearInterval(state.aggregatePollTimer);
    state.aggregatePollTimer = null;
  }
}

function renderAggregateJob(job) {
  if (!job) return;
  renderAggregateFile(job.files?.sold, dom.aggSoldStatus, dom.aggSoldMsg);
  renderAggregateFile(job.files?.purchased, dom.aggPurchasedStatus, dom.aggPurchasedMsg);
  state.isAggregating = job.status === "running";
  applyControlState();
}

function parseDateForSort(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  const normalized = value.replace(/[-.]/g, "/");
  const [datePart] = normalized.split(" ");
  const match = datePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;

  const date = new Date(year, month - 1, day);
  const valid =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day;
  return valid ? date.getTime() : null;
}

function logAggregateFileResult(label, file) {
  if (!file) {
    appendLog(`[AGG] ${label}: Khong co du lieu.\n`);
    return;
  }

  appendLog(
    `[AGG] ${label}: status=${file.status}, unmatched=${file.unmatchedRows}\n`,
  );

  const unmatchedIds = Array.isArray(file.unmatchedInvoiceKeys) ? file.unmatchedInvoiceKeys : [];
  const unmatchedByDate =
    file && typeof file.unmatchedInvoiceKeysByDate === "object"
      ? file.unmatchedInvoiceKeysByDate
      : {};

  const groupedDates = Object.entries(unmatchedByDate).filter(
    ([, ids]) => Array.isArray(ids) && ids.length > 0,
  );

  if (groupedDates.length > 0) {
    appendLog(`[AGG] ${label} | ID khong khop theo ngay:\n`);
    groupedDates
      .sort(([dateA], [dateB]) => {
        const tsA = parseDateForSort(dateA);
        const tsB = parseDateForSort(dateB);
        if (tsA != null && tsB != null) return tsA - tsB;
        if (tsA != null) return -1;
        if (tsB != null) return 1;
        return dateA.localeCompare(dateB, "vi");
      })
      .forEach(([date, ids]) => {
        appendLog(`[AGG] ${label} |   - ${date} (${ids.length}): ${ids.join(", ")}\n`);
      });
  }

  appendLog(
    `[AGG] ${label} | ID khong khop (${unmatchedIds.length}): ${unmatchedIds.length > 0 ? unmatchedIds.join(", ") : "(khong co)"}\n`,
  );
}

function logAggregatePurchasedTypeResults(job) {
  const purchasedTypes = job?.files?.purchasedTypes;
  if (!purchasedTypes) return;

  ["hasCode", "noCode", "initCode"].forEach((type) => {
    const file = purchasedTypes[type];
    logAggregateFileResult(`hd_purchased_${type}.xlsx`, file);
  });
}

async function fetchAggregateStatus(jobId) {
  const res = await fetch(`/aggregate-status?jobId=${encodeURIComponent(jobId)}`);
  const data = await res.json();
  if (!data.ok || !data.job) {
    throw new Error(data.output || "Khong doc duoc trang thai tong hop");
  }
  return data.job;
}

export function trackAggregateJob(jobId) {
  state.aggregateJobId = jobId;
  state.isAggregating = true;
  applyControlState();
  clearAggregatePolling();

  const refresh = async () => {
    if (!state.aggregateJobId) return;
    try {
      const job = await fetchAggregateStatus(state.aggregateJobId);
      renderAggregateJob(job);

      if (job.status === "success" || job.status === "failed") {
        clearAggregatePolling();
        state.aggregateJobId = null;
        appendLog(`[AGG] Hoan tat job tong hop: ${job.id} (${job.status}).\n`);
        logAggregateFileResult("hd_sold.xlsx", job.files?.sold);
        logAggregateFileResult("hd_purchased.xlsx", job.files?.purchased);
        logAggregatePurchasedTypeResults(job);
      }
    } catch (error) {
      clearAggregatePolling();
      state.aggregateJobId = null;
      state.isAggregating = false;
      applyControlState();
      appendLog(`[AGG] Loi cap nhat trang thai: ${String(error)}\n`);
    }
  };

  void refresh();
  state.aggregatePollTimer = setInterval(() => {
    void refresh();
  }, 1200);
}
