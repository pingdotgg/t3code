// T3 Code desktop control — Chrome side.
//
// The agent works only in tabs it created, collected into a labelled tab group,
// so the user's own tabs are never touched and they can keep browsing while a
// task runs. Page interaction goes through the DevTools protocol rather than
// synthetic mouse input, which is what makes it work in a *background* tab: a
// window only renders its active tab, so anything coordinate-based would be
// blind the moment the user switches away.
//
// Commands arrive from the desktop app over native messaging; every reply
// carries the originating request id.

const HOST = "com.t3tools.t3code.desktop";
const GROUP_TITLE = "T3 Code";

/** Tabs this extension owns, and the group holding them. */
let ownedTabs = new Set();
let groupId = null;
/** Tabs we have attached the debugger to, so we detach exactly once. */
const attached = new Set();
let port = null;

// ── native messaging ────────────────────────────────────────────────────────

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    return;
  }
  port.onMessage.addListener(handleCommand);
  port.onDisconnect.addListener(() => {
    // Reading lastError here keeps "Native host has exited" out of the error
    // list while the desktop app simply is not running yet.
    void chrome.runtime.lastError;
    port = null;
    // The agent is gone, so its tabs and group should not outlive it.
    if (ownedTabs.size) void closeAllTabs();
  });
}

// The desktop app comes and goes with the user's session, so reconnect on a
// schedule. An alarm rather than setTimeout: a service worker is terminated
// when idle and timers do not survive that, which would strand the connection
// until the user reloaded the extension by hand.
// Chrome clamps alarm periods to a minute, so ask for what we will get.
chrome.alarms.create("t3-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "t3-reconnect") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

function reply(id, result) {
  if (port) port.postMessage({ id, ok: true, result });
}

function replyError(id, message) {
  if (port) port.postMessage({ id, ok: false, error: String(message) });
}

// ── tab + group management ──────────────────────────────────────────────────

async function ensureGroup(tabId) {
  // Re-create the group if the user dismissed it or Chrome dropped it.
  if (groupId !== null) {
    try {
      await chrome.tabGroups.get(groupId);
    } catch {
      groupId = null;
    }
  }
  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "blue" });
  } else {
    await chrome.tabs.group({ groupId, tabIds: [tabId] });
  }
  return groupId;
}

async function openTab(url) {
  // active:false is the whole point — the user stays on whatever they were doing.
  const tab = await chrome.tabs.create({ url: url || "about:blank", active: false });
  ownedTabs.add(tab.id);
  await ensureGroup(tab.id);
  // Re-badge once the page has its own icon in place, otherwise the page load
  // overwrites ours immediately.
  chrome.tabs.onUpdated.addListener(function badge(id, info) {
    if (id !== tab.id) return;
    if (info.status === "complete") markTab(tab.id);
    if (!ownedTabs.has(tab.id)) chrome.tabs.onUpdated.removeListener(badge);
  });
  return { tabId: tab.id, url: tab.url, title: tab.title };
}

async function listTabs() {
  const out = [];
  for (const tabId of [...ownedTabs]) {
    try {
      const tab = await chrome.tabs.get(tabId);
      out.push({ tabId, title: tab.title, url: tab.url, active: tab.active });
    } catch {
      ownedTabs.delete(tabId); // closed behind our back
    }
  }
  return { groupId, tabs: out };
}

/// Close everything the agent opened. Chrome deletes a tab group once its last
/// tab is gone, so this also clears the "T3 Code" group rather than leaving an
/// empty label behind in the user's tab strip.
async function closeAllTabs() {
  const ids = [...ownedTabs];
  for (const id of ids) {
    try {
      await chrome.tabs.remove(id);
    } catch {
      // Already closed by the user; nothing to do.
    }
  }
  ownedTabs.clear();
  attached.clear();
  if (groupId !== null) {
    try {
      // Belt and braces: if any tab survived, ungroup it so the label goes.
      const remaining = await chrome.tabs.query({ groupId });
      if (remaining.length) await chrome.tabs.ungroup(remaining.map((t) => t.id));
    } catch {
      // The group is already gone.
    }
    groupId = null;
  }
  return { closed: ids.length };
}

