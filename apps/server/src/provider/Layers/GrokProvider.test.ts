// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokModelCapabilities,
  buildGrokModelsFromSessionModelState,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "./GrokProvider.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { grokUsageResponseToLimits, readGrokAccount } from "./grokUsageLimits.ts";

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

describe("grokSlashCommandsFromInitialize", () => {
  it("publishes native ACP commands and input hints without permission overrides", () => {
    const commands = grokSlashCommandsFromInitialize({
      protocolVersion: 1,
      _meta: {
        availableCommands: [
          { name: "compact", description: "Compress history", input: { hint: "what to preserve" } },
          {
            name: "always-approve",
            description: "Skip permission prompts",
            input: { hint: "on|off" },
          },
          { name: "context", description: "Show context usage", input: null },
          { name: "session-info", description: "Show session details" },
          { name: "deep-research", description: "Research a topic", input: { hint: "<query>" } },
          { name: "workflow", description: "Manage workflows", input: { hint: "runs" } },
          { name: "goal", description: "Manage an autonomous goal", input: { hint: "status" } },
        ],
      },
    });
    expect(commands.map((command) => command.name)).toEqual([
      "compact",
      "session-info",
      "deep-research",
      "workflow",
      "goal",
    ]);
    expect(commands[0]?.input).toEqual({ hint: "what to preserve" });
    expect(commands[2]).toEqual({
      name: "deep-research",
      description: "Research a topic",
      input: { hint: "<query>" },
    });
  });

  it("keeps valid commands when other metadata entries are malformed", () => {
    const commands = grokSlashCommandsFromInitialize({
      protocolVersion: 1,
      _meta: {
        availableCommands: [
          null,
          { name: "broken", description: 42 },
          { name: " ", description: "Empty name" },
          { name: " session-info ", description: " Session details " },
          { name: "session-info", description: "Updated session details" },
        ],
      },
    });
    expect(commands.map((command) => command.name)).toEqual(["compact", "session-info"]);
    expect(commands[1]?.description).toBe("Updated session details");
  });

  it("keeps compact available for older agents without command metadata", () => {
    for (const _meta of [undefined, {}, { availableCommands: "invalid" }]) {
      expect(
        grokSlashCommandsFromInitialize({ protocolVersion: 1, ...(_meta ? { _meta } : {}) }).map(
          (command) => command.name,
        ),
      ).toEqual(["compact"]);
    }
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
      expect(snapshot.supportsConversationRollback).toBe(false);
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
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
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

describe("Grok usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the reported subscription percentage and weekly reset", () => {
    const limits = grokUsageResponseToLimits(
      {
        config: {
          creditUsagePercent: 100,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            end: "2026-09-18T03:10:30.159171+00:00",
          },
        },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      {
        id: "subscription",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        resetsAt: "2026-09-18T03:10:30.159Z",
      },
    ]);
  });

  it("does not invent allowance or reset dates when billing omits them", () => {
    for (const response of [{}, { config: {} }, { config: { creditUsagePercent: NaN } }]) {
      const limits = grokUsageResponseToLimits(response, checkedAt);
      expect(limits.windows).toEqual([]);
      // Nothing metered yet, which xAI reports by omitting the field until
      // usage registers. Marking it `unsupported` would drop the account from
      // the Limits view for good; leaving the marker off keeps it listed.
      expect(limits.unavailable).toBeUndefined();
    }
    expect(
      grokUsageResponseToLimits({ config: { creditUsagePercent: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "subscription", kind: "other", label: "Subscription", usedPercent: 0 }]);
    expect(
      grokUsageResponseToLimits(
        {
          config: {
            creditUsagePercent: 120,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" },
          },
        },
        checkedAt,
      ).windows,
    ).toEqual([{ id: "subscription", kind: "monthly", label: "Monthly", usedPercent: 100 }]);
  });
});

it.layer(NodeServices.layer)("readGrokAccount", (it) => {
  it.effect("reads the configured Grok home and prefers the current login scope to legacy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        NodePath.join(directory, "auth.json"),
        '{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"session-token","auth_mode":"oauth"},"https://accounts.x.ai/sign-in":{"key":"legacy-token"}}',
      );
      const { usageLimits: limits } = yield* readGrokAccount({
        GROK_HOME: directory,
        HOME: "/unrelated-home",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.method).toBe("GET");
            expect(request.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
            expect(request.headers.authorization).toBe("Bearer session-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ config: { creditUsagePercent: 37 } }),
              ),
            );
          }),
        ),
      );
      expect(limits.windows[0]?.usedPercent).toBe(37);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "uses GROK_AUTH without reading stored credentials and accepts the legacy login scope",
    () =>
      readGrokAccount({
        GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"legacy-token"}}',
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: (path) =>
              path.endsWith("auth.json")
                ? Effect.die("must not read stored credentials")
                : Effect.succeed(""),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.headers.authorization).toBe("Bearer legacy-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ config: { creditUsagePercent: 12 } }),
              ),
            );
          }),
        ),
        Effect.tap(({ usageLimits }) =>
          Effect.sync(() => expect(usageLimits.windows[0]?.usedPercent).toBe(12)),
        ),
      ),
  );

  it.effect("does not use unrelated scopes, API keys, or custom auth deployments", () =>
    Effect.gen(function* () {
      for (const environment of [
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          XAI_API_KEY: "different-api-account",
        },
        { GROK_AUTH: '{"https://other.example":{"key":"unrelated-token"}}' },
        { GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"api-key","auth_mode":"api_key"}}' },
        { GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":" "}}' },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"session-token"}}',
          GROK_OIDC_ISSUER: "https://custom.example",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          GROK_MODELS_BASE_URL: "https://custom.example/v1",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          GROK_OAUTH2_PRINCIPAL_TYPE: "Team",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-account"}}',
          GROK_OAUTH2_PRINCIPAL_ID: "team-id",
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"session-token"}}',
          GROK_CONFIG: '{"auth_provider_command":"custom-auth"}',
        },
        {
          GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"session-token"}}',
          GROK_CONFIG_PATH: "/custom-config.toml",
        },
      ]) {
        const { usageLimits: limits } = yield* readGrokAccount({
          HOME: "/definitely/not/a/grok-home",
          ...environment,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not request another account's quota")),
          ),
        );
        expect(limits.windows).toEqual([]);
        expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }),
  );

  it.effect(
    "reports a missing login as unsupported and malformed credentials as a sanitized failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const client = HttpClient.make(() => Effect.die("must not request without credentials"));
        const { usageLimits: missing } = yield* readGrokAccount({ HOME: directory }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(missing.unavailable?.reason).toBe("unsupported");
        for (const contents of [
          "private-token-invalid-json",
          '{"https://accounts.x.ai/sign-in":{"key":42}}',
        ]) {
          const { usageLimits: malformed } = yield* readGrokAccount({
            GROK_HOME: directory,
            GROK_AUTH: contents,
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));
          expect(malformed.unavailable).toEqual({
            reason: "probeFailed",
            message: "Grok could not read usage limits.",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    "does not request subscription limits for custom account or endpoint configuration",
    () =>
      Effect.gen(function* () {
        for (const config of [
          '[auth]\nprovider_command = "custom-auth"',
          '[grok_com_config]\nissuer = "https://custom.example"',
          'endpoints.proxy = "https://custom.example"',
        ]) {
          const { usageLimits: limits } = yield* readGrokAccount({
            GROK_AUTH: '{"https://accounts.x.ai/sign-in":{"key":"stored-token"}}',
          }).pipe(
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                readFileString: (path) => {
                  expect(path.endsWith("config.toml")).toBe(true);
                  return Effect.succeed(config);
                },
              }),
            ),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die("must not request another account's quota")),
            ),
          );
          expect(limits.windows).toEqual([]);
          expect(limits.unavailable?.reason).toBe("unsupported");
        }
      }),
  );

  it.effect("sanitizes HTTP failures and malformed billing responses, keeping the account", () =>
    Effect.gen(function* () {
      for (const response of [
        new Response("private response", { status: 401 }),
        Response.json({ config: { creditUsagePercent: "private-value" } }),
      ]) {
        const { email, usageLimits: limits } = yield* readGrokAccount({
          HOME: "/definitely/not/a/grok-home",
          GROK_AUTH:
            '{"https://accounts.x.ai/sign-in":{"key":"private-token","email":"someone@example.com"}}',
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, response)),
            ),
          ),
        );
        expect(email).toBe("someone@example.com");
        expect(limits.windows).toEqual([]);
        expect(limits.unavailable).toEqual({
          reason: "probeFailed",
          message: "Grok could not read usage limits.",
        });
      }
    }),
  );
});

