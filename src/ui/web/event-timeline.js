import { dom } from "./dom.js";
import { EVENT_LABELS } from "./state.js";
import { escapeHtml } from "./log-utils.js";

let eventCount = 0;
let eventLineBuffer = "";

function updatePaginationLabel(detail) {
  if (!dom.testPaginationValue) return;
  const match = String(detail || "").match(/(\d+)\s*\/\s*(\d+)/);
  if (match) {
    dom.testPaginationValue.textContent = `${match[1]}/${match[2]}`;
  }
}

export function resetEventTimeline() {
  eventCount = 0;
  eventLineBuffer = "";
  if (dom.eventTimeline) {
    dom.eventTimeline.innerHTML =
      '<p class="text-slate-500">Chưa có sự kiện nào. Chạy "Lấy thông tin" để bắt đầu ghi.</p>';
  }
}

function renderEvent(evt) {
  if (!dom.eventTimeline) return;
  if (eventCount === 0) dom.eventTimeline.innerHTML = "";
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

  dom.eventTimeline.appendChild(wrap);
  dom.eventTimeline.scrollTop = dom.eventTimeline.scrollHeight;

  if (
    evt.action === "pagination-state" ||
    evt.action === "next-page" ||
    evt.action === "pagination-end"
  ) {
    updatePaginationLabel(evt.detail || "");
  }
}

export function ingestEventChunk(chunk) {
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
        // Ignore malformed event line.
      }
    }
  }
}