function assertOwned(tabId) {
  if (!ownedTabs.has(tabId)) {
    throw new Error(`tab ${tabId} is not one of the agent's tabs`);
  }
}

// ── DevTools protocol ───────────────────────────────────────────────────────

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
}

async function send(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/// A compact outline of the interactive elements on the page, with ids the
/// agent can click. Mirrors the accessibility-tree tools on the desktop side.
const SNAPSHOT_JS = `(() => {
  const out = [];
  const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true],summary';
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value ||
                   el.getAttribute('title') || el.getAttribute('placeholder') || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, 90);
    el.setAttribute('data-t3-idx', String(i));
    out.push({
      i: i++,
      tag: el.tagName.toLowerCase(),
      label,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      inView: r.top >= 0 && r.bottom <= innerHeight,
    });
    if (i >= 250) break;
  }
  return { title: document.title, url: location.href, elements: out };
})()`;

async function snapshot(tabId) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression: SNAPSHOT_JS,
    returnByValue: true,
  });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate failed");
  return res.result.value;
}

async function clickAt(tabId, x, y) {
  // A hover first, then press/release carrying the button bitmask. Single-page
  // apps route clicks through pointer/hover handlers, and without the leading
  // mouseMoved (or with buttons unset) the press lands on nothing.
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "mouse",
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "mouse",
  });
  await markTab(tabId);
  return { clicked: { x, y } };
}

/// The agent cursor, drawn into the page itself so a controlled tab shows the
/// same pointer as the desktop overlay. Fixed-position, pointer-events:none and
/// max z-index, so it is purely decorative and cannot intercept anything.
const PAINT_CURSOR_JS = `
  (function paint(x, y) {
    const ID = '__t3AgentCursor';
    let el = document.getElementById(ID);
    if (!el) {
      el = document.createElement('div');
      el.id = ID;
      el.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;' +
        'pointer-events:none;z-index:2147483647;opacity:0;' +
        'transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .25s ease;';
      el.innerHTML =
        '<svg width="96" height="96" viewBox="0 0 96 96">' +
          '<defs>' +
            '<radialGradient id="t3g">' +
              '<stop offset="0" stop-color="#bcbaf0" stop-opacity=".55"/>' +
              '<stop offset=".55" stop-color="#bcbaf0" stop-opacity=".2"/>' +
              '<stop offset="1" stop-color="#bcbaf0" stop-opacity="0"/>' +
            '</radialGradient>' +
            '<linearGradient id="t3f" x1="0" y1="1" x2="1" y2="0">' +
              '<stop offset="0" stop-color="#66668d"/>' +
              '<stop offset="1" stop-color="#9a9ac0"/>' +
            '</linearGradient>' +
          '</defs>' +
          '<circle cx="48" cy="48" r="33" fill="url(#t3g)"/>' +
          '<path d="M48 48 L70.5 58.5 L61.5 64 L54.5 74 Z" fill="url(#t3f)" ' +
            'stroke="#f7f7fa" stroke-width="3.1" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>';
      (document.body || document.documentElement).appendChild(el);
    }
    el.style.transform = 'translate(' + (x - 48) + 'px,' + (y - 48) + 'px)';
    requestAnimationFrame(function () { el.style.opacity = '1'; });
    clearTimeout(el.__t3hide);
    el.__t3hide = setTimeout(function () { el.style.opacity = '0'; }, 1700);
  })
`;

const CLICK_JS = (index) => `(() => {
  const el = document.querySelector('[data-t3-idx="${index}"]');
  if (!el) return { ok: false, reason: 'element ${index} is no longer on the page' };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const r = el.getBoundingClientRect();
  try { (${PAINT_CURSOR_JS})(r.left + r.width / 2, r.top + r.height / 2); } catch (e) {}
  const opts = { bubbles: true, cancelable: true, composed: true, view: window,
                 clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), href: el.href || null };
})()`;

/// Click a snapshotted element by invoking it in the page.
///
/// Coordinate dispatch is unreliable here: a background tab is not composited,
/// so hit-testing a point finds nothing and the click silently does nothing.
/// Driving the node directly works regardless of whether the tab is rendered,
/// which is the whole point of working in a tab the user is not looking at.
async function clickElement(tabId, index) {
  const res = await send(tabId, "Runtime.evaluate", {
    expression: CLICK_JS(index),
    returnByValue: true,
    userGesture: true,
  });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "click failed");
  const value = res.result.value || {};
  if (!value.ok) throw new Error(value.reason || "click failed");
  await markTab(tabId);
  return value;
}

