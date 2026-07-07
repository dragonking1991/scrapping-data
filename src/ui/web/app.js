const form = document.getElementById("runForm");
const logEl = document.getElementById("log");
const statusBadge = document.getElementById("statusBadge");

const startBtn = document.getElementById("startBtn");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const closeSessionBtn = document.getElementById("closeSessionBtn");
const clearBtn = document.getElementById("clearLog");

const aggregateBtn = document.getElementById("aggregateBtn");
const sessionSelect = document.getElementById("sessionSelect");

const testNextPageBtn = document.getElementById("testNextPageBtn");
const testScanPageBtn = document.getElementById("testScanPageBtn");
const testOpenInvoiceBtn = document.getElementById("testOpenInvoiceBtn");
const testSelectRowBtn = document.getElementById("testSelectRowBtn");
const testRowInput = document.getElementById("testRowInput");

const clearEventsBtn = document.getElementById("clearEvents");
const eventTimeline = document.getElementById("eventTimeline");
const testPaginationValue = document.getElementById("testPaginationValue");

const ACTIVE_JOB_STORAGE_KEY = "gdt-active-job-id";
const DEFAULT_OUT = window.__DEFAULT_OUT__ || "./DANH-SACH-HOA-DON.xlsx";

let isBusy = false;
let hasSession = false;
let isRunningFlow = false;
let continueInFlight = false;
let closingSession = false;
let currentJobId = null;
let eventSource = null;

let eventCount = 0;
let eventLineBuffer = "";

const EVENT_LABELS = {
  "rows-found": ["🧾", "text-emerald-300"],
  "no-rows": ["⚠️", "text-amber-300"],
  stopped: ["⏸️", "text-amber-300"],
  resumed: ["▶️", "text-emerald-300"],
  "select-checkbox": ["☑️", "text-sky-300"],
  "click-row": ["👆", "text-sky-300"],
  "find-icon": ["🔍", "text-slate-300"],
  hover: ["🖱️", "text-slate-400"],
  "found-view-icon": ["👁️", "text-emerald-300"],
  "icon-not-found": ["❌", "text-rose-300"],
  "click-view": ["👁️", "text-blue-300"],
  "detail-modal": ["🪟", "text-amber-300"],
  "items-extracted": ["📦", "text-emerald-300"],
  "items-empty": ["⚠️", "text-amber-300"],
  "modal-closed": ["✖️", "text-slate-400"],
  "next-page": ["⏭️", "text-sky-300"],
  "pagination-state": ["📄", "text-cyan-300"],
  "pagination-end": ["🏁", "text-emerald-300"],
  "row-error": ["🛑", "text-rose-300"],
  saved: ["💾", "text-emerald-300"],
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setLog(text) {
  logEl.textContent = text;
  logEl.scrollTop = logEl.scrollHeight;
}

function appendLog(text) {
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = cls;
}

function applyControlState() {
  if (startBtn) startBtn.disabled = isBusy || continueInFlight;
  if (runBtn) runBtn.disabled = isBusy || continueInFlight || !hasSession;
  if (stopBtn) stopBtn.disabled = !isRunningFlow;
  if (closeSessionBtn) closeSessionBtn.disabled = !hasSession || closingSession;
  if (sessionSelect) sessionSelect.disabled = isBusy || continueInFlight;

  if (testNextPageBtn) testNextPageBtn.disabled = !hasSession;
  if (testScanPageBtn) testScanPageBtn.disabled = !hasSession;
  if (testOpenInvoiceBtn) testOpenInvoiceBtn.disabled = !hasSession;
  if (testSelectRowBtn) testSelectRowBtn.disabled = !hasSession;
  if (testRowInput) testRowInput.disabled = !hasSession;
}

function setSessionJobId(jobId) {
  currentJobId = jobId || null;
  hasSession = Boolean(currentJobId);
  if (!hasSession) {
    isRunningFlow = false;
  }

  if (currentJobId) {
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, currentJobId);
  } else {
    localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  }

  if (sessionSelect) {
    sessionSelect.value = currentJobId || "";
  }

  applyControlState();
}

