import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { SDKModel } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { CursorSettings, ServerProviderModel } from "@t3tools/contracts";

import {
  buildCursorProviderSnapshot,
  buildCursorCapabilitiesFromConfigOptions,
  buildCursorCapabilitiesFromSdkModel,
  buildCursorDiscoveredModelsFromSdk,
  checkCursorProviderStatus,
  discoverCursorModelsViaAcp,
  getCursorFallbackModels,
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "./CursorProvider.ts";
import { CursorSdkCatalogError, makeCursorSdkCatalogTestLayer } from "./CursorSdkCatalog.ts";

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

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-mock-",
  });
  const wrapperPath = path.join(dir, "fake-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify("bun")} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await writeFile(wrapperPath, script, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function waitForFileContent(filePath: string, attempts = 40): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const content = await readFile(filePath, "utf8");
      if (content.trim().length > 0) {
        return content;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

const parameterizedGpt54ConfigOptions = [
  {
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ name: "GPT-5.4", value: "gpt-5.4-medium-fast" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "medium",
    options: [
      { name: "None", value: "none" },
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Extra High", value: "extra-high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "272k",
    options: [
      { name: "272K", value: "272k" },
      { name: "1M", value: "1m" },
    ],
    category: "model_config",
    id: "context",
    name: "Context",
  },
  {
    type: "select",
    currentValue: "false",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeConfigOptions = [
  {
    type: "select",
    currentValue: "claude-4.6-opus-high-thinking",
    options: [{ name: "Opus 4.6", value: "claude-4.6-opus-high-thinking" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "boolean",
    currentValue: true,
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeModelOptionConfigOptions = [
  {
    type: "select",
    currentValue: "claude-opus-4-6",
    options: [{ name: "Opus 4.6", value: "claude-opus-4-6" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "max",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    category: "model_option",
    id: "effort",
    name: "Effort",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: ":icon-brain:", value: "true" },
    ],
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const sessionNewCursorConfigOptions = [
  {
    type: "select",
    currentValue: "agent",
    options: [
      { name: "Agent", value: "agent", description: "Full agent capabilities with tool access" },
    ],
    category: "mode",
    id: "mode",
    name: "Mode",
    description: "Controls how the agent executes tasks",
  },
  {
    type: "select",
    currentValue: "composer-2",
    options: [
      { name: "Auto", value: "default" },
      { name: "Composer 2", value: "composer-2" },
      { name: "GPT-5.4", value: "gpt-5.4" },
      { name: "Sonnet 4.6", value: "claude-sonnet-4-6" },
      { name: "Opus 4.6", value: "claude-opus-4-6" },
      { name: "Codex 5.3 Spark", value: "gpt-5.3-codex-spark" },
    ],
    category: "model",
    id: "model",
    name: "Model",
    description: "Controls which model is used for responses",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
    description: "Faster speeds.",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const baseCursorSettings: CursorSettings = {
  enabled: true,
  binaryPath: "agent",
  apiEndpoint: "",
  customModels: [],
};
const cursorAcpDiscoveryFailedMessage = [
  "Cursor ACP model discovery failed.",
  "Cursor CLI setup may be incomplete; install or enable the Cursor CLI, restart T3 Code, and try again.",
  "See https://cursor.com/docs/cli/installation.",
  "Check server logs for ACP details.",
].join(" ");
const missingCursorBinaryPath = "/definitely/not/installed/t3-cursor-agent";

const sdkParameterizedModel = {
  id: "claude-opus-4-8",
  displayName: "Opus 4.8",
  parameters: [
    {
      id: "thinking",
      displayName: "Thinking",
      values: [{ value: "false" }, { value: "true" }],
    },
    {
      id: "context",
      displayName: "Context",
      values: [
        { value: "300k", displayName: "300K" },
        { value: "1m", displayName: "1M" },
      ],
    },
    {
      id: "effort",
      displayName: "Effort",
      values: [
        { value: "low", displayName: "Low" },
        { value: "high", displayName: "High" },
      ],
    },
    {
      id: "fast",
      displayName: "Fast",
      values: [{ value: "false" }, { value: "true", displayName: "Fast" }],
    },
  ],
  variants: [
    {
      displayName: "Opus 4.8",
      isDefault: true,
      params: [
        { id: "thinking", value: "true" },
        { id: "context", value: "1m" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
      ],
    },
  ],
} satisfies SDKModel;

describe("getCursorFallbackModels", () => {
  it("does not publish any built-in cursor models before ACP discovery", () => {
    expect(
      getCursorFallbackModels({
        customModels: ["internal/cursor-model"],
      }).map((model) => model.slug),
    ).toEqual(["internal/cursor-model"]);
  });
});

describe("buildCursorProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "ready",
          auth: { status: "authenticated", type: "Team", label: "Cursor Team Subscription" },
        },
        discoveryWarning: "Cursor ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor ACP model discovery timed out after 15000ms.",
      models: [],
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: {
          ...baseCursorSettings,
          customModels: ["claude-sonnet-4-6"],
        },
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
        },
        discoveryWarning: "Cursor ACP model discovery failed. Check server logs for details.",
      }),
    ).toMatchObject({
      status: "error",
      message:
        "Cursor Agent is not authenticated. Run `agent login` and try again. Cursor ACP model discovery failed. Check server logs for details.",
      models: [
        {
          slug: "claude-sonnet-4-6",
          isCustom: true,
        },
      ],
    });
  });
});

describe("buildCursorCapabilitiesFromConfigOptions", () => {
  it("derives model capabilities from parameterized Cursor ACP config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedGpt54ConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "272k", label: "272K", isDefault: true },
            { id: "1m", label: "1M" },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
        ],
      }),
    );
  });

  it("detects boolean thinking toggles from model_config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ]),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("prefers the newer model_option effort control over legacy thought_level", () => {
    expect(
      buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeModelOptionConfigOptions),
    ).toEqual({
      reasoningEffortLevels: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "max", label: "Max", isDefault: true },
      ],
      supportsFastMode: true,
      supportsThinkingToggle: true,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    });
  });
});

