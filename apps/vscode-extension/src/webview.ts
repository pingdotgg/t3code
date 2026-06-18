import {
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
  normalizeThreadConversationMaxWidth,
} from "@t3tools/shared/displayPreferences";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";

import type { BackendConnection } from "./backendManager.ts";

export interface WebviewDisplayPreferences {
  readonly showOpenInPicker: boolean;
  readonly showCheckoutModeIndicator: boolean;
  readonly showBranchSelector: boolean;
  readonly enableTerminal: boolean;
  readonly enableSourceControlPanel: boolean;
  readonly threadConversationMaxWidthPx: number | null;
}

export interface WebviewHostAppearance {
  readonly themeSource: "default" | "vscode";
  readonly colorScheme: "light" | "dark";
}

export interface WebviewBackendConnection {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
}

export interface WebviewVscodeWorkspaceBootstrap {
  readonly environmentId: string;
  readonly workspaceFolders: readonly {
    readonly key: string;
    readonly name: string;
    readonly cwd: string;
    readonly uriScheme: string;
    readonly uriAuthority: string;
  }[];
  readonly activeWorkspaceFolderKey?: string | undefined;
  readonly bootstrapProjects: readonly {
    readonly workspaceFolderKey: string;
    readonly workspaceFolderName: string;
    readonly cwd: string;
    readonly projectId: string;
    readonly bootstrapThreadId: string;
    readonly isActive?: boolean | undefined;
  }[];
}

export interface WebviewRenderInput {
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  readonly connection: BackendConnection;
  readonly displayPreferences?: WebviewDisplayPreferences;
  readonly hostAppearance?: WebviewHostAppearance;
  readonly initialRoute?: string;
}

export async function renderT3Webview(input: WebviewRenderInput): Promise<string> {
  const webRoot = vscode.Uri.joinPath(input.extensionUri, "dist", "webview");
  const indexUri = vscode.Uri.joinPath(webRoot, "index.html");
  const indexHtml = await fs.readFile(indexUri.fsPath, "utf8");
  const nonce = crypto.randomBytes(16).toString("base64");
  const webRootUri = input.webview.asWebviewUri(webRoot).toString().replace(/\/?$/, "/");
  const connectSources = [
    input.webview.cspSource,
    input.connection.httpBaseUrl,
    input.connection.wsBaseUrl,
  ].join(" ");
  const csp = [
    "default-src 'none'",
    `base-uri ${input.webview.cspSource}`,
    `img-src ${input.webview.cspSource} https: data: blob:`,
    `font-src ${input.webview.cspSource}`,
    `style-src ${input.webview.cspSource} 'unsafe-inline'`,
    `script-src ${input.webview.cspSource} 'nonce-${nonce}'`,
    `connect-src ${connectSources}`,
  ].join("; ");
  const bridgeScript = makeBridgeScript({
    bootstrap: {
      label: "Local VS Code",
      httpBaseUrl: input.connection.httpBaseUrl,
      wsBaseUrl: input.connection.wsBaseUrl,
      bearerToken: input.connection.bearerToken,
    },
    displayPreferences: input.displayPreferences ?? DEFAULT_DISPLAY_PREFERENCES,
    hostAppearance: input.hostAppearance ?? DEFAULT_HOST_APPEARANCE,
    initialRoute: input.initialRoute ?? "/_chat/",
    vscodeWorkspaceBootstrap: {
      environmentId: input.connection.environmentId,
      workspaceFolders: input.connection.workspaceFolders,
      ...(input.connection.activeWorkspaceFolderKey
        ? { activeWorkspaceFolderKey: input.connection.activeWorkspaceFolderKey }
        : {}),
      bootstrapProjects: input.connection.bootstrapProjects,
    },
  });

  const html = indexHtml.replace(
    /<head\b([^>]*)>/i,
    `<head$1>
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
    <base href="${escapeHtml(webRootUri)}">
    <script nonce="${escapeHtml(nonce)}">${bridgeScript}</script>`,
  );
  if (html === indexHtml) {
    throw new Error("Unable to inject T3 webview host bridge: index.html is missing <head>.");
  }
  return html;
}

