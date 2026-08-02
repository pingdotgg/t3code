import { assert, it } from "@effect/vitest";
import { OpenCode2Settings } from "@t3tools/contracts";
import type {
  AgentInfoV2,
  IntegrationInfo,
  ModelInfo,
  OpencodeClient,
} from "@opencode-ai/sdk-next/v2";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as OpenCode2Runtime from "../opencode2Runtime.ts";
import { parseGenericCliVersion } from "../providerSnapshot.ts";
import {
  checkOpenCode2ProviderStatus,
  flattenOpenCode2Models,
  isOpenCode2InventorySettlementError,
  openCode2NextBuild,
  parseOpenCode2Version,
  settleOpenCode2Inventory,
} from "./OpenCode2Provider.ts";

const OPENCODE2_BANNER = "opencode2 v0.0.0-next-16339\n";
const BIG_PICKLE_MODEL = {
  id: "big-pickle",
  modelID: "big-pickle",
  providerID: "opencode",
  name: "Big Pickle",
  capabilities: {
    tools: true,
    input: ["text"],
    output: ["text"],
  },
  variants: [],
  time: {
    released: 0,
  },
  cost: [],
  status: "active",
  enabled: true,
  limit: {
    context: 128_000,
    output: 16_384,
  },
} satisfies ModelInfo;
const BIG_PICKLE_FAST_MODEL = {
  ...BIG_PICKLE_MODEL,
  id: "big-pickle-fast",
  name: "Big Pickle Fast",
} satisfies ModelInfo;
const OPENAI_MODEL = {
  ...BIG_PICKLE_MODEL,
  id: "gpt-test",
  modelID: "gpt-test",
  providerID: "openai",
  name: "GPT Test",
} satisfies ModelInfo;
const OPENCODE2_TEST_SETTINGS = Schema.decodeSync(OpenCode2Settings)({
  binaryPath: "fake-opencode2",
});
const OPENCODE2_EXTERNAL_TEST_SETTINGS = Schema.decodeSync(OpenCode2Settings)({
  binaryPath: "fake-opencode2",
  serverPassword: "external-secret",
  serverUrl: "http://127.0.0.1:9998",
});

function failingOpenCode2Runtime(
  category: OpenCode2Runtime.OpenCode2RuntimeErrorCategory,
  cause?: unknown,
): OpenCode2Runtime.OpenCode2Runtime["Service"] {
  const failure = new OpenCode2Runtime.OpenCode2RuntimeError({
    operation: "startOpenCode2ServerProcess",
    category,
    cause,
  });
  return OpenCode2Runtime.OpenCode2Runtime.of({
    startOpenCode2ServerProcess: () => Effect.fail(failure),
    connectToOpenCode2Server: () => Effect.fail(failure),
    createOpenCode2SdkClient: () => {
      throw new Error("unexpected SDK client creation");
    },
  });
}

function openCode2RuntimeWithHealthVersion(
  version: string,
  models: () => Array<ModelInfo> = () => [BIG_PICKLE_MODEL],
): OpenCode2Runtime.OpenCode2Runtime["Service"] {
  const client = {
    v2: {
      agent: {
        list: async () => ({ data: { data: [BUILD_AGENT] } }),
      },
      health: {
        get: async () => ({ data: { version } }),
      },
      integration: {
        list: async () => ({
          data: {
            data: [
              {
                id: "opencode",
                name: "OpenCode",
                methods: [],
                connections: [{ type: "env", name: "OPENCODE_TEST_KEY" }],
              } satisfies IntegrationInfo,
            ],
          },
        }),
      },
      model: {
        list: async () => ({ data: { data: models() } }),
      },
    },
  } as unknown as OpencodeClient;

  return OpenCode2Runtime.OpenCode2Runtime.of({
    startOpenCode2ServerProcess: () => Effect.die("unexpected server process start"),
    connectToOpenCode2Server: () =>
      Effect.succeed({
        exitCode: null,
        external: false,
        password: "test-password",
        url: "http://127.0.0.1:1234",
      }),
    createOpenCode2SdkClient: () => client,
  });
}

const BUILD_AGENT = {
  id: "build",
  name: "Build",
  request: { settings: {}, headers: {}, body: {} },
  mode: "primary",
  hidden: false,
  permissions: [],
} satisfies AgentInfoV2;