async function typeText(tabId, text) {
  await send(tabId, "Input.insertText", { text });
  await markTab(tabId);
  return { typed: text.length };
}

async function pressKey(tabId, key) {
  const map = {
    Enter: { windowsVirtualKeyCode: 13, key: "Enter", text: "\r" },
    Tab: { windowsVirtualKeyCode: 9, key: "Tab" },
    Escape: { windowsVirtualKeyCode: 27, key: "Escape" },
    Backspace: { windowsVirtualKeyCode: 8, key: "Backspace" },
  };
  const spec = map[key];
  if (!spec) throw new Error(`unsupported key: ${key}`);
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...spec });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...spec });
  return { pressed: key };
}

async function screenshot(tabId) {
  // Page.captureScreenshot works on a background tab; captureVisibleTab does not.
  const res = await send(tabId, "Page.captureScreenshot", { format: "png" });
  return { data: res.data };
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  return { tabId, url };
}

// ── "the agent is using this tab" indicator ─────────────────────────────────
//
// An extension cannot set a tab's favicon directly, but it can replace the
// page's icon link, which is what Chrome renders in the tab strip. Pages
// rewrite their own favicon (YouTube does it for notifications), so this is
// re-applied after each interaction rather than set once.

const CURSOR_FAVICON =
  "data:image/svg+xml;base64," +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect x="1" y="1" width="30" height="30" rx="9" fill="#c8c7f5"/>' +
      '<path d="M11 7 L23.5 16.2 L17.2 17.4 L20.6 24.4 L17.6 25.8 L14.2 18.8 ' +
      'L9.6 22.6 Z" fill="#ffffff" stroke="#ffffff" stroke-width="2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' +
      "</svg>",
  );

function applyFavicon(url) {
  for (const link of document.querySelectorAll("link[rel~='icon']")) link.remove();
  const link = document.createElement("link");
  link.rel = "icon";
  link.href = url;
  document.head.appendChild(link);
}

async function markTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: applyFavicon,
      args: [CURSOR_FAVICON],
    });
  } catch {
    // Chrome's own pages (chrome://, the Web Store) refuse injection; the tab
    // still works, it just cannot show the badge.
  }
}

// ── dispatch ────────────────────────────────────────────────────────────────

const handlers = {
  ping: async () => ({ pong: true }),
  open_tab: async (p) => openTab(p.url),
  list_tabs: async () => listTabs(),
  select_tab: async (p) => {
    assertOwned(p.tabId);
    await chrome.tabs.update(p.tabId, { active: true });
    return { tabId: p.tabId };
  },
  close_all_tabs: async () => closeAllTabs(),
  close_tab: async (p) => {
    assertOwned(p.tabId);
    await chrome.tabs.remove(p.tabId);
    ownedTabs.delete(p.tabId);
    return { closed: p.tabId };
  },
  navigate: async (p) => {
    assertOwned(p.tabId);
    return navigate(p.tabId, p.url);
  },
  snapshot: async (p) => {
    assertOwned(p.tabId);
    return snapshot(p.tabId);
  },
  click: async (p) => {
    assertOwned(p.tabId);
    return p.index !== undefined ? clickElement(p.tabId, p.index) : clickAt(p.tabId, p.x, p.y);
  },
  type: async (p) => {
    assertOwned(p.tabId);
    return typeText(p.tabId, p.text);
  },
  press: async (p) => {
    assertOwned(p.tabId);
    return pressKey(p.tabId, p.key);
  },
  screenshot: async (p) => {
    assertOwned(p.tabId);
    return screenshot(p.tabId);
  },
};

async function handleCommand(msg) {
  const { id, command, params } = msg || {};
  const handler = handlers[command];
  if (!handler) return replyError(id, `unknown command: ${command}`);
  try {
    reply(id, await handler(params || {}));
  } catch (e) {
    replyError(id, e && e.message ? e.message : e);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  ownedTabs.delete(tabId);
  attached.delete(tabId);
});

connect();
