import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { OmpSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildOmpProviderSnapshot,
  buildOmpCapabilitiesFromConfigOptions,
  checkOmpProviderStatus,
  discoverOmpModelsViaAcp,
  getOmpFallbackModels,
  resolveOmpAcpConfigUpdates,
} from "./OmpProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const node = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Effect.Effect<A, E> => effect.pipe(Effect.provide(NodeServices.layer));

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

/**
 * These fixtures are ACP-only fakes: `--mode rpc` exits without a catalog, so
 * `checkOmpProviderStatus` has to reach its ACP fallback to build a model
 * list — which is exactly the degraded path the tests below cover.
 */
const RPC_UNSUPPORTED_SOURCE = [
  'if (process.argv[2] === "--mode") {',
  "  process.exit(0);",
  "}",
].join("\n");

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-mock-",
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-omp",
    env: { T3_ACP_OMP_SHAPES: "1", ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
});

const makeMockAgentWithVersionWrapper = Effect.fn("makeMockAgentWithVersionWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-version-mock-",
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-omp",
    env: { T3_ACP_OMP_SHAPES: "1" },
    source: [
      RPC_UNSUPPORTED_SOURCE,
      'if (process.argv[2] === "--version") {',
      '  process.stdout.write("omp/18.0.6\\n");',
      "  process.exit(0);",
      "}",
      execScriptSource({ scriptPath: mockAgentPath }),
    ].join("\n"),
  });
});

const ompUsageFixturePayload = JSON.stringify({
  generatedAt: "2030-01-01T00:00:00.000Z",
  reports: [
    {
      provider: "anthropic",
      fetchedAt: "2030-01-01T00:00:00.000Z",
      limits: [
        {
          id: "5h",
          label: "5-hour",
          scope: { provider: "anthropic", windowId: "5h", shared: false },
          window: {
            id: "5h",
            label: "5-hour",
            durationMs: 18_000_000,
            resetsAt: "2030-01-01T05:00:00.000Z",
          },
          amount: {
            used: 42,
            limit: 100,
            remaining: 58,
            usedFraction: 0.42,
            remainingFraction: 0.58,
            unit: "percent",
          },
          status: "ok",
        },
        {
          id: "7d",
          label: "7-day",
          scope: { provider: "anthropic", windowId: "7d", shared: false },
          window: {
            id: "7d",
            label: "7-day",
            durationMs: 604_800_000,
            resetsAt: "2030-01-08T00:00:00.000Z",
          },
          amount: {
            used: 15,
            limit: 100,
            remaining: 85,
            usedFraction: 0.15,
            remainingFraction: 0.85,
            unit: "percent",
          },
          status: "ok",
        },
      ],
    },
    {
      provider: "openai",
      fetchedAt: "2030-01-01T00:00:00.000Z",
      limits: [
        {
          id: "5h",
          label: "5-hour",
          scope: { provider: "openai", windowId: "5h", shared: false },
          window: {
            id: "5h",
            label: "5-hour",
            durationMs: 18_000_000,
            resetsAt: "2030-01-01T05:00:00.000Z",
          },
          amount: {
            used: 71,
            limit: 100,
            remaining: 29,
            usedFraction: 0.71,
            remainingFraction: 0.29,
            unit: "percent",
          },
          status: "ok",
        },
        {
          id: "7d",
          label: "7-day",
          scope: { provider: "openai", windowId: "7d", shared: false },
          window: {
            id: "7d",
            label: "7-day",
            durationMs: 604_800_000,
            resetsAt: "2030-01-08T00:00:00.000Z",
          },
          amount: {
            used: 20,
            limit: 100,
            remaining: 80,
            usedFraction: 0.2,
            remainingFraction: 0.8,
            unit: "percent",
          },
          status: "ok",
        },
      ],
    },
  ],
});

const makeMockAgentWithUsageWrapper = Effect.fn("makeMockAgentWithUsageWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-usage-mock-",
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-omp",
    env: { T3_ACP_OMP_SHAPES: "1" },
    source: [
      RPC_UNSUPPORTED_SOURCE,
      'if (process.argv[2] === "--version") {',
      '  process.stdout.write("omp/18.0.6\\n");',
      "  process.exit(0);",
      "}",
      'if (process.argv[2] === "usage" && process.argv[3] === "--json") {',
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
      `  process.stdout.write(${JSON.stringify(ompUsageFixturePayload)});`,
      "  process.exit(0);",
      "}",
      execScriptSource({ scriptPath: mockAgentPath }),
    ].join("\n"),
  });
});

