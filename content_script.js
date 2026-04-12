// Content script runs on facebook.com pages and can access the page DOM.
// It returns fb_dtsg (CSRF token) and lsd (request token) in the most reliable way possible.

function tryGetFromRequire(moduleName, key) {
  try {
    if (typeof window.require === "function") {
      const mod = window.require(moduleName);
      if (!mod) return null;
      const v = mod[key] || (typeof mod.getToken === "function" ? mod.getToken() : null);
      if (v && typeof v === "string") return v;
    }
  } catch (_) {}
  return null;
}

function tryGetInputValue(name) {
  try {
    const el = document.querySelector(`input[name="${name}"]`);
    const v = el && el.value;
    if (v && typeof v === "string") return v;
  } catch (_) {}
  return null;
}

function tryRegex(pattern) {
  try {
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    if (!html) return null;
    const m = html.match(pattern);
    return m && m[1] ? m[1] : null;
  } catch (_) {}
  return null;
}

function getFbDtsg() {
  return (
    tryGetFromRequire("DTSGInitialData", "token") ||
    tryGetInputValue("fb_dtsg") ||
    tryRegex(/DTSGInitialData[\s\S]{0,4000}?"token"\s*:\s*"([^"]+)"/) ||
    tryRegex(/name="fb_dtsg"[^>]*value="([^"]+)"/) ||
    tryRegex(/"fb_dtsg"\s*:\s*"([^"]+)"/) ||
    null
  );
}

function getLsd() {
  return (
    tryGetFromRequire("LSD", "token") ||
    tryGetInputValue("lsd") ||
    // Common module embed
    tryRegex(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
    // Hidden input in some forms
    tryRegex(/name="lsd"[^>]*value="([^"]+)"/) ||
    null
  );
}



function computeJazoest(fb_dtsg) {
  const s = String(fb_dtsg || "");
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return "2" + String(sum);
}

function cleanJsonLike(s) {
  let out = String(s || "").trim();
  if (out.startsWith("for (;;);")) out = out.slice("for (;;);".length).trim();
  if (out.startsWith(")]}'")) out = out.slice(4).trim();
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function clickContinueIfPresent() {
  const candidates = Array.from(
    document.querySelectorAll('div[role="button"], button')
  );
  const rx = /(continue|continuar|continuer|weiter|prosegui|devam|продолж|次へ|继续|jari)/i;
  for (const el of candidates) {
    const txt = (el.innerText || el.getAttribute("aria-label") || "").trim();
    if (txt && rx.test(txt) && isVisible(el)) {
      el.click();
      return true;
    }
  }
  return false;
}

function cleanMessengerLabel(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:[-(|]).*$/g, "")
    .trim();
  if (!text) return "";

  const banned = new Set([
    "messenger",
    "facebook",
    "meta",
    "chats",
    "chat",
    "message",
    "messages"
  ]);
  if (banned.has(text.toLowerCase())) return "";
  return text;
}

function getMessengerThreadLabel() {
  const main = document.querySelector('div[role="main"]') || document.body;
  const selectors = [
    'div[role="main"] h1',
    'div[role="main"] h2',
    'div[role="main"] h3',
    'div[role="main"] [role="banner"] h1',
    'div[role="main"] [role="banner"] h2',
    'div[role="main"] a[role="link"] span[dir="auto"]'
  ];

  for (const sel of selectors) {
    const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible);
    for (const node of nodes) {
      const label = cleanMessengerLabel(node.innerText || node.textContent || "");
      if (label) return label;
    }
  }

  if (main) {
    const autoTextNodes = Array.from(main.querySelectorAll('span[dir="auto"], div[dir="auto"]')).filter(isVisible);
    for (const node of autoTextNodes) {
      const label = cleanMessengerLabel(node.innerText || node.textContent || "");
      if (label && !/^\d+$/.test(label)) return label;
    }
  }

  const title = cleanMessengerLabel(
    document.title
      .replace(/\s*\|\s*Messenger\s*$/i, "")
      .replace(/^Messenger\s*$/i, "")
  );
  return title;
}

async function findMessageComposer(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    clickContinueIfPresent();

    const selectors = [
      'div[aria-label="Message"][contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="Message"]',
      'div[role="textbox"][contenteditable="true"]'
    ];
    for (const sel of selectors) {
      const all = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (all.length) return all[all.length - 1];
    }
    await sleep(350);
  }
  return null;
}

