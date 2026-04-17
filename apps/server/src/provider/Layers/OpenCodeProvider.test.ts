import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeProvider } from "../Services/OpenCodeProvider.ts";
import { makeOpenCodeProviderLive } from "./OpenCodeProvider.ts";

const runtimeMock = vi.hoisted(() => {
  const state = {
    runVersionError: null as Error | null,
    inventoryError: null as Error | null,
  };

  return {
    state,
    reset() {
      state.runVersionError = null;
      state.inventoryError = null;
    },
  };
});

vi.mock("../opencodeRuntime.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../opencodeRuntime.ts")>("../opencodeRuntime.ts");

  return {
    ...actual,
    runOpenCodeCommand: vi.fn(async () => {
      if (runtimeMock.state.runVersionError) {
        throw runtimeMock.state.runVersionError;
      }
      return { stdout: "opencode 1.0.0\n", stderr: "", code: 0 };
    }),
    connectToOpenCodeServer: vi.fn(async ({ serverUrl }: { serverUrl?: string }) => ({
      url: serverUrl ?? "http://127.0.0.1:4301",
      process: null,
      external: Boolean(serverUrl),
      close() {},
    })),
    createOpenCodeSdkClient: vi.fn(() => ({})),
    loadOpenCodeInventory: vi.fn(async () => {
      if (runtimeMock.state.inventoryError) {
        throw runtimeMock.state.inventoryError;
      }
      return {
        providerList: { connected: [], all: [] },
        agents: [],
      };
    }),
    flattenOpenCodeModels: vi.fn(() => []),
  };
});

beforeEach(() => {
  runtimeMock.reset();
});

const makeTestLayer = (settingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0]) =>
  makeOpenCodeProviderLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest(settingsOverrides)),
    Layer.provideMerge(NodeServices.layer),
  );

it.layer(makeTestLayer())("OpenCodeProviderLive", (it) => {
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const provider = yield* OpenCodeProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.message, "OpenCode CLI (`opencode`) is not installed or not on PATH.");
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const provider = yield* OpenCodeProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );
});

it.layer(
  makeTestLayer({
    providers: {
      opencode: {
        serverUrl: "http://127.0.0.1:9999",
        serverPassword: "secret-password",
      },
    },
  }),
)("OpenCodeProviderLive with configured server URL", (it) => {
  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("401 Unauthorized");
      const provider = yield* OpenCodeProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const provider = yield* OpenCodeProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
});