/**
 * Fake omp with a real RPC catalog: the startup command frame plus a
 * `get_available_models` response holding a 1,000,000-token reasoning model
 * and a 200,000-token non-reasoning one, shaped like omp/18.1.18.
 */
const makeRpcCatalogOmpWrapper = Effect.fn("makeRpcCatalogOmpWrapper")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-rpc-mock-",
  });
  // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame for a fake CLI.
  const commandFrame = JSON.stringify({
    type: "available_commands_update",
    commands: [
      { name: "compact", description: "Compact the context" },
      { name: "model", description: "Show current model selection" },
      { name: "skill:deploy", description: "Deploy the app" },
    ],
  });
  // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame for a fake CLI.
  const modelsResponse = JSON.stringify({
    type: "response",
    command: "get_available_models",
    data: {
      models: [
        {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          provider: "anthropic",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinking: {
            mode: "anthropic-adaptive",
            efforts: ["low", "medium", "high", "xhigh", "max"],
          },
        },
        {
          id: "claude-sonnet-3-5",
          name: "Claude Sonnet 3.5",
          provider: "anthropic",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
    },
  });
  return writeFakeCli({
    directory: dir,
    name: "fake-omp",
    source: [
      'if (process.argv[2] === "--version") {',
      '  process.stdout.write("omp/18.0.6\\n");',
      "  process.exit(0);",
      "}",
      'if (process.argv[2] === "--mode") {',
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
      `  process.stdout.write(${JSON.stringify(`${commandFrame}\n`)});`,
      "  const chunks = [];",
      "  for await (const chunk of process.stdin) chunks.push(chunk);",
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
      `  if (Buffer.concat(chunks).toString("utf8").includes("get_available_models")) {`,
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fake child-process stdout.
      `    process.stdout.write(${JSON.stringify(`${modelsResponse}\n`)});`,
      "  }",
      "  process.exit(0);",
      "}",
      '  process.stderr.write("unsupported\\n");',
      "process.exit(11);",
      "",
    ].join("\n"),
  });
});

const waitForFileContent = Effect.fn("waitForFileContent")(function* (
  filePath: string,
  attempts = 40,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const content = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.void));
    if (content !== undefined) {
      if (content.trim().length > 0) {
        return content;
      }
    }
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die(`Timed out waiting for file content at ${filePath}`);
});

const makeProviderStatusEnvFixture = Effect.fn("makeProviderStatusEnvFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "omp-provider-status-env-",
  });
  return {
    requestLogPath: path.join(tempDir, "requests.ndjson"),
    wrapperPath: yield* makeMockAgentWithVersionWrapper(),
  };
});

const makeExitLogFixture = Effect.fn("makeExitLogFixture")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix,
  });
  const exitLogPath = path.join(tempDir, "exit.log");
  return {
    exitLogPath,
    wrapperPath: yield* makeMockAgentWrapper({
      T3_ACP_EXIT_LOG_PATH: exitLogPath,
    }),
  };
});

