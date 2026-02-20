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

