const els = {
  enabled: document.getElementById("enabled"),
  timelineSendTime: document.getElementById("timelineSendTime"),
  timelineMessageTemplates: document.getElementById("timelineMessageTemplates"),
  messengerBetaEnabled: document.getElementById("messengerBetaEnabled"),
  messengerSendTime: document.getElementById("messengerSendTime"),
  messengerMessageTemplates: document.getElementById("messengerMessageTemplates"),
  timelineFields: document.getElementById("timelineFields"),
  messengerFields: document.getElementById("messengerFields"),
  dryRun: document.getElementById("dryRun"),
  saveBtn: document.getElementById("saveBtn"),
  runNowBtn: document.getElementById("runNowBtn"),
  testBtn: document.getElementById("testBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  log: document.getElementById("log")
};


let verboseEnabled = false;

function applyChannelVisibility() {
  if (els.timelineFields) {
    els.timelineFields.classList.toggle("collapsed", !els.enabled.checked);
  }
  if (els.messengerFields) {
    els.messengerFields.classList.toggle("collapsed", !els.messengerBetaEnabled.checked);
  }
}

async function loadVerboseSetting() {
  try {
    const res = await chrome.storage.local.get(["ui_verbose_log"]);
    verboseEnabled = !!res.ui_verbose_log;
    if (document.getElementById("verboseLog")) {
      document.getElementById("verboseLog").checked = verboseEnabled;
    }
  } catch (e) {}
}

function bindVerboseToggle() {
  const cb = document.getElementById("verboseLog");
  if (!cb) return;
  cb.checked = verboseEnabled;
  cb.addEventListener("change", async () => {
    verboseEnabled = !!cb.checked;
    try {
      setTimeout(() => window.location.reload(), 100);
 await chrome.storage.local.set({ ui_verbose_log: verboseEnabled }); } catch (e) {}
    // Re-render log with new verbosity setting
    try {
      const res = await chrome.runtime.sendMessage({ type: "get_log" });
      els.log.innerHTML = "";
      (res?.log || []).forEach(addLogLine);
    } catch (e) {}
  });
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}


async function appendActivity(levelOrMessage, message, meta) {
  try {
    const level = (message === undefined) ? "info" : (levelOrMessage || "info");
    const msg = (message === undefined) ? (levelOrMessage || "") : (message || "");
    await chrome.runtime.sendMessage({ type: "append_log", level, message: msg, meta });
  } catch (e) {
    // ignore UI logging failures
  }
}

function appendActivityImmediate(levelOrMessage, message) {
  const level = (message === undefined) ? "info" : (levelOrMessage || "info");
  const msg = (message === undefined) ? (levelOrMessage || "") : (message || "");
  addLogLine({ ts: new Date().toISOString(), level, message: msg });
}


function addLogLine(entry) {
  if (!verboseEnabled && (entry.level === "debug")) return;
  const line = document.createElement("div");
  line.className = `logLine level-${entry.level || "info"}`;

  const ts = document.createElement("span");
  ts.className = "ts";
  ts.textContent = fmtTime(entry.ts);

  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = entry.message || "";

  line.appendChild(ts);
  line.appendChild(msg);

  if (verboseEnabled && entry.extra) {
    const extra = document.createElement("div");
    extra.className = "extra";
    extra.textContent = JSON.stringify(entry.extra, null, 2);
    line.appendChild(extra);
  }

  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

// --- LOG REFRESH (NO POLLING) ---
async function refreshLogNow() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "get_log" });
    if (!res?.log) return;
    els.log.innerHTML = "";
    res.log.forEach(addLogLine);
  } catch (e) {}
}