const ompConfigOptions = [
  {
    type: "select",
    currentValue: "default",
    options: [
      { name: "Default", value: "default" },
      { name: "Plan", value: "plan" },
    ],
    category: "mode",
    id: "mode",
    name: "Mode",
  },
  {
    type: "select",
    currentValue: "zhipu-coding-plan/glm-5.3",
    options: [
      { name: "GLM 5.3", value: "zhipu-coding-plan/glm-5.3" },
      { name: "Claude Opus 4.6", value: "anthropic/claude-opus-4-6" },
      { name: "GPT-5.4", value: "openai/gpt-5.4" },
    ],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Off", value: "off" },
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    category: "thought_level",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const baseOmpSettings: OmpSettings = {
  enabled: true,
  binaryPath: "omp",
  customModels: [],
};
const missingOmpBinaryPath = "/definitely/not/installed/t3-omp";
const ompCliCommandMissingMessage = [
  `Oh My Pi CLI command \`${missingOmpBinaryPath}\` was not found.`,
  `Install or enable the omp CLI, make sure \`${missingOmpBinaryPath}\` is on PATH, then restart T3 Code.`,
  "See https://github.com/can1357/oh-my-pi.",
].join(" ");

describe("getOmpFallbackModels", () => {
  it("does not publish any built-in omp models before ACP discovery", () => {
    expect(
      getOmpFallbackModels({
        customModels: ["internal/omp-model"],
      }).map((model) => model.slug),
    ).toEqual(["internal/omp-model"]);
  });

  it("reports unknown capabilities for custom models the probe never validated", () => {
    expect(
      getOmpFallbackModels({
        customModels: ["internal/omp-model"],
      }).map((model) => model.capabilities),
    ).toEqual([null]);
  });
});

describe("buildOmpProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildOmpProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        ompSettings: baseOmpSettings,
        version: "18.0.6",
        discoveryWarning: "Oh My Pi ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Oh My Pi ACP model discovery timed out after 15000ms.",
      models: [],
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildOmpProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        ompSettings: {
          ...baseOmpSettings,
          customModels: ["internal/omp-model"],
        },
        version: "18.0.6",
        status: "error",
        message: "Oh My Pi CLI is installed but failed to run.",
        discoveryWarning: "Oh My Pi ACP model discovery failed.",
      }),
    ).toMatchObject({
      status: "error",
      message: "Oh My Pi CLI is installed but failed to run. Oh My Pi ACP model discovery failed.",
      models: [
        {
          slug: "internal/omp-model",
          isCustom: true,
        },
      ],
    });
  });

  it("publishes the context-window flag with auth and usage limits", () => {
    expect(
      buildOmpProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        ompSettings: baseOmpSettings,
        version: "18.0.6",
        auth: { status: "authenticated", type: "agent", label: "anthropic" },
        usageLimits: {
          checkedAt: "2026-01-01T00:00:00.000Z",
          windows: [{ id: "anthropic:5h", kind: "session", label: "5-hour", usedPercent: 42 }],
        },
      }),
    ).toMatchObject({
      reportsContextWindow: true,
      auth: { status: "authenticated", label: "anthropic" },
      usageLimits: {
        windows: [{ id: "anthropic:5h", usedPercent: 42 }],
      },
    });
  });

  it("defaults to unknown auth with no usage limits when the probe degraded", () => {
    const snapshot = buildOmpProviderSnapshot({
      checkedAt: "2026-01-01T00:00:00.000Z",
      ompSettings: baseOmpSettings,
      version: "18.0.6",
    });
    expect(snapshot.reportsContextWindow).toBe(true);
    expect(snapshot.auth).toEqual({ status: "unknown" });
    expect(snapshot.usageLimits).toBeUndefined();
  });

  it("names a custom model omp does not advertise instead of failing silently", () => {
    const snapshot = buildOmpProviderSnapshot({
      checkedAt: "2026-01-01T00:00:00.000Z",
      ompSettings: { ...baseOmpSettings, customModels: ["ghost/model"] },
      version: "18.0.6",
      discoveredModels: [
        {
          slug: "anthropic/claude-opus-4-6",
          name: "Claude Opus 4.6",
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    expect(snapshot.status).toBe("warning");
    expect(snapshot.message).toContain('"ghost/model"');
  });

  it("stays quiet when every custom model is advertised", () => {
    const snapshot = buildOmpProviderSnapshot({
      checkedAt: "2026-01-01T00:00:00.000Z",
      ompSettings: { ...baseOmpSettings, customModels: ["anthropic/claude-opus-4-6"] },
      version: "18.0.6",
      message: "1 upstream provider configured through Oh My Pi.",
      discoveredModels: [
        {
          slug: "anthropic/claude-opus-4-6",
          name: "Claude Opus 4.6",
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBe("1 upstream provider configured through Oh My Pi.");
  });

  it("cannot judge custom models without a discovered catalog", () => {
    const snapshot = buildOmpProviderSnapshot({
      checkedAt: "2026-01-01T00:00:00.000Z",
      ompSettings: { ...baseOmpSettings, customModels: ["ghost/model"] },
      version: "18.0.6",
    });
    expect(snapshot.status).toBe("ready");
    expect(snapshot.message).toBeUndefined();
  });

  it("reports unknown capabilities for custom models the probe never validated", () => {
    const snapshot = buildOmpProviderSnapshot({
      checkedAt: "2026-01-01T00:00:00.000Z",
      ompSettings: { ...baseOmpSettings, customModels: ["internal/omp-model"] },
      version: "18.0.6",
    });
    expect(snapshot.models.map((model) => model.capabilities)).toEqual([null]);
  });
});

describe("buildOmpCapabilitiesFromConfigOptions", () => {
  it("maps the omp thought_level select onto a reasoning effort descriptor", () => {
    expect(buildOmpCapabilitiesFromConfigOptions(ompConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Thinking", [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "max", label: "Max" },
          ]),
        ],
      }),
    );
  });

  it("exposes auto thinking levels on auto models", () => {
    expect(
      buildOmpCapabilitiesFromConfigOptions([
        {
          type: "select",
          currentValue: "auto",
          options: [
            { name: "Off", value: "off" },
            { name: "Auto", value: "auto" },
          ],
          category: "thought_level",
          id: "thinking",
          name: "Thinking",
        },
      ]),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Thinking", [
            { id: "off", label: "Off" },
            { id: "auto", label: "Auto", isDefault: true },
          ]),
        ],
      }),
    );
  });

  it("returns empty capabilities when no config options are advertised", () => {
    expect(buildOmpCapabilitiesFromConfigOptions([])).toEqual(
      createModelCapabilities({ optionDescriptors: [] }),
    );
    expect(buildOmpCapabilitiesFromConfigOptions(undefined)).toEqual(
      createModelCapabilities({ optionDescriptors: [] }),
    );
  });

  it("mirrors the full omp ladder including minimal and xhigh", () => {
    expect(
      buildOmpCapabilitiesFromConfigOptions([
        {
          type: "select",
          currentValue: "xhigh",
          options: [
            { name: "Off", value: "off" },
            { name: "Minimal", value: "minimal" },
            { name: "Low", value: "low" },
            { name: "Medium", value: "medium" },
            { name: "High", value: "high" },
            { name: "Extra High", value: "xhigh" },
            { name: "Max", value: "max" },
            { name: "Auto", value: "auto" },
          ],
          category: "thought_level",
          id: "thinking",
          name: "Thinking",
        },
      ]),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Thinking", [
            { id: "off", label: "Off" },
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High", isDefault: true },
            { id: "max", label: "Max" },
            { id: "auto", label: "Auto" },
          ]),
        ],
      }),
    );
  });

  it("dedupes aliased thinking values to one picker option", () => {
    expect(
      buildOmpCapabilitiesFromConfigOptions([
        {
          type: "select",
          currentValue: "off",
          options: [
            { name: "None", value: "none" },
            { name: "Off", value: "off" },
            { name: "Extra High", value: "extra-high" },
            { name: "XHigh", value: "xhigh" },
          ],
          category: "thought_level",
          id: "thinking",
          name: "Thinking",
        },
      ]),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Thinking", [
            { id: "off", label: "None", isDefault: true },
            { id: "xhigh", label: "Extra High" },
          ]),
        ],
      }),
    );
  });

  it("emits no descriptor for options omp never advertised", () => {
    // omp/18.1.18 `session/new` advertises exactly mode, model and thinking:
    // a `context_size` select or a `fast` toggle would be a control the
    // picker offers and omp rejects. Both shapes must stay unmapped even if
    // some other agent advertises them.
    expect(
      buildOmpCapabilitiesFromConfigOptions([
        {
          type: "select",
          currentValue: "1m",
          options: [
            { name: "272K", value: "272k" },
            { name: "1M", value: "1m" },
          ],
          category: "model_config",
          id: "context_size",
          name: "Context",
        },
        {
          type: "boolean",
          currentValue: true,
          category: "model_config",
          id: "fast",
          name: "Fast",
        },
      ]),
    ).toEqual(createModelCapabilities({ optionDescriptors: [] }));
    expect(
      resolveOmpAcpConfigUpdates(
        [
          {
            type: "select",
            currentValue: "1m",
            options: [{ name: "1M", value: "1m" }],
            category: "model_config",
            id: "context_size",
            name: "Context",
          },
        ],
        [
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      ),
    ).toEqual([]);
  });
});