it.layer(NodeServices.layer)("readGrokAccount email", (it) => {
  it.effect("names the account whose limits were read, and nothing for other auth", () =>
    Effect.gen(function* () {
      const current = '"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"';
      const cases = [
        [
          { GROK_AUTH: `{${current}:{"key":"t","email":" Someone@Example.com "}}` },
          "Someone@Example.com",
        ],
        [
          {
            GROK_AUTH: `{${current}:{"key":"t","email":"current@example.com"},"https://accounts.x.ai/sign-in":{"key":"t","email":"legacy@example.com"}}`,
          },
          "current@example.com",
        ],
        [{ GROK_AUTH: `{${current}:{"key":"t"}}` }, undefined],
        [
          {
            GROK_AUTH: `{${current}:{"key":"t","email":"someone@example.com"}}`,
            XAI_API_KEY: "api-key",
          },
          undefined,
        ],
        [
          {
            GROK_AUTH: `{${current}:{"key":"t","email":"someone@example.com","auth_mode":"api_key"}}`,
          },
          undefined,
        ],
        [{ GROK_AUTH: "not-json" }, undefined],
      ] as const;
      for (const [environment, expected] of cases) {
        const { email, usageLimits } = yield* readGrokAccount({
          HOME: "/definitely/not/a/grok-home",
          ...environment,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ config: { creditUsagePercent: 25 } }),
                ),
              ),
            ),
          ),
        );
        expect(email).toBe(expected);
        if (expected) expect(usageLimits.windows[0]?.usedPercent).toBe(25);
      }
    }),
  );
});
