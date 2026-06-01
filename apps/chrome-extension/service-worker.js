const BACKEND_KEY = "t3code.browserAgent.backend";
const LINKS_KEY = "t3code.browserAgent.workspaceLinks";
const ACTIVE_LINK_KEY = "t3code.browserAgent.activeWorkspaceLink";
const SIDE_PANEL_PATH = "sidepanel.html";
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let socket = null;
let socketBaseUrl = null;
let socketEventController = null;
let reconnectTimer = null;
let reconnectDelayMs = RECONNECT_MIN_MS;
let currentBackend = null;
let connecting = null;
let workspaceLinksCache = [];

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (url.pathname === "") {
      url.pathname = "/";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function wsUrlFor(baseUrl, token) {
  const url = new URL(`${baseUrl}/browser-agent/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsToken", token);
  return url.toString();
}

function chatUrlForWorkspaceLink(baseUrl, link, sidebarSessionToken) {
  const url = new URL(
    `/${encodeURIComponent(link.environmentId)}/${encodeURIComponent(link.threadId)}`,
    `${baseUrl}/`,
  );
  url.searchParams.set("browserAgentSidebar", "1");
  url.searchParams.set("browserWorkspaceLinkId", link.id);
  if (typeof sidebarSessionToken === "string" && sidebarSessionToken.length > 0) {
    url.hash = new URLSearchParams([["token", sidebarSessionToken]]).toString();
  }
  return url.toString();
}

async function workspaceLinkForContent(link, tab = null, options = {}) {
  const backend = currentBackend ?? (await readBackend());
  const nextLink = {
    ...link,
    ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
    ...(tab?.windowId !== undefined ? { windowId: tab.windowId } : {}),
  };
  if (!backend?.baseUrl) {
    return nextLink;
  }
  const sidebarSessionToken =
    typeof options.sidebarSessionToken === "string" && options.sidebarSessionToken.length > 0
      ? options.sidebarSessionToken
      : backend.sessionToken;
  return {
    ...nextLink,
    t3Url: chatUrlForWorkspaceLink(backend.baseUrl, nextLink, sidebarSessionToken),
  };
}

async function readBackend() {
  const stored = await chrome.storage.local.get(BACKEND_KEY);
  const backend = stored[BACKEND_KEY];
  if (!backend || typeof backend.baseUrl !== "string" || typeof backend.sessionToken !== "string") {
    return null;
  }
  return backend;
}

async function writeBackend(backend) {
  currentBackend = backend;
  await chrome.storage.local.set({ [BACKEND_KEY]: backend });
}

async function clearBackend() {
  currentBackend = null;
  workspaceLinksCache = [];
  closeSocket();
  await chrome.storage.local.remove([BACKEND_KEY, LINKS_KEY, ACTIVE_LINK_KEY]);
  await disableNativeSidePanelForAllTabs();
}

async function readLinks() {
  const stored = await chrome.storage.local.get(LINKS_KEY);
  const links = stored[LINKS_KEY];
  workspaceLinksCache = Array.isArray(links) ? links : [];
  return workspaceLinksCache;
}

async function upsertLink(link) {
  const links = await readLinks();
  const next = links.filter((entry) => {
    if (entry.id === link.id) {
      return false;
    }
    if (link.tabId === undefined || link.windowId === undefined) {
      return true;
    }
    return (
      String(entry.tabId) !== String(link.tabId) || String(entry.windowId) !== String(link.windowId)
    );
  });
  next.push(link);
  workspaceLinksCache = next;
  await chrome.storage.local.set({ [LINKS_KEY]: next });
}

function linkForStorage(link) {
  if (typeof link.t3Url !== "string" || link.t3Url.length === 0) {
    return link;
  }
  try {
    const url = new URL(link.t3Url);
    url.hash = "";
    return { ...link, t3Url: url.toString() };
  } catch {
    return link;
  }
}

async function readActiveWorkspaceLink() {
  const stored = await chrome.storage.local.get(ACTIVE_LINK_KEY);
  const record = stored[ACTIVE_LINK_KEY];
  return record && typeof record.linkId === "string" ? record : null;
}

async function writeActiveWorkspaceLink(link) {
  await chrome.storage.local.set({
    [ACTIVE_LINK_KEY]: {
      linkId: link.id,
      ...(link.tabId !== undefined ? { tabId: link.tabId } : {}),
      ...(link.windowId !== undefined ? { windowId: link.windowId } : {}),
      updatedAt: new Date().toISOString(),
    },
  });
}

async function fetchJson(baseUrl, path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed with status ${response.status}`);
  }
  return await response.json();
}