describe("parseOpenCode2Version", () => {
  // The reason this parser exists: the generic one anchors on `\b`, and the
  // `v` prefix kills the word boundary before the leading digit.
  it("parses the banner the generic CLI parser returns null for", () => {
    assert.strictEqual(parseGenericCliVersion(OPENCODE2_BANNER), null);
    assert.strictEqual(parseOpenCode2Version(OPENCODE2_BANNER), "0.0.0-next-16339");
  });

  it("parses a plain release version", () => {
    assert.strictEqual(parseOpenCode2Version("opencode2 2.1.4\n"), "2.1.4");
  });

  it("returns null when there is no version at all", () => {
    assert.strictEqual(
      parseOpenCode2Version("Error: @opencode-ai/cli's postinstall script was not run."),
      null,
    );
  });
});

describe("openCode2NextBuild", () => {
  it("reads the build number off the next line", () => {
    assert.strictEqual(openCode2NextBuild("0.0.0-next-16339"), 16339);
  });

  // A stable 2.x is not on the preview line, so the build gate must not apply
  // to it rather than rejecting it for lacking a build number.
  it("returns null for a version that is not on the next line", () => {
    assert.strictEqual(openCode2NextBuild("2.1.4"), null);
    assert.strictEqual(openCode2NextBuild("2.1.4-rc.1"), null);
  });
});