describe("checkOmpProviderStatus", () => {
  effectIt.live("reports the install docs when the omp CLI command is missing", () =>
    Effect.gen(function* () {
      const provider = yield* node(
        checkOmpProviderStatus({
          enabled: true,
          binaryPath: missingOmpBinaryPath,
          customModels: [],
        }),
      );

      expect(provider).toMatchObject({
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        message: ompCliCommandMissingMessage,
      });
    }),
  );

  effectIt.live("falls back to the ACP catalog when the RPC probe answers no models", () =>
    Effect.gen(function* () {
      const { requestLogPath, wrapperPath } = yield* node(makeProviderStatusEnvFixture());

      const provider = yield* node(
        checkOmpProviderStatus(
          {
            enabled: true,
            binaryPath: wrapperPath,
            customModels: [],
          },
          {
            ...process.env,
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          },
        ),
      );

      expect(provider).toMatchObject({
        installed: true,
        version: "18.0.6",
        status: "ready",
        message: "3 upstream providers configured through Oh My Pi.",
      });
      expect(provider.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-opus-4-6",
        "zhipu-coding-plan/glm-5.3",
        "openai/gpt-5.4",
      ]);
      expect(provider.models.map((model) => model.subProvider)).toEqual([
        "Anthropic",
        "Zhipu Coding Plan",
        "Openai",
      ]);
      const requestLog = yield* node(waitForFileContent(requestLogPath));
      expect(requestLog).toContain("initialize");
    }),
  );
  effectIt.live("reports authenticated usage limits from omp usage --json", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* node(makeMockAgentWithUsageWrapper());

      const provider = yield* node(
        checkOmpProviderStatus({
          enabled: true,
          binaryPath: wrapperPath,
          customModels: [],
        }),
      );

      expect(provider).toMatchObject({
        installed: true,
        version: "18.0.6",
        status: "ready",
        reportsContextWindow: true,
        auth: {
          status: "authenticated",
          type: "agent",
          label: "2 providers: anthropic, openai",
        },
      });
      expect(provider.usageLimits?.windows.map((window) => window.id)).toEqual([
        "anthropic:5h",
        "openai:5h",
        "anthropic:7d",
        "openai:7d",
      ]);
      expect(provider.usageLimits?.windows.map((window) => window.usedPercent)).toEqual([
        42, 71, 15, 20,
      ]);
    }),
  );

  effectIt.live("sources each model's own context window and ladder from omp", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* node(makeRpcCatalogOmpWrapper());

      const provider = yield* node(
        checkOmpProviderStatus({
          enabled: true,
          binaryPath: wrapperPath,
          // The duplicate is what a user carries from before omp advertised
          // the slug; it must not produce a second picker entry.
          customModels: ["anthropic/claude-sonnet-5", "ghost/model"],
        }),
      );

      expect(provider.models.map((model) => model.slug)).toEqual([
        "anthropic/claude-sonnet-3-5",
        "anthropic/claude-sonnet-5",
        "ghost/model",
      ]);
      expect(provider.models.filter((model) => model.slug === "anthropic/claude-sonnet-5")).toEqual(
        [
          {
            slug: "anthropic/claude-sonnet-5",
            name: "Claude Sonnet 5",
            subProvider: "Anthropic",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("reasoning", "Thinking", [
                  { id: "off", label: "Off" },
                  { id: "auto", label: "Auto" },
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                  { id: "max", label: "Max" },
                ]),
              ],
            }),
          },
        ],
      );
      // The 200,000-window sibling is non-reasoning: no ladder, and its own
      // window is the one the meter must divide by, not the 1,000,000 above.
      expect(
        provider.models.find((model) => model.slug === "anthropic/claude-sonnet-3-5")?.capabilities,
      ).toEqual(createModelCapabilities({ optionDescriptors: [] }));
    }),
  );

  effectIt.live("publishes omp's own commands and skills at machine level", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* node(makeRpcCatalogOmpWrapper());

      const provider = yield* node(
        checkOmpProviderStatus({
          enabled: true,
          binaryPath: wrapperPath,
          customModels: [],
        }),
      );

      // The Compact affordance reads the base snapshot, not a workspace one.
      expect(provider.slashCommands.map((command) => command.name)).toEqual(["compact", "model"]);
      expect(provider.skills.map((skill) => skill.name)).toEqual(["deploy"]);
    }),
  );
});