async function pairBackend(input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!baseUrl) {
    throw new Error("Enter a valid T3 Code backend URL.");
  }
  const providedSessionToken = String(input.sessionToken ?? "").trim();
  if (providedSessionToken) {
    const session = await fetchJson(baseUrl, "/api/auth/session", {
      token: providedSessionToken,
    });
    if (!session?.authenticated) {
      throw new Error("The backend rejected the browser agent session token.");
    }
    const backend = {
      baseUrl,
      sessionToken: providedSessionToken,
      pairedAt: new Date().toISOString(),
    };
    await writeBackend(backend);
    await connectBackend({ force: true });
    return { ok: true };
  }

  const credential = String(input.credential ?? "").trim();
  if (!credential) {
    throw new Error("Enter a pairing token or browser agent session token.");
  }
  const result = await fetchJson(baseUrl, "/api/auth/bootstrap/bearer", {
    method: "POST",
    body: { credential },
  });
  if (typeof result.sessionToken !== "string") {
    throw new Error("The backend did not return a bearer session token.");
  }
  const backend = {
    baseUrl,
    sessionToken: result.sessionToken,
    pairedAt: new Date().toISOString(),
  };
  await writeBackend(backend);
  await connectBackend({ force: true });
  return { ok: true };
}

async function getWsToken(backend) {
  const result = await fetchJson(backend.baseUrl, "/api/auth/ws-token", {
    method: "POST",
    token: backend.sessionToken,
  });
  if (typeof result.token !== "string") {
    throw new Error("The backend did not return a WebSocket token.");
  }
  return result.token;
}

function closeSocket() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socketEventController?.abort();
    socketEventController = null;
    socket.close();
    socket = null;
  }
  socketBaseUrl = null;
}

function scheduleReconnect() {
  if (!currentBackend || reconnectTimer !== null) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectBackend().catch(() => scheduleReconnect());
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
}

