const DEFAULT_SETTINGS = {
  enabled: true,                  // timeline posting toggle
  timelineSendTime: "09:00",      // local computer time (HH:MM, 24h)
  timelineMessageTemplate: "Happy Birthday {first_name} 🎉",
  messengerBetaEnabled: false,    // when true, sends private Messenger DMs instead of timeline posts
  messengerSendTime: "09:00",
  messengerMessageTemplate: "Happy Birthday! 🎉",
  dryRun: false                   // if true, logs actions but does not post
};

const STORAGE_KEYS = {
  settings: "bm_settings",
  log: "bm_log",
  sent: "bm_sent_history"        // { "YYYY-MM-DD": { "<friendId>": true } }
};

const DOC_IDS = {
  birthdays: "4576878779047229", // BirthdayCometRootQuery
  post: "7517691441636945"       // ComposerStoryCreateMutation
};

const LOG_LIMIT = 500;
const SENT_DAYS_TO_KEEP = 10;
const FB_LOGIN_REQUIRED_MESSAGE = "Facebook does not appear to be logged in. Please log into your Facebook account before continueing.";
const LOG_MESSAGE_MAX_CHARS = 500;
const LOG_EXTRA_MAX_CHARS = 4000;
const DM_DELAY_MS = 2500;
const ALARM_TIMELINE = "bm_daily_timeline";
const ALARM_MESSENGER = "bm_daily_messenger";

let dashboardPorts = new Set();

function todayKey(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettings() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const stored = res[STORAGE_KEYS.settings] || {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // Backward compatibility with previous single-template/single-time schema.
  if (!stored.timelineSendTime && stored.sendTime) merged.timelineSendTime = stored.sendTime;
  if (!stored.timelineMessageTemplate && stored.messageTemplate) merged.timelineMessageTemplate = stored.messageTemplate;
  if (!stored.messengerSendTime && stored.sendTime) merged.messengerSendTime = stored.sendTime;
  if (!stored.messengerMessageTemplate && stored.messageTemplate) merged.messengerMessageTemplate = stored.messageTemplate;
  merged.messengerMessageTemplate = sanitizeMessengerTemplate(merged.messengerMessageTemplate);
  return merged;
}

async function setSettings(next) {
  const sanitized = {
    ...next,
    messengerMessageTemplate: sanitizeMessengerTemplate(next?.messengerMessageTemplate)
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: sanitized });
  await ensureScheduledAlarms(sanitized, "save");
}

async function appendLog(level, message, extra = null) {
  const entry = {
    ts: nowIso(),
    level,
    message: truncateString(message, LOG_MESSAGE_MAX_CHARS),
    extra: normalizeLogExtra(extra)
  };

  try {
    const res = await chrome.storage.local.get(STORAGE_KEYS.log);
    const log = Array.isArray(res[STORAGE_KEYS.log]) ? res[STORAGE_KEYS.log] : [];
    log.push(entry);
    while (log.length > LOG_LIMIT) log.shift();

    // If storage is near quota, progressively trim oldest entries instead of throwing.
    while (log.length > 0) {
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.log]: log });
        break;
      } catch (err) {
        const msg = String(err || "");
        if (!msg.includes("kQuotaBytes")) throw err;
        log.shift();
      }
    }
  } catch (_) {
    // Never let logging break posting flow.
  }

  broadcastLog(entry);
}