describe("discoverOmpModelsViaAcp", () => {
  effectIt.live("builds the model catalog from the ACP model config option", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* node(makeMockAgentWrapper());

      const models = yield* node(
        discoverOmpModelsViaAcp({
          enabled: true,
          binaryPath: wrapperPath,
          customModels: [],
        }).pipe(Effect.scoped),
      );

      expect(models.map((model) => model.slug)).toEqual([
        "anthropic/claude-opus-4-6",
        "zhipu-coding-plan/glm-5.3",
        "openai/gpt-5.4",
      ]);
      expect(models[0]).toMatchObject({
        name: "Claude Opus 4.6",
        subProvider: "Anthropic",
        isCustom: false,
      });
    }),
  );

  effectIt.live("marks only the probe-validated model capable", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* node(makeMockAgentWrapper());

      const models = yield* node(
        discoverOmpModelsViaAcp({
          enabled: true,
          binaryPath: wrapperPath,
          customModels: [],
        }).pipe(Effect.scoped),
      );

      // The mock probe session sits on zhipu-coding-plan/glm-5.3, so only that
      // entry may carry the probed reasoning options; the rest stay unknown.
      const bySlug = new Map(models.map((model) => [model.slug, model]));
      expect(bySlug.get("anthropic/claude-opus-4-6")?.capabilities).toBeNull();
      expect(bySlug.get("openai/gpt-5.4")?.capabilities).toBeNull();
      const probed = bySlug.get("zhipu-coding-plan/glm-5.3")?.capabilities;
      expect(probed).toEqual(
        createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoning", "Thinking", [
              { id: "off", label: "Off" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ]),
          ],
        }),
      );
    }),
  );

  // Stopping the probe kills the agent with SIGTERM; Windows terminates the
  // process instead, so the mock never sees a signal to log.
  effectIt.live.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "closes the ACP probe runtime after discovery completes",
    () =>
      Effect.gen(function* () {
        const { exitLogPath, wrapperPath } = yield* node(
          makeExitLogFixture("omp-provider-exit-log-"),
        );

        yield* node(
          discoverOmpModelsViaAcp({
            enabled: true,
            binaryPath: wrapperPath,
            customModels: [],
          }),
        );

        const exitLog = yield* node(waitForFileContent(exitLogPath));
        expect(exitLog).toContain("SIGTERM");
      }),
  );
});