async function connectBackend(options = {}) {
  if (connecting) {
    return connecting;
  }
  connecting = (async () => {
    const backend = currentBackend ?? (await readBackend());
    currentBackend = backend;
    if (!backend) {
      return { connected: false };
    }
    if (
      !options.force &&
      socket &&
      socket.readyState === WebSocket.OPEN &&
      socketBaseUrl === backend.baseUrl
    ) {
      return { connected: true };
    }

    closeSocket();
    const token = await getWsToken(backend);
    socketBaseUrl = backend.baseUrl;
    socket = new WebSocket(wsUrlFor(backend.baseUrl, token));
    socketEventController = new AbortController();
    const eventOptions = { signal: socketEventController.signal };
    socket.addEventListener(
      "open",
      () => {
        reconnectDelayMs = RECONNECT_MIN_MS;
        sendHello();
        void sendTabsSnapshot();
      },
      eventOptions,
    );
    socket.addEventListener(
      "message",
      (event) => {
        void handleServerMessage(event.data).catch((error) => {
          console.warn("[T3 Code] browser-agent command failed", error);
        });
      },
      eventOptions,
    );
    socket.addEventListener(
      "close",
      () => {
        socket = null;
        socketBaseUrl = null;
        socketEventController = null;
        scheduleReconnect();
      },
      eventOptions,
    );
    socket.addEventListener(
      "error",
      () => {
        socket?.close();
      },
      eventOptions,
    );
    return { connected: true };
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function sendToServer(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error("T3 Code browser-agent socket is not connected.");
  }
  socket.send(JSON.stringify(message));
}

function sendHello() {
  sendToServer({
    type: "browserAgent.hello",
    device: {
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      browser: "Chrome",
      platform: navigator.platform,
    },
    capabilities: {
      version: 1,
      canCaptureVisibleTab: true,
      canInjectScripts: Boolean(chrome.scripting?.executeScript),
      canFocusTabs: true,
      canGroupTabs: Boolean(chrome.tabs?.group),
      canAnnotate: true,
      canRenderInlineSidebar: false,
    },
  });
}

async function sendTabsSnapshot() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  const tabs = await chrome.tabs.query({});
  const groupsById = new Map();
  const groupIds = Array.from(
    new Set(
      tabs
        .map((tab) => tab.groupId)
        .filter((groupId) => typeof groupId === "number" && groupId >= 0),
    ),
  );
  await Promise.all(
    groupIds.map(async (groupId) => {
      try {
        groupsById.set(groupId, await chrome.tabGroups.get(groupId));
      } catch {
        groupsById.delete(groupId);
      }
    }),
  );
  sendToServer({
    type: "browserAgent.tabs.snapshot",
    tabs: tabs
      .filter((tab) => tab.id !== undefined && tab.windowId !== undefined)
      .map((tab) => {
        const group = typeof tab.groupId === "number" ? groupsById.get(tab.groupId) : null;
        const snapshot = {
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          title: tab.title,
          active: tab.active === true,
        };
        if (typeof tab.groupId === "number" && tab.groupId >= 0) {
          snapshot.groupId = tab.groupId;
        }
        if (group?.title) {
          snapshot.groupTitle = group.title;
        }
        return snapshot;
      }),
  });
}

function normalizeUrlForMatch(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function tabMatchesDevServer(tabUrl, devServerUrl) {
  const tab = normalizeUrlForMatch(tabUrl ?? "");
  const target = normalizeUrlForMatch(devServerUrl);
  if (!tab || !target) {
    return false;
  }
  if (tab.origin !== target.origin) {
    return false;
  }
  const targetPath = target.pathname.replace(/\/+$/, "") || "/";
  if (targetPath === "/") {
    return true;
  }
  return tab.pathname === target.pathname || tab.pathname.startsWith(`${targetPath}/`);
}

function linkTimestamp(link) {
  const value = Date.parse(link.updatedAt ?? link.createdAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

function newestLink(links) {
  return links.reduce((best, link) => {
    if (!best) {
      return link;
    }
    return linkTimestamp(link) >= linkTimestamp(best) ? link : best;
  }, null);
}

function linkMatchesTabIdentity(link, tab) {
  return (
    tab.id !== undefined &&
    tab.windowId !== undefined &&
    link.tabId !== undefined &&
    link.windowId !== undefined &&
    String(link.tabId) === String(tab.id) &&
    String(link.windowId) === String(tab.windowId)
  );
}

function selectWorkspaceLinkForTab(links, tab) {
  const matchingUrlLinks = links.filter((entry) =>
    tabMatchesDevServer(tab.url, entry.devServerUrl),
  );
  if (matchingUrlLinks.length === 0) {
    return null;
  }

  const exactTabLinks = matchingUrlLinks.filter((entry) => linkMatchesTabIdentity(entry, tab));
  if (exactTabLinks.length > 0) {
    return newestLink(exactTabLinks);
  }

  const sameWindowLinks = matchingUrlLinks.filter(
    (entry) =>
      tab.windowId !== undefined &&
      entry.windowId !== undefined &&
      String(entry.windowId) === String(tab.windowId),
  );
  return newestLink(sameWindowLinks.length > 0 ? sameWindowLinks : matchingUrlLinks);
}

async function findPreviewTab(link) {
  if (link.tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(Number(link.tabId));
      if (tabMatchesDevServer(tab.url, link.devServerUrl)) {
        return tab;
      }
    } catch {
      // Fall back to URL scan below.
    }
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => tabMatchesDevServer(tab.url, link.devServerUrl)) ?? null;
}

async function ensureGrouped(tabId, repoName) {
  if (!chrome.tabs.group || !chrome.tabGroups?.update) {
    return;
  }
  try {
    const tabs = await chrome.tabs.query({});
    const groupIds = Array.from(
      new Set(
        tabs
          .map((tab) => tab.groupId)
          .filter((groupId) => typeof groupId === "number" && groupId >= 0),
      ),
    );
    let groupId = null;
    for (const candidateGroupId of groupIds) {
      try {
        const group = await chrome.tabGroups.get(candidateGroupId);
        if (group.title === repoName) {
          groupId = group.id;
          break;
        }
      } catch {
        // Ignore stale group ids from tabs that changed while we were scanning.
      }
    }
    if (groupId === null) {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
    } else {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    }
    await chrome.tabGroups.update(groupId, {
      title: repoName,
      color: "green",
      collapsed: false,
    });
  } catch (error) {
    console.warn("[T3 Code] failed to group preview tab", error);
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "t3code.browserAgent.ping" }, { frameId: 0 });
    return;
  } catch {
    // Inject below.
  }
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["transfer-content.js"],
  });
}