describe("checkOpenCode2ProviderStatus", () => {
  it.effect("rejects local next builds below the verified floor with install guidance", () =>
    Effect.gen(function* () {
      const providerFiber = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(
        Effect.provideService(
          OpenCode2Runtime.OpenCode2Runtime,
          openCode2RuntimeWithHealthVersion("0.0.0-next-10000"),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const provider = yield* Fiber.join(providerFiber);

      assert.strictEqual(provider.status, "error");
      assert.include(provider.message ?? "", "next-16339");
      assert.include(provider.message ?? "", "npm install");
    }),
  );

  it.effect("rejects external next builds below the verified floor with server guidance", () =>
    Effect.gen(function* () {
      const providerFiber = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_EXTERNAL_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(
        Effect.provideService(
          OpenCode2Runtime.OpenCode2Runtime,
          openCode2RuntimeWithHealthVersion("0.0.0-next-10000"),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const provider = yield* Fiber.join(providerFiber);

      assert.strictEqual(provider.status, "error");
      assert.include(provider.message ?? "", "configured OpenCode 2 server");
      assert.include(provider.message ?? "", "next-16339");
      assert.notInclude(provider.message ?? "", "npm install");
    }),
  );

  it.effect("does not include a minted startup password in provider status", () =>
    Effect.gen(function* () {
      const password = "MINTED_PROVIDER_STATUS_PASSWORD";
      const runtime = failingOpenCode2Runtime("startup-failed", new Error(password));
      const provider = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(Effect.provideService(OpenCode2Runtime.OpenCode2Runtime, runtime));

      assert.notInclude(provider.message ?? "", password);
      assert.include(provider.message ?? "", "startup-failed");
    }),
  );

  it.effect("preserves safe package and executable diagnostics", () =>
    Effect.gen(function* () {
      const placeholder = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(
        Effect.provideService(
          OpenCode2Runtime.OpenCode2Runtime,
          failingOpenCode2Runtime("placeholder-binary"),
        ),
      );
      const missing = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(
        Effect.provideService(
          OpenCode2Runtime.OpenCode2Runtime,
          failingOpenCode2Runtime("binary-not-found"),
        ),
      );

      assert.isFalse(placeholder.installed);
      assert.include(placeholder.message ?? "", "postinstall script never ran");
      assert.isFalse(missing.installed);
      assert.include(missing.message ?? "", "not installed or not on PATH");
    }),
  );

  it.effect("preserves generic health version diagnostics", () =>
    Effect.gen(function* () {
      const providerFiber = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(
        Effect.provideService(
          OpenCode2Runtime.OpenCode2Runtime,
          openCode2RuntimeWithHealthVersion("not-a-version"),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      const provider = yield* Fiber.join(providerFiber);

      assert.include(
        provider.message ?? "",
        "Unable to determine OpenCode 2 version from `/api/health`.",
      );
    }),
  );

  it.effect("reports inventory instability without blaming the health check", () =>
    Effect.gen(function* () {
      let reads = 0;
      const providerFiber = yield* checkOpenCode2ProviderStatus(
        OPENCODE2_TEST_SETTINGS,
        "/workspace",
        {},
      ).pipe(
        Effect.provideService(
          OpenCode2Runtime.OpenCode2Runtime,
          openCode2RuntimeWithHealthVersion("0.0.0-next-16339", () => {
            reads += 1;
            return [{ ...BIG_PICKLE_MODEL, id: `big-pickle-${reads}` }];
          }),
        ),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 seconds");
      const provider = yield* Fiber.join(providerFiber);

      assert.strictEqual(provider.status, "error");
      assert.include(provider.message ?? "", "inventory did not stabilize");
      assert.notInclude(provider.message ?? "", "health check");
    }),
  );
});

describe("settleOpenCode2Inventory", () => {
  it.effect("uses a 500ms healthy-path floor by default", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const settlement = yield* settleOpenCode2Inventory(
        Ref.update(reads, (count) => count + 1).pipe(
          Effect.as({
            models: [BIG_PICKLE_MODEL],
            agents: [BUILD_AGENT],
            connectedIntegrationIDs: ["opencode"],
          }),
        ),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust("499 millis");
      assert.strictEqual(yield* Ref.get(reads), 5);

      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(settlement);
      assert.strictEqual(yield* Ref.get(reads), 6);
    }),
  );

  it.effect("waits through a non-empty baseline until connected integrations settle", () =>
    Effect.gen(function* () {
      let reads = 0;
      const inventory = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return reads < 4
            ? { models: [BIG_PICKLE_MODEL], agents: [BUILD_AGENT], connectedIntegrationIDs: [] }
            : {
                models: [BIG_PICKLE_MODEL, OPENAI_MODEL],
                agents: [BUILD_AGENT],
                connectedIntegrationIDs: ["openai", "opencode"],
              };
        }),
        { maxAttempts: 6, minimumAttempts: 4, quietAttempts: 2, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 5);
      assert.deepStrictEqual(inventory.connectedIntegrationIDs, ["openai", "opencode"]);
      assert.deepStrictEqual(
        inventory.models.map((model) => model.providerID),
        ["opencode", "openai"],
      );
    }),
  );

  it.effect("returns a logged-out free catalog only at the bounded deadline", () =>
    Effect.gen(function* () {
      let reads = 0;
      const inventory = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return {
            models: [BIG_PICKLE_MODEL],
            agents: [BUILD_AGENT],
            connectedIntegrationIDs: [],
          };
        }),
        { maxAttempts: 6, minimumAttempts: 4, quietAttempts: 2, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 6);
      assert.deepStrictEqual(inventory.models, [BIG_PICKLE_MODEL]);
      assert.deepStrictEqual(inventory.connectedIntegrationIDs, []);
    }),
  );

  it.effect("keeps the last settled catalog when the final attempt changes", () =>
    Effect.gen(function* () {
      let reads = 0;
      const inventory = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return reads < 6
            ? { models: [BIG_PICKLE_MODEL], agents: [BUILD_AGENT], connectedIntegrationIDs: [] }
            : {
                models: [BIG_PICKLE_MODEL, OPENAI_MODEL],
                agents: [BUILD_AGENT],
                connectedIntegrationIDs: ["openai", "opencode"],
              };
        }),
        { maxAttempts: 6, minimumAttempts: 4, quietAttempts: 2, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 6);
      assert.deepStrictEqual(inventory.connectedIntegrationIDs, []);
      assert.deepStrictEqual(
        inventory.models.map((model) => model.providerID),
        ["opencode"],
      );
    }),
  );

  it.effect("fails when no catalog fingerprint stabilizes", () =>
    Effect.gen(function* () {
      let reads = 0;
      const error = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return {
            models: [{ ...BIG_PICKLE_MODEL, id: `big-pickle-${reads}` }],
            agents: [BUILD_AGENT],
            connectedIntegrationIDs: [],
          };
        }),
        { maxAttempts: 6, minimumAttempts: 4, quietAttempts: 2, retryDelayMs: 0 },
      ).pipe(Effect.flip);

      assert.strictEqual(reads, 6);
      assert.ok(isOpenCode2InventorySettlementError(error));
      assert.strictEqual(error.attempts, 6);
      assert.strictEqual(
        error.message,
        "OpenCode 2 inventory did not stabilize before the retry limit.",
      );
    }),
  );

  it.effect("ignores a non-model integration when another connection supplies models", () =>
    Effect.gen(function* () {
      let reads = 0;
      const inventory = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return {
            models: [BIG_PICKLE_MODEL],
            agents: [BUILD_AGENT],
            connectedIntegrationIDs: ["openai", "opencode"],
          };
        }),
        { maxAttempts: 3, minimumAttempts: 2, quietAttempts: 2, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 2);
      assert.deepStrictEqual(inventory.connectedIntegrationIDs, ["openai", "opencode"]);
    }),
  );

  it.effect("stops at the deadline when no connected integration supplies models", () =>
    Effect.gen(function* () {
      let reads = 0;
      const inventory = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return {
            models: [BIG_PICKLE_MODEL],
            agents: [BUILD_AGENT],
            connectedIntegrationIDs: ["openai"],
          };
        }),
        { maxAttempts: 3, minimumAttempts: 2, quietAttempts: 2, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 3);
      assert.deepStrictEqual(inventory.connectedIntegrationIDs, ["openai"]);
    }),
  );

  it.effect("stops at the deadline when the catalog stays empty", () =>
    Effect.gen(function* () {
      let reads = 0;
      const inventory = yield* settleOpenCode2Inventory(
        Effect.sync(() => {
          reads += 1;
          return { models: [], agents: [], connectedIntegrationIDs: [] };
        }),
        { maxAttempts: 3, retryDelayMs: 0 },
      );

      assert.strictEqual(reads, 3);
      assert.deepStrictEqual(inventory, {
        models: [],
        agents: [],
        connectedIntegrationIDs: [],
      });
    }),
  );
});