async function setComposerText(composer, text) {
  composer.focus();
  const target = String(text || "");
  const normalized = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // If the exact target text is already in the composer, do nothing to avoid double injection.
  if (normalized(composer.textContent) === normalized(target)) return;

  // Clear existing text first to prevent accidental append behavior.
  try {
    const range = document.createRange();
    range.selectNodeContents(composer);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
  } catch (_) {}

  // Type character-by-character to simulate human typing behavior.
  // Random delays between keystrokes (40-180ms) with occasional longer pauses.
  let typed = false;
  try {
    for (let i = 0; i < target.length; i++) {
      const char = target[i];
      const inputEvent = new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "insertText", data: char
      });
      composer.dispatchEvent(inputEvent);

      // Use execCommand to insert text (triggers React/Messenger's internal handlers)
      document.execCommand("insertText", false, char);

      // Random typing delay: mostly 40-180ms, with ~15% chance of a longer "thinking" pause
      let delay;
      if (Math.random() < 0.15) {
        delay = 200 + Math.floor(Math.random() * 400); // 200-600ms pause
      } else {
        delay = 40 + Math.floor(Math.random() * 140);  // 40-180ms normal typing
      }
      await sleep(delay);
    }
    typed = normalized(composer.textContent) === normalized(target);
  } catch (_) {}

  // Fallback: paste if character-by-character typing didn't work
  if (!typed) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", target);
      const pasteEvt = new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt
      });
      composer.dispatchEvent(pasteEvt);
      typed = normalized(composer.textContent) === normalized(target);
    } catch (_) {}
  }

  // Last resort fallback: direct text assignment
  if (!typed) {
    composer.textContent = target;
    composer.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
  }
}

function tryClickSendButton() {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'div[role="button"][aria-label*="Send" i]',
    'button[aria-label*="Send" i]',
    'div[role="button"][aria-label*="enter" i]',
    'div[aria-label*="enter" i]'
  ];

  for (const sel of selectors) {
    const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
    if (!candidates.length) continue;
    const btn = candidates[candidates.length - 1];
    btn.click();
    return true;
  }
  return false;
}

function sendWithEnter(composer) {
  composer.focus();
  composer.dispatchEvent(new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13
  }));
  composer.dispatchEvent(new KeyboardEvent("keyup", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13
  }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "bm_get_fb_tokens") {
    const fb_dtsg = getFbDtsg();
    const lsd = getLsd();
    sendResponse({
      ok: !!fb_dtsg,
      fb_dtsg: fb_dtsg || null,
      lsd: lsd || null,
      href: location.href
    });
    return true;
  }

  if (msg.type === "bm_graphql_exec") {
    (async () => {
      try {
        const fb_dtsg = getFbDtsg();
        const lsd = getLsd();
        if (!fb_dtsg) throw new Error("No fb_dtsg found in page context");

        const url = "/api/graphql/";
        const body = new URLSearchParams();
        body.set("fb_dtsg", fb_dtsg);
        if (lsd) body.set("lsd", lsd);
        body.set("jazoest", computeJazoest(fb_dtsg));

        if (msg.userId) {
          body.set("__user", String(msg.userId));
          body.set("av", String(msg.userId));
        }

        if (msg.friendlyName) {
          body.set("fb_api_caller_class", "RelayModern");
          body.set("fb_api_req_friendly_name", String(msg.friendlyName));
        }

        body.set("doc_id", String(msg.doc_id));
        body.set("variables", JSON.stringify(msg.variables || {}));
        body.set("server_timestamps", "true");
        body.set("__a","1");
        body.set("dpr", String(window.devicePixelRatio || 1));

        const resp = await fetch(url, {
          referrer: location.href,
          cache: "no-store",
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*",
            ...(lsd ? { "x-fb-lsd": lsd } : {}),
            ...(msg.friendlyName ? { "x-fb-friendly-name": String(msg.friendlyName) } : {})
          },
          body
        });

        const text = await resp.text();
        const headers = Object.fromEntries(Array.from(resp.headers.entries()));
        const t = text || "";
        sendResponse({
          ok: true,
          status: resp.status,
          url: resp.url,
          redirected: resp.redirected,
          headers,
          text: t,
          textLength: t.length,
          textPreview: t.slice(0, 400),
          href: location.href,
          hasDtsg: !!fb_dtsg,
          hasLsd: !!lsd
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), href: location.href });
      }
    })();
    return true;
  }

  if (msg.type === "bm_dm_send") {
    (async () => {
      try {
        const text = String(msg.text || "").trim();
        if (!text) throw new Error("Message text is empty");

        const composer = await findMessageComposer(Number(msg.timeoutMs) || 30000);
        if (!composer) throw new Error("Could not find Messenger composer");

        await setComposerText(composer, text);
        await sleep(500 + Math.floor(Math.random() * 1500)); // 0.5-2s pause after typing, like reviewing before sending

        let sent = tryClickSendButton();
        if (!sent) {
          sendWithEnter(composer);
          sent = true;
        }

        await sleep(700);
        sendResponse({
          ok: !!sent,
          detail: sent ? "message_send_triggered" : "send_trigger_not_found",
          href: location.href
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), href: location.href });
      }
    })();
    return true;
  }

  if (msg.type === "bm_dm_prepare") {
    (async () => {
      try {
        const composer = await findMessageComposer(Number(msg.timeoutMs) || 30000);
        if (!composer) throw new Error("Could not find Messenger composer");

        const recipientName = getMessengerThreadLabel();
        sendResponse({
          ok: true,
          recipientName: recipientName || null,
          href: location.href
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e), href: location.href });
      }
    })();
    return true;
  }

  return false;
});
