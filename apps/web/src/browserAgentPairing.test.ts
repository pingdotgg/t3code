import type { BrowserAgentListResult } from "@t3tools/contracts";
import {
  BROWSER_AGENT_AUTO_PAIR_PATH,
  BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH,
} from "@t3tools/shared/browserAgent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserAgentExtensionUnavailableError,
  buildBrowserAgentAutoPairUrl,
  buildBrowserAgentExtensionDownloadUrl,
  isBrowserAgentExtensionUnavailableError,
  isNoBrowserAgentConnectedError,
  resolveBrowserAgentBackendBaseUrl,
  waitForBrowserAgentConnection,
} from "./browserAgentPairing";
import { useUiStateStore } from "./uiStateStore";

function installWindow(url: string, desktopBridge?: unknown) {
  vi.stubGlobal("window", {
    location: new URL(url),
    setTimeout,
    clearTimeout,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    postMessage: vi.fn(),
    ...(desktopBridge ? { desktopBridge } : {}),
  });
}

function snapshot(connected: boolean): BrowserAgentListResult {
  return {
    agents: connected ? [{ connected }] : [],
    tabs: [],
    workspaceLinks: [],
  } as unknown as BrowserAgentListResult;
}

describe("browser agent pairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
  });

  it("builds an auto-pair URL on the backend origin", () => {
    const url = new URL(
      buildBrowserAgentAutoPairUrl({
        baseUrl: "http://100.105.249.96:3773/some/path",
        sessionToken: "session-token",
      }),
    );

    expect(url.origin).toBe("http://100.105.249.96:3773");
    expect(url.pathname).toBe(BROWSER_AGENT_AUTO_PAIR_PATH);
    expect(url.searchParams.get("t3BrowserAgentPair")).toBe("1");
    expect(url.searchParams.get("t3BrowserAgentBaseUrl")).toBe("http://100.105.249.96:3773/");
    expect(new URLSearchParams(url.hash.slice(1)).get("t3BrowserAgentSessionToken")).toBe(
      "session-token",
    );
  });

  it("builds an extension download URL on the backend origin", () => {
    const url = new URL(
      buildBrowserAgentExtensionDownloadUrl({
        baseUrl: "http://100.105.249.96:3773/some/path",
      }),
    );

    expect(url.origin).toBe("http://100.105.249.96:3773");
    expect(url.pathname).toBe(BROWSER_AGENT_EXTENSION_DOWNLOAD_PATH);
  });

  it("uses the configured backend target instead of the current dev proxy origin", async () => {
    installWindow("http://127.0.0.1:5733/", {
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://100.105.249.96:3773/",
        wsBaseUrl: "ws://100.105.249.96:3773/",
      }),
    });

    await expect(resolveBrowserAgentBackendBaseUrl()).resolves.toBe("http://100.105.249.96:3773/");
  });

  it("uses the saved default advertised endpoint for browser agent pairing", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:5733/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          {
            id: "desktop-loopback:127.0.0.1",
            label: "This machine",
            provider: {
              id: "desktop-core",
              label: "Desktop",
              kind: "core",
              isAddon: false,
            },
            httpBaseUrl: "http://127.0.0.1:3773/",
            wsBaseUrl: "ws://127.0.0.1:3773/",
            reachability: "loopback",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
            isDefault: true,
          },
          {
            id: "tailscale-ip:100.105.249.96",
            label: "Tailscale IP",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "addon",
              isAddon: true,
            },
            httpBaseUrl: "http://100.105.249.96:3773/",
            wsBaseUrl: "ws://100.105.249.96:3773/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-core",
            status: "available",
          },
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveBrowserAgentBackendBaseUrl()).resolves.toBe("http://100.105.249.96:3773/");
  });

  it("prefers Tailscale HTTPS for browser agent pairing when the saved default is Tailscale IP", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:5733/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          {
            id: "tailscale-ip:100.105.249.96",
            label: "Tailscale IP",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "http://100.105.249.96:3773/",
            wsBaseUrl: "ws://100.105.249.96:3773/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "mixed-content-blocked",
              desktopApp: "compatible",
            },
            source: "desktop-addon",
            status: "available",
          },
          {
            id: "tailscale-magicdns:https://desktop.tail.ts.net/",
            label: "Tailscale HTTPS",
            provider: {
              id: "tailscale",
              label: "Tailscale",
              kind: "private-network",
              isAddon: true,
            },
            httpBaseUrl: "https://desktop.tail.ts.net/",
            wsBaseUrl: "wss://desktop.tail.ts.net/",
            reachability: "private-network",
            compatibility: {
              hostedHttpsApp: "compatible",
              desktopApp: "compatible",
            },
            source: "desktop-addon",
            status: "available",
          },
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveBrowserAgentBackendBaseUrl()).resolves.toBe("https://desktop.tail.ts.net/");
  });

  it("detects the no-agent RPC failure", () => {
    expect(isNoBrowserAgentConnectedError({ code: "no-agent-connected" })).toBe(true);
    expect(
      isNoBrowserAgentConnectedError(new Error("No paired browser extension is connected.")),
    ).toBe(true);
    expect(isNoBrowserAgentConnectedError(new Error("Different failure"))).toBe(false);
  });

  it("detects the extension unavailable pairing failure", () => {
    const error = new BrowserAgentExtensionUnavailableError({
      downloadUrl: "http://localhost:3773/downloads/t3-code-browser-agent.zip",
    });

    expect(isBrowserAgentExtensionUnavailableError(error)).toBe(true);
    expect(isBrowserAgentExtensionUnavailableError(new Error("Different failure"))).toBe(false);
  });

  it("waits until a browser agent connects", async () => {
    installWindow("http://localhost/");
    const client = {
      browserAgents: {
        list: vi
          .fn<() => Promise<BrowserAgentListResult>>()
          .mockResolvedValueOnce(snapshot(false))
          .mockResolvedValueOnce(snapshot(true)),
      },
    };

    await expect(
      waitForBrowserAgentConnection(client, {
        timeoutMs: 100,
        pollIntervalMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(client.browserAgents.list).toHaveBeenCalledTimes(2);
  });
});
