import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  getPrimaryKnownEnvironment,
  resolvePrimaryEnvironmentHttpUrl,
  resolveInitialPrimaryEnvironmentDescriptor,
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from ".";
import { installEnvironmentHttpTest } from "../../../test/environmentHttpTest";

const BASE_ENVIRONMENT = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
} satisfies ExecutionEnvironmentDescriptor;

let disposeHttpTest: (() => Promise<void>) | undefined;

async function installDescriptorApi() {
  const testApi = await installEnvironmentHttpTest({
    descriptor: () => Effect.succeed(BASE_ENVIRONMENT),
  });
  disposeHttpTest = testApi.dispose;
  return testApi;
}

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

  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
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
      environmentId: EnvironmentId.make("environment-local"),
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
    const testApi = await installDescriptorApi();

    await Promise.all([
      resolveInitialPrimaryEnvironmentDescriptor(),
      resolveInitialPrimaryEnvironmentDescriptor(),
    ]);

    expect(testApi.calls.descriptor).toBe(1);
  });

  it("uses https descriptor urls when the primary environment uses wss", async () => {
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://remote.example.com/.well-known/t3/environment",
    );
  });

  it("derives the websocket url when only VITE_HTTP_URL is configured", async () => {
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://remote.example.com/.well-known/t3/environment",
    );
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives the http url when only VITE_WS_URL is configured", async () => {
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "https://remote.example.com/.well-known/t3/environment",
    );
    expect(getPrimaryKnownEnvironment()?.target).toEqual({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("uses the current origin as the descriptor base for local dev environments", async () => {
    installTestBrowser("http://localhost:5735/");
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://localhost:5735/.well-known/t3/environment",
    );
  });

  it("uses the vite proxy for desktop-managed loopback descriptor requests during local dev", async () => {
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
    await installDescriptorApi();

    await expect(resolveInitialPrimaryEnvironmentDescriptor()).resolves.toEqual(BASE_ENVIRONMENT);
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
  });
});