async function sendTabMessage(tabId, message) {
  await ensureContentScript(tabId);
  return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
}

async function sendExistingTabMessage(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The prompt content script may not be present on every tab.
  }
}

function numericTabId(tab) {
  const tabId = Number(tab?.id);
  return Number.isInteger(tabId) && tabId >= 0 ? tabId : null;
}

async function closeGlobalNativeSidePanels() {
  if (!chrome.sidePanel?.close) {
    return;
  }
  try {
    const windows = await chrome.windows.getAll();
    await Promise.all(
      windows.map(async (window) => {
        if (window.id === undefined) {
          return;
        }
        await chrome.sidePanel.close({ windowId: window.id }).catch(() => undefined);
      }),
    );
  } catch (error) {
    console.warn("[T3 Code] failed to close stale global side panels", error);
  }
}

async function setNativeSidePanelForTab(tab, enabled) {
  if (!chrome.sidePanel?.setOptions) {
    return false;
  }
  const tabId = numericTabId(tab);
  if (tabId === null) {
    return false;
  }
  await chrome.sidePanel.setOptions(
    enabled ? { tabId, path: SIDE_PANEL_PATH, enabled: true } : { tabId, enabled: false },
  );
  return true;
}

function tabHasNativeSidePanelLink(links, tab) {
  return links.some(
    (entry) =>
      linkMatchesTabIdentity(entry, tab) && tabMatchesDevServer(tab.url, entry.devServerUrl),
  );
}

async function syncNativeSidePanelOptionsForTabs(tabs) {
  if (!chrome.sidePanel?.setOptions || tabs.length === 0) {
    return;
  }
  try {
    const links = await readLinks();
    await Promise.all(
      tabs.map((tab) => setNativeSidePanelForTab(tab, tabHasNativeSidePanelLink(links, tab))),
    );
  } catch (error) {
    console.warn("[T3 Code] failed to sync side panel tab options", error);
  }
}

async function syncNativeSidePanelOptionsForTab(tab) {
  await syncNativeSidePanelOptionsForTabs([tab]);
}

async function syncNativeSidePanelOptionsForTabId(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncNativeSidePanelOptionsForTabs([tab]);
  } catch {
    // The tab may have closed before Chrome delivered the event.
  }
}

async function syncNativeSidePanelOptionsForAllTabs() {
  if (!chrome.sidePanel?.setOptions) {
    return;
  }
  try {
    await syncNativeSidePanelOptionsForTabs(await chrome.tabs.query({}));
  } catch (error) {
    console.warn("[T3 Code] failed to sync side panel options for open tabs", error);
  }
}