describe("Cursor SDK model discovery", () => {
  it("maps native SDK parameter ids and default variant values to model capabilities", () => {
    expect(buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("effort", "Effort", [
            { id: "low", label: "Low" },
            { id: "high", label: "High", isDefault: true },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "300k", label: "300K" },
            { id: "1m", label: "1M", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("filters invalid and duplicate SDK model entries", () => {
    expect(
      buildCursorDiscoveredModelsFromSdk([
        sdkParameterizedModel,
        { ...sdkParameterizedModel, displayName: "Duplicate" },
        { id: "", displayName: "Invalid" },
      ]),
    ).toEqual([
      {
        slug: "claude-opus-4-8",
        name: "Opus 4.8",
        isCustom: false,
        capabilities: buildCursorCapabilitiesFromSdkModel(sdkParameterizedModel),
      },
    ]);
  });
});

describe("checkCursorProviderStatus", () => {
  it("uses the SDK catalog when CURSOR_API_KEY is configured", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus(
        {
          ...baseCursorSettings,
          binaryPath: "cursor-cli-must-not-be-invoked",
          customModels: ["internal/cursor-model"],
        },
        { CURSOR_API_KEY: "test-cursor-key" },
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeCursorSdkCatalogTestLayer((apiKey) => {
              expect(apiKey).toBe("test-cursor-key");
              return Effect.succeed({
                user: {
                  apiKeyName: "test-key",
                  userEmail: "cursor@example.com",
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
                models: [sdkParameterizedModel],
              });
            }),
            NodeServices.layer,
          ),
        ),
      ),
    );

    expect(provider).toMatchObject({
      status: "ready",
      auth: {
        status: "authenticated",
        type: "api-key",
        label: "Cursor API key (test-key)",
        email: "cursor@example.com",
      },
      models: [
        { slug: "claude-opus-4-8", isCustom: false },
        { slug: "internal/cursor-model", isCustom: true },
      ],
    });
  });

  it("surfaces SDK authentication failures without invoking the CLI", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus(baseCursorSettings, {
        CURSOR_API_KEY: "invalid-test-key",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeCursorSdkCatalogTestLayer(() =>
              Effect.fail(
                new CursorSdkCatalogError({
                  authenticationFailure: true,
                  cause: new Error("unauthorized"),
                }),
              ),
            ),
            NodeServices.layer,
          ),
        ),
      ),
    );

    expect(provider).toMatchObject({
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor SDK authentication failed. Check CURSOR_API_KEY.",
    });
  });

  it("requires a Cursor API key without probing the legacy CLI fallback", async () => {
    const provider = await Effect.runPromise(
      checkCursorProviderStatus({
        enabled: true,
        binaryPath: missingCursorBinaryPath,
        apiEndpoint: "",
        customModels: [],
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeCursorSdkCatalogTestLayer(() =>
              Effect.die("SDK catalog must not be used without CURSOR_API_KEY"),
            ),
            NodeServices.layer,
          ),
        ),
      ),
    );

    expect(provider).toMatchObject({
      installed: true,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
    });
  });
});

