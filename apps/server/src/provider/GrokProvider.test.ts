// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import {
  buildGrokModelCapabilities,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { grokUsageResponseToLimits, readGrokAccount } from "@t3tools/provider-grok/testing";

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
});

describe("buildGrokModelCapabilities", () => {
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
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
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
  // A list of `models` outputs is served in call order, repeating the last one.
  const writeFakeGrokCli = (input: {
    readonly modelsOutput: string | ReadonlyArray<string>;
    readonly acp: boolean;
    readonly updateLogPath?: string;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-probe-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../scripts/acp-mock-agent.ts");
      return writeFakeCli({
        directory: dir,
        name: "grok",
        source: [
          ...(input.updateLogPath
            ? [
                'import { appendFileSync as appendUpdateAttempt } from "node:fs";',
                'if (process.env.GROK_DISABLE_AUTOUPDATER !== "1") {',
                `  appendUpdateAttempt(${JSON.stringify(input.updateLogPath)}, "update\\n");`,
                "}",
              ]
            : []),
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("grok 1.0.13\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "models") {',
          '  const fs = await import("node:fs");',
          `  const callsPath = ${JSON.stringify(NodePath.join(dir, "models-calls"))};`,
          '  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").length : 0;',
          '  fs.appendFileSync(callsPath, ".");',
          `  const outputs = ${JSON.stringify([input.modelsOutput].flat())};`,
          "  process.stdout.write(outputs[Math.min(calls, outputs.length - 1)]);",
          "  process.exit(0);",
          "}",
          'if (process.argv[2] !== "agent") process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
    });

  it.effect("reports ready with ACP-discovered models without running startup updates", () =>
    Effect.gen(function* () {
      const environment = { ...process.env, XAI_API_KEY: "", GROK_DISABLE_AUTOUPDATER: "0" };
      const { snapshot, updateRan } = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-updater-" });
          const updateLogPath = NodePath.join(dir, "updates.log");
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_IN_MODELS_OUTPUT,
            acp: true,
            updateLogPath,
          });
          const snapshot = yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            environment,
          );
          return { snapshot, updateRan: yield* fs.exists(updateLogPath) };
        }),
      );

      expect(updateRan).toBe(false);
      expect(environment.GROK_DISABLE_AUTOUPDATER).toBe("0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.0.13");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Grok account",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(
        snapshot.models[0]?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
      ).toEqual(["reasoningEffort"]);
    }),
  );

  // An expired access token prints the logged-out banner, then the CLI refreshes it in the
  // same run, so the next `grok models` reports the login.
  it.effect("reports authenticated when `grok models` logs in after refreshing a token", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: [LOGGED_OUT_MODELS_OUTPUT, LOGGED_IN_MODELS_OUTPUT],
            acp: true,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
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
  const weeklyPeriod = {
    type: "USAGE_PERIOD_TYPE_WEEKLY",
    start: "2026-09-11T03:10:30.159171+00:00",
    end: "2026-09-18T03:10:30.159171+00:00",
  };

  it("shows zero usage for complete weekly and monthly periods with no percentage", () => {
    for (const [currentPeriod, kind, label, resetsAt] of [
      [weeklyPeriod, "weekly", "Weekly", "2026-09-18T03:10:30.159Z"],
      [
        {
          type: "USAGE_PERIOD_TYPE_MONTHLY",
          start: "2026-09-01T00:00:00.000Z",
          end: "2026-10-01T00:00:00.000Z",
        },
        "monthly",
        "Monthly",
        "2026-10-01T00:00:00.000Z",
      ],
    ] as const) {
      const response = { config: { currentPeriod } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows)
        .toEqual([{ id: "subscription", kind, label, usedPercent: 0, resetsAt }]);
    }
  });

  it("keeps incomplete, invalid, unordered, and unknown periods unreported", () => {
    for (const currentPeriod of [
      undefined,
      { ...weeklyPeriod, type: undefined },
      { ...weeklyPeriod, type: "USAGE_PERIOD_TYPE_DAILY" },
      { ...weeklyPeriod, start: undefined },
      { ...weeklyPeriod, end: undefined },
      { ...weeklyPeriod, start: "invalid" },
      { ...weeklyPeriod, end: "invalid" },
      { ...weeklyPeriod, start: weeklyPeriod.end },
      { ...weeklyPeriod, start: weeklyPeriod.end, end: weeklyPeriod.start },
    ]) {
      const response = { config: { currentPeriod } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows, JSON.stringify(response))
        .toEqual([]);
    }
  });

  // regression: #17061 show zero-use Grok billing periods
  it("rejects impossible calendar dates at either period boundary", () => {
    for (const [start, end] of [
      ["2026-02-30T00:00:00.000Z", "2026-03-09T00:00:00.000Z"],
      ["2026-02-23T00:00:00.000Z", "2026-02-30T00:00:00.000Z"],
    ]) {
      const response = { config: { currentPeriod: { ...weeklyPeriod, start, end } } };
      expect
        .soft(grokUsageResponseToLimits(response, checkedAt).windows, JSON.stringify(response))
        .toEqual([]);
    }
  });

  it("does not invent allowance or reset dates when billing omits them", () => {
    for (const response of [{}, { config: {} }, { config: { creditUsagePercent: NaN } }]) {
      const limits = grokUsageResponseToLimits(response, checkedAt);
      expect(limits.windows).toEqual([]);
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
