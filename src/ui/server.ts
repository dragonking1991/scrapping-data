import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { URL } from "node:url";
interface UiDefaults {
  out: string;
  direction: "sold" | "purchase";
}

interface RunPayload {
  out: string;
  direction: "sold" | "purchase";
  verifyOnly?: boolean;
  relogin?: boolean;
  manualFirst?: boolean;
  autoExportXml?: boolean;
}

interface StartPayload {
  direction: "sold" | "purchase";
  out: string;
  verifyOnly?: boolean;
  manualFirst?: boolean;
  autoExportXml?: boolean;
}

interface ContinuePayload {
  jobId?: string;
}

type JobStatus = "running" | "success" | "failed";

interface Job {
  id: string;
  status: JobStatus;
  output: string;
  startedAt: number;
  finishedAt?: number;
  child?: ChildProcess;
  stopped?: boolean;
}

const jobs = new Map<string, Job>();
const activeSessions = new Map<string, { jobId: string; continueSignalFile: string }>();

function parseArgValue(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }

  const inline = args.find((v) => v.startsWith(`${flag}=`));
  if (inline) {
    return inline.substring(flag.length + 1);
  }

  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", (err) => reject(err));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sseWrite(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimJobs(limit = 20): void {
  const all = Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
  for (let i = limit; i < all.length; i += 1) {
    const stale = all[i];
    if (stale) {
      jobs.delete(stale.id);
    }
  }
}

function buildCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GDT_")) {
      delete env[key];
    }
  }

  return env;
}

function validatePayload(payload: RunPayload): string | null {
  if (!["sold", "purchase"].includes(payload.direction)) {
    return "Loai hoa don khong hop le.";
  }

  if (!payload.verifyOnly && !payload.out.trim()) {
    return "Duong dan out khong duoc de trong khi chay pipeline.";
  }

  return null;
}

function validateStartPayload(payload: StartPayload): string | null {
  if (!["sold", "purchase"].includes(payload.direction)) {
    return "Loai hoa don khong hop le.";
  }

  if (!payload.verifyOnly && !payload.out.trim()) {
    return "Duong dan out khong duoc de trong khi chay pipeline.";
  }

  return null;
}

