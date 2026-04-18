import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { beforeEach, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeProvider } from "../Services/OpenCodeProvider.ts";
import { makeOpenCodeProviderLive } from "./OpenCodeProvider.ts";

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    inventoryError: null as Error | null,
    inventoryResult: {
      providerList: { connected: [], default: {}, all: [] },
      agents: [],
    } as {
      providerList: {
        connected: string[];
        default: Record<string, string>;
        all: Array<Record<string, unknown>>;
      };
      agents: Array<unknown>;
    },
  },
  reset() {
    this.state.runVersionError = null;
    this.state.inventoryError = null;
    this.state.inventoryResult = {
      providerList: { connected: [], default: {}, all: [] },
      agents: [],
    };
  },
};

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
      return runtimeMock.state.inventoryResult;
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

  it.effect("shows managed OpenCode usage only when a managed provider reports real usage", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryResult = {
        providerList: {
          connected: ["opencode-go", "anthropic"],
          default: {},
          all: [
            {
              id: "opencode-go",
              name: "OpenCode Go",
              env: [],
              models: {},
              usage: { usedPercent: 27 },
            },
            {
              id: "anthropic",
              name: "Anthropic",
              env: [],
              models: {},
              usage: { usedPercent: 99 },
            },
          ],
        },
        agents: [],
      };
      const provider = yield* OpenCodeProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.usageLimits?.available, true);
      assert.deepEqual(snapshot.usageLimits?.windows, [
        { kind: "session", label: "OpenCode Go", usedPercent: 27 },
      ]);
    }),
  );

  it.effect("shows unavailable usage when only upstream providers are connected", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryResult = {
        providerList: {
          connected: ["anthropic"],
          default: {},
          all: [{ id: "anthropic", name: "Anthropic", env: [], models: {} }],
        },
        agents: [],
      };
      const provider = yield* OpenCodeProvider;
      const snapshot = yield* provider.refresh;

      assert.equal(snapshot.usageLimits?.available, false);
      assert.equal(snapshot.usageLimits?.reason, "Unable to fetch usage");
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