function truncateString(value, maxChars) {
  const s = String(value ?? "");
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)} ...[truncated]`;
}

function normalizeLogExtra(extra) {
  if (extra == null) return null;
  if (typeof extra === "string") return truncateString(extra, LOG_EXTRA_MAX_CHARS);
  if (typeof extra !== "object") return extra;

  // Keep frequently-used IDs and errors while avoiding huge payloads in storage.
  const compact = {};
  if (extra.friendId) compact.friendId = String(extra.friendId);
  if (extra.error) compact.error = truncateString(extra.error, 500);
  if (extra.status) compact.status = String(extra.status);

  const keys = Object.keys(extra);
  const hasLargePayload = keys.includes("response") || keys.includes("raw") || keys.includes("data");
  if (hasLargePayload) compact.note = "Large payload omitted from log.";

  // If compact has useful fields, prefer it.
  if (Object.keys(compact).length > 0) return compact;

  // Fallback: keep the original object only if it serializes small enough.
  try {
    const serialized = JSON.stringify(extra);
    if (serialized.length <= LOG_EXTRA_MAX_CHARS) return extra;
    return { note: "Extra data truncated.", preview: `${serialized.slice(0, LOG_EXTRA_MAX_CHARS)} ...[truncated]` };
  } catch (_) {
    return { note: "Extra data unavailable (non-serializable)." };
  }
}

function broadcastLog(entry) {
  for (const port of dashboardPorts) {
    try { port.postMessage({ type: "log_append", entry }); } catch (_) {}
  }
}

async function getLog() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.log);
  return Array.isArray(res[STORAGE_KEYS.log]) ? res[STORAGE_KEYS.log] : [];
}

async function clearLog() {
  await chrome.storage.local.set({ [STORAGE_KEYS.log]: [] });
  for (const port of dashboardPorts) {
    try { port.postMessage({ type: "log_cleared" }); } catch (_) {}
  }
}

async function getSentHistory() {
  const res = await chrome.storage.local.get(STORAGE_KEYS.sent);
  return res[STORAGE_KEYS.sent] || {};
}

function normalizeSentEntry(v) {
  if (v === true) return { timeline: true, messenger: true };
  if (v && typeof v === "object") {
    return { timeline: !!v.timeline, messenger: !!v.messenger };
  }
  return { timeline: false, messenger: false };
}

async function markSent(friendId, channel = "all") {
  const key = todayKey();
  const sent = await getSentHistory();
  sent[key] = sent[key] || {};
  const cur = normalizeSentEntry(sent[key][String(friendId)]);
  if (channel === "timeline") cur.timeline = true;
  else if (channel === "messenger") cur.messenger = true;
  else { cur.timeline = true; cur.messenger = true; }
  sent[key][String(friendId)] = cur;

  // prune old days
  const keys = Object.keys(sent).sort(); // ascending
  while (keys.length > SENT_DAYS_TO_KEEP) {
    const k = keys.shift();
    delete sent[k];
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.sent]: sent });
}

async function wasSentToday(friendId, channel = "any") {
  const sent = await getSentHistory();
  const key = todayKey();
  const cur = normalizeSentEntry(sent[key]?.[String(friendId)]);
  if (channel === "timeline") return !!cur.timeline;
  if (channel === "messenger") return !!cur.messenger;
  return !!(cur.timeline || cur.messenger);
}

function parseAndFindDtsg(html) {
  // Facebook moves this around a lot. Try multiple tolerant patterns.
  // 1) "DTSGInitialData" ... "token":"..." (often nested / escaped)
  const m1 = html.match(/DTSGInitialData[\s\S]{0,2000}?"token"\s*:\s*"([^"]+)"/);
  if (m1?.[1]) return m1[1];

  const m1b = html.match(/DTSGInitialData[\s\S]{0,2000}?token"\s*:\s*"([^"]+)"/);
  if (m1b?.[1]) return m1b[1];

  // 2) Hidden input
  const m2 = html.match(/name="fb_dtsg"[^>]*value="([^"]+)"/);
  if (m2?.[1]) return m2[1];

  // 3) "fb_dtsg":"..." anywhere
  const m3 = html.match(/"fb_dtsg"\s*:\s*"([^"]+)"/);
  if (m3?.[1]) return m3[1];

  // 4) Sometimes appears as fb_dtsg value inside JS: fb_dtsg":"..."
  const m4 = html.match(/fb_dtsg"\s*:\s*\{[\s\S]{0,200}?"token"\s*:\s*"([^"]+)"/);
  if (m4?.[1]) return m4[1];

  return null;
}

function parseAndFindFbId(html) {
  // Several possible locations. These are best-effort.
  const m1 = html.match(/"USER_ID"\s*:\s*"(\d+)"/);
  if (m1?.[1]) return m1[1];

  const m2 = html.match(/"viewerID"\s*:\s*"(\d+)"/);
  if (m2?.[1]) return m2[1];

  const m3 = html.match(/"ACCOUNT_ID"\s*:\s*"(\d+)"/);
  if (m3?.[1]) return m3[1];

  const m4 = html.match(/"currentUserID"\s*:\s*"(\d+)"/);
  if (m4?.[1]) return m4[1];

  const m5 = html.match(/"actorID"\s*:\s*"(\d+)"/);
  if (m5?.[1]) return m5[1];

  return null;
}

async function getFbUserIdFromCookie() {
  try {
    const c = await chrome.cookies.get({ url: "https://www.facebook.com", name: "c_user" });
    if (c?.value && /^\d+$/.test(c.value)) return c.value;
  } catch (_) {}
  return null;
}

function createLoginRequiredError() {
  const err = new Error(FB_LOGIN_REQUIRED_MESSAGE);
  err.code = "FB_NOT_LOGGED_IN";
  return err;
}

async function fetchAuthTokens(runCtx = null) {
  // User id is most reliably the c_user cookie.
  const userId = await getFbUserIdFromCookie();
  if (!userId) {
    return null;
  }

  // fb_dtsg (and often lsd) are safest to read from a live facebook.com tab via content script.
  const tokenRes = await getFbTokensFromOpenTab(runCtx);
  const fb_dtsg = tokenRes?.fb_dtsg || null;
  const lsd = tokenRes?.lsd || null;

  if (!fb_dtsg) {
    // Fallback: try scraping HTML (sometimes still works)
    const fallback = await getFbDtsgFromHtmlFetch();
    if (fallback) return { fb_dtsg: fallback, lsd: null, userId };

    return null;
  }

  return { fb_dtsg, lsd, userId };
}
async function getFbTokensFromOpenTab(runCtx = null) {
  const active = await ensureFacebookTab(runCtx);
  if (!active?.id) return null;

  async function ask(tabId) {
    const res = await chrome.tabs.sendMessage(tabId, { type: "bm_get_fb_tokens" });
    if (res && res.ok && typeof res.fb_dtsg === "string") return res;
    return null;
  }

  try {
    const res = await ask(active.id);
    if (res) return res;
  } catch (_) {
    // content script might not be injected yet (tab loaded before install). Try programmatically.
    try {
      await chrome.scripting.executeScript({ target: { tabId: active.id }, files: ["content_script.js"] });
      const res2 = await ask(active.id);
      if (res2) return res2;
    } catch (_) {}
  }

  return null;
}
async function ensureFbContentScript(tabId) {
  try {
    // ping first
    await chrome.tabs.sendMessage(tabId, { type: "bm_get_fb_tokens" });
    return true;
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content_script.js"] });
      return true;
    } catch (_) {}
  }
  return false;
}

async function getActiveFacebookTab() {
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.facebook.com/*",
      "https://web.facebook.com/*",
      "https://m.facebook.com/*",
      "https://mbasic.facebook.com/*"
    ]
  });
  if (!tabs || tabs.length === 0) return null;
  return tabs.find(t => t.active && t.lastFocusedWindow) || tabs.find(t => t.active) || tabs[0] || null;
}
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (!tab || tab.status === "complete") {
        resolve();
        return;
      }
      function listener(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}
async function ensureFacebookTab(runCtx = null) {
  const tabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
  let fbTab;

  if (tabs.length === 0) {
    console.log("Facebook tab not detected. Opening Facebook tab. Waiting to complete page load before continuing.");
    fbTab = await chrome.tabs.create({
      url: "https://www.facebook.com/",
      active: false
    });
    if (runCtx?.openedFacebookTabIds && fbTab?.id) {
      runCtx.openedFacebookTabIds.add(fbTab.id);
    }
    await waitForTabComplete(fbTab.id);
  } else {
    fbTab = tabs[0];
    if (fbTab.status !== "complete") {
      console.log("Facebook tab detected but still loading. Waiting to complete page load before continuing.");
      await waitForTabComplete(fbTab.id);
    }
  }

  return fbTab;
}
async function facebookGraphqlViaTab({ userId, doc_id, variables, friendlyName, runCtx = null }) {
  const tab = await ensureFacebookTab(runCtx);
  if (!tab?.id) throw new Error("No Facebook tab found. Please open Facebook.com and log in, then try again.");

  await ensureFbContentScript(tab.id);

  const res = await chrome.tabs.sendMessage(tab.id, {
    type: "bm_graphql_exec",
    userId,
    doc_id,
    variables,
    friendlyName: friendlyName || null
  });

  if (!res || !res.ok) throw new Error(res?.error || "GraphQL exec failed in tab");

  const text = (res.text || "").trim();
  if (!text) {
  const h = res.headers ? JSON.stringify(res.headers) : "";
  const prev = (res.textPreview || "").replace(/\s+/g," ").slice(0,200);
  throw new Error(`Empty response from Facebook GraphQL. Status=${res.status} URL=${res.url || ""} Redirected=${res.redirected ? "yes":"no"} Len=${res.textLength ?? 0} Preview=${prev} Headers=${h.slice(0,300)}`);
}

  return parseFacebookJson(text, res.status);
}

function parseFacebookJson(text, status = 0) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error(`Empty response from Facebook GraphQL. Status=${status}`);

  function cleanJsonLike(s) {
    let out = String(s || "").trim();
    if (out.startsWith("for (;;);")) out = out.slice("for (;;);".length).trim();
    if (out.startsWith(")]}'")) out = out.slice(4).trim();
    return out;
  }

  const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
  const candidates = lines.length ? lines : [trimmed];

  let lastErr = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = cleanJsonLike(candidates[i]);
    if (!c) continue;
    try { return JSON.parse(c); } catch (e) { lastErr = e; }
  }
  try { return JSON.parse(cleanJsonLike(trimmed)); } catch (e) {
    const preview = trimmed.slice(0, 200);
    throw new Error(`Failed to parse Facebook GraphQL response. Status=${status}. Preview=${preview}. Error=${String(lastErr || e)}`);
  }
}


async function getFbDtsgFromHtmlFetch() {
  const urlsToTry = [
    "https://www.facebook.com/",
    "https://www.facebook.com/home.php",
    "https://m.facebook.com/"
  ];
  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, { method: "GET", credentials: "include" });
      const html = await resp.text();
      const fb_dtsg = parseAndFindDtsg(html);
      if (fb_dtsg) return fb_dtsg;
    } catch (_) {}
  }
  return null;
}

function computeJazoest(fb_dtsg) {
  // FB commonly expects a "jazoest" field: "2" + sum of char codes of fb_dtsg
  const s = String(fb_dtsg || "");
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return "2" + String(sum);
}

async function facebookGraphql({ fb_dtsg, lsd, userId, doc_id, variables, friendlyName, runCtx = null }) {
  // Prefer executing from a live facebook.com tab (more reliable: correct origin/referer)
  try {
    return await facebookGraphqlViaTab({ userId, doc_id, variables, friendlyName, runCtx });
  } catch (e) {
    // Fall back to background fetch if tab execution fails (best-effort).
  }

  const url = "https://www.facebook.com/api/graphql/";
  const body = new URLSearchParams();
  body.set("fb_dtsg", fb_dtsg);
  if (lsd) body.set("lsd", lsd);
  body.set("jazoest", computeJazoest(fb_dtsg));
  if (userId) { body.set("__user", userId); body.set("av", userId); }
  if (friendlyName) {
    body.set("fb_api_caller_class", "RelayModern");
    body.set("fb_api_req_friendly_name", String(friendlyName));
  }
  body.set("doc_id", doc_id);
  body.set("variables", JSON.stringify(variables || {}));
  body.set("server_timestamps", "true");

  const resp = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "*/*",
      ...(lsd ? { "x-fb-lsd": lsd } : {}),
      ...(friendlyName ? { "x-fb-friendly-name": String(friendlyName) } : {})
    },
    body
  });

  const text = await resp.text();
  return parseFacebookJson(text, resp.status);
}

function extractTodayBirthdays(data) {
  // Expected:
  // data.data.viewer.all_friends.edges -> today list
  const edges =
    data?.data?.viewer?.all_friends?.edges ||
    data?.data?.viewer?.all_friends_by_birthday_month?.edges ||
    [];
  const out = [];
  for (const e of edges) {
    const node = e?.node || e;
    const id = node?.id || node?.profile?.id;
    const name = node?.name || node?.profile?.name || node?.profile_name;
    if (id) out.push({ id: String(id), name: name || "" });
  }
  return out;
}

async function getTodaysBirthdays(tokensOverride = null, runCtx = null) {
  const tokens = tokensOverride || await fetchAuthTokens(runCtx);
  if (!tokens) throw createLoginRequiredError();
  const { fb_dtsg, lsd, userId } = tokens;

  const variables = { offset_month: -1, scale: 1 };
  const res = await facebookGraphql({ fb_dtsg, lsd, userId, doc_id: DOC_IDS.birthdays, variables, friendlyName: "BirthdayCometRootQuery", runCtx });

  // Primary: viewer.all_friends.edges (today’s birthdays)
  const todayEdges = res?.data?.viewer?.all_friends?.edges;
  const list = Array.isArray(todayEdges) ? todayEdges : [];
  const out = [];
  for (const e of list) {
    const n = e?.node;
    const id = n?.id || n?.profile?.id;
    const name = n?.name || n?.profile?.name;
    if (id) out.push({ id: String(id), name: name || "" });
  }

  return { userId, fb_dtsg, raw: res, birthdays: out };
}
function renderMessage(template, name, includeName) {
  const safeName = (name || "").trim();
  const firstName = safeName ? safeName.split(/\s+/)[0] : "";

  if (!includeName || !safeName) {
    return template
      .replace(/\{first_name\}/g, firstName || '')
      .replace(/\s+/g, " ")
      .trim();
  }

  return template
    .replace(/\{first_name\}/g, firstName || '');
}

function sanitizeMessengerTemplate(template) {
  return String(template || DEFAULT_SETTINGS.messengerMessageTemplate)
    .replace(/\{first_name\}/g, "")
    .replace(/\s+/g, " ")
    .trim() || DEFAULT_SETTINGS.messengerMessageTemplate;
}

function normalizePersonName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function namesProbablyReferToSamePerson(expectedName, actualName) {
  const expected = normalizePersonName(expectedName);
  const actual = normalizePersonName(actualName);
  if (!expected || !actual) return true;
  if (expected === actual) return true;

  const expectedParts = expected.split(" ").filter(Boolean);
  const actualParts = actual.split(" ").filter(Boolean);
  if (!expectedParts.length || !actualParts.length) return true;

  const expectedFirst = expectedParts[0];
  const actualFirst = actualParts[0];
  if (expectedFirst === actualFirst) return true;

  return expectedParts.some((part) => actualParts.includes(part));
}
async function postHappyBirthday({ fb_dtsg, lsd, userId, actorId, friendId, messageText, runCtx = null }) {
  const variables = {
    input: {
      composer_entry_point: "inline_composer",
      composer_source_surface: "timeline",
      idempotence_token: `${friendId}:${Date.now()}`,
      source: "WWW",
      actor_id: String(actorId),
      audience: { to_id: String(friendId) },
      message: { text: messageText },
      attachments: [],
      // Keep the rest minimal. FB may accept fewer fields.
    }
  };

  const res = await facebookGraphql({ fb_dtsg, lsd, userId, doc_id: DOC_IDS.post, variables, friendlyName: "ComposerStoryCreateMutation", runCtx });
  return res;
}

async function closeRunOpenedFacebookTabs(runCtx) {
  if (!runCtx?.openedFacebookTabIds || runCtx.openedFacebookTabIds.size === 0) return;
  const tabIds = Array.from(runCtx.openedFacebookTabIds);
  runCtx.openedFacebookTabIds.clear();
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_) {}
  }
}

async function runBirthdayPosting({ manual = false, mode = "both" } = {}) {
  const runCtx = { openedFacebookTabIds: new Set() };
  try {
    const settings = await getSettings();
    const wantsTimeline = !!settings.enabled && mode !== "messenger";
    const wantsMessenger = !!settings.messengerBetaEnabled && mode !== "timeline";
    if (!wantsTimeline && !wantsMessenger) {
      await appendLog("info", "All delivery modes are disabled. Skipping run.");
      return { ok: true, skipped: true };
    }

    await appendLog("info", `${manual ? "Manual" : "Scheduled"} run started.`);
    if (wantsTimeline) {
      await appendLog("info", "Timeline posting is enabled.");
    }
    if (wantsMessenger) {
      await appendLog("info", "Messenger Beta mode enabled: sending private messages via Messenger threads.");
    }

    let tokens;
    try {
      tokens = await fetchAuthTokens(runCtx);
      if (!tokens) {
        return { ok: false, error: FB_LOGIN_REQUIRED_MESSAGE };
      }
      await appendLog("info", "Facebook tokens acquired.");
    } catch (err) {
      await appendLog("error", "Failed to acquire Facebook tokens.", { error: String(err) });
      return { ok: false, error: String(err) };
    }

    let birthdayData;
    try {
      birthdayData = await getTodaysBirthdays(tokens, runCtx);
      await appendLog("info", `Fetched today's birthdays: ${birthdayData.birthdays.length}`);
    } catch (err) {
      const msg = err?.code === "FB_NOT_LOGGED_IN" ? FB_LOGIN_REQUIRED_MESSAGE : String(err);
      await appendLog("error", "Failed to fetch birthdays.", { error: msg });
      return { ok: false, error: msg };
    }

    const actorId = birthdayData.userId;
    const fb_dtsg = tokens.fb_dtsg; // use latest

    let postedTimeline = 0;
    let sentMessenger = 0;
    for (const b of birthdayData.birthdays) {
      const alreadyTimeline = wantsTimeline ? await wasSentToday(b.id, "timeline") : true;
      const alreadyMessenger = wantsMessenger ? await wasSentToday(b.id, "messenger") : true;
      if (alreadyTimeline && alreadyMessenger) {
        await appendLog("info", `Already completed selected actions today for ${b.name || b.id}. Skipping.`, { friendId: b.id });
        continue;
      }

      const timelineMessage = renderMessage(settings.timelineMessageTemplate, b.name, true);
      const messengerMessage = renderMessage(settings.messengerMessageTemplate, b.name, true);

      if (settings.dryRun) {
        if (wantsTimeline && !alreadyTimeline) {
          await appendLog("info", `DRY RUN: would post "${timelineMessage}" to ${b.name || b.id}`, { friendId: b.id });
        }
        if (wantsMessenger && !alreadyMessenger) {
          await appendLog("info", `DRY RUN: would send private message "${messengerMessage}" to ${b.name || b.id}`, { friendId: b.id });
        }
        continue;
      }

      if (wantsTimeline && !alreadyTimeline) {
        try {
          const res = await postHappyBirthday({ fb_dtsg, lsd: tokens.lsd, userId: tokens.userId, actorId, friendId: b.id, messageText: timelineMessage, runCtx });
          await markSent(b.id, "timeline");
          await appendLog("info", `Posted to ${b.name || b.id}.`, {
            friendId: b.id,
            status: res?.errors ? "posted_with_graphql_errors" : "posted"
          });
          postedTimeline++;
        } catch (err) {
          await appendLog("error", `Failed to post to ${b.name || b.id}.`, { friendId: b.id, error: String(err) });
        }
      }

      if (wantsMessenger && !alreadyMessenger) {
        try {
          const dmRes = await sendPrivateMessage({
            friendId: b.id,
            expectedName: b.name,
            messageTemplate: settings.messengerMessageTemplate
          });
          await markSent(b.id, "messenger");
          await appendLog("info", `Sent private message to ${b.name || b.id}.`, {
            friendId: b.id,
            status: dmRes?.detail || "dm_sent"
          });
          sentMessenger++;
        } catch (err) {
          await appendLog("error", `Failed to send private message to ${b.name || b.id}.`, { friendId: b.id, error: String(err) });
        }
      }
      await sleep(DM_DELAY_MS);
    }

    await appendLog("info", `Run finished. Timeline posted: ${postedTimeline}. Private messages sent: ${sentMessenger}.`);
    return { ok: true, posted: postedTimeline, messaged: sentMessenger };
  } finally {
    await closeRunOpenedFacebookTabs(runCtx);
  }
}