function updatePaginationLabel(detail) {
  if (!testPaginationValue) return;
  const match = String(detail || "").match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    testPaginationValue.textContent = `${match[1]}/${match[2]}`;
  }
}

function resetEventTimeline() {
  eventCount = 0;
  eventLineBuffer = "";
  if (eventTimeline) {
    eventTimeline.innerHTML =
      '<p class="text-slate-500">Chưa có sự kiện nào. Chạy "Lấy thông tin" để bắt đầu ghi.</p>';
  }
}

function renderEvent(evt) {
  if (!eventTimeline) return;
  if (eventCount === 0) eventTimeline.innerHTML = "";
  eventCount += 1;

  const [icon, tone] = EVENT_LABELS[evt.action] || ["•", "text-slate-300"];
  const time = new Date(evt.ts || Date.now());
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  const ss = String(time.getSeconds()).padStart(2, "0");

  const wrap = document.createElement("div");
  wrap.className = "rounded-lg border border-slate-800 bg-slate-900/60 p-2";
  wrap.innerHTML =
    `<div class="flex items-start gap-2">` +
    `<span class="shrink-0">${icon}</span>` +
    `<span class="shrink-0 font-mono text-[10px] text-slate-500">${hh}:${mm}:${ss}</span>` +
    `<span class="font-mono text-[11px] font-bold ${tone}">${escapeHtml(evt.action)}</span>` +
    `<span class="min-w-0 break-words text-slate-300">${escapeHtml(evt.detail || "")}</span>` +
    `</div>`;

  eventTimeline.appendChild(wrap);
  eventTimeline.scrollTop = eventTimeline.scrollHeight;

  if (
    evt.action === "pagination-state" ||
    evt.action === "next-page" ||
    evt.action === "pagination-end"
  ) {
    updatePaginationLabel(evt.detail || "");
  }
}

function ingestEventChunk(chunk) {
  eventLineBuffer += chunk;
  let idx;
  while ((idx = eventLineBuffer.indexOf("\n")) >= 0) {
    const line = eventLineBuffer.slice(0, idx);
    eventLineBuffer = eventLineBuffer.slice(idx + 1);
    const marker = line.indexOf("[GDT-EVENT]");
    if (marker >= 0) {
      const jsonPart = line.slice(marker + "[GDT-EVENT]".length).trim();
      try {
        renderEvent(JSON.parse(jsonPart));
      } catch {
        // ignore malformed event line
      }
    }
  }
}

async function refreshSessions() {
  if (!sessionSelect) return;

  try {
    const res = await fetch("/sessions");
    const data = await res.json();
    const sessions = data?.sessions || [];
    const prev = currentJobId || sessionSelect.value || "";

    if (sessions.length === 0) {
      sessionSelect.innerHTML =
        '<option value="">(chưa có session — bấm Bắt đầu để mở)</option>';
    } else {
      let html = '<option value="">(chọn session)</option>';
      sessions.forEach((s, idx) => {
        const t = new Date(s.startedAt);
        const hh = String(t.getHours()).padStart(2, "0");
        const mm = String(t.getMinutes()).padStart(2, "0");
        const ss = String(t.getSeconds()).padStart(2, "0");
        const label = `Session ${idx + 1} • ${hh}:${mm}:${ss} • ${s.jobId}`;
        html += `<option value="${s.jobId}">${label}</option>`;
      });
      sessionSelect.innerHTML = html;
    }

    if (prev && sessions.some((s) => s.jobId === prev)) {
      sessionSelect.value = prev;
    }
  } catch {
    // ignore transient fetch errors
  }
}