function html(defaults: UiDefaults): string {
  return `<!doctype html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GDT Invoice Runner</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;700;800&display=swap');
      body { font-family: 'Be Vietnam Pro', sans-serif; }
    </style>
  </head>
  <body class="min-h-screen bg-[radial-gradient(circle_at_top_left,_#fef9c3,_#fef2f2_45%,_#eff6ff)] text-slate-900">
    <div class="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-5 py-8 md:px-10">
      <header class="mb-8 rounded-3xl border border-amber-200/70 bg-white/80 p-6 shadow-xl backdrop-blur">
        <p class="text-xs font-bold uppercase tracking-[0.25em] text-amber-700">Scrape GDT Invoices</p>
        <h1 class="mt-2 text-3xl font-extrabold leading-tight md:text-4xl">Manual-first collector cho hóa đơn GDT</h1>
        <p class="mt-3 max-w-3xl text-sm text-slate-600">Bam Bat dau de mo Cloakbrowser va dien san user/pass. Ban nhap captcha, dang nhap va bam Tim kiem tren GDT. Sau do bam Lay thong tin de xem tung hoa don va ghi lai ten hang hoa/dich vu.</p>
      </header>

      <main class="grid gap-6 lg:grid-cols-[360px,minmax(0,1fr)] items-start">
        <section class="w-full min-w-0 rounded-3xl border border-slate-200 bg-white p-6 shadow-lg lg:sticky lg:top-8">
          <h2 class="text-lg font-bold">Thiết lập chạy</h2>
          <p class="mt-1 text-sm text-slate-500">Khoang ngay duoc doc tu man hinh tra cuu GDT sau khi ban bam Tim kiem.</p>

          <form id="runForm" class="mt-6 space-y-4">
            <div>
              <label for="sessionSelect" class="mb-1 block text-sm font-semibold text-slate-700">Session browser đang chạy</label>
              <select id="sessionSelect" name="sessionSelect" class="w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-base outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200">
                <option value="">(chưa có session — bấm Bắt đầu để mở)</option>
              </select>
              <p class="mt-1 text-xs text-slate-500">Chọn một session để switch qua và bấm "Lấy thông tin" tiếp tục.</p>
            </div>

            <div>
              <label for="out" class="mb-1 block text-sm font-semibold text-slate-700">File đầu ra (.xlsx)</label>
              <input id="out" name="out" value="${defaults.out}" class="w-full rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-base outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-200" placeholder="./DANH-SACH-HOA-DON.xlsx" />
            </div>

            <label class="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium">
              <input id="verifyOnly" name="verifyOnly" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500" />
              Chỉ verify endpoint (không ghi file)
            </label>

            <label class="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium">
              <input id="manualFirst" name="manualFirst" type="checkbox" checked class="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500" />
              Manual-first (mo browser, doi ban thao tac xong roi moi crawl)
            </label>

            <label class="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium">
              <input id="autoExportXml" name="autoExportXml" type="checkbox" checked class="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
              Xem từng hóa đơn &amp; ghi lại Tên hàng hóa, dịch vụ (tất cả trang)
            </label>

            <div class="grid gap-3 sm:grid-cols-2">
              <button type="button" id="startBtn" class="min-h-12 rounded-xl border border-amber-600 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800 transition hover:bg-amber-100">Bắt đầu</button>
              <button type="submit" id="runBtn" class="min-h-12 rounded-xl bg-amber-700 px-4 py-3 text-sm font-bold text-white transition hover:bg-amber-800">Lấy thông tin</button>
            </div>

            <div class="grid gap-3">
              <button type="button" id="stopBtn" class="min-h-12 rounded-xl border border-rose-500 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700 transition hover:bg-rose-100">⏹ Dừng</button>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button type="button" id="clearLog" class="min-h-12 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-bold text-slate-700 transition hover:bg-slate-50">Xóa log</button>
              <button type="button" id="runRelogin" class="min-h-12 rounded-xl border border-amber-600 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800 transition hover:bg-amber-100">Re-login ngay rồi chạy</button>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <button type="button" id="exportLogs" class="min-h-12 rounded-xl border border-blue-500 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800 transition hover:bg-blue-100">⬇️ Xuất log hiện tại</button>
              <button type="button" id="viewLogFiles" class="min-h-12 rounded-xl border border-blue-500 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-800 transition hover:bg-blue-100">📋 Xem tất cả log</button>
            </div>
          </form>
        </section>

        <section class="w-full min-w-0 rounded-3xl border border-slate-200 bg-slate-950 p-6 shadow-lg">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="text-lg font-bold text-white">Kết quả chạy</h2>
            <span id="statusBadge" class="rounded-full bg-slate-800 px-3 py-1 text-xs font-bold text-slate-200">Sẵn sàng</span>
          </div>
          <pre id="log" class="h-[32rem] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-slate-800 bg-black/60 p-4 text-xs leading-relaxed text-emerald-300"></pre>

          <div class="mt-4 flex items-center justify-between">
            <h3 class="text-sm font-bold text-white">🐞 Debug DOM &amp; Sự kiện (theo thời gian)</h3>
            <button type="button" id="clearEvents" class="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold text-slate-200 transition hover:bg-slate-700">Xóa</button>
          </div>
          <div id="eventTimeline" class="mt-2 max-h-[24rem] min-w-0 space-y-2 overflow-auto rounded-2xl border border-slate-800 bg-black/40 p-3 text-xs text-slate-200">
            <p class="text-slate-500">Chưa có sự kiện nào. Chạy "Lấy thông tin" để bắt đầu ghi.</p>
          </div>
        </section>
      </main>
    </div>

    <script>
      const form = document.getElementById('runForm');
      const log = document.getElementById('log');
      const statusBadge = document.getElementById('statusBadge');
      const clearBtn = document.getElementById('clearLog');
      const reloginBtn = document.getElementById('runRelogin');
      const startBtn = document.getElementById('startBtn');
      const runBtn = document.getElementById('runBtn');
      const stopBtn = document.getElementById('stopBtn');
      const sessionSelect = document.getElementById('sessionSelect');
      const outField = document.getElementById('out');
      const verifyOnlyField = document.getElementById('verifyOnly');
      const manualFirstField = document.getElementById('manualFirst');
      const autoExportXmlField = document.getElementById('autoExportXml');

      const eventTimeline = document.getElementById('eventTimeline');
      const clearEventsBtn = document.getElementById('clearEvents');
      let eventLineBuffer = '';
      let eventCount = 0;

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      const EVENT_LABELS = {
        'rows-found': ['🧾', 'text-emerald-300'],
        'no-rows': ['⚠️', 'text-amber-300'],
        'select-checkbox': ['☑️', 'text-sky-300'],
        'click-row': ['👆', 'text-sky-300'],
        'find-icon': ['🔍', 'text-slate-300'],
        'hover': ['🖱️', 'text-slate-400'],
        'found-view-icon': ['👁️', 'text-emerald-300'],
        'icon-not-found': ['❌', 'text-rose-300'],
        'click-view': ['👁️', 'text-blue-300'],
        'detail-modal': ['🪟', 'text-amber-300'],
        'items-extracted': ['📦', 'text-emerald-300'],
        'items-empty': ['⚠️', 'text-amber-300'],
        'modal-closed': ['✖️', 'text-slate-400'],
        'next-page': ['⏭️', 'text-sky-300'],
        'pagination-end': ['🏁', 'text-emerald-300'],
        'row-error': ['🛑', 'text-rose-300'],
        'saved': ['💾', 'text-emerald-300'],
      };

      function renderEvent(evt) {
        if (eventCount === 0) {
          eventTimeline.innerHTML = '';
        }
        eventCount += 1;
        const meta = EVENT_LABELS[evt.action] || ['•', 'text-slate-300'];
        const time = new Date(evt.ts || Date.now());
        const hh = String(time.getHours()).padStart(2, '0');
        const mm = String(time.getMinutes()).padStart(2, '0');
        const ss = String(time.getSeconds()).padStart(2, '0');
        const ms = String(time.getMilliseconds()).padStart(3, '0');
        const wrap = document.createElement('div');
        wrap.className = 'rounded-lg border border-slate-800 bg-slate-900/60 p-2';
        let inner =
          '<div class="flex items-start gap-2">' +
          '<span class="shrink-0">' + meta[0] + '</span>' +
          '<span class="shrink-0 font-mono text-[10px] text-slate-500">' + hh + ':' + mm + ':' + ss + '.' + ms + '</span>' +
          '<span class="font-mono text-[11px] font-bold ' + meta[1] + '">' + escapeHtml(evt.action) + '</span>' +
          '<span class="min-w-0 break-words text-slate-300">' + escapeHtml(evt.detail || '') + '</span>' +
          '</div>';
        if (evt.html) {
          inner +=
            '<details class="mt-1"><summary class="cursor-pointer text-[10px] text-blue-400">Xem DOM HTML</summary>' +
            '<pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 text-[10px] text-slate-400">' +
            escapeHtml(evt.html) + '</pre></details>';
        }
        wrap.innerHTML = inner;
        eventTimeline.appendChild(wrap);
        eventTimeline.scrollTop = eventTimeline.scrollHeight;
      }

      function ingestEventChunk(chunk) {
        eventLineBuffer += chunk;
        let idx;
        while ((idx = eventLineBuffer.indexOf('\\n')) >= 0) {
          const line = eventLineBuffer.slice(0, idx);
          eventLineBuffer = eventLineBuffer.slice(idx + 1);
          const marker = line.indexOf('[GDT-EVENT]');
          if (marker >= 0) {
            const jsonPart = line.slice(marker + '[GDT-EVENT]'.length).trim();
            try {
              renderEvent(JSON.parse(jsonPart));
            } catch (e) {
              // ignore malformed event line
            }
          }
        }
      }

      function resetEventTimeline() {
        eventCount = 0;
        eventLineBuffer = '';
        eventTimeline.innerHTML = '<p class="text-slate-500">Chưa có sự kiện nào. Chạy "Lấy thông tin" để bắt đầu ghi.</p>';
      }

      if (clearEventsBtn) {
        clearEventsBtn.addEventListener('click', resetEventTimeline);
      }

      const startBtnDefaultText = startBtn.textContent;
      const runBtnDefaultText = runBtn.textContent;
      const ACTIVE_JOB_STORAGE_KEY = 'gdt-active-job-id';
      let isBusy = false;
      let hasSession = false;

      function applyControlState() {
        startBtn.disabled = isBusy;
        runBtn.disabled = isBusy || !hasSession;
        reloginBtn.disabled = isBusy || !hasSession;
        if (stopBtn) stopBtn.disabled = !isBusy;
        if (sessionSelect) sessionSelect.disabled = isBusy;
        outField.disabled = isBusy;
        verifyOnlyField.disabled = isBusy;
        manualFirstField.disabled = isBusy;
        if (autoExportXmlField) autoExportXmlField.disabled = isBusy;

        const toggle = (el, off) => {
          if (off) {
            el.classList.add('opacity-70', 'cursor-not-allowed');
          } else {
            el.classList.remove('opacity-70', 'cursor-not-allowed');
          }
        };

        toggle(startBtn, startBtn.disabled);
        toggle(runBtn, runBtn.disabled);
        toggle(reloginBtn, reloginBtn.disabled);
        if (stopBtn) toggle(stopBtn, stopBtn.disabled);
      }

      function setSessionJobId(jobId) {
        currentJobId = jobId || null;
        hasSession = Boolean(currentJobId);
        if (currentJobId) {
          localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, currentJobId);
        } else {
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        }
        if (sessionSelect && sessionSelect.value !== (currentJobId || '')) {
          sessionSelect.value = currentJobId || '';
        }
        applyControlState();
      }

      async function refreshSessions() {
        if (!sessionSelect) {
          return;
        }
        try {
          const res = await fetch('/sessions');
          const data = await res.json();
          const sessions = (data && data.sessions) || [];
          const prev = currentJobId || sessionSelect.value || '';
          if (sessions.length === 0) {
            sessionSelect.innerHTML = '<option value="">(chưa có session — bấm Bắt đầu để mở)</option>';
          } else {
            let html = '<option value="">(chọn session)</option>';
            sessions.forEach((s, idx) => {
              const t = new Date(s.startedAt);
              const hh = String(t.getHours()).padStart(2, '0');
              const mm = String(t.getMinutes()).padStart(2, '0');
              const ss = String(t.getSeconds()).padStart(2, '0');
              const label = 'Session ' + (idx + 1) + ' • ' + hh + ':' + mm + ':' + ss + ' • ' + s.jobId;
              html += '<option value="' + s.jobId + '">' + label + '</option>';
            });
            sessionSelect.innerHTML = html;
          }
          // Restore selection if it still exists
          if (prev && sessions.some((s) => s.jobId === prev)) {
            sessionSelect.value = prev;
          }
        } catch (e) {
          // ignore transient fetch errors
        }
      }

      function setBusy(mode, busy) {
        isBusy = busy;
        applyControlState();

        if (mode === 'start') {
          startBtn.textContent = busy ? 'Đang mở...' : startBtnDefaultText;
        } else {
          startBtn.textContent = startBtnDefaultText;
        }

        if (mode === 'run') {
          runBtn.textContent = busy ? 'Đang chạy...' : runBtnDefaultText;
          reloginBtn.textContent = busy ? 'Đang chạy...' : 'Re-login ngay rồi chạy';
        } else {
          runBtn.textContent = runBtnDefaultText;
          reloginBtn.textContent = 'Re-login ngay rồi chạy';
        }
      }

      function setStatus(text, cls) {
        statusBadge.textContent = text;
        statusBadge.className = cls;
      }

      function setLog(text) {
        log.textContent = text;
        log.scrollTop = log.scrollHeight;
      }

      let eventSource = null;
      let currentJobId = null;
      const restoredJobId = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
      setSessionJobId(restoredJobId);

      // Populate the running-session dropdown and keep it fresh.
      refreshSessions();
      setInterval(refreshSessions, 4000);

      if (sessionSelect) {
        sessionSelect.addEventListener('change', () => {
          const chosen = sessionSelect.value;
          if (!chosen) {
            setSessionJobId(null);
            return;
          }
          attachJobEvents(chosen);
          setLog('[UI] Da switch sang session ' + chosen + '. Bam "Lay thong tin" de tiep tuc.\\n');
        });
      }

      function attachJobEvents(jobId) {
        if (currentJobId === jobId && eventSource) {
          return;
        }

        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }

        setSessionJobId(jobId);
        eventSource = new EventSource('/events?jobId=' + encodeURIComponent(jobId));

        eventSource.addEventListener('log', (ev) => {
          const payload = JSON.parse(ev.data);
          const chunk = payload.chunk || '';
          log.textContent += chunk;
          log.scrollTop = log.scrollHeight;
          ingestEventChunk(chunk);
        });

        eventSource.addEventListener('status', (ev) => {
          const payload = JSON.parse(ev.data);
          if (payload.status === 'running') {
            setStatus('Đang chạy', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
            return;
          }

          if (payload.status === 'success') {
            setStatus('Thành công', 'rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300');
          } else {
            setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
          }

          if (payload.status !== 'running') {
            setSessionJobId(null);
            setBusy(null, false);
          }

          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
        });

        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
        };
      }

      clearBtn.addEventListener('click', () => setLog(''));

      document.getElementById('exportLogs')?.addEventListener('click', () => {
        const link = document.createElement('a');
        link.href = '/export-logs';
        link.download = 'gdt-session-' + Date.now() + '.jsonl';
        link.click();
        setLog('Log hien tai da duoc tai xuong.\\n');
      });

      document.getElementById('viewLogFiles')?.addEventListener('click', async () => {
        try {
          const res = await fetch('/log-files');
          const data = await res.json();
          if (data.files && data.files.length > 0) {
            let msg = 'Cac file log co san:\\n';
            data.files.forEach((f) => {
              msg += '- ' + f + '\\n';
            });
            msg += '\\nClick tren link de tai xuong:\\n';
            data.files.forEach((f) => {
              msg += '- <a href="/download-log?file=' + encodeURIComponent(f) + '" class="text-blue-400 underline">' + f + '</a>\\n';
            });
            setLog(msg);
          } else {
            setLog('Khong co file log nao.\\n');
          }
        } catch (e) {
          setLog('Loi khi lay danh sach log: ' + e + '\\n');
        }
      });

      async function startBrowser() {
        if (isBusy) {
          return;
        }

        setBusy('start', true);
        const direction = 'sold';
        setStatus('Đang mở browser', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
        setLog('Dang mo Cloakbrowser va chuan bi browser session...\\n');
        try {
          const res = await fetch('/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              direction,
              out: String(document.getElementById('out').value || ''),
              verifyOnly: document.getElementById('verifyOnly').checked,
              manualFirst: document.getElementById('manualFirst').checked,
              autoExportXml: document.getElementById('autoExportXml').checked,
            }),
          });
          const data = await res.json();
          if (!data.ok) {
            setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
            setLog((data.output || 'Khong mo duoc browser') + '\\n');
            setBusy(null, false);
            return;
          }

          if (data.jobId) {
            attachJobEvents(data.jobId);
          }
          refreshSessions();

          setStatus('Đã mở browser', 'rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300');
          log.textContent += '[UI] Da mo browser va dien user/pass. Ban nhap captcha + dang nhap + bam Tim kiem tren GDT. Sau do bam Lay thong tin de tiep tuc cung browser session.\\n';
          setBusy(null, false);
        } catch (err) {
          setStatus('Lỗi', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
          setLog(String(err));
          setBusy(null, false);
        }
      }

      async function continueJob() {
        if (isBusy) {
          return;
        }

        resetEventTimeline();
        setBusy('run', true);
        try {
          const res = await fetch('/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: currentJobId }),
          });
          const data = await res.json();
          if (!data.ok || !data.jobId) {
            if ((data.output || '').includes('Khong tim thay browser session')) {
              setSessionJobId(null);
            }
            setStatus('Thất bại', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
            setLog((data.output || 'Khong tao duoc job') + '\\n');
            setBusy(null, false);
            return;
          }

          attachJobEvents(data.jobId);
          setStatus('Đang chạy', 'rounded-full bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-300');
          log.textContent += '[UI] Da gui tin hieu tiep tuc cho browser session hien tai.\\n';
          // Keep busy=true — SSE status handler will unlock when job finishes
        } catch (err) {
          setStatus('Lỗi', 'rounded-full bg-rose-500/20 px-3 py-1 text-xs font-bold text-rose-300');
          setLog(String(err));
          setBusy(null, false);
        }
      }

      startBtn.addEventListener('click', async () => {
        await startBrowser();
      });

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        await continueJob();
      });

      reloginBtn.addEventListener('click', async () => {
        await continueJob();
      });

      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          if (!isBusy) {
            return;
          }
          stopBtn.disabled = true;
          stopBtn.textContent = 'Đang dừng...';
          try {
            const res = await fetch('/stop', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId: currentJobId || undefined }),
            });
            const data = await res.json();
            if (!data.ok) {
              log.textContent += '[UI] Khong dung duoc: ' + (data.output || '') + '\\n';
            } else {
              log.textContent += '[UI] Da gui yeu cau dung job.\\n';
            }
          } catch (err) {
            log.textContent += '[UI] Loi khi dung job: ' + String(err) + '\\n';
          } finally {
            stopBtn.textContent = '⏹ Dừng';
            // SSE status handler will unlock controls when the job actually ends
          }
        });
      }
    </script>
  </body>
</html>`;
}

