import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { beforeEach, describe, it as vitestIt } from "vite-plus/test";

import { KiloSettings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  KiloRuntime,
  KiloRuntimeError,
  type KiloInventory,
  type KiloRuntimeShape,
} from "../kiloRuntime.ts";
import { checkKiloProviderStatus, flattenKiloModels } from "./KiloProvider.ts";

const decodeKiloSettings = Schema.decodeSync(KiloSettings);

const DEFAULT_VERSION_STDOUT = "kilo 7.4.11\n";

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    closeCalls: 0,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {}, failed: [] },
      agents: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.closeCalls = 0;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {}, failed: [] },
      agents: [] as unknown[],
    };
  },
};

const KiloRuntimeTestDouble: KiloRuntimeShape = {
  startKiloServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      password: "test-password",
      exitCode: Effect.never,
    }),
  connectToKiloServer: () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls += 1;
        }),
      );
      return {
        url: "http://127.0.0.1:4301",
        password: "test-password",
        exitCode: null,
        external: false,
      };
    }),
  runKiloCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new KiloRuntimeError({
            operation: "runKiloCommand",
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createKiloSdkClient: () => ({}) as unknown as ReturnType<KiloRuntimeShape["createKiloSdkClient"]>,
  loadKiloInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new KiloRuntimeError({
            operation: "loadKiloInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as KiloInventory),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(KiloRuntime, KiloRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeKiloSettings = (overrides?: Partial<KiloSettings>): KiloSettings =>
  decodeKiloSettings({
    enabled: true,
    binaryPath: "kilo",
    customModels: [],
    ...overrides,
  });

it.layer(testLayer)("checkKiloProviderStatus", (it) => {
  it.effect("shows a clear missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn kilo ENOENT");
      const snapshot = yield* checkKiloProviderStatus(makeKiloSettings(), process.cwd());

      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(snapshot.message, "Kilo CLI (`kilo`) is not installed or not on PATH.");
    }),
  );

  it.effect("returns disabled snapshot without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiloProviderStatus(
        makeKiloSettings({ enabled: false }),
        process.cwd(),
      );

      NodeAssert.equal(snapshot.enabled, false);
      NodeAssert.equal(snapshot.status, "disabled");
      NodeAssert.match(snapshot.message ?? "", /disabled/i);
      NodeAssert.equal(runtimeMock.state.closeCalls, 0);
    }),
  );

  it.effect("flattens connected upstream models as providerID/modelID", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["anthropic", "openai"],
          failed: [],
          default: {},
          all: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "claude-sonnet-4-5": {
                  id: "claude-sonnet-4-5",
                  name: "Claude Sonnet 4.5",
                  variants: {},
                },
              },
            },
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5": { id: "gpt-5", name: "GPT-5", variants: { medium: {}, high: {} } },
              },
            },
            {
              id: "disconnected",
              name: "Disconnected",
              models: {
                ignored: { id: "ignored", name: "Ignored", variants: {} },
              },
            },
          ],
        },
        agents: [{ name: "code", mode: "primary", hidden: false }],
      };

      const snapshot = yield* checkKiloProviderStatus(makeKiloSettings(), process.cwd());
      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.installed, true);
      const slugs = snapshot.models.map((model) => model.slug).toSorted();
      NodeAssert.deepEqual(slugs, ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
      const gpt = snapshot.models.find((model) => model.slug === "openai/gpt-5");
      NodeAssert.equal(gpt?.subProvider, "OpenAI");
      NodeAssert.ok(
        !(gpt?.capabilities?.optionDescriptors ?? []).some(
          (descriptor) => descriptor.id === "agent",
        ),
      );
    }),
  );

  it.effect("appends custom models", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["anthropic"],
          failed: [],
          default: {},
          all: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "claude-sonnet-4-5": {
                  id: "claude-sonnet-4-5",
                  name: "Claude Sonnet 4.5",
                  variants: {},
                },
              },
            },
          ],
        },
        agents: [],
      };

      const snapshot = yield* checkKiloProviderStatus(
        makeKiloSettings({ customModels: ["custom/my-model"] }),
        process.cwd(),
      );
      NodeAssert.ok(snapshot.models.some((model) => model.slug === "custom/my-model"));
    }),
  );

  it.effect("warns when Kilo reports zero connected upstreams", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiloProviderStatus(makeKiloSettings(), process.cwd());
      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.match(snapshot.message ?? "", /did not report any connected upstream providers/);
    }),
  );
});

describe("flattenKiloModels", () => {
  vitestIt("skips disconnected providers", () => {
    const models = flattenKiloModels({
      providerList: {
        connected: ["a"],
        failed: [],
        default: {},
        all: [
          {
            id: "a",
            name: "A",
            models: { m1: { id: "m1", name: "Model 1", variants: {} } },
          } as never,
          {
            id: "b",
            name: "B",
            models: { m2: { id: "m2", name: "Model 2", variants: {} } },
          } as never,
        ],
      },
      agents: [],
    });
    NodeAssert.deepEqual(
      models.map((model) => model.slug),
      ["a/m1"],
    );
  });
});