async function disableNativeSidePanelForAllTabs() {
  if (!chrome.sidePanel?.setOptions) {
    return;
  }
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => setNativeSidePanelForTab(tab, false)));
  } catch (error) {
    console.warn("[T3 Code] failed to disable side panel options for open tabs", error);
  }
}

async function syncNativeSidePanelOptionsForFocusedWindow() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTab) {
      await syncNativeSidePanelOptionsForTabs([activeTab]);
    }
  } catch {
    // There may be no focused browser window.
  }
}

async function configureSidePanelBehavior() {
  if (!chrome.sidePanel) {
    return;
  }
  if (chrome.sidePanel.setOptions) {
    await chrome.sidePanel.setOptions({ enabled: false }).catch((error) => {
      console.warn("[T3 Code] failed to disable the default side panel", error);
    });
  }
  await closeGlobalNativeSidePanels();
  await syncNativeSidePanelOptionsForAllTabs();
  if (!chrome.sidePanel.setPanelBehavior) {
    return;
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("[T3 Code] failed to configure side panel action behavior", error);
  }
}

function sidePanelOpenFailure(error) {
  return {
    opened: false,
    reason: error instanceof Error ? error.message : String(error),
  };
}

function openNativeSidePanel(tab) {
  if (!chrome.sidePanel?.open) {
    return Promise.resolve({ opened: false, reason: "Chrome Side Panel API is unavailable." });
  }
  if (!chrome.sidePanel.setOptions) {
    return Promise.resolve({
      opened: false,
      reason: "Chrome Side Panel tab options are unavailable.",
    });
  }

  const tabId = numericTabId(tab);
  if (tabId === null) {
    return Promise.resolve({ opened: false, reason: "No active Chrome tab." });
  }

  try {
    const optionsPromise = chrome.sidePanel.setOptions({
      tabId,
      path: SIDE_PANEL_PATH,
      enabled: true,
    });
    if (optionsPromise?.catch) {
      void optionsPromise.catch((error) => {
        console.warn("[T3 Code] failed to enable side panel before opening", error);
      });
    }
  } catch (error) {
    return Promise.resolve(sidePanelOpenFailure(error));
  }

  try {
    return Promise.resolve(chrome.sidePanel.open({ tabId }))
      .then(() => ({ opened: true }))
      .catch(sidePanelOpenFailure);
  } catch (error) {
    return Promise.resolve(sidePanelOpenFailure(error));
  }
}

async function markSidePanelNeedsUserOpen(tab, reason) {
  if (tab?.id === undefined) {
    return;
  }
  await chrome.action.setBadgeText({ tabId: tab.id, text: "OPEN" });
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#2563eb" });
  await chrome.action.setTitle({
    tabId: tab.id,
    title: reason ? `Open T3 Code side panel: ${reason}` : "Open T3 Code side panel",
  });
}

async function clearSidePanelNeedsUserOpen(tab) {
  if (tab?.id === undefined) {
    return;
  }
  await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  await chrome.action.setTitle({ tabId: tab.id, title: "T3 Code Browser Agent" });
}

async function showSidePanelOpenPrompt(tab, reason) {
  await markSidePanelNeedsUserOpen(tab, reason);
  if (tab?.id === undefined) {
    return;
  }
  await sendTabMessage(tab.id, {
    type: "t3code.browserAgent.showOpenSidePanelPrompt",
    reason,
  }).catch((error) => {
    console.warn("[T3 Code] failed to show side panel open prompt", error);
  });
}

async function clearSidePanelOpenPrompt(tab) {
  await clearSidePanelNeedsUserOpen(tab);
  if (tab?.id === undefined) {
    return;
  }
  await sendExistingTabMessage(tab.id, { type: "t3code.browserAgent.hideOpenSidePanelPrompt" });
}