function attachJobEvents(jobId) {
  if (currentJobId === jobId && eventSource) return;

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  setSessionJobId(jobId);
  eventSource = new EventSource(`/events?jobId=${encodeURIComponent(jobId)}`);

  eventSource.addEventListener("log", (ev) => {
    const payload = JSON.parse(ev.data);
    const chunk = payload.chunk || "";
    appendLog(chunk);
    ingestEventChunk(chunk);
  });

  eventSource.addEventListener("status", (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.status === "running") {
      isRunningFlow = true;
      setStatus(
        "Đang chạy",
        "rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300",
      );
      applyControlState();
      return;
    }

    if (payload.status === "paused") {
      isRunningFlow = false;
      setStatus(
        "Đã dừng flow",
        "rounded-full bg-sky-500/20 px-3 py-1 text-xs font-bold text-sky-300",
      );
      isBusy = false;
      continueInFlight = false;
      applyControlState();
      return;
    }

    if (payload.status === "success") {
      isRunningFlow = false;
      setStatus(
        "Thành công",
        "rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300",
      );
    } else if (payload.status === "failed") {
      isRunningFlow = false;
      setStatus(
        "Thất bại",
        "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
      );
    }

    if (payload.status === "success" || payload.status === "failed") {
      isBusy = false;
      continueInFlight = false;
      setSessionJobId(null);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      applyControlState();
    }
  });

  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}

async function sendDebugAction(action, label) {
  if (!hasSession) return;
  try {
    const res = await fetch("/debug-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: currentJobId || undefined, action }),
    });
    const data = await res.json();
    appendLog(
      data.ok
        ? `[UI-TEST] Da gui test: ${label}\n`
        : `[UI-TEST] Loi: ${data.output || "Khong gui duoc test action"}\n`,
    );
  } catch (error) {
    appendLog(`[UI-TEST] Loi gui test action: ${String(error)}\n`);
  }
}

async function startBrowser() {
  if (isBusy || continueInFlight) return;
  continueInFlight = true;
  isBusy = true;
  applyControlState();

  setStatus(
    "Đang mở browser",
    "rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300",
  );
  setLog("Dang mo Cloakbrowser va chuan bi browser session...\n");

  try {
    const res = await fetch("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        direction: "sold",
        out: DEFAULT_OUT,
        verifyOnly: false,
        manualFirst: true,
        autoExportXml: true,
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      setStatus(
        "Thất bại",
        "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
      );
      setLog((data.output || "Khong mo duoc browser") + "\n");
      return;
    }

    if (data.jobId) attachJobEvents(data.jobId);
    isRunningFlow = true;
    await refreshSessions();
    setStatus(
      "Đã mở browser",
      "rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300",
    );
    appendLog(
      "[UI] Da mo browser va dien user/pass. Ban nhap captcha + dang nhap + bam Tim kiem tren GDT. Sau do bam Lay thong tin de tiep tuc cung browser session.\n",
    );
  } catch (error) {
    setStatus(
      "Lỗi",
      "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
    );
    setLog(String(error));
  } finally {
    isBusy = false;
    continueInFlight = false;
    applyControlState();
  }
}

async function continueJob() {
  if (isBusy || continueInFlight) return;

  const activeJobId = currentJobId || sessionSelect?.value || "";
  if (!activeJobId) {
    setStatus(
      "Thiếu session",
      "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
    );
    appendLog(
      "[UI] Khong co session dang mo. Bam Bat dau de tao session moi.\n",
    );
    setSessionJobId(null);
    return;
  }

  continueInFlight = true;
  isBusy = true;
  resetEventTimeline();
  applyControlState();

  try {
    attachJobEvents(activeJobId);
    const res = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId }),
    });
    const data = await res.json();

    if (!data.ok || !data.jobId) {
      if (
        String(data.output || "").includes("Khong tim thay browser session")
      ) {
        setSessionJobId(null);
      }
      setStatus(
        "Thất bại",
        "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
      );
      appendLog((data.output || "Khong tao duoc job") + "\n");
      return;
    }

    attachJobEvents(data.jobId);
    isRunningFlow = true;
    setStatus(
      "Đang chạy",
      "rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300",
    );
    appendLog(
      `[UI] ${data.output || "Da gui tin hieu tiep tuc cho browser session hien tai."}\n`,
    );
  } catch (error) {
    setStatus(
      "Lỗi",
      "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
    );
    setLog(String(error));
  } finally {
    isBusy = false;
    continueInFlight = false;
    applyControlState();
  }
}

