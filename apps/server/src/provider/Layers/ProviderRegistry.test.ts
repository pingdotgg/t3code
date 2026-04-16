import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Scope,
  Sink,
  Stream,
} from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  type ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@t3tools/shared/Struct";

import {
  checkCodexProviderStatus,
  hasCustomModelProvider,
  parseAuthStatusFromOutput,
  readCodexConfigModelProvider,
} from "./CodexProvider";
import { checkClaudeProviderStatus, parseClaudeAuthStatusFromOutput } from "./ClaudeProvider";
import { haveProvidersChanged, ProviderRegistryLive } from "./ProviderRegistry";
import { ServerConfig } from "../../config";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings";
import { ProviderRegistry } from "../Services/ProviderRegistry";

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

/**
 * Create a temporary CODEX_HOME scoped to the current Effect test.
 * Cleanup is registered in the test scope rather than via Vitest hooks.
 */
function withTempCodexHome(configContent?: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-test-codex-" });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = tmpDir;
        return originalCodexHome;
      }),
      (originalCodexHome) =>
        Effect.sync(() => {
          if (originalCodexHome !== undefined) {
            process.env.CODEX_HOME = originalCodexHome;
          } else {
            delete process.env.CODEX_HOME;
          }
        }),
    );

    if (configContent !== undefined) {
      yield* fileSystem.writeFileString(path.join(tmpDir, "config.toml"), configContent);
    }

    return { tmpDir } as const;
  });
}

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest()))(
  "ProviderRegistry",
  (it) => {
    // ── checkCodexProviderStatus tests ────────────────────────────────
    //
    // These tests control CODEX_HOME to ensure the custom-provider detection
    // in hasCustomModelProvider() does not interfere with the auth-probe
    // path being tested.

    describe("checkCodexProviderStatus", () => {
      it.effect("returns ready when codex is installed and authenticated", () =>
        Effect.gen(function* () {
          // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
          // default code path (OpenAI provider, auth probe runs) is exercised.
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "authenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns the codex plan type in auth and keeps spark for supported plans", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "chatgpt" as const,
              planType: "pro" as const,
              sparkEnabled: true,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "pro");
          assert.strictEqual(status.auth.label, "ChatGPT Pro Subscription");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            true,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("includes probed codex skills in the provider snapshot", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(
            () =>
              Effect.succeed({
                type: "chatgpt" as const,
                planType: "pro" as const,
                sparkEnabled: true,
              }),
            () =>
              Effect.succeed([
                {
                  name: "github:gh-fix-ci",
                  path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                  enabled: true,
                  displayName: "CI Debug",
                  shortDescription: "Debug failing GitHub Actions checks",
                },
              ]),
          );

          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides spark from codex models for unsupported chatgpt plans", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "chatgpt" as const,
              planType: "plus" as const,
              sparkEnabled: false,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "plus");
          assert.strictEqual(status.auth.label, "ChatGPT Plus Subscription");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("hides spark from codex models for non-pro chatgpt subscriptions", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "chatgpt" as const,
              planType: "team" as const,
              sparkEnabled: false,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.auth.type, "team");
          assert.strictEqual(status.auth.label, "ChatGPT Team Subscription");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus(() =>
            Effect.succeed({
              type: "apiKey" as const,
              planType: null,
              sparkEnabled: false,
            }),
          );

          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
          assert.deepStrictEqual(
            status.models.some((model) => model.slug === "gpt-5.3-codex-spark"),
            false,
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") return { stdout: "Logged in\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect.skipIf(process.platform === "win32")(
        "inherits PATH when launching the codex probe with a CODEX_HOME override",
        () =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const binDir = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-test-codex-bin-",
            });
            const codexPath = path.join(binDir, "codex");
            yield* fileSystem.writeFileString(
              codexPath,
              [
                "#!/bin/sh",
                'if [ "$1" = "--version" ]; then',
                '  echo "codex-cli 1.0.0"',
                "  exit 0",
                "fi",
                'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
                '  echo "Logged in using ChatGPT"',
                "  exit 0",
                "fi",
                'echo "unexpected args: $*" >&2',
                "exit 1",
                "",
              ].join("\n"),
            );
            yield* fileSystem.chmod(codexPath, 0o755);
            const customCodexHome = yield* fileSystem.makeTempDirectoryScoped({
              prefix: "t3-test-codex-home-",
            });
            const previousPath = process.env.PATH;
            process.env.PATH = binDir;

            try {
              const serverSettingsLayer = ServerSettingsService.layerTest({
                providers: {
                  codex: {
                    homePath: customCodexHome,
                  },
                },
              });

              const status = yield* checkCodexProviderStatus().pipe(
                Effect.provide(serverSettingsLayer),
              );
              assert.strictEqual(status.provider, "codex");
              assert.strictEqual(status.installed, true);
              assert.strictEqual(status.status, "ready");
              assert.strictEqual(status.auth.status, "authenticated");
            } finally {
              process.env.PATH = previousPath;
            }
          }),
      );

      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI (`codex`) is not installed or not on PATH.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
      );

      it.effect("returns unavailable when codex is below the minimum supported version", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI v0.36.0 is too old for T3 Code. Upgrade to v0.37.0 or newer and restart T3 Code.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 0.36.0\n", stderr: "", code: 0 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when auth probe reports login required", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") {
                return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns unauthenticated when login status output includes 'not logged in'", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status")
                return { stdout: "Not logged in\n", stderr: "", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("returns warning when login status command is unsupported", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.provider, "codex");
          assert.strictEqual(status.status, "warning");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(
            status.message,
            "Codex CLI authentication status command is unavailable in this Codex version.",
          );
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status") {
                return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
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

      it.effect("does not probe provider health during registry startup", () =>
        Effect.gen(function* () {
          let spawnCount = 0;
          const serverSettings = yield* makeMutableServerSettingsService();
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
                  if (command === "codex") {
                    return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                  }
                  return { stdout: "claude 1.0.0\n", stderr: "", code: 0 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in\n", stderr: "", code: 0 };
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
            assert.deepStrictEqual(yield* registry.getProviders, []);
            assert.strictEqual(spawnCount, 0);

            const refreshed = yield* registry.refresh("codex");
            assert.strictEqual(spawnCount > 0, true);
            assert.strictEqual(
              refreshed.find((provider) => provider.provider === "codex")?.status,
              "ready",
            );
          }).pipe(Effect.provide(runtimeServices));
        }),
      );

      it.effect("reruns codex health when codex provider settings change", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService();
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
                const joined = args.join(" ");
                if (joined === "--version") {
                  if (command === "codex") {
                    return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                  }
                  return { stdout: "", stderr: "spawn ENOENT", code: 1 };
                }
                if (joined === "login status") {
                  return { stdout: "Logged in\n", stderr: "", code: 0 };
                }
                throw new Error(`Unexpected args: ${joined}`);
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

            const initial = yield* registry.getProviders;
            assert.deepStrictEqual(initial, []);

            const refreshed = yield* registry.refresh("codex");
            assert.strictEqual(
              refreshed.find((status) => status.provider === "codex")?.status,
              "ready",
            );

            yield* serverSettings.updateSettings({
              providers: {
                codex: {
                  binaryPath: "/custom/codex",
                },
              },
            });

            for (let attempt = 0; attempt < 20; attempt += 1) {
              const updated = yield* registry.getProviders;
              if (updated.find((status) => status.provider === "codex")?.status === "error") {
                return;
              }
              yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
            }

            const updated = yield* registry.getProviders;
            assert.strictEqual(
              updated.find((status) => status.provider === "codex")?.status,
              "error",
            );
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

    // ── Custom model provider: checkCodexProviderStatus integration ───

    describe("checkCodexProviderStatus with custom model provider", () => {
      it.effect(
        "skips auth probe and returns ready when a custom model provider is configured",
        () =>
          Effect.gen(function* () {
            yield* withTempCodexHome(
              [
                'model_provider = "portkey"',
                "",
                "[model_providers.portkey]",
                'base_url = "https://api.portkey.ai/v1"',
                'env_key = "PORTKEY_API_KEY"',
              ].join("\n"),
            );
            const status = yield* checkCodexProviderStatus();
            assert.strictEqual(status.provider, "codex");
            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.installed, true);
            assert.strictEqual(status.auth.status, "unknown");
            assert.strictEqual(
              status.message,
              "Using a custom Codex model provider; OpenAI login check skipped.",
            );
          }).pipe(
            Effect.provide(
              // The spawner only handles --version; if the test attempts
              // "login status" the throw proves the auth probe was NOT skipped.
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
                throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
              }),
            ),
          ),
      );

      it.effect("still reports error when codex CLI is missing even with custom provider", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome(
            [
              'model_provider = "portkey"',
              "",
              "[model_providers.portkey]",
              'base_url = "https://api.portkey.ai/v1"',
              'env_key = "PORTKEY_API_KEY"',
            ].join("\n"),
          );
          const status = yield* checkCodexProviderStatus();
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
        }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
      );
    });

    describe("checkCodexProviderStatus with openai model provider", () => {
      it.effect("still runs auth probe when model_provider is openai", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "openai"\n');
          const status = yield* checkCodexProviderStatus();
          // The auth probe runs and sees "not logged in" → error
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              if (joined === "login status")
                return { stdout: "Not logged in\n", stderr: "", code: 1 };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });

    // ── parseAuthStatusFromOutput pure tests ──────────────────────────

    describe("parseAuthStatusFromOutput", () => {
      it("exit code 0 with no auth markers is ready", () => {
        const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
        assert.strictEqual(parsed.status, "ready");
        assert.strictEqual(parsed.auth.status, "authenticated");
      });

      it("JSON with authenticated=false is unauthenticated", () => {
        const parsed = parseAuthStatusFromOutput({
          stdout: '[{"authenticated":false}]\n',
          stderr: "",
          code: 0,
        });
        assert.strictEqual(parsed.status, "error");
        assert.strictEqual(parsed.auth.status, "unauthenticated");
      });

      it("JSON without auth marker is warning", () => {
        const parsed = parseAuthStatusFromOutput({
          stdout: '[{"ok":true}]\n',
          stderr: "",
          code: 0,
        });
        assert.strictEqual(parsed.status, "warning");
        assert.strictEqual(parsed.auth.status, "unknown");
      });
    });

    // ── readCodexConfigModelProvider tests ─────────────────────────────

    describe("readCodexConfigModelProvider", () => {
      it.effect("returns undefined when config file does not exist", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
        }),
      );

      it.effect("returns undefined when config has no model_provider key", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model = "gpt-5-codex"\n');
          assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
        }),
      );

      it.effect("returns the provider when model_provider is set at top level", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model = "gpt-5-codex"\nmodel_provider = "portkey"\n');
          assert.strictEqual(yield* readCodexConfigModelProvider(), "portkey");
        }),
      );

      it.effect("returns openai when model_provider is openai", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "openai"\n');
          assert.strictEqual(yield* readCodexConfigModelProvider(), "openai");
        }),
      );

      it.effect("ignores model_provider inside section headers", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome(
            [
              'model = "gpt-5-codex"',
              "",
              "[model_providers.portkey]",
              'base_url = "https://api.portkey.ai/v1"',
              'model_provider = "should-be-ignored"',
              "",
            ].join("\n"),
          );
          assert.strictEqual(yield* readCodexConfigModelProvider(), undefined);
        }),
      );

      it.effect("handles comments and whitespace", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome(
            [
              "# This is a comment",
              "",
              '  model_provider = "azure"  ',
              "",
              "[profiles.deep-review]",
              'model = "gpt-5-pro"',
            ].join("\n"),
          );
          assert.strictEqual(yield* readCodexConfigModelProvider(), "azure");
        }),
      );

      it.effect("handles single-quoted values in TOML", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome("model_provider = 'mistral'\n");
          assert.strictEqual(yield* readCodexConfigModelProvider(), "mistral");
        }),
      );
    });

    // ── hasCustomModelProvider tests ───────────────────────────────────

    describe("hasCustomModelProvider", () => {
      it.effect("returns false when no config file exists", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome();
          assert.strictEqual(yield* hasCustomModelProvider, false);
        }),
      );

      it.effect("returns false when model_provider is not set", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model = "gpt-5-codex"\n');
          assert.strictEqual(yield* hasCustomModelProvider, false);
        }),
      );

      it.effect("returns false when model_provider is openai", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "openai"\n');
          assert.strictEqual(yield* hasCustomModelProvider, false);
        }),
      );

      it.effect("returns true when model_provider is portkey", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "portkey"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );

      it.effect("returns true when model_provider is azure", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "azure"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );

      it.effect("returns true when model_provider is ollama", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "ollama"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
        }),
      );

      it.effect("returns true when model_provider is a custom proxy", () =>
        Effect.gen(function* () {
          yield* withTempCodexHome('model_provider = "my-company-proxy"\n');
          assert.strictEqual(yield* hasCustomModelProvider, true);
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
