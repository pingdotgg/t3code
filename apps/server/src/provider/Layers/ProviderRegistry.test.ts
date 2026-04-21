import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import { Effect, Exit, Layer, PubSub, Ref, Schema, Scope, Sink, Stream } from "effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@t3tools/shared/Struct";

import { checkCodexProviderStatus, type CodexAppServerProviderSnapshot } from "./CodexProvider.ts";
import { checkClaudeProviderStatus, parseClaudeAuthStatusFromOutput } from "./ClaudeProvider.ts";
import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  ProviderRegistryLive,
} from "./ProviderRegistry.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";

process.env.T3CODE_CURSOR_ENABLED = "1";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

const codexModelCapabilities = {
  reasoningEffortLevels: [
    { value: "high", label: "High", isDefault: true },
    { value: "low", label: "Low" },
  ],
  supportsFastMode: true,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
} satisfies NonNullable<ServerProvider["models"][number]["capabilities"]>;

function makeCodexProbeSnapshot(
  input: Partial<CodexAppServerProviderSnapshot> = {},
): CodexAppServerProviderSnapshot {
  return {
    version: "1.0.0",
    account: {
      account: {
        type: "chatgpt",
        email: "test@example.com",
        planType: "pro",
      },
      requiresOpenaiAuth: false,
    },
    models: [
      {
        slug: "gpt-live-codex",
        name: "GPT Live Codex",
        isCustom: false,
        capabilities: codexModelCapabilities,
      },
    ],
    skills: [],
    ...input,
  };
}