describe("resolveOmpAcpConfigUpdates", () => {
  it("maps reasoning selections onto the omp thinking config option", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "max" }]),
    ).toEqual([{ configId: "thinking", value: "max" }]);
  });

  it("maps reasoning off so the adapter can clear a prior thinking selection", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "off" }]),
    ).toEqual([{ configId: "thinking", value: "off" }]);
  });

  it("maps reasoning auto onto the omp thinking config option", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "auto" }]),
    ).toEqual([]);
    expect(
      resolveOmpAcpConfigUpdates(
        [
          {
            type: "select",
            currentValue: "off",
            options: [
              { name: "Off", value: "off" },
              { name: "Auto", value: "auto" },
            ],
            category: "thought_level",
            id: "thinking",
            name: "Thinking",
          },
        ],
        [{ id: "reasoning", value: "auto" }],
      ),
    ).toEqual([{ configId: "thinking", value: "auto" }]);
  });

  it("writes minimal and xhigh back to their advertised raw values", () => {
    const ladder = [
      {
        type: "select",
        currentValue: "off",
        options: [
          { name: "Off", value: "off" },
          { name: "Minimal", value: "minimal" },
          { name: "Low", value: "low" },
          { name: "Medium", value: "medium" },
          { name: "High", value: "high" },
          { name: "Extra High", value: "extra-high" },
          { name: "Max", value: "max" },
          { name: "Auto", value: "auto" },
        ],
        category: "thought_level",
        id: "thinking",
        name: "Thinking",
      },
    ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
    expect(resolveOmpAcpConfigUpdates(ladder, [{ id: "reasoning", value: "minimal" }])).toEqual([
      { configId: "thinking", value: "minimal" },
    ]);
    expect(resolveOmpAcpConfigUpdates(ladder, [{ id: "reasoning", value: "xhigh" }])).toEqual([
      { configId: "thinking", value: "extra-high" },
    ]);
  });

  it("ignores unknown reasoning values and empty selections", () => {
    expect(
      resolveOmpAcpConfigUpdates(ompConfigOptions, [{ id: "reasoning", value: "ludicrous" }]),
    ).toEqual([]);
    expect(resolveOmpAcpConfigUpdates(ompConfigOptions, undefined)).toEqual([]);
    expect(resolveOmpAcpConfigUpdates([], [{ id: "reasoning", value: "max" }])).toEqual([]);
  });
});
