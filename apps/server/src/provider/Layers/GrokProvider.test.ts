// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokModelCapabilities,
  buildGrokModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  parseGrokModelsCliOutput,
} from "./GrokProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

const LOGGED_OUT_MODELS_OUTPUT = LOGGED_IN_MODELS_OUTPUT.replace(
  "You are logged in with grok.com.",
  "You are not authenticated.",
);

describe("parseGrokModelsCliOutput", () => {
  it("reads login state and model slugs, marking the default", () => {
    const parsed = parseGrokModelsCliOutput(LOGGED_IN_MODELS_OUTPUT);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["grok-4.6", true],
      ["grok-4.5", false],
    ]);
  });

  it("detects a logged-out CLI even though it exits 0", () => {
    expect(parseGrokModelsCliOutput(LOGGED_OUT_MODELS_OUTPUT).authenticated).toBe(false);
  });

  it("returns unknown auth for unrecognized output", () => {
    expect(parseGrokModelsCliOutput("grok 9.9.9\n").authenticated).toBeNull();
  });
});

describe("buildGrokModelsFromSessionModelState", () => {
  it("marks the agent's current model as default and keeps reasoning options", () => {
    const models = buildGrokModelsFromSessionModelState({
      currentModelId: "grok-4.6",
      availableModels: [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: "high",
            reasoningEfforts: [{ value: "high", label: "High", default: true }],
          },
        },
        { modelId: "grok-4.5", name: "Grok 4.5" },
      ],
    });
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["grok-4.6", true],
      ["grok-4.5", false],
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toHaveLength(1);
  });
});

describe("buildGrokModelCapabilities", () => {
  it("preserves ACP-provided reasoning labels and the active default", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort" },
          { value: "low", label: "Low Effort" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "Extra High Effort", isDefault: true },
          { id: "high", label: "High Effort" },
          { id: "medium", label: "Medium Effort" },
          { id: "low", label: "Low Effort" },
        ],
      },
    ]);
  });

  it("uses raw ACP values when option labels are omitted", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [{ value: "xhigh" }, { value: "medium" }],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "xhigh" },
          { id: "medium", label: "medium" },
        ],
      },
    ]);
  });

  it("keeps ACP current effort separate from its collapsed advertised default", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "medium",
        reasoningEfforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "xhigh", label: "Extra High Effort", isDefault: true },
          { id: "high", label: "High Effort" },
          { id: "medium", label: "Medium Effort" },
        ],
      },
    ]);
  });

  it("preserves ACP descriptions and falls back from invalid values to valid ids", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          {
            id: "high",
            value: "not a token",
            label: "High Effort",
            description: "Higher implementation quality",
            default: true,
          },
          { id: "bad id", value: "also invalid", label: "Invalid" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          {
            id: "high",
            label: "High Effort",
            description: "Higher implementation quality",
            isDefault: true,
          },
        ],
      },
    ]);
  });

  it("accepts an advertised ACP menu when the support flag is omitted", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [{ value: "high", label: "High Effort", default: true }],
      },
    });

    expect(capabilities.optionDescriptors).toHaveLength(1);
  });

  it("honors an explicit ACP opt-out even when a menu is present", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: false,
        reasoningEfforts: [{ value: "high", label: "High Effort", default: true }],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([]);
  });

  it("does not synthesize a reasoning menu when ACP omits it", () => {
    expect(
      buildGrokModelCapabilities({
        modelId: "grok-4.6",
        name: "Grok 4.6",
        _meta: { supportsReasoningEffort: true, reasoningEffort: "xhigh" },
      }).optionDescriptors,
    ).toEqual([]);
  });

  it("keeps non-reasoning Grok models free of reasoning controls", () => {
    expect(
      buildGrokModelCapabilities({ modelId: "grok-build", name: "Grok Build" }).optionDescriptors,
    ).toEqual([]);
  });
});

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Grok is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBeUndefined();
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = writeFakeCli({
            directory: dir,
            name: "grok",
            source: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              `process.stderr.write(${JSON.stringify(`${secretStderr}\n`)});`,
              "process.exit(2);",
              "",
            ].join("\n"),
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  // A stand-in for the Grok CLI: `--version` and `models` print canned text,
  // and `agent stdio` execs the mock ACP agent so `initialize` returns model metadata.
  const writeFakeGrokCli = (input: { readonly modelsOutput: string; readonly acp: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-probe-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
      return writeFakeCli({
        directory: dir,
        name: "grok",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("grok 1.0.13\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "models") {',
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          `  process.stdout.write(${JSON.stringify(input.modelsOutput)});`,
          "  process.exit(0);",
          "}",
          'if (process.argv[2] !== "agent") process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
    });

  it.effect("reports ready with ACP-discovered models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_IN_MODELS_OUTPUT,
            acp: true,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.0.13");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Grok account",
      });
      // The mock agent advertises grok-4.6 with reasoning options in initialize._meta.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(
        snapshot.models[0]?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
      ).toEqual(["reasoningEffort"]);
    }),
  );

  it.effect("reports unauthenticated from `grok models` without starting a session", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_OUT_MODELS_OUTPUT,
            acp: true,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("grok login");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);
    }),
  );

  it.effect("falls back to CLI-listed models with a warning when ACP initialize fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_IN_MODELS_OUTPUT,
            acp: false,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["grok-4.6", true],
        ["grok-4.5", false],
      ]);
      expect(snapshot.message).toContain("ACP initialize failed");
    }),
  );

  it.effect("treats XAI_API_KEY as authenticated regardless of CLI login state", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_OUT_MODELS_OUTPUT,
            acp: false,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "xai-test-key" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "xAI API key",
      });
      expect(snapshot.status).toBe("warning");
    }),
  );
});
