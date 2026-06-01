import { EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  inferBrowserAgentDevServerUrl,
  normalizeBrowserAgentPreviewUrl,
  resolveBrowserAgentPreviewUrl,
  resolveBrowserAgentReachablePreviewUrl,
  shouldShowBrowserAgentControls,
} from "./browserAgents";
import { useUiStateStore } from "./uiStateStore";

function script(command: string): ProjectScript {
  return {
    id: command,
    name: command,
    command,
    icon: "play",
    runOnWorktreeCreate: false,
  };
}

function installWindow(url: string, desktopBridge?: unknown) {
  vi.stubGlobal("window", {
    location: new URL(url),
    ...(desktopBridge ? { desktopBridge } : {}),
  });
}

function endpoint(input: {
  readonly id: string;
  readonly httpBaseUrl: string;
  readonly reachability: "loopback" | "private-network" | "lan";
  readonly isDefault?: boolean;
}) {
  return {
    id: input.id,
    label: input.id,
    provider: {
      id: input.id.startsWith("tailscale-") ? "tailscale" : "desktop-core",
      label: input.id.startsWith("tailscale-") ? "Tailscale" : "Desktop",
      kind: input.id.startsWith("tailscale-") ? "private-network" : "core",
      isAddon: input.id.startsWith("tailscale-"),
    },
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.httpBaseUrl.replace(/^http/u, "ws"),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp: "mixed-content-blocked",
      desktopApp: "compatible",
    },
    source: "desktop-core",
    status: "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  } as const;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
});

describe("inferBrowserAgentDevServerUrl", () => {
  it("uses explicit script ports", () => {
    expect(inferBrowserAgentDevServerUrl([script("pnpm dev --port 4173")])).toBe(
      "http://localhost:4173/",
    );
  });

  it("uses common framework defaults", () => {
    expect(inferBrowserAgentDevServerUrl([script("pnpm next dev")])).toBe("http://localhost:3000/");
    expect(inferBrowserAgentDevServerUrl([script("pnpm vite --host 0.0.0.0")])).toBe(
      "http://localhost:5173/",
    );
  });
});

describe("normalizeBrowserAgentPreviewUrl", () => {
  it("normalizes common localhost shorthand", () => {
    expect(normalizeBrowserAgentPreviewUrl(" localhost:4173/app ")).toBe(
      "http://localhost:4173/app",
    );
    expect(normalizeBrowserAgentPreviewUrl("localhost")).toBe("http://localhost");
    expect(normalizeBrowserAgentPreviewUrl(":5173")).toBe("http://localhost:5173");
  });

  it("preserves absolute and root-relative URLs", () => {
    expect(normalizeBrowserAgentPreviewUrl("https://preview.example.test/app")).toBe(
      "https://preview.example.test/app",
    );
    expect(normalizeBrowserAgentPreviewUrl("/preview")).toBe("/preview");
  });
});

describe("resolveBrowserAgentPreviewUrl", () => {
  it("uses the custom preview URL before detected or inferred URLs", () => {
    expect(
      resolveBrowserAgentPreviewUrl({
        customPreviewUrl: "localhost:4000",
        detectedDevServerUrl: "http://localhost:5173/",
        scripts: [script("pnpm next dev")],
      }),
    ).toBe("http://localhost:4000");
  });

  it("falls back to detected then inferred project dev-server URLs", () => {
    expect(
      resolveBrowserAgentPreviewUrl({
        customPreviewUrl: "",
        detectedDevServerUrl: "http://localhost:5173/",
        scripts: [script("pnpm next dev")],
      }),
    ).toBe("http://localhost:5173/");

    expect(
      resolveBrowserAgentPreviewUrl({
        customPreviewUrl: "   ",
        detectedDevServerUrl: null,
        scripts: [script("pnpm next dev")],
      }),
    ).toBe("http://localhost:3000/");
  });
});

describe("resolveBrowserAgentReachablePreviewUrl", () => {
  it("rewrites loopback dev-server URLs through the remote browser origin", async () => {
    installWindow("http://100.105.249.96:3773/t3code/thread");

    await expect(resolveBrowserAgentReachablePreviewUrl("http://localhost:3000/")).resolves.toBe(
      "http://100.105.249.96:3000/",
    );
  });

  it("prefers the remote browser origin over a loopback primary target", async () => {
    installWindow("http://100.105.249.96:3773/t3code/thread", {
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveBrowserAgentReachablePreviewUrl("http://localhost:3000/")).resolves.toBe(
      "http://100.105.249.96:3000/",
    );
  });

  it("uses the default advertised Tailscale IP endpoint when desktop provides one", async () => {
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: "tailscale:ip:http" });
    installWindow("http://127.0.0.1:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
          }),
          endpoint({
            id: "tailscale-ip:100.105.249.96",
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          }),
        ]),
    });

    await expect(resolveBrowserAgentReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://100.105.249.96:5173/",
    );
  });

  it("uses the current remote browser origin before a Tailscale IP fallback", async () => {
    installWindow("http://100.105.249.97:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
          }),
          endpoint({
            id: "tailscale-ip:100.105.249.96",
            httpBaseUrl: "http://100.105.249.96:3773/",
            reachability: "private-network",
          }),
        ]),
    });

    await expect(resolveBrowserAgentReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://100.105.249.97:5173/",
    );
  });

  it("keeps localhost when only loopback endpoints are available", async () => {
    installWindow("http://127.0.0.1:3773/", {
      getAdvertisedEndpoints: () =>
        Promise.resolve([
          endpoint({
            id: "desktop-loopback:3773",
            httpBaseUrl: "http://127.0.0.1:3773/",
            reachability: "loopback",
            isDefault: true,
          }),
        ]),
      getLocalEnvironmentBootstrap: () => ({
        environmentId: "environment-local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      }),
    });

    await expect(resolveBrowserAgentReachablePreviewUrl("http://localhost:5173/")).resolves.toBe(
      "http://localhost:5173/",
    );
  });

  it("does not rewrite already remote dev-server URLs", async () => {
    installWindow("http://100.105.249.96:3773/t3code/thread");

    await expect(
      resolveBrowserAgentReachablePreviewUrl("http://preview.example.test:3000/"),
    ).resolves.toBe("http://preview.example.test:3000/");
  });
});

describe("shouldShowBrowserAgentControls", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows controls for active primary-environment projects", () => {
    expect(
      shouldShowBrowserAgentControls({
        activeProjectName: "repo",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides controls without a project or primary environment match", () => {
    expect(
      shouldShowBrowserAgentControls({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
    expect(
      shouldShowBrowserAgentControls({
        activeProjectName: "repo",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});
