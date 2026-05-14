import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";

import type { BackendConnection } from "./backendManager.ts";

export interface WebviewRenderInput {
  readonly webview: vscode.Webview;
  readonly extensionUri: vscode.Uri;
  readonly connection: BackendConnection;
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
      bootstrapToken: input.connection.bootstrapToken,
      bearerToken: input.connection.bearerToken,
    },
    initialRoute: input.initialRoute ?? "/_chat/",
  });

  return indexHtml.replace(
    /<head>/i,
    `<head>
    <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
    <base href="${escapeHtml(webRootUri)}">
    <script nonce="${escapeHtml(nonce)}">${bridgeScript}</script>`,
  );
}

function makeBridgeScript(input: {
  readonly bootstrap: {
    readonly label: string;
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
    readonly bootstrapToken: string;
    readonly bearerToken: string;
  };
  readonly initialRoute: string;
}): string {
  return `
    (() => {
      const vscode = acquireVsCodeApi();
      const bootstrap = ${JSON.stringify(input.bootstrap)};
      const initialRoute = ${JSON.stringify(input.initialRoute)};
      window.__T3_IS_VSCODE_WEBVIEW = true;
      const pendingRequests = new Map();
      window.addEventListener("message", (event) => {
        const message = event.data;
        if (!message || message.type !== "t3.hostResponse") {
          return;
        }
        const pending = pendingRequests.get(message.id);
        if (!pending) {
          return;
        }
        pendingRequests.delete(message.id);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error(message.error || "T3 host bridge request failed."));
        }
      });
      function requestHost(method, ...args) {
        const id = String(Date.now()) + ":" + Math.random().toString(16).slice(2);
        return new Promise((resolve, reject) => {
          pendingRequests.set(id, { resolve, reject });
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
        getClientSettings() {
          return requestHost("getClientSettings");
        },
        setClientSettings(settings) {
          return requestHost("setClientSettings", settings);
        },
        postMessage(message) {
          vscode.postMessage(message);
        },
      };
      if (initialRoute && !window.location.hash) {
        window.history.replaceState(null, document.title, "#" + initialRoute);
      }
    })();
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