async function loadState() {
  await loadVerboseSetting();
  bindVerboseToggle();
  const res = await chrome.runtime.sendMessage({ type: "get_state" });
  if (!res?.ok) {
    appendActivity(res?.error || "Failed to load state");
    return;
  }

  const s = res.settings || {};
  els.enabled.checked = !!s.enabled;
  els.timelineSendTime.value = s.timelineSendTime || s.sendTime || "08:05";
  els.timelineMessageTemplates.value = s.timelineMessageTemplates || s.timelineMessageTemplate || s.messageTemplate || "";
  els.messengerBetaEnabled.checked = !!s.messengerBetaEnabled;
  els.messengerSendTime.value = s.messengerSendTime || s.timelineSendTime || s.sendTime || "08:30";
  els.messengerMessageTemplates.value = s.messengerMessageTemplates || s.messengerMessageTemplate || "";
  els.dryRun.checked = !!s.dryRun;
  applyChannelVisibility();

  els.log.innerHTML = "";
  for (const e of (res.log || [])) addLogLine(e);
}

function collectSettings() {
  return {
    enabled: els.enabled.checked,
    timelineSendTime: els.timelineSendTime.value || "08:05",
    timelineMessageTemplates: els.timelineMessageTemplates.value || "",
    messengerBetaEnabled: !!els.messengerBetaEnabled.checked,
    messengerSendTime: els.messengerSendTime.value || "08:30",
    messengerMessageTemplates: els.messengerMessageTemplates.value || "",
    dryRun: els.dryRun.checked
  };
}

els.enabled.addEventListener("change", applyChannelVisibility);
els.messengerBetaEnabled.addEventListener("change", applyChannelVisibility);

els.saveBtn.addEventListener("click", async () => {
  const settings = collectSettings();
  const res = await chrome.runtime.sendMessage({ type: "save_settings", settings });
  if (!res?.ok) {
    appendActivity(res?.error || "Save failed");
  }
  setTimeout(() => refreshLogNow(), 150);
});;

els.runNowBtn.addEventListener("click", async () => {
  els.runNowBtn.disabled = true;
  appendActivityImmediate("info", "Task started. Please wait...");
  const res = await chrome.runtime.sendMessage({ type: "run_now" });
  els.runNowBtn.disabled = false;
  if (!res?.ok) {
    appendActivity("error", res?.error || "Run failed");
  } else if (res?.result?.ok === false) {
    appendActivity("error", res?.result?.error || "Run failed");
  } else {
    appendActivity("Done");
  }
  setTimeout(() => refreshLogNow(), 150);
});

els.testBtn.addEventListener("click", async () => {
  els.testBtn.disabled = true;
  appendActivityImmediate("info", "Task started. Please wait...");
  const res = await chrome.runtime.sendMessage({ type: "test_fetch_birthdays" });
  els.testBtn.disabled = false;
  if (!res?.ok) {
    appendActivity("error", res?.error || "Test failed");
    return;
  }
  appendActivity("info", `Found ${res.count} birthdays today`);
  console.log("Birthdays sample:", res.birthdays);
  setTimeout(() => refreshLogNow(), 150);
});

els.clearLogBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "clear_log" });
  if (res?.ok) {
    els.log.innerHTML = "";
    appendActivity("Log cleared");
  } else appendActivity(res?.error || "Failed to clear log");
  setTimeout(() => refreshLogNow(), 150);
});

let dashboardPort = null;
let reconnectTimer = null;
let syncTimer = null;

function onPortMessage(m) {
  if (m?.type === "log_append" && m.entry) addLogLine(m.entry);
  if (m?.type === "log_cleared") els.log.innerHTML = "";
}

function connectDashboardPort() {
  try {
    dashboardPort = chrome.runtime.connect({ name: "bm_dashboard" });
    dashboardPort.onMessage.addListener(onPortMessage);
    dashboardPort.onDisconnect.addListener(() => {
      dashboardPort = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectDashboardPort, 1000);
    });
  } catch (_) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectDashboardPort, 1000);
  }
}

function startLogSyncFallback() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (!document.hidden) refreshLogNow();
  }, 15000);
}

loadState();
connectDashboardPort();
startLogSyncFallback();

// --- LOG WAKE EVENTS ---
window.addEventListener("focus", () => refreshLogNow());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshLogNow();
});
