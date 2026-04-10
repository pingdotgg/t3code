import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  getPrimaryKnownEnvironment,
  resolveInitialPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from ".";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

const BASE_ENVIRONMENT = {
  environmentId: "environment-local",
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

function installTestBrowser(url: string) {
  vi.stubGlobal("window", {
    location: new URL(url),
    history: {
      replaceState: vi.fn(),
    },
  });
}

describe("environmentBootstrap", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(() => {
    resetPrimaryEnvironmentDescriptorForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("attaches the bootstrapped environment descriptor to the primary environment", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3773",
      },
      desktopBridge: undefined,
    });
    writePrimaryEnvironmentDescriptor({
      environmentId: EnvironmentId.makeUnsafe("environment-local"),
      label: "Bootstrapped environment",
      platform: {
        os: "darwin",
        arch: "arm64",
      },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
      },
    });

    expect(getPrimaryKnownEnvironment()).toEqual({
      id: "environment-local",
      label: "Bootstrapped environment",
      source: "window-origin",
      environmentId: "environment-local",
      target: {
        httpBaseUrl: "http://localhost:3773/",
        wsBaseUrl: "ws://localhost:3773/",
      },
    });
  });

  it("reuses an in-flight descriptor bootstrap request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([
      resolveInitialPrimaryEnvironmentDescriptor(),
      resolveInitialPrimaryEnvironmentDescriptor(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/.well-known/t3/environment");
  });

  it("uses https descriptor urls when the primary environment uses wss", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/.well-known/t3/environment");
  });

  it("derives the websocket url when only VITE_HTTP_URL is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/.well-known/t3/environment");
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives the http url when only VITE_WS_URL is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/.well-known/t3/environment");
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("uses the current origin as the descriptor base for local dev environments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost:5735/");

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5735/.well-known/t3/environment");
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(BASE_ENVIRONMENT));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      history: {
        replaceState: vi.fn(),
      },
      desktopBridge: {
        getLocalEnvironmentBootstrap: () => ({
          label: "Local environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
          bootstrapToken: "desktop-bootstrap-token",
        }),
      },
    });

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5733/.well-known/t3/environment");
  });
});
