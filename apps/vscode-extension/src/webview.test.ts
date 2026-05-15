import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../package.json" with { type: "json" };
import { renderT3Webview } from "./webview.ts";

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
        bootstrapToken: "bootstrap-token",
        bearerToken: "bearer-token",
        cwd: "/workspace",
        t3Home: "/home/user/.t3",
      },
      initialRoute: "/_chat/",
    });

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(
      "connect-src vscode-webview: http://127.0.0.1:49111 ws://127.0.0.1:49111",
    );
    expect(html).toContain(`<base href="vscode-resource:${extensionRoot}/dist/webview/">`);
    expect(html).toContain("window.__T3_IS_VSCODE_WEBVIEW = true");
    expect(html).toContain("window.t3HostBridge");
    expect(html).toContain("getDisplayPreferences()");
    expect(html).toContain("onDisplayPreferencesChanged(callback)");
    expect(html).toContain('message.type === "t3.displayPreferencesChanged"');
    expect(html).toContain('"showOpenInPicker":false');
    expect(html).toContain("getClientSettings()");
    expect(html).toContain("setClientSettings(settings)");
    expect(html).toContain('"bootstrapToken":"bootstrap-token"');
    expect(html).toContain('"bearerToken":"bearer-token"');
    expect(html).toContain('window.history.replaceState(null, document.title, "#" + initialRoute)');
    expect(html).not.toContain("!window.location.hash");
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
        bootstrapToken: "bootstrap-token",
        bearerToken: "bearer-token",
        cwd: "/workspace",
        t3Home: "/home/user/.t3",
      },
      displayPreferences: {
        showOpenInPicker: true,
        showCheckoutModeIndicator: true,
        showBranchSelector: false,
        showTerminalToggle: true,
      },
    });

    expect(html).toContain('const initialRoute = "/_chat/"');
    expect(html).toContain('"showOpenInPicker":true');
    expect(html).toContain('"showBranchSelector":false');
  });
});

describe("VS Code display preference settings", () => {
  it("contributes disabled-by-default settings for each host-hidden control", () => {
    const properties = packageJson.contributes.configuration.properties;

    expect(properties["t3code.ui.showOpenInPicker"]?.default).toBe(false);
    expect(properties["t3code.ui.showCheckoutModeIndicator"]?.default).toBe(false);
    expect(properties["t3code.ui.showBranchSelector"]?.default).toBe(false);
    expect(properties["t3code.ui.showTerminalToggle"]?.default).toBe(false);
  });
});