async function stopCurrentJob() {
  const targetJobId = currentJobId || sessionSelect?.value || "";
  if (!targetJobId) return;
  try {
    const res = await fetch("/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: targetJobId }),
    });
    const data = await res.json();
    appendLog(
      data.ok
        ? "[UI] Da gui yeu cau dung job.\n"
        : `[UI] Khong dung duoc: ${data.output || ""}\n`,
    );
  } catch (error) {
    appendLog(`[UI] Loi khi dung job: ${String(error)}\n`);
  }
}

async function closeSession() {
  if (closingSession || !hasSession) return;
  const targetJobId = currentJobId || sessionSelect?.value || "";
  if (!targetJobId) {
    appendLog("[UI] Khong co session de tat.\n");
    return;
  }

  closingSession = true;
  applyControlState();

  try {
    const res = await fetch("/close-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: targetJobId }),
    });
    const data = await res.json();
    if (!data.ok) {
      appendLog(`[UI] Khong tat duoc session: ${data.output || ""}\n`);
      return;
    }

    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    setSessionJobId(null);
    isRunningFlow = false;
    setStatus(
      "Đã tắt session",
      "rounded-full bg-slate-500/20 px-3 py-1 text-xs font-bold text-slate-300",
    );
    appendLog(`[UI] Da tat session ${targetJobId}.\n`);
    await refreshSessions();
  } catch (error) {
    appendLog(`[UI] Loi khi tat session: ${String(error)}\n`);
  } finally {
    closingSession = false;
    applyControlState();
  }
}

clearBtn?.addEventListener("click", () => setLog(""));
clearEventsBtn?.addEventListener("click", resetEventTimeline);

startBtn?.addEventListener("click", startBrowser);
form?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  await continueJob();
});

stopBtn?.addEventListener("click", stopCurrentJob);
closeSessionBtn?.addEventListener("click", closeSession);

sessionSelect?.addEventListener("change", () => {
  const chosen = sessionSelect.value;
  if (!chosen) {
    setSessionJobId(null);
    return;
  }
  attachJobEvents(chosen);
  setLog(
    `[UI] Da switch sang session ${chosen}. Bam "Lay thong tin" de tiep tuc.\n`,
  );
});

aggregateBtn?.addEventListener("click", async () => {
  try {
    const res = await fetch("/aggregate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    appendLog(
      data.ok
        ? `[AGG] Da gui job tong hop: ${data.jobId}\n`
        : `[AGG] Loi: ${data.output || "Khong tao duoc job"}\n`,
    );
  } catch (error) {
    appendLog(`[AGG] Loi: ${String(error)}\n`);
  }
});

testNextPageBtn?.addEventListener("click", () =>
  sendDebugAction("debug-next-page", "chuyen trang"),
);
testScanPageBtn?.addEventListener("click", () =>
  sendDebugAction("debug-read-pagination", "quet phan trang"),
);
testOpenInvoiceBtn?.addEventListener("click", () =>
  sendDebugAction("debug-open-invoice", "bam xem hoa don"),
);
testSelectRowBtn?.addEventListener("click", async () => {
  const rowNum = Math.max(1, Number(testRowInput?.value || "1") || 1);
  await sendDebugAction(`debug-select-row:${rowNum}`, `chon row #${rowNum}`);
});

setSessionJobId(localStorage.getItem(ACTIVE_JOB_STORAGE_KEY));
refreshSessions();
setInterval(refreshSessions, 4000);