function makeMutableServerSettingsService(
  initial: ContractServerSettings = DEFAULT_SERVER_SETTINGS,
) {
  return Effect.gen(function* () {
    const settingsRef = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ContractServerSettings>();

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(settingsRef),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(settingsRef);
          const next = Schema.decodeSync(ServerSettings)(deepMerge(current, patch));
          yield* Ref.set(settingsRef, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
    } satisfies ServerSettingsShape;
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest()))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("uses the app-server account and model list for provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                skills: [
                  {
                    name: "github:gh-fix-ci",
                    path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                    enabled: true,
                    displayName: "CI Debug",
                    shortDescription: "Debug failing GitHub Actions checks",
                  },
                ],
              }),
            ),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "1.0.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.deepStrictEqual(status.models, [
            {
              slug: "gpt-live-codex",
              name: "GPT Live Codex",
              isCustom: false,
              capabilities: codexModelCapabilities,
            },
          ]);
          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }),
      );

      it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: null,
                  requiresOpenaiAuth: true,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );

      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
          Effect.gen(function* () {
            const status = yield* checkCodexProviderStatus(() =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }),
              ),
            );

            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "unknown");
          }),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(() =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }),
      );
    });

    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            provider: "claudeAgent",
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });

      it("preserves previously discovered provider models when a refresh returns none", () => {
        const previousProvider = {
          provider: "cursor",
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: {
                reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
                supportsFastMode: true,
                supportsThinkingToggle: true,
                contextWindowOptions: [],
                promptInjectedEffortLevels: [],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it("fills missing capabilities from the previous provider snapshot", () => {
        const previousProvider = {
          provider: "cursor",
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: {
                reasoningEffortLevels: [{ value: "high", label: "High", isDefault: true }],
                supportsFastMode: true,
                supportsThinkingToggle: true,
                contextWindowOptions: [],
                promptInjectedEffortLevels: [],
              },
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;
        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: {
                reasoningEffortLevels: [],
                supportsFastMode: false,
                supportsThinkingToggle: false,
                contextWindowOptions: [],
                promptInjectedEffortLevels: [],
              },
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });

      it.effect("probes enabled providers in the background during registry startup", () =>
        Effect.gen(function* () {
          let spawnCount = 0;
          const serverSettings = yield* makeMutableServerSettingsService(
            Schema.decodeSync(ServerSettings)(
              deepMerge(DEFAULT_SERVER_SETTINGS, {
                providers: {
                  codex: { enabled: false },
                  cursor: { enabled: false },
                },
              }),
            ),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(
              mockCommandSpawnerLayer((command, args) => {
                spawnCount += 1;
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "claude 1.0.0\n", stderr: "", code: 0 };
                }
                if (joined === "auth status") {
                  return { stdout: '{"authenticated":true}\n', stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${command} ${joined}`);
              }),
            ),
          );
          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry;
            assert.strictEqual(spawnCount > 0, true);
            const refreshed = yield* Effect.gen(function* () {
              for (let remainingAttempts = 50; remainingAttempts > 0; remainingAttempts -= 1) {
                const providers = yield* registry.getProviders;
                const claudeProvider = providers.find(
                  (provider) => provider.provider === "claudeAgent",
                );
                if (claudeProvider?.status === "ready") {
                  return providers;
                }
                yield* Effect.sleep("10 millis");
              }
              return yield* registry.getProviders;
            });
            assert.strictEqual(
              refreshed.find((provider) => provider.provider === "claudeAgent")?.status,
              "ready",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect(
        "keeps cursor disabled and skips probing when the provider setting is disabled",
        () =>
          Effect.gen(function* () {
            const serverSettings = yield* makeMutableServerSettingsService(
              Schema.decodeSync(ServerSettings)(
                deepMerge(DEFAULT_SERVER_SETTINGS, {
                  providers: {
                    codex: {
                      enabled: false,
                    },
                    cursor: {
                      enabled: false,
                    },
                  },
                }),
              ),
            );
            let cursorSpawned = false;
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
            const providerRegistryLayer = ProviderRegistryLive.pipe(
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-",
                }),
              ),
              Layer.provideMerge(
                mockCommandSpawnerLayer((command, args) => {
                  if (command === "agent") {
                    cursorSpawned = true;
                  }
                  const joined = args.join(" ");
                  if (joined === "--version") {
                    return { stdout: `${command} 1.0.0\n`, stderr: "", code: 0 };
                  }
                  if (joined === "auth status") {
                    return { stdout: '{"authenticated":true}\n', stderr: "", code: 0 };
                  }
                  throw new Error(`Unexpected args: ${command} ${joined}`);
                }),
              ),
            );
            const runtimeServices = yield* Layer.build(
              Layer.mergeAll(
                Layer.succeed(ServerSettingsService, serverSettings),
                providerRegistryLayer,
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry;
              const providers = yield* registry.getProviders;
              const cursorProvider = providers.find((provider) => provider.provider === "cursor");

              assert.deepStrictEqual(
                providers.map((provider) => provider.provider),
                ["codex", "claudeAgent", "opencode", "cursor"],
              );
              assert.strictEqual(cursorProvider?.enabled, false);
              assert.strictEqual(cursorProvider?.status, "disabled");
              assert.strictEqual(
                cursorProvider?.message,
                "Cursor is disabled in T3 Code settings.",
              );
              assert.strictEqual(cursorSpawned, false);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );

      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const serverSettingsLayer = ServerSettingsService.layerTest({
            providers: {
              codex: {
                enabled: false,
              },
            },
          });

          const status = yield* checkCodexProviderStatus().pipe(
            Effect.provide(
              Layer.mergeAll(serverSettingsLayer, failingSpawnerLayer("spawn codex ENOENT")),
            ),
          );
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in T3 Code settings.");
        }),
      );
    });

    // ── checkClaudeProviderStatus tests ──────────────────────────

    describe("checkClaudeProviderStatus", () => {
      it.effect("returns ready when claude is installed and authenticated", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect(
        "includes Claude Opus 4.7 with xhigh as the default effort on supported versions",
        () =>
          Effect.gen(function* () {
            const status = yield* checkClaudeProviderStatus();
            const opus47 = status.models.find((model) => model.slug === "claude-opus-4-7");
            if (!opus47) {
              assert.fail("Expected Claude Opus 4.7 to be present for Claude Code v2.1.111.");
            }
            if (!opus47.capabilities) {
              assert.fail(
                "Expected Claude Opus 4.7 capabilities to be present for Claude Code v2.1.111.",
              );
            }
            assert.deepStrictEqual(
              opus47.capabilities.reasoningEffortLevels.find((level) => level.isDefault),
              { value: "xhigh", label: "Extra High", isDefault: true },
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "2.1.111\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect("hides Claude Opus 4.7 on older Claude Code versions", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(
            status.models.some((model) => model.slug === "claude-opus-4-7"),
            false,
          );
          assert.strictEqual(
            status.message,
            "Claude Code v2.1.110 is too old for Claude Opus 4.7. Upgrade to v2.1.111 or newer to access it.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "2.1.110\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns a display label for claude subscription types", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(() => Effect.succeed("maxplan"));
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "maxplan");
          assert.strictEqual(status.auth.label, "Claude Max Subscription");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes probed claude slash commands in the provider snapshot", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            () => Effect.succeed("maxplan"),
            () =>
              Effect.succeed([
                {
                  name: "review",
                  description: "Review a pull request",
                  input: { hint: "pr-or-branch" },
                },
              ]),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "review",
              description: "Review a pull request",
              input: { hint: "pr-or-branch" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("deduplicates probed claude slash commands by name", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            () => Effect.succeed("maxplan"),
            () =>
              Effect.succeed([
                {
                  name: "ui",
                  description: "Explore and refine UI",
                },
                {
                  name: "ui",
                  input: { hint: "component-or-screen" },
                },
              ]),
          );

          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "ui",
              description: "Explore and refine UI",
              input: { hint: "component-or-screen" },
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for claude api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "Claude API Key");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"api-key"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unavailable when claude is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent CLI (`claude`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
      );

      it.effect("returns error when version check fails with non-zero exit code", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version")
                return { stdout: "", stderr: "Something went wrong", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when auth status reports not logged in", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Claude is not authenticated. Run `claude auth login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false}\n',
                  stderr: "",
                  code: 1,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when output includes 'not logged in'", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return { stdout: "Not logged in\n", stderr: "", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns warning when auth status command is unsupported", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus();
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Claude Agent authentication status command is unavailable in this version of Claude.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return { stdout: "", stderr: "error: unknown command 'auth'", code: 2 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });

    // ── parseClaudeAuthStatusFromOutput pure tests ────────────────────

    describe("parseClaudeAuthStatusFromOutput", () => {
      it("exit code 0 with no auth markers is ready", () => {
        const parsed = parseClaudeAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
        assert.strictEqual(parsed.status, "ready");
        assert.strictEqual(parsed.auth.status, "authenticated");
      });

      it("JSON with loggedIn=true is authenticated", () => {
        const parsed = parseClaudeAuthStatusFromOutput({
          stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
          stderr: "",
          code: 0,
        });
        assert.strictEqual(parsed.status, "ready");
        assert.strictEqual(parsed.auth.status, "authenticated");
      });

      it("JSON with loggedIn=false is unauthenticated", () => {
        const parsed = parseClaudeAuthStatusFromOutput({
          stdout: '{"loggedIn":false}\n',
          stderr: "",
          code: 0,
        });
        assert.strictEqual(parsed.status, "error");
        assert.strictEqual(parsed.auth.status, "unauthenticated");
      });

      it("JSON without auth marker is warning", () => {
        const parsed = parseClaudeAuthStatusFromOutput({
          stdout: '{"ok":true}\n',
          stderr: "",
          code: 0,
        });
        assert.strictEqual(parsed.status, "warning");
        assert.strictEqual(parsed.auth.status, "unknown");
      });
    });
  },
);
