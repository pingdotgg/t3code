import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  THREAD_CONVERSATION_MAX_WIDTH_PX,
  THREAD_CONVERSATION_MIN_WIDTH_PX,
} from "@t3tools/shared/displayPreferences";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import packageJson from "../package.json" with { type: "json" };
import { renderDesktopBackendRequiredWebview, renderT3Webview } from "./webview.ts";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: { fsPath: string }, ...segments: readonly string[]) => ({
      fsPath: path.join(base.fsPath, ...segments),
    }),
  },
}));

describe("renderT3Webview", () => {
  let extensionRoot: string;

  beforeEach(() => {
    extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-vscode-webview-"));
    fs.mkdirSync(path.join(extensionRoot, "dist", "webview"), { recursive: true });
    fs.writeFileSync(
      path.join(extensionRoot, "dist", "webview", "index.html"),
      '<!doctype html><html><head><title>T3</title></head><body><div id="root"></div></body></html>',
    );
  });

  afterEach(() => {
    fs.rmSync(extensionRoot, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  it("injects CSP, base URI, and host bridge bootstrap before the app bundle", async () => {
    const html = await renderT3Webview({
      extensionUri: { fsPath: extensionRoot } as never,
      webview: {
        cspSource: "vscode-webview:",
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `vscode-resource:${uri.fsPath}`,
        }),
      } as never,
      connection: {
        httpBaseUrl: "http://127.0.0.1:49111",
        wsBaseUrl: "ws://127.0.0.1:49111",
        bearerToken: "bearer-token",
        cwd: "/workspace",
        t3Home: "/home/user/.t3",
        environmentId: "environment-desktop",
        workspaceFolders: [
          {
            key: "file::/workspace",
            name: "workspace",
            cwd: "/workspace",
            uriScheme: "file",
            uriAuthority: "",
          },
        ],
        activeWorkspaceFolderKey: "file::/workspace",
        bootstrapProjects: [
          {
            workspaceFolderKey: "file::/workspace",
            workspaceFolderName: "workspace",
            cwd: "/workspace",
            projectId: "project-workspace",
            bootstrapThreadId: "thread-workspace",
            isActive: true,
          },
        ],
      },
      initialRoute: "/_chat/",
    });

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src &#39;none&#39;");
    expect(html).toContain(
      "connect-src vscode-webview: http://127.0.0.1:49111 ws://127.0.0.1:49111",
    );
    expect(html).toContain(`<base href="vscode-resource:${extensionRoot}/dist/webview/">`);
    expect(html).toContain("window.__T3_IS_VSCODE_WEBVIEW = true");
    expect(html).toContain("window.t3HostBridge");
    expect(html).toContain("getDisplayPreferences()");
    expect(html).toContain("onDisplayPreferencesChanged(callback)");
    expect(html).toContain("getHostAppearance()");
    expect(html).toContain("onHostAppearanceChanged(callback)");
    expect(html).toContain('message.type === "t3.displayPreferencesChanged"');
    expect(html).toContain('message.type === "t3.hostAppearanceChanged"');
    expect(html).toContain('message.type === "t3.backendConnectionChanged"');
    expect(html).toContain('root.setAttribute("data-t3-host-theme", "vscode")');
    expect(html).toContain("applyDisplayPreferences(displayPreferences)");
    expect(html).toContain(
      `const threadConversationMinWidthPx = ${THREAD_CONVERSATION_MIN_WIDTH_PX}`,
    );
    expect(html).toContain(
      `const threadConversationMaxWidthPx = ${THREAD_CONVERSATION_MAX_WIDTH_PX}`,
    );
    expect(html).toContain("const normalizeThreadConversationMaxWidth = function");
    expect(html).toContain("Ignoring invalid T3 thread conversation max width preference.");
    expect(html).toContain('root.setAttribute("data-t3-thread-conversation-width", "custom")');
    expect(html).toContain(
      'root.style.setProperty("--t3-thread-conversation-max-width", width + "px")',
    );
    expect(html).toContain('root.removeAttribute("data-t3-thread-conversation-width")');
    expect(html).toContain('"showOpenInPicker":false');
    expect(html).toContain('"enableTerminal":false');
    expect(html).toContain('"enableSourceControlPanel":false');
    expect(html).toContain('"threadConversationMaxWidthPx":null');
    expect(html).toContain('"themeSource":"default"');
    expect(html).toContain("getClientSettings()");
    expect(html).toContain("getVscodeWorkspaceBootstrap()");
    expect(html).toContain("setClientSettings(settings)");
    expect(html).toContain("confirm(message)");
    expect(html).toContain('return requestHost("confirm", message)');
    expect(html).toContain('reject(new Error("T3 host bridge request timed out."))');
    expect(html).toContain("clearTimeout(pending.timeoutId)");
    expect(html).not.toContain('"bootstrapToken"');
    expect(html).toContain('"bearerToken":"bearer-token"');
    expect(html).toContain('"environmentId":"environment-desktop"');
    expect(html).toContain('"projectId":"project-workspace"');
    expect(html).toContain('window.history.replaceState(null, document.title, "#" + initialRoute)');
    expect(html).not.toContain("!window.location.hash");
  });

  it("injects into head tags with attributes", async () => {
    fs.writeFileSync(
      path.join(extensionRoot, "dist", "webview", "index.html"),
      '<!doctype html><html><head data-test="true"><title>T3</title></head><body></body></html>',
    );

    const html = await renderT3Webview({
      extensionUri: { fsPath: extensionRoot } as never,
      webview: {
        cspSource: "vscode-webview:",
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `vscode-resource:${uri.fsPath}`,
        }),
      } as never,
      connection: {
        httpBaseUrl: "http://127.0.0.1:49111",
        wsBaseUrl: "ws://127.0.0.1:49111",
        bearerToken: "bearer-token",
        cwd: "/workspace",
        t3Home: "/home/user/.t3",
        environmentId: "environment-desktop",
        workspaceFolders: [],
        bootstrapProjects: [],
      },
    });

    expect(html).toContain('<head data-test="true">');
    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  it("defaults to the chat index route when no initial route is provided", async () => {
    const html = await renderT3Webview({
      extensionUri: { fsPath: extensionRoot } as never,
      webview: {
        cspSource: "vscode-webview:",
        asWebviewUri: (uri: { fsPath: string }) => ({
          toString: () => `vscode-resource:${uri.fsPath}`,
        }),
      } as never,
      connection: {
        httpBaseUrl: "http://127.0.0.1:49111",
        wsBaseUrl: "ws://127.0.0.1:49111",
        bearerToken: "bearer-token",
        cwd: "/workspace",
        t3Home: "/home/user/.t3",
        environmentId: "environment-desktop",
        workspaceFolders: [],
        bootstrapProjects: [],
      },
      displayPreferences: {
        showOpenInPicker: true,
        showCheckoutModeIndicator: true,
        showBranchSelector: false,
        enableTerminal: true,
        enableSourceControlPanel: true,
        threadConversationMaxWidthPx: 960,
      },
      hostAppearance: {
        themeSource: "vscode",
        colorScheme: "dark",
      },
    });

    expect(html).toContain('const initialRoute = "/_chat/"');
    expect(html).toContain('"showOpenInPicker":true');
    expect(html).toContain('"showBranchSelector":false');
    expect(html).toContain('"enableTerminal":true');
    expect(html).toContain('"enableSourceControlPanel":true');
    expect(html).toContain('"threadConversationMaxWidthPx":960');
    expect(html).toContain('"themeSource":"vscode"');
    expect(html).toContain('"colorScheme":"dark"');
  });
});

describe("renderDesktopBackendRequiredWebview", () => {
  it("renders a reconnect button that asks the extension host to retry backend discovery", () => {
    const html = renderDesktopBackendRequiredWebview();

    expect(html).toContain("Start T3 Code Desktop");
    expect(html).toContain("Start the desktop app manually, then reconnect.");
    expect(html).toContain('<button type="button" id="reconnect">Reconnect</button>');
    expect(html).toContain('vscode.postMessage({ type: "t3.reconnectDesktopBackend" })');
    expect(html).not.toContain("T3 Code: Reconnect to Desktop Backend");
  });
});

describe("VS Code display preference settings", () => {
  it("contributes disabled-by-default settings for each host-hidden control and theme restore", () => {
    const properties = packageJson.contributes.configuration.properties;

    expect(properties["t3code.ui.showOpenInPicker"]?.default).toBe(false);
    expect(properties["t3code.ui.showCheckoutModeIndicator"]?.default).toBe(false);
    expect(properties["t3code.ui.showBranchSelector"]?.default).toBe(false);
    expect(properties["t3code.ui.enableTerminal"]?.default).toBe(false);
    expect(properties["t3code.ui.enableSourceControlPanel"]?.default).toBe(false);
    expect(properties["t3code.ui.threadConversationMaxWidth"]?.type).toEqual(["number", "null"]);
    expect(properties["t3code.ui.threadConversationMaxWidth"]?.default).toBeNull();
    expect(properties["t3code.ui.threadConversationMaxWidth"]?.minimum).toBe(
      THREAD_CONVERSATION_MIN_WIDTH_PX,
    );
    expect(properties["t3code.ui.threadConversationMaxWidth"]?.maximum).toBe(
      THREAD_CONVERSATION_MAX_WIDTH_PX,
    );
    expect(properties["t3code.ui.restoreDefaultTheme"]?.default).toBe(false);
    expect("t3code.ui.showTerminalToggle" in properties).toBe(false);
  });
});

describe("VS Code MCP settings", () => {
  it("contributes a customizable vscodeRunCommand allowlist", () => {
    const properties = packageJson.contributes.configuration.properties;

    expect(properties["t3code.mcp.allowedRunCommands"]?.type).toBe("array");
    expect(properties["t3code.mcp.allowedRunCommands"]?.default).toEqual([
      "t3code.*",
      "vscode.open",
      "vscode.diff",
      "revealLine",
    ]);
    expect(properties["t3code.mcp.allowedRunCommands"]?.items).toEqual({
      type: "string",
      minLength: 1,
      pattern: "^[^*]+\\*?$",
    });
    expect(properties["t3code.mcp.allowedActivateExtensions"]?.type).toBe("array");
    expect(properties["t3code.mcp.allowedActivateExtensions"]?.default).toEqual([]);
    expect(properties["t3code.mcp.allowedActivateExtensions"]?.items).toEqual({
      type: "string",
      minLength: 1,
      pattern: "\\S",
    });
  });
});