async function setActiveNativeSidePanelLink(tab, link, options = {}) {
  await upsertLink(linkForStorage(link));
  await writeActiveWorkspaceLink(link);
  if (options.open !== true) {
    await setNativeSidePanelForTab(tab, true).catch((error) => {
      console.warn("[T3 Code] failed to enable side panel for linked tab", error);
    });
  }
  if (options.open === true) {
    const result = await openNativeSidePanel(tab);
    if (result.opened) {
      await clearSidePanelOpenPrompt(tab);
    } else {
      await showSidePanelOpenPrompt(tab, result.reason);
    }
  }
}

function linkMatchesActiveWorkspaceRecord(link, record) {
  if (!record) {
    return false;
  }
  if (link.id === record.linkId) {
    return true;
  }
  if (record.tabId === undefined || record.windowId === undefined) {
    return false;
  }
  return (
    link.tabId !== undefined &&
    link.windowId !== undefined &&
    String(link.tabId) === String(record.tabId) &&
    String(link.windowId) === String(record.windowId)
  );
}

async function resolveSidePanelActiveTab(input) {
  if (!input?.activeTab || input.activeTab.id === undefined) {
    return null;
  }
  const tabId = Number(input.activeTab.id);
  if (!Number.isFinite(tabId)) {
    return input.activeTab;
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return input.activeTab;
  }
}

async function getSidePanelState(input = {}) {
  const backend = currentBackend ?? (await readBackend());
  const activeTab = await resolveSidePanelActiveTab(input);
  if (activeTab) {
    void clearSidePanelOpenPrompt(activeTab).catch(() => undefined);
  }
  const links = await readLinks();
  let selectedLink = activeTab ? selectWorkspaceLinkForTab(links, activeTab) : null;

  if (!selectedLink && !activeTab) {
    const activeRecord = await readActiveWorkspaceLink();
    selectedLink =
      links.find((link) => linkMatchesActiveWorkspaceRecord(link, activeRecord)) ?? null;
  }

  if (!selectedLink && !activeTab) {
    selectedLink = newestLink(links);
  }

  const previewTab =
    selectedLink && activeTab && tabMatchesDevServer(activeTab.url, selectedLink.devServerUrl)
      ? activeTab
      : selectedLink
        ? await findPreviewTab(selectedLink)
        : null;
  const workspaceLink = selectedLink
    ? await workspaceLinkForContent(selectedLink, previewTab)
    : null;

  return {
    ok: true,
    paired: Boolean(backend),
    baseUrl: backend?.baseUrl ?? null,
    connected: socket?.readyState === WebSocket.OPEN,
    workspaceLink,
    activeTab: activeTab
      ? {
          tabId: activeTab.id,
          windowId: activeTab.windowId,
          url: activeTab.url,
          title: activeTab.title,
        }
      : null,
  };
}

async function openOrFocusPreview(command) {
  const link = command.workspaceLink;
  let tab = await findPreviewTab(link);
  if (!tab) {
    tab = await chrome.tabs.create({ url: link.devServerUrl, active: true });
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  await ensureGrouped(tab.id, link.repoName);
  const contentLink = await workspaceLinkForContent(link, tab, {
    sidebarSessionToken: command.sidebarSessionToken,
  });
  await setActiveNativeSidePanelLink(tab, contentLink, { open: true });
  await sendTabsSnapshot();
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: tab.id,
    windowId: tab.windowId,
  });
}