describe("flattenOpenCode2Models", () => {
  it("uses a readable upstream provider label", () => {
    assert.deepStrictEqual(flattenOpenCode2Models({ models: [BIG_PICKLE_MODEL], agents: [] }), [
      {
        slug: "opencode/big-pickle",
        name: "Big Pickle",
        subProvider: "OpenCode",
        isCustom: false,
        capabilities: {
          optionDescriptors: [],
        },
      },
    ]);
  });

  it("uses the selectable model ref id when models share an underlying model id", () => {
    assert.deepStrictEqual(
      flattenOpenCode2Models({
        models: [BIG_PICKLE_MODEL, BIG_PICKLE_FAST_MODEL],
        agents: [],
      }).map((model) => model.slug),
      ["opencode/big-pickle", "opencode/big-pickle-fast"],
    );
  });

  it("keeps a structured model whose id contains a slash", () => {
    const slashModel = {
      ...BIG_PICKLE_MODEL,
      id: "qwen/qwen3-coder",
      modelID: "qwen/qwen3-coder",
      providerID: "openrouter",
      name: "qwen3-coder",
    } satisfies ModelInfo;

    // Unlike the 1.x text parser fixed by #5072 opencode-model-slug-misclassification,
    // 2.x receives a structured SDK model and constructs the selectable
    // provider/model ref directly.
    assert.deepStrictEqual(
      flattenOpenCode2Models({ models: [slashModel], agents: [] }).map((model) => model.slug),
      ["openrouter/qwen/qwen3-coder"],
    );
  });

  it("marks the inferred reasoning default without a synthetic Default option", () => {
    const [model] = flattenOpenCode2Models({
      models: [
        {
          ...BIG_PICKLE_MODEL,
          variants: [
            { id: "low" },
            { id: "medium" },
            { id: "high" },
            { id: "xhigh" },
            { id: "max" },
          ],
        },
      ],
      agents: [],
    });

    assert.deepStrictEqual(model?.capabilities?.optionDescriptors, [
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
        ],
      },
    ]);
  });

  it("hides a catalog-supplied Default sentinel", () => {
    const [model] = flattenOpenCode2Models({
      models: [
        {
          ...BIG_PICKLE_MODEL,
          variants: [{ id: "default" }, { id: "high" }],
        },
      ],
      agents: [],
    });
    const descriptor = model?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === "variant",
    );

    assert.deepStrictEqual(descriptor?.type === "select" ? descriptor.options : [], [
      { id: "high", label: "High", isDefault: true },
    ]);
  });

  it("chooses a concrete fallback default for a thinking toggle", () => {
    const [model] = flattenOpenCode2Models({
      models: [
        {
          ...BIG_PICKLE_MODEL,
          variants: [{ id: "none" }, { id: "thinking" }],
        },
      ],
      agents: [],
    });
    const descriptor = model?.capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === "variant",
    );

    assert.deepStrictEqual(descriptor, {
      id: "variant",
      label: "Reasoning",
      type: "select",
      currentValue: "thinking",
      options: [
        { id: "none", label: "None" },
        { id: "thinking", label: "Thinking", isDefault: true },
      ],
    });
  });
});
