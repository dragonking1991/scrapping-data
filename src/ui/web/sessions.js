import { dom } from "./dom.js";
import { ingestEventChunk } from "./event-timeline.js";
import { appendLog, setStatus } from "./log-utils.js";
import { ACTIVE_JOB_STORAGE_KEY, state } from "./state.js";
import { applyControlState } from "./ui-controls.js";

export function setSessionJobId(jobId) {
  state.currentJobId = jobId || null;
  state.hasSession = Boolean(state.currentJobId);
  if (!state.hasSession) state.isRunningFlow = false;

  if (state.currentJobId) {
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, state.currentJobId);
  } else {
    localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  }

  if (dom.sessionSelect) {
    dom.sessionSelect.value = state.currentJobId || "";
  }

  applyControlState();
}

export async function refreshSessions() {
  if (!dom.sessionSelect) return;

  try {
    const res = await fetch("/sessions");
    const data = await res.json();
    const sessions = data?.sessions || [];
    const prev = state.currentJobId || dom.sessionSelect.value || "";

    if (sessions.length === 0) {
      dom.sessionSelect.innerHTML =
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
      dom.sessionSelect.innerHTML = html;
    }

    if (prev && sessions.some((s) => s.jobId === prev)) {
      dom.sessionSelect.value = prev;
    }
  } catch {
    // Ignore transient fetch errors.
  }
}

function finalizeSessionStatus(payload) {
  if (payload.status === "success") {
    state.isRunningFlow = false;
    setStatus(
      "Thành công",
      "rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300",
    );
  } else if (payload.status === "failed") {
    state.isRunningFlow = false;
    setStatus(
      "Thất bại",
      "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
    );
  }

  if (payload.status === "success" || payload.status === "failed") {
    state.isBusy = false;
    state.continueInFlight = false;
    setSessionJobId(null);
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    applyControlState();
  }
}

export function attachJobEvents(jobId) {
  if (state.currentJobId === jobId && state.eventSource) return;

  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  setSessionJobId(jobId);
  state.eventSource = new EventSource(`/events?jobId=${encodeURIComponent(jobId)}`);

  state.eventSource.addEventListener("log", (ev) => {
    const payload = JSON.parse(ev.data);
    const chunk = payload.chunk || "";
    appendLog(chunk);
    ingestEventChunk(chunk);
  });

  state.eventSource.addEventListener("status", (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.status === "running") {
      state.isRunningFlow = true;
      setStatus(
        "Đang chạy",
        "rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300",
      );
      applyControlState();
      return;
    }

    if (payload.status === "paused") {
      state.isRunningFlow = false;
      setStatus(
        "Đã dừng flow",
        "rounded-full bg-sky-500/20 px-3 py-1 text-xs font-bold text-sky-300",
      );
      state.isBusy = false;
      state.continueInFlight = false;
      applyControlState();
      return;
    }

    finalizeSessionStatus(payload);
  });

  state.eventSource.onerror = () => {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
  };
}
