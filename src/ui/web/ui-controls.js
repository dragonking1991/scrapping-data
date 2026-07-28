import { dom } from "./dom.js";
import { DEFAULT_PURCHASED_TYPE, state } from "./state.js";

export function applyControlState() {
  if (dom.startBtn) dom.startBtn.disabled = state.isBusy || state.continueInFlight;
  if (dom.runBtn)
    dom.runBtn.disabled = state.isBusy || state.continueInFlight || !state.hasSession;
  if (dom.stopBtn) dom.stopBtn.disabled = !state.isRunningFlow;
  if (dom.closeSessionBtn)
    dom.closeSessionBtn.disabled = !state.hasSession || state.closingSession;
  if (dom.aggregateBtn) dom.aggregateBtn.disabled = state.isAggregating;
  if (dom.sessionSelect) dom.sessionSelect.disabled = state.isBusy || state.continueInFlight;
  if (dom.purchasedModeCheckbox)
    dom.purchasedModeCheckbox.disabled = state.isBusy || state.continueInFlight;

  if (dom.purchasedTypeSelect) {
    dom.purchasedTypeSelect.disabled =
      state.isBusy ||
      state.continueInFlight ||
      !(dom.purchasedModeCheckbox && dom.purchasedModeCheckbox.checked);
  }

  if (dom.testNextPageBtn) dom.testNextPageBtn.disabled = !state.hasSession;
  if (dom.testScanPageBtn) dom.testScanPageBtn.disabled = !state.hasSession;
  if (dom.testOpenInvoiceBtn) dom.testOpenInvoiceBtn.disabled = !state.hasSession;
  if (dom.testSelectRowBtn) dom.testSelectRowBtn.disabled = !state.hasSession;
  if (dom.testRowInput) dom.testRowInput.disabled = !state.hasSession;
}

export function syncPurchasedModeControls() {
  const checked = Boolean(dom.purchasedModeCheckbox && dom.purchasedModeCheckbox.checked);
  if (dom.purchasedTypeWrapper) {
    dom.purchasedTypeWrapper.classList.toggle("hidden", !checked);
  }

  if (checked && dom.purchasedTypeSelect && !dom.purchasedTypeSelect.value) {
    dom.purchasedTypeSelect.value = DEFAULT_PURCHASED_TYPE;
  }

  applyControlState();
}

export function getSelectedRunMode() {
  if (!dom.purchasedModeCheckbox || !dom.purchasedModeCheckbox.checked) {
    return "sold";
  }

  const value = dom.purchasedTypeSelect?.value || DEFAULT_PURCHASED_TYPE;
  if (value === "noCode") return "purchased-noCode";
  if (value === "initCode") return "purchased-initCode";
  return "purchased-hasCode";
}