export function renderDesktopBackendRequiredWebview(): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 18px;
        box-sizing: border-box;
      }
      main {
        max-width: 360px;
        border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
        background: var(--vscode-editor-background);
        border-radius: 8px;
        padding: 18px;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 15px;
        font-weight: 600;
      }
      p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: 13px;
        line-height: 1.45;
      }
      p + p {
        margin-top: 10px;
      }
      button {
        appearance: none;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 4px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        margin-top: 14px;
        min-height: 30px;
        padding: 5px 12px;
      }
      button:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground);
      }
      button:disabled {
        cursor: default;
        opacity: 0.72;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Start T3 Code Desktop</h1>
      <p>The T3 Code VS Code extension requires the desktop app to be running before the sidebar can load.</p>
      <p>Start the desktop app manually, then reconnect.</p>
      <button type="button" id="reconnect">Reconnect</button>
    </main>
    <script nonce="${escapeHtml(nonce)}">
      (() => {
        const vscode = acquireVsCodeApi();
        const button = document.getElementById("reconnect");
        button?.addEventListener("click", () => {
          button.disabled = true;
          button.textContent = "Reconnecting...";
          vscode.postMessage({ type: "t3.reconnectDesktopBackend" });
        });
      })();
    </script>
  </body>
</html>`;
}

export function renderDesktopBackendConnectionErrorWebview(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 18px;
        box-sizing: border-box;
      }
      main {
        max-width: 380px;
        border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
        background: var(--vscode-editor-background);
        border-radius: 8px;
        padding: 18px;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 15px;
        font-weight: 600;
      }
      p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: 13px;
        line-height: 1.45;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 12px 0 0;
        color: var(--vscode-foreground);
        background: var(--vscode-textCodeBlock-background);
        border-radius: 6px;
        padding: 10px;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Could not initialize T3 Code</h1>
      <p>The extension connected to the desktop backend, but could not initialize this VS Code workspace.</p>
      <pre>${escapeHtml(message)}</pre>
    </main>
  </body>
</html>`;
}

const DEFAULT_DISPLAY_PREFERENCES: WebviewDisplayPreferences = {
  showOpenInPicker: false,
  showCheckoutModeIndicator: false,
  showBranchSelector: false,
  enableTerminal: false,
  enableSourceControlPanel: false,
  threadConversationMaxWidthPx: null,
};

const DEFAULT_HOST_APPEARANCE: WebviewHostAppearance = {
  themeSource: "default",
  colorScheme: "light",
};
const HOST_BRIDGE_REQUEST_TIMEOUT_MS = 30_000;