/**
 * Kill the whole process tree for a job. The child was spawned `detached`,
 * so it owns a process group whose id equals the child pid; killing the
 * negative pid signals every process in that group (npm, tsx, cli, browser).
 */
function killJobTree(job: Job, signal: NodeJS.Signals): void {
  const child = job.child;
  if (!child || child.killed) {
    return;
  }
  try {
    if (typeof child.pid === "number") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Group may already be gone; fall back to a direct kill.
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

function startJob(payload: RunPayload): Job {
  const id = randomId();
  const job: Job = {
    id,
    status: "running",
    output: "",
    startedAt: Date.now(),
  };

  jobs.set(id, job);
  trimJobs();

  const continueSignalFile = join(process.cwd(), `.gdt-continue-${id}.signal`);
  const args = ["run", "dev:cli", "--", "--direction", payload.direction, "--manual-first", "--continue-signal-file", continueSignalFile];

  if (payload.verifyOnly) {
    args.push("--verify-only");
  } else {
    args.push("--out", payload.out);
  }

  if (payload.autoExportXml) {
    args.push("--auto-export-xml");
  }

  const child = spawn("npm", args, {
    cwd: process.cwd(),
    // Let CLI reload latest .env on each run instead of reusing stale GDT_* values.
    env: buildCliEnv(),
    // Own process group so we can kill the whole tree (npm -> tsx -> cli -> browser).
    detached: true,
  });

  job.child = child;
  activeSessions.set(id, { jobId: id, continueSignalFile });

  const append = (chunk: Buffer | string): void => {
    job.output += chunk.toString();
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);

  child.on("close", (code) => {
    job.status = job.stopped ? "failed" : code === 0 ? "success" : "failed";
    if (job.stopped) {
      job.output += "\n[UI] Da dung job theo yeu cau nguoi dung.\n";
    }
    job.finishedAt = Date.now();
    job.child = undefined;
    const session = activeSessions.get(id);
    if (session) {
      activeSessions.delete(id);
      fs.unlink(session.continueSignalFile).catch(() => undefined);
    }
  });

  return job;
}

const defaults: UiDefaults = {
  out: parseArgValue("--out") ?? "./DANH-SACH-HOA-DON.xlsx",
  direction: (parseArgValue("--direction") as "sold" | "purchase" | undefined) ?? "sold",
};

const preferredPort = Number(process.env.UI_PORT ?? 4173);
const maxPortAttempts = Number(process.env.UI_PORT_FALLBACK_MAX ?? 25);
let activePort = preferredPort;

// Session logging
const sessionLogs: string[] = [];
const logsDir = join(process.cwd(), ".gdt-logs");
const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const currentSessionLogFile = join(logsDir, `session-${sessionId}.jsonl`);

// Create logs directory
fs.mkdir(logsDir, { recursive: true }).catch(() => {
  // Silently fail
});

function addLog(source: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, source, message, data };
  sessionLogs.push(JSON.stringify(entry));
  
  // Append to session log file
  fs.appendFile(currentSessionLogFile, JSON.stringify(entry) + "\n").catch(() => {
    // Silently fail - don't break on log write errors
  });
}

addLog("ui-server", "Server started", { port: preferredPort, sessionId, logFile: currentSessionLogFile });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${activePort}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html(defaults));
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const list = Array.from(activeSessions.values())
      .map((s) => {
        const job = jobs.get(s.jobId);
        return {
          jobId: s.jobId,
          status: job?.status ?? "unknown",
          startedAt: job?.startedAt ?? 0,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
    writeJson(res, 200, { ok: true, sessions: list });
    return;
  }

  if (req.method === "POST" && url.pathname === "/start") {
    const raw = await readBody(req);
    let payload: StartPayload;

    try {
      payload = JSON.parse(raw) as StartPayload;
    } catch {
      addLog("ui-api", "/start parse error", { raw });
      writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
      return;
    }

    const validationError = validateStartPayload(payload);
    if (validationError) {
      addLog("ui-api", "/start validation error", { error: validationError, payload });
      writeJson(res, 400, { ok: false, output: validationError });
      return;
    }

    const job = startJob(payload as RunPayload);
    addLog("ui-api", "/start job created", { jobId: job.id, payload });
    writeJson(res, 200, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    const raw = await readBody(req);
    let payload: ContinuePayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as ContinuePayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return;
      }
    }

    const active =
      (payload.jobId ? activeSessions.get(payload.jobId) : undefined) ??
      Array.from(activeSessions.values()).at(-1);

    if (!active) {
      addLog("ui-api", "/run session not found", { jobId: payload.jobId });
      writeJson(res, 400, {
        ok: false,
        output: "Khong tim thay browser session dang cho tiep tuc. Vui long bam Bat dau lai.",
      });
      return;
    }

    addLog("ui-api", "/run signal sent", { jobId: active.jobId, signalFile: active.continueSignalFile });
    await fs.writeFile(active.continueSignalFile, "continue", "utf8");
    writeJson(res, 200, { ok: true, jobId: active.jobId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    const raw = await readBody(req);
    let payload: ContinuePayload = {};

    if (raw.trim()) {
      try {
        payload = JSON.parse(raw) as ContinuePayload;
      } catch {
        writeJson(res, 400, { ok: false, output: "JSON khong hop le" });
        return;
      }
    }

    // Find the running job: by jobId or the latest running one
    const job =
      (payload.jobId ? jobs.get(payload.jobId) : undefined) ??
      Array.from(jobs.values())
        .filter((j) => j.status === "running")
        .sort((a, b) => b.startedAt - a.startedAt)[0];

    if (!job || job.status !== "running") {
      addLog("ui-api", "/stop no running job", { jobId: payload.jobId });
      writeJson(res, 400, { ok: false, output: "Khong co job dang chay de dung." });
      return;
    }

    addLog("ui-api", "/stop killing job", { jobId: job.id });
    job.stopped = true;

    // Clean up session + signal file
    const session = activeSessions.get(job.id);
    if (session) {
      activeSessions.delete(job.id);
      fs.unlink(session.continueSignalFile).catch(() => undefined);
    }

    // Kill the whole child process tree (npm -> tsx -> cli -> browser).
    if (job.child && !job.child.killed) {
      killJobTree(job, "SIGTERM");
      // Force kill the tree after a grace period if still alive.
      setTimeout(() => {
        if (job.child && !job.child.killed) {
          killJobTree(job, "SIGKILL");
        }
      }, 3000);
      // Safety net: if the close event never fires (lingering browser),
      // mark the job finished so the UI unlocks its controls.
      setTimeout(() => {
        if (job.status === "running") {
          job.status = "failed";
          job.finishedAt = Date.now();
          job.output += "\n[UI] Job bi ep dung (process khong tu thoat).\n";
        }
      }, 5000);
    } else {
      // No child handle: mark as failed directly
      job.status = "failed";
      job.finishedAt = Date.now();
    }

    writeJson(res, 200, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const jobId = url.searchParams.get("jobId") ?? "";
    const job = jobs.get(jobId);
    if (!job) {
      writeJson(res, 404, { ok: false, output: "Khong tim thay job" });
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    sseWrite(res, "status", { status: job.status });

    let cursor = 0;
    const interval = setInterval(() => {
      const current = jobs.get(jobId);
      if (!current) {
        clearInterval(interval);
        res.end();
        return;
      }

      if (current.output.length > cursor) {
        const chunk = current.output.slice(cursor);
        cursor = current.output.length;
        sseWrite(res, "log", { chunk });
      }

      sseWrite(res, "status", { status: current.status });
      if (current.status !== "running") {
        clearInterval(interval);
        setTimeout(() => res.end(), 50);
      }
    }, 250);

    req.on("close", () => {
      clearInterval(interval);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/logs") {
    // Return logs as JSON
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const logsData = sessionLogs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { message: line, timestamp: new Date().toISOString() };
      }
    });
    res.end(JSON.stringify(logsData, null, 2));
    return;
  }

  if (req.method === "GET" && url.pathname === "/export-logs") {
    // Download current session logs as JSONL file
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gdt-session-${sessionId}.jsonl"`);
    res.end(sessionLogs.join("\n"));
    return;
  }

  if (req.method === "GET" && url.pathname === "/log-files") {
    // List all available log files
    try {
      const files = await fs.readdir(logsDir);
      const jsonlFiles = files
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .reverse();
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ files: jsonlFiles, current: `session-${sessionId}.jsonl` }));
    } catch {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ files: [], current: `session-${sessionId}.jsonl` }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/download-log") {
    // Download a specific log file
    const filename = url.searchParams.get("file");
    if (!filename || !filename.endsWith(".jsonl")) {
      res.statusCode = 400;
      res.end("Invalid filename");
      return;
    }

    const filepath = join(logsDir, filename);
    // Security: ensure file is within logsDir
    if (!filepath.startsWith(logsDir)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    try {
      const content = await fs.readFile(filepath, "utf8");
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("File not found");
    }
    return;
  }

  res.statusCode = 404;
  res.end("Not Found");
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    const maxPort = preferredPort + maxPortAttempts;
    if (activePort < maxPort) {
      const nextPort = activePort + 1;
      console.warn(`Port ${activePort} dang duoc su dung, thu port ${nextPort}...`);
      activePort = nextPort;
      server.listen(activePort);
      return;
    }
  }

  console.error(`Khong the khoi dong UI server: ${error.message}`);
  process.exit(1);
});

server.listen(activePort, () => {
  console.log(`UI server running at http://localhost:${activePort}`);
});
