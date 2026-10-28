// ==UserScript==
// @name         GlobalProtect callback for gpclient
// @namespace    https://github.com/jjaychen1e/GlobalProtect-openconnect-macOS
// @version      1.0.0
// @description  On a GlobalProtect portal's SAML success page, open globalprotectcallback1: (gpclient) instead of globalprotectcallback: (official client), before the CAS token expires.
// @match        https://*/SAML20/SP/ACS*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// The portal's /SAML20/SP/ACS response hands the browser a
// `globalprotectcallback:` URL whose CAS token expires 60 seconds after the
// page loads. That scheme belongs to the official Palo Alto client; gpclient
// listens on `globalprotectcallback1:`. This script rewrites the URL on the
// page before the browser follows it, and shows a link to click if the
// browser does not open it.

(function () {
  "use strict";

  const OFFICIAL = "globalprotectcallback:";
  const OURS = "globalprotectcallback1:";
  // A callback URL inside raw HTML or JavaScript source.
  const CALLBACK_RE = /globalprotectcallback1?:[^"'<>\s\\]+/;
  const SELECTOR = "meta, script, a, iframe, form";
  const URL_ATTRS = ["content", "href", "src", "action"];

  let callbackUrl = "";
  let bannerShown = false;

  /** Swap the official scheme for ours. `globalprotectcallback1:` does not contain `globalprotectcallback:`, so it stays as is. */
  function rewrite(text) {
    return text.split(OFFICIAL).join(OURS);
  }

  /** Keep the first callback URL found, already rewritten, for the fallback link. */
  function remember(text) {
    if (callbackUrl) {
      return;
    }
    const match = text.match(CALLBACK_RE);
    if (match) {
      callbackUrl = rewrite(match[0].replace(/&amp;/g, "&"));
    }
  }

  /**
   * Rewrite one element that points at the official scheme.
   * A changed meta `content` makes Chrome schedule the refresh again, which
   * replaces the pending one. An inline script is rewritten before it runs.
   */
  function fixElement(el) {
    if (el.tagName === "SCRIPT") {
      const code = el.textContent || "";
      if (code.includes(OFFICIAL)) {
        remember(code);
        el.textContent = rewrite(code);
      }
      return;
    }
    for (const attr of URL_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && value.includes(OFFICIAL)) {
        remember(value);
        el.setAttribute(attr, rewrite(value));
      }
    }
  }

  /** Rewrite every element on the page. The ACS page is a few lines long, so a full pass is cheap. */
  function fixAll() {
    document.querySelectorAll(SELECTOR).forEach(fixElement);
  }

  /** Seconds until the JWT in `token=` expires, or null when the URL has no readable token. */
  function secondsLeft(url) {
    const token = (url.match(/[?&:]token=([^&]+)/) || [])[1];
    const payload = token && token.split(".")[1];
    if (!payload) {
      return null;
    }
    try {
      const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
      return typeof json.exp === "number" ? Math.round(json.exp - Date.now() / 1000) : null;
    } catch {
      return null;
    }
  }

  /** Show a fixed bar with a link to the rewritten URL. A click counts as a user gesture, so Chrome lets it through. */
  function showBanner() {
    if (bannerShown || !callbackUrl || !document.body) {
      return;
    }
    bannerShown = true;

    const bar = document.createElement("div");
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px 16px;" +
      "font:15px/1.4 -apple-system,sans-serif;background:#1f6feb;color:#fff;";
    const link = document.createElement("a");
    link.href = callbackUrl;
    link.textContent = "Open globalprotectcallback1";
    link.style.cssText = "color:#fff;font-weight:600;text-decoration:underline;";
    const status = document.createElement("span");
    bar.append("gpclient: sent the callback to gpclient. Nothing happened? ", link, " ", status);
    document.body.prepend(bar);

    const tick = () => {
      const left = secondsLeft(callbackUrl);
      if (left === null) {
        return;
      }
      status.textContent = left > 0 ? `(token expires in ${left} s)` : "(token expired: sign in again)";
      if (left > 0) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  // Mutation callbacks run as microtasks: after the parser inserts an element,
  // before an inline script executes, and before a meta refresh fires.
  new MutationObserver(fixAll).observe(document, { childList: true, subtree: true, characterData: true });

  document.addEventListener("DOMContentLoaded", () => {
    fixAll();
    if (!callbackUrl) {
      remember(document.documentElement.innerHTML);
    }
    showBanner();
  });
})();
