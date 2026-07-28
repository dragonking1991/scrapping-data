import { dom } from "./dom.js";
import { resetEventTimeline } from "./event-timeline.js";
import { appendLog, setLog, setStatus } from "./log-utils.js";
import { DEFAULT_OUT, state } from "./state.js";
import { getSelectedRunMode, applyControlState } from "./ui-controls.js";
import { attachJobEvents, refreshSessions, setSessionJobId } from "./sessions.js";

export async function sendDebugAction(action, label) {
  if (!state.hasSession) return;
  try {
    const res = await fetch("/debug-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: state.currentJobId || undefined, action }),
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

export async function startBrowser() {
  if (state.isBusy || state.continueInFlight) return;
  state.continueInFlight = true;
  state.isBusy = true;
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
    state.isRunningFlow = true;
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
    state.isBusy = false;
    state.continueInFlight = false;
    applyControlState();
  }
}

export async function continueJob() {
  if (state.isBusy || state.continueInFlight) return;

  const activeJobId = state.currentJobId || dom.sessionSelect?.value || "";
  if (!activeJobId) {
    setStatus(
      "Thiếu session",
      "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
    );
    appendLog("[UI] Khong co session dang mo. Bam Bat dau de tao session moi.\n");
    setSessionJobId(null);
    return;
  }

  state.continueInFlight = true;
  state.isBusy = true;
  resetEventTimeline();
  applyControlState();
  const runMode = getSelectedRunMode();

  try {
    attachJobEvents(activeJobId);
    const res = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: activeJobId, runMode }),
    });
    const data = await res.json();

    if (!data.ok || !data.jobId) {
      if (String(data.output || "").includes("Khong tim thay browser session")) {
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
    state.isRunningFlow = true;
    setStatus(
      "Đang chạy",
      "rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300",
    );
    appendLog(`[UI] ${data.output || "Da gui tin hieu tiep tuc cho browser session hien tai."} mode=${runMode}\n`);
  } catch (error) {
    setStatus(
      "Lỗi",
      "rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300",
    );
    setLog(String(error));
  } finally {
    state.isBusy = false;
    state.continueInFlight = false;
    applyControlState();
  }
}

export async function stopCurrentJob() {
  const targetJobId = state.currentJobId || dom.sessionSelect?.value || "";
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

export async function closeSession() {
  if (state.closingSession || !state.hasSession) return;
  const targetJobId = state.currentJobId || dom.sessionSelect?.value || "";
  if (!targetJobId) {
    appendLog("[UI] Khong co session de tat.\n");
    return;
  }

  state.closingSession = true;
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

    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }

    setSessionJobId(null);
    state.isRunningFlow = false;
    setStatus(
      "Đã tắt session",
      "rounded-full bg-slate-500/20 px-3 py-1 text-xs font-bold text-slate-300",
    );
    appendLog(`[UI] Da tat session ${targetJobId}.\n`);
    await refreshSessions();
  } catch (error) {
    appendLog(`[UI] Loi khi tat session: ${String(error)}\n`);
  } finally {
    state.closingSession = false;
    applyControlState();
  }
}
