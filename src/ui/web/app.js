import { closeSession, continueJob, sendDebugAction, startBrowser, stopCurrentJob } from "./actions.js";
import { trackAggregateJob } from "./aggregate.js";
import { dom } from "./dom.js";
import { resetEventTimeline } from "./event-timeline.js";
import { appendLog, setLog } from "./log-utils.js";
import { DEFAULT_PURCHASED_TYPE, ACTIVE_JOB_STORAGE_KEY, state } from "./state.js";
import { attachJobEvents, refreshSessions, setSessionJobId } from "./sessions.js";
import { syncPurchasedModeControls } from "./ui-controls.js";

function openSetupGuideModal() {
  if (!dom.setupGuideModal) return;
  dom.setupGuideModal.classList.remove("hidden");
  dom.setupGuideModal.classList.add("flex");
}

function closeSetupGuideModal() {
  if (!dom.setupGuideModal) return;
  dom.setupGuideModal.classList.add("hidden");
  dom.setupGuideModal.classList.remove("flex");
}

async function startAggregate() {
  if (state.isAggregating) return;
  try {
    const res = await fetch("/aggregate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!data.ok || !data.jobId) {
      appendLog(`[AGG] Loi: ${data.output || "Khong tao duoc job"}\n`);
      return;
    }

    appendLog(`[AGG] Da gui job tong hop: ${data.jobId}\n`);
    trackAggregateJob(data.jobId);
  } catch (error) {
    appendLog(`[AGG] Loi: ${String(error)}\n`);
  }
}

function bindEvents() {
  dom.clearBtn?.addEventListener("click", () => setLog(""));
  dom.clearEventsBtn?.addEventListener("click", resetEventTimeline);
  dom.startBtn?.addEventListener("click", startBrowser);
  dom.stopBtn?.addEventListener("click", stopCurrentJob);
  dom.closeSessionBtn?.addEventListener("click", closeSession);
  dom.aggregateBtn?.addEventListener("click", () => void startAggregate());

  dom.form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await continueJob();
  });

  dom.sessionSelect?.addEventListener("change", () => {
    const chosen = dom.sessionSelect.value;
    if (!chosen) {
      setSessionJobId(null);
      return;
    }
    attachJobEvents(chosen);
    setLog(`[UI] Da switch sang session ${chosen}. Bam "Lay thong tin" de tiep tuc.\n`);
  });

  dom.purchasedModeCheckbox?.addEventListener("change", () => {
    if (dom.purchasedModeCheckbox.checked && dom.purchasedTypeSelect && !dom.purchasedTypeSelect.value) {
      dom.purchasedTypeSelect.value = DEFAULT_PURCHASED_TYPE;
    }
    syncPurchasedModeControls();
  });

  dom.purchasedTypeSelect?.addEventListener("change", () => {
    if (!dom.purchasedTypeSelect.value) {
      dom.purchasedTypeSelect.value = DEFAULT_PURCHASED_TYPE;
    }
  });

  dom.setupGuideBtn?.addEventListener("click", openSetupGuideModal);
  dom.closeSetupGuideBtn?.addEventListener("click", closeSetupGuideModal);
  dom.setupGuideModal?.addEventListener("click", (event) => {
    if (event.target === dom.setupGuideModal) {
      closeSetupGuideModal();
    }
  });

  dom.testNextPageBtn?.addEventListener("click", () =>
    sendDebugAction("debug-next-page", "chuyen trang"),
  );
  dom.testScanPageBtn?.addEventListener("click", () =>
    sendDebugAction("debug-read-pagination", "quet phan trang"),
  );
  dom.testOpenInvoiceBtn?.addEventListener("click", () =>
    sendDebugAction("debug-open-invoice", "bam xem hoa don"),
  );
  dom.testSelectRowBtn?.addEventListener("click", async () => {
    const rowNum = Math.max(1, Number(dom.testRowInput?.value || "1") || 1);
    await sendDebugAction(`debug-select-row:${rowNum}`, `chon row #${rowNum}`);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSetupGuideModal();
  });
}

function init() {
  setSessionJobId(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY));
  if (dom.purchasedTypeSelect) {
    dom.purchasedTypeSelect.value = DEFAULT_PURCHASED_TYPE;
  }
  syncPurchasedModeControls();
  void refreshSessions();
  setInterval(() => {
    void refreshSessions();
  }, 4000);
  bindEvents();
}

init();
