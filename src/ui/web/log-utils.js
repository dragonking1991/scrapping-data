import { dom } from "./dom.js";

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

export function setLog(text) {
  if (!dom.logEl) return;
  dom.logEl.textContent = text;
  dom.logEl.scrollTop = dom.logEl.scrollHeight;
}

export function appendLog(text) {
  if (!dom.logEl) return;
  dom.logEl.textContent += text;
  dom.logEl.scrollTop = dom.logEl.scrollHeight;
}

export function setStatus(text, cls) {
  if (!dom.statusBadge) return;
  dom.statusBadge.textContent = text;
  dom.statusBadge.className = cls;
}