async function sendPrivateMessage({ friendId, expectedName, messageTemplate }) {
  const url = `https://www.facebook.com/messages/t/${encodeURIComponent(String(friendId))}`;
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab?.id) throw new Error("Could not open Messenger thread tab");

  try {
    await waitForTabComplete(tab.id);
    await ensureFbContentScript(tab.id);

    const prep = await chrome.tabs.sendMessage(tab.id, {
      type: "bm_dm_prepare",
      timeoutMs: 30000
    });
    if (!prep?.ok) {
      throw new Error(prep?.error || "Messenger thread inspection failed");
    }

    const recipientName = String(prep.recipientName || expectedName || "").trim();
    if (!recipientName) {
      throw new Error("Could not determine Messenger recipient name");
    }
    if (!namesProbablyReferToSamePerson(expectedName, recipientName)) {
      throw new Error(`Messenger opened a different conversation ("${recipientName}") than expected ("${expectedName || friendId}")`);
    }

    const messageText = renderMessage(messageTemplate, recipientName, true);
    if (!messageText) {
      throw new Error("Rendered Messenger message is empty");
    }

    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "bm_dm_send",
      text: String(messageText || ""),
      timeoutMs: 30000
    });

    if (!res?.ok) {
      throw new Error(res?.error || "Messenger auto-send failed");
    }
    return { ok: true, detail: res.detail || "message_send_triggered" };
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (_) {}
  }
}

