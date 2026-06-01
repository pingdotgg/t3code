const LINKS_KEY = "t3code.browserAgent.workspaceLinks";
const ACTIVE_LINK_KEY = "t3code.browserAgent.activeWorkspaceLink";
const BACKEND_KEY = "t3code.browserAgent.backend";
const CANCEL_ANNOTATION_MESSAGE_TYPE = "t3code.browserAgent.cancelAnnotation";

const setupEl = document.getElementById("setup");
const setupCopyEl = document.getElementById("setup-copy");
const chatEl = document.getElementById("chat");
const frameEl = document.getElementById("chat-frame");
const statusEl = document.getElementById("status");
const baseUrlEl = document.getElementById("base-url");
const credentialEl = document.getElementById("credential");
const form = document.getElementById("pair-form");
const forgetButton = document.getElementById("forget");

let currentWorkspaceLink = null;
let currentFrameOrigin = null;
let loadedWorkspaceLink = null;
let loadedFrameUrl = null;
let refreshTimer = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response?.ok === false) {
        reject(new Error(response.error ?? response.reason ?? "Request failed."));
        return;
      }
      resolve(response);
    });
  });
}

function setStatus(message, options = {}) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", options.error === true);
}

function setMode(mode) {
  setupEl.hidden = mode !== "setup";
  chatEl.hidden = mode !== "chat";
}

async function readActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

function frameOriginFor(rawUrl) {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

function clearFrame() {
  frameEl.removeAttribute("src");
  loadedWorkspaceLink = null;
  loadedFrameUrl = null;
}

function setFrameWorkspaceLink(workspaceLink) {
  loadedWorkspaceLink = workspaceLink;
  if (loadedFrameUrl !== workspaceLink.t3Url) {
    frameEl.src = workspaceLink.t3Url;
    loadedFrameUrl = workspaceLink.t3Url;
  }
}

async function refreshState() {
  const activeTab = await readActiveTab();
  const state = await send({
    type: "t3code.browserAgent.getSidePanelState",
    activeTab,
  });

  if (state.baseUrl) {
    baseUrlEl.value = state.baseUrl;
  }

  currentWorkspaceLink = state.workspaceLink ?? null;
  const frameUrl = currentWorkspaceLink?.t3Url ?? loadedFrameUrl;
  currentFrameOrigin = frameUrl ? frameOriginFor(frameUrl) : null;

  if (!state.paired) {
    currentWorkspaceLink = null;
    currentFrameOrigin = null;
    clearFrame();
    setupCopyEl.textContent = "Pair this browser with T3 Code, then use Preview.";
    setStatus("Not paired.");
    setMode("setup");
    return;
  }

  if (!currentWorkspaceLink?.t3Url) {
    setupCopyEl.textContent = "This browser is paired. Use Preview in T3 Code.";
    setStatus(`${state.connected ? "Connected" : "Paired"}: ${state.baseUrl}`);
    setMode("setup");
    return;
  }

  setFrameWorkspaceLink(currentWorkspaceLink);
  setMode("chat");
}

function scheduleRefresh() {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshState().catch((error) => {
      setStatus(error.message, { error: true });
      setMode("setup");
    });
  }, 50);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  setStatus("Pairing...");
  void send({
    type: "t3code.browserAgent.pair",
    baseUrl: baseUrlEl.value,
    credential: credentialEl.value,
  })
    .then(() => {
      credentialEl.value = "";
      return refreshState();
    })
    .catch((error) => setStatus(error.message, { error: true }));
});

forgetButton.addEventListener("click", () => {
  void send({ type: "t3code.browserAgent.forget" })
    .then(refreshState)
    .catch((error) => setStatus(error.message, { error: true }));
});

window.addEventListener("message", (event) => {
  if (event.source !== frameEl.contentWindow) {
    return;
  }
  if (event.data?.type !== CANCEL_ANNOTATION_MESSAGE_TYPE) {
    return;
  }
  if (currentFrameOrigin && event.origin !== currentFrameOrigin) {
    return;
  }
  const workspaceLink = currentWorkspaceLink ?? loadedWorkspaceLink;
  void send({
    type: CANCEL_ANNOTATION_MESSAGE_TYPE,
    workspaceLinkId: workspaceLink?.id,
  }).catch(() => undefined);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes[LINKS_KEY] || changes[ACTIVE_LINK_KEY] || changes[BACKEND_KEY]) {
    scheduleRefresh();
  }
});

chrome.tabs.onActivated.addListener(scheduleRefresh);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    scheduleRefresh();
  }
});
chrome.windows.onFocusChanged.addListener(scheduleRefresh);

void refreshState().catch((error) => {
  setStatus(error.message, { error: true });
  setMode("setup");
});