describe("discoverCursorModelsViaAcp", () => {
  it.effect("passes the injected environment to ACP model discovery", () =>
    Effect.gen(function* () {
      const { requestLogPath, wrapperPath } = yield* makeProviderStatusEnvFixture();
      const models = yield* discoverCursorModelsViaAcp(
        {
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        },
        {
          ...process.env,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      );

      expect(models.map((model) => model.slug)).toEqual([
        "default",
        "composer-2",
        "gpt-5.4",
        "claude-opus-4-6",
      ]);
      yield* waitForFileContent(requestLogPath).pipe(
        Effect.tap((content) => Effect.sync(() => expect(content).toContain("initialize"))),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the ACP probe runtime alive long enough to discover models", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* makeMockAgentWrapper();
      const models = yield* discoverCursorModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        apiEndpoint: "",
        customModels: [],
      });

      expect(models.map((model) => model.slug)).toEqual([
        "default",
        "composer-2",
        "gpt-5.4",
        "claude-opus-4-6",
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("closes the ACP probe runtime after discovery completes", () =>
    Effect.gen(function* () {
      const { exitLogPath, wrapperPath } = yield* makeExitLogFixture("cursor-provider-exit-log-");

      yield* discoverCursorModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        apiEndpoint: "",
        customModels: [],
      });

      const exitLog = yield* waitForFileContent(exitLogPath);
      expect(exitLog).toContain("SIGTERM");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("discoverCursorModelCapabilitiesViaAcp", () => {
  it("closes all ACP probe runtimes after capability enrichment completes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cursor-capabilities-exit-log-"));
    const exitLogPath = path.join(tempDir, "exit.log");
    const wrapperPath = await makeMockAgentWrapper({
      T3_ACP_EXIT_LOG_PATH: exitLogPath,
    });
    const existingModels: ReadonlyArray<ServerProviderModel> = [
      { slug: "default", name: "Auto", isCustom: false, capabilities: emptyCapabilities },
      { slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: emptyCapabilities },
      { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: emptyCapabilities },
      {
        slug: "claude-opus-4-6",
        name: "Opus 4.6",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
    ];

    const models = await Effect.runPromise(
      discoverCursorModelCapabilitiesViaAcp(
        {
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        },
        existingModels,
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "composer-2",
      "gpt-5.4",
      "claude-opus-4-6",
    ]);

    const exitLog = await waitForFileContent(exitLogPath);
    expect(exitLog.match(/SIGTERM/g)?.length ?? 0).toBe(4);
  });
});

describe("parseCursorAboutOutput", () => {
  it("parses json about output and forwards subscription metadata", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "jmarminge@gmail.com",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "jmarminge@gmail.com",
        type: "Team",
        label: "Cursor Team Subscription",
      },
    });
  });

  it("treats json about output with a logged-out email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "Not logged in",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });

  it("treats json about output with a null email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: null,
          userEmail: null,
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });
});

describe("Cursor parameterized model picker preview gating", () => {
  it("parses Cursor CLI version dates from build versions", () => {
    expect(parseCursorVersionDate("2026.04.08-c4e73a3")).toBe(20260408);
    expect(parseCursorVersionDate("2026.04.09")).toBe(20260409);
    expect(parseCursorVersionDate("not-a-version")).toBeUndefined();
  });

  it("parses the Cursor CLI channel from cli-config.json", () => {
    expect(parseCursorCliConfigChannel('{ "channel": "lab" }')).toBe("lab");
    expect(parseCursorCliConfigChannel('{ "channel": "stable" }')).toBe("stable");
    expect(parseCursorCliConfigChannel('{ "version": 1 }')).toBeUndefined();
    expect(parseCursorCliConfigChannel("not-json")).toBeUndefined();
  });

  it("returns no warning when the preview requirements are met", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "lab",
      }),
    ).toBeUndefined();
  });

  it("explains when the Cursor Agent version is too old", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.07-c4e73a3",
        channel: "lab",
      }),
    ).toContain("too old");
  });

  it("explains when the Cursor Agent channel is not lab", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "stable",
      }),
    ).toContain("lab channel");
  });
});

describe("resolveCursorAcpBaseModelId", () => {
  it("drops bracket traits without rewriting raw ACP model ids", () => {
    expect(resolveCursorAcpBaseModelId("gpt-5.4[reasoning=medium,context=272k]")).toBe("gpt-5.4");
    expect(resolveCursorAcpBaseModelId("gpt-5.4-medium-fast")).toBe("gpt-5.4-medium-fast");
    expect(resolveCursorAcpBaseModelId("claude-4.6-opus-high-thinking")).toBe(
      "claude-4.6-opus-high-thinking",
    );
    expect(resolveCursorAcpBaseModelId("composer-2")).toBe("composer-2");
    expect(resolveCursorAcpBaseModelId("auto")).toBe("auto");
  });
});

describe("resolveCursorAcpConfigUpdates", () => {
  it("maps Cursor model options onto separate ACP config option updates", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "reasoning", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toEqual([
      { configId: "reasoning", value: "extra-high" },
      { configId: "context", value: "1m" },
      { configId: "fast", value: "true" },
    ]);
  });

  it("maps boolean thinking toggles when the model exposes them separately", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeConfigOptions, [
        { id: "thinking", value: false },
      ]),
    ).toEqual([{ configId: "thinking", value: false }]);
  });

  it("maps explicit fastMode: false so the adapter can clear a prior fast selection", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "fastMode", value: false },
      ]),
    ).toEqual([{ configId: "fast", value: "false" }]);
  });

  it("writes Cursor effort changes through the newer model_option config when available", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeModelOptionConfigOptions, {
        reasoning: "max",
        thinking: false,
      }),
    ).toEqual([
      { configId: "effort", value: "max" },
      { configId: "thinking", value: "false" },
    ]);
  });
});