function makeBridgeScript(input: {
  readonly bootstrap: WebviewBackendConnection & { readonly label: string };
  readonly displayPreferences: WebviewDisplayPreferences;
  readonly hostAppearance: WebviewHostAppearance;
  readonly initialRoute: string;
  readonly vscodeWorkspaceBootstrap: WebviewVscodeWorkspaceBootstrap;
}): string {
  return `
    (() => {
      const vscode = acquireVsCodeApi();
      let bootstrap = ${JSON.stringify(input.bootstrap)};
      let displayPreferences = ${JSON.stringify(input.displayPreferences)};
      let hostAppearance = ${JSON.stringify(input.hostAppearance)};
      const initialRoute = ${JSON.stringify(input.initialRoute)};
      const vscodeWorkspaceBootstrap = ${JSON.stringify(input.vscodeWorkspaceBootstrap)};
      const threadConversationMinWidthPx = ${THREAD_CONVERSATION_MIN_WIDTH_PX};
      const threadConversationMaxWidthPx = ${THREAD_CONVERSATION_MAX_WIDTH_PX};
      const THREAD_CONVERSATION_MIN_WIDTH_PX = threadConversationMinWidthPx;
      const THREAD_CONVERSATION_MAX_WIDTH_PX = threadConversationMaxWidthPx;
      const HOST_BRIDGE_REQUEST_TIMEOUT_MS = ${HOST_BRIDGE_REQUEST_TIMEOUT_MS};
      const normalizeThreadConversationMaxWidth = ${normalizeThreadConversationMaxWidth.toString()};
      const displayPreferenceListeners = new Set();
      const hostAppearanceListeners = new Set();
      const backendConnectionListeners = new Set();
      window.__T3_IS_VSCODE_WEBVIEW = true;
      const pendingRequests = new Map();
      function applyHostAppearance(appearance) {
        const root = document.documentElement;
        if (appearance && appearance.themeSource === "vscode") {
          root.setAttribute("data-t3-host-theme", "vscode");
          root.classList.toggle("dark", appearance.colorScheme === "dark");
        } else {
          root.removeAttribute("data-t3-host-theme");
        }
      }
      function applyDisplayPreferences(preferences) {
        const root = document.documentElement;
        const value = preferences && preferences.threadConversationMaxWidthPx;
        const width = normalizeThreadConversationMaxWidth(value);
        if (value != null && width === null) {
          console.warn("Ignoring invalid T3 thread conversation max width preference.", value);
        }
        if (width === null) {
          root.removeAttribute("data-t3-thread-conversation-width");
          root.style.removeProperty("--t3-thread-conversation-max-width");
          return;
        }
        root.setAttribute("data-t3-thread-conversation-width", "custom");
        root.style.setProperty("--t3-thread-conversation-max-width", width + "px");
      }
      applyHostAppearance(hostAppearance);
      applyDisplayPreferences(displayPreferences);
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message && message.type === "t3.displayPreferencesChanged") {
          displayPreferences = message.preferences;
          applyDisplayPreferences(displayPreferences);
          for (const listener of displayPreferenceListeners) {
            listener(displayPreferences);
          }
          return;
        }
        if (message && message.type === "t3.hostAppearanceChanged") {
          hostAppearance = message.appearance;
          applyHostAppearance(hostAppearance);
          for (const listener of hostAppearanceListeners) {
            listener(hostAppearance);
          }
          return;
        }
        if (message && message.type === "t3.backendConnectionChanged") {
          bootstrap = { ...bootstrap, ...message.connection };
          for (const listener of backendConnectionListeners) {
            listener(bootstrap);
          }
          return;
        }
        if (!message || message.type !== "t3.hostResponse") {
          return;
        }
        const pending = pendingRequests.get(message.id);
        if (!pending) {
          return;
        }
        pendingRequests.delete(message.id);
        clearTimeout(pending.timeoutId);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error || "T3 host bridge request failed."));
        }
      });
      function requestHost(method, ...args) {
        const id = String(Date.now()) + ":" + Math.random().toString(16).slice(2);
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error("T3 host bridge request timed out."));
          }, HOST_BRIDGE_REQUEST_TIMEOUT_MS);
          pendingRequests.set(id, { resolve, reject, timeoutId });
          vscode.postMessage({
            type: "t3.hostRequest",
            id,
            method,
            args,
          });
        });
      }
      window.t3HostBridge = {
        getLocalEnvironmentBootstrap() {
          return bootstrap;
        },
        getDisplayPreferences() {
          return displayPreferences;
        },
        onDisplayPreferencesChanged(callback) {
          displayPreferenceListeners.add(callback);
          return () => {
            displayPreferenceListeners.delete(callback);
          };
        },
        getHostAppearance() {
          return hostAppearance;
        },
        onHostAppearanceChanged(callback) {
          hostAppearanceListeners.add(callback);
          return () => {
            hostAppearanceListeners.delete(callback);
          };
        },
        onBackendConnectionChanged(callback) {
          backendConnectionListeners.add(callback);
          return () => {
            backendConnectionListeners.delete(callback);
          };
        },
        getVscodeWorkspaceBootstrap() {
          return vscodeWorkspaceBootstrap;
        },
        getClientSettings() {
          return requestHost("getClientSettings");
        },
        setClientSettings(settings) {
          return requestHost("setClientSettings", settings);
        },
        confirm(message) {
          return requestHost("confirm", message);
        },
        postMessage(message) {
          vscode.postMessage(message);
        },
      };
      if (initialRoute) {
        window.history.replaceState(null, document.title, "#" + initialRoute);
      }
    })();
  `;
}

function escapeHtml(value: string): string {
  // Escape ampersands first so the entities introduced below are not double-encoded.
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