async function activateAnnotation(command) {
  const link = command.workspaceLink;
  const tab = await findPreviewTab(link);
  if (!tab?.id) {
    throw new Error("Could not find the dev-server tab for this workspace.");
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  const contentLink = await workspaceLinkForContent(link, tab);
  await setActiveNativeSidePanelLink(tab, contentLink);
  await sendTabMessage(tab.id, {
    type: "t3code.browserAgent.activateAnnotation",
    workspaceLink: contentLink,
  });
  sendToServer({
    type: "browserAgent.command.result",
    commandId: command.commandId,
    ok: true,
    tabId: tab.id,
    windowId: tab.windowId,
  });
}

async function handleServerMessage(rawData) {
  const command = JSON.parse(rawData);
  try {
    switch (command.type) {
      case "browserAgent.command.openOrFocusPreview":
        await openOrFocusPreview(command);
        return;
      case "browserAgent.command.activateAnnotation":
        await activateAnnotation(command);
        return;
      case "browserAgent.command.requestTabsSnapshot":
        await sendTabsSnapshot();
        sendToServer({
          type: "browserAgent.command.result",
          commandId: command.commandId,
          ok: true,
        });
        return;
      default:
        return;
    }
  } catch (error) {
    if (command.commandId) {
      sendToServer({
        type: "browserAgent.command.result",
        commandId: command.commandId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

async function captureVisibleTab(sender) {
  if (!sender.tab?.windowId) {
    throw new Error("Cannot capture a screenshot outside a tab.");
  }
  return await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
}

async function activateForCurrentTab(tab) {
  if (!tab?.id || !tab.url) {
    return { ok: false, reason: "No active tab." };
  }
  const links = await readLinks();
  const link = selectWorkspaceLinkForTab(links, tab);
  if (!link) {
    return { ok: false, reason: "No T3 Code workspace link matches this tab yet." };
  }
  const contentLink = await workspaceLinkForContent(link, tab);
  await setActiveNativeSidePanelLink(tab, contentLink);
  return { ok: true };
}

function cachedWorkspaceLinkForTab(tab) {
  if (!tab?.id || !tab.url) {
    return null;
  }
  return selectWorkspaceLinkForTab(workspaceLinksCache, tab);
}

async function completeSidePanelActionClick(tab, openPromise) {
  const result = await openPromise;
  if (result.opened) {
    await clearSidePanelOpenPrompt(tab);
  } else {
    await showSidePanelOpenPrompt(tab, result.reason);
  }
  const backend = currentBackend ?? (await readBackend());
  if (backend) {
    currentBackend = backend;
    await connectBackend();
    await activateForCurrentTab(tab).catch(() => undefined);
  }
}

async function openBackendFromActionClick(tab, backend) {
  currentBackend = backend;
  void connectBackend().catch((error) => {
    console.warn("[T3 Code] failed to connect after toolbar backend open", error);
  });

  const createProperties = {
    url: backend.baseUrl,
    active: true,
  };
  if (tab?.windowId !== undefined) {
    createProperties.windowId = tab.windowId;
  }
  await chrome.tabs.create(createProperties);
}

async function handleNonPreviewActionClick(tab) {
  const links = await readLinks().catch(() => workspaceLinksCache);
  if (tab?.id && tab.url && selectWorkspaceLinkForTab(links, tab)) {
    await completeSidePanelActionClick(tab, openNativeSidePanel(tab));
    return;
  }

  const backend = currentBackend ?? (await readBackend());
  if (backend?.baseUrl) {
    await openBackendFromActionClick(tab, backend);
    return;
  }

  await completeSidePanelActionClick(tab, openNativeSidePanel(tab));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = (promise) => {
    promise
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  };

  switch (message?.type) {
    case "t3code.browserAgent.getStatus":
      return respond(
        (async () => {
          const backend = currentBackend ?? (await readBackend());
          return {
            ok: true,
            paired: Boolean(backend),
            baseUrl: backend?.baseUrl ?? null,
            connected: socket?.readyState === WebSocket.OPEN,
          };
        })(),
      );
    case "t3code.browserAgent.getSidePanelState":
      return respond(getSidePanelState(message));
    case "t3code.browserAgent.pair":
      return respond(
        (async () => {
          const result = await pairBackend(message);
          if (message.closeTabAfterPair === true && sender.tab?.id !== undefined) {
            setTimeout(() => {
              void chrome.tabs.remove(sender.tab.id).catch(() => undefined);
            }, 750);
          }
          return result;
        })(),
      );
    case "t3code.browserAgent.forget":
      return respond(clearBackend().then(() => ({ ok: true })));
    case "t3code.browserAgent.captureVisibleTab":
      return respond(captureVisibleTab(sender).then((dataUrl) => ({ ok: true, dataUrl })));
    case "t3code.browserAgent.annotationSubmitted":
      return respond(
        (async () => {
          await connectBackend();
          sendToServer({
            type: "browserAgent.annotation.submitted",
            workspaceLinkId: message.workspaceLinkId,
            annotation: message.annotation,
          });
          return { ok: true };
        })(),
      );
    case "t3code.browserAgent.cancelAnnotation":
      return respond(
        (async () => {
          const links = await readLinks();
          const link =
            typeof message.workspaceLinkId === "string"
              ? links.find((entry) => entry.id === message.workspaceLinkId)
              : null;
          const activeRecord = await readActiveWorkspaceLink();
          const selectedLink =
            link ??
            links.find((entry) => linkMatchesActiveWorkspaceRecord(entry, activeRecord)) ??
            newestLink(links);
          const tab = selectedLink ? await findPreviewTab(selectedLink) : null;
          if (tab?.id !== undefined) {
            await sendTabMessage(tab.id, { type: "t3code.browserAgent.cancelAnnotation" });
          }
          return { ok: true };
        })(),
      );
    case "t3code.browserAgent.openSidePanelFromPage": {
      const tab = sender.tab;
      const openPromise = openNativeSidePanel(tab);
      return respond(
        (async () => {
          const result = await openPromise;
          if (!result.opened) {
            throw new Error(result.reason ?? "Chrome did not open the side panel.");
          }
          await clearSidePanelOpenPrompt(tab);
          const backend = currentBackend ?? (await readBackend());
          if (backend) {
            await connectBackend();
            await activateForCurrentTab(tab).catch(() => undefined);
          }
          return { ok: true };
        })(),
      );
    }
    case "t3code.browserAgent.activateFromSidebar":
      return respond(
        (async () => {
          await connectBackend();
          const link = message.workspaceLink;
          sendToServer({
            type: "browserAgent.annotation.submitted",
            workspaceLinkId: link.id,
            annotation: message.annotation,
          });
          return { ok: true };
        })(),
      );
    default:
      return false;
  }
});

chrome.action.onClicked.addListener((tab) => {
  if (cachedWorkspaceLinkForTab(tab)) {
    const openPromise = openNativeSidePanel(tab);
    void completeSidePanelActionClick(tab, openPromise).catch((error) => {
      console.warn("[T3 Code] failed to handle preview toolbar click", error);
    });
    return;
  }

  void handleNonPreviewActionClick(tab).catch((error) => {
    console.warn("[T3 Code] failed to handle toolbar click", error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[LINKS_KEY]) {
    return;
  }
  const links = changes[LINKS_KEY].newValue;
  workspaceLinksCache = Array.isArray(links) ? links : [];
});

chrome.tabs.onCreated.addListener((tab) => {
  void syncNativeSidePanelOptionsForTab(tab);
  void sendTabsSnapshot();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void syncNativeSidePanelOptionsForTab(tab);
  }
  void sendTabsSnapshot();
});
chrome.tabs.onRemoved.addListener(() => void sendTabsSnapshot());
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void syncNativeSidePanelOptionsForTabId(tabId);
  void sendTabsSnapshot();
});
chrome.windows.onFocusChanged.addListener(() => {
  void syncNativeSidePanelOptionsForFocusedWindow();
  void sendTabsSnapshot();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanelBehavior();
  void connectBackend();
});
chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanelBehavior();
  void connectBackend();
});

void readLinks().catch(() => undefined);
void configureSidePanelBehavior();
void connectBackend();