function parseHHMM(sendTimeHHMM, fallbackHH = 9, fallbackMM = 0) {
  const [hh, mm] = String(sendTimeHHMM || "09:00").split(":").map(x => parseInt(x, 10));
  return {
    hh: Number.isFinite(hh) ? hh : fallbackHH,
    mm: Number.isFinite(mm) ? mm : fallbackMM
  };
}

async function ensureChannelAlarm(alarmName, sendTimeHHMM, enabled) {
  await chrome.alarms.clear(alarmName);
  if (!enabled) return null;

  const { hh, mm } = parseHHMM(sendTimeHHMM);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  chrome.alarms.create(alarmName, { when: next.getTime() });
  return next;
}

async function ensureScheduledAlarms(settings, source = "save") {
  const nextTimeline = await ensureChannelAlarm(ALARM_TIMELINE, settings.timelineSendTime, !!settings.enabled);
  const nextMessenger = await ensureChannelAlarm(ALARM_MESSENGER, settings.messengerSendTime, !!settings.messengerBetaEnabled);

  if (source === "save") {
    const timelineMsg = nextTimeline ? `Timeline next run: ${nextTimeline.toLocaleString()}.` : "Timeline disabled.";
    const messengerMsg = nextMessenger ? `Messenger next run: ${nextMessenger.toLocaleString()}.` : "Messenger disabled.";
    await appendLog("info", `Settings saved. ${timelineMsg} ${messengerMsg}`);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name === ALARM_TIMELINE) {
    try {
      await runBirthdayPosting({ manual: false, mode: "timeline" });
    } catch (err) {
      await appendLog("error", "Scheduled timeline run crashed.", { error: String(err) });
    } finally {
      const settings = await getSettings();
      await ensureChannelAlarm(ALARM_TIMELINE, settings.timelineSendTime, !!settings.enabled);
    }
    return;
  }

  if (alarm?.name === ALARM_MESSENGER) {
    try {
      await runBirthdayPosting({ manual: false, mode: "messenger" });
    } catch (err) {
      await appendLog("error", "Scheduled messenger run crashed.", { error: String(err) });
    } finally {
      const settings = await getSettings();
      await ensureChannelAlarm(ALARM_MESSENGER, settings.messengerSendTime, !!settings.messengerBetaEnabled);
    }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await setSettings(settings);
  await appendLog("info", "Extension installed/updated. Settings initialized.");
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await ensureScheduledAlarms(settings, "startup");
  await appendLog("info", "Chrome started. Alarms ensured.");
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "bm_dashboard") return;
  dashboardPorts.add(port);
  port.onDisconnect.addListener(() => dashboardPorts.delete(port));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // --- DASHBOARD HEALTH + LOG PULL ---
  if (msg?.type === "ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "get_log") {
    chrome.storage.local.get(["bm_log"], (res) => { sendResponse({ ok: true, log: res.bm_log || [] }); });
    return true;
  }

  (async () => {
    try {
      if (msg?.type === "get_state") {
        const settings = await getSettings();
        const log = await getLog();
        sendResponse({ ok: true, settings, log });
        return;
      }
      if (msg?.type === "save_settings") {
        const next = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
        await setSettings(next);
        
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "run_now") {
        const result = await runBirthdayPosting({ manual: true });
        sendResponse({ ok: true, result });
        return;
      }
      if (msg?.type === "clear_log") {
        await clearLog();
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "test_fetch_birthdays") {
        const runCtx = { openedFacebookTabIds: new Set() };
        try {
          const data = await getTodaysBirthdays(null, runCtx);
          sendResponse({ ok: true, count: data.birthdays.length, birthdays: data.birthdays.slice(0, 20) });
        } finally {
          await closeRunOpenedFacebookTabs(runCtx);
        }
        return;
      }

      if (msg?.type === "append_log") {
        const level = (msg.level && String(msg.level)) || "info";
        const message = (msg.message && String(msg.message)) || "";
        const meta = (msg.meta && typeof msg.meta === "object") ? msg.meta : undefined;
        if (message) {
          await appendLog(level, message, meta);
        }
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message" });
    } catch (err) {
      const errorMessage = err?.code === "FB_NOT_LOGGED_IN" ? FB_LOGIN_REQUIRED_MESSAGE : String(err);
      if (err?.code !== "FB_NOT_LOGGED_IN") {
        await appendLog("error", "Background error.", { error: errorMessage, msg });
      }
      sendResponse({ ok: false, error: errorMessage });
    }
  })();
  return true;
});


async function verifyFacebookLogin(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof window.fb_dtsg !== "undefined"
  });

  if (!results || !results[0] || !results[0].result) {
    console.log(FB_LOGIN_REQUIRED_MESSAGE);
    return false;
  }
  return true;
}



chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard.html")
  });
});
