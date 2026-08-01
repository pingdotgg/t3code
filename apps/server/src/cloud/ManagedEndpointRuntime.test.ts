// @ts-nocheck
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as RelayClient from "@t3tools/shared/relayClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const relayClientAvailableLayer = Layer.succeed(
  RelayClient.RelayClient,
  RelayClient.RelayClient.of({
    resolve: Effect.succeed({
      status: "available",
      executablePath: "cloudflared",
      source: "path",
      version: RelayClient.CLOUDFLARED_VERSION,
    }),
    install: Effect.die("unused"),
    installWithProgress: () => Effect.die("unused"),
  }),
);

const runtimeDependencies = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = relayClientAvailableLayer,
) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    relayClientLayer,
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeed(Option.none()),
    }),
  );

const buildCloudManagedEndpointRuntime = (
  spawner: ReturnType<typeof ChildProcessSpawner.make>,
  relayClientLayer = relayClientAvailableLayer,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      ManagedEndpointRuntime.layer.pipe(
        Layer.provide(runtimeDependencies(spawner, relayClientLayer)),
      ),
    );
    return yield* Effect.service(ManagedEndpointRuntime.CloudManagedEndpointRuntime).pipe(
      Effect.provide(context),
    );
  });

function makeHandle(input: {
  readonly pid: number;
  readonly onKill: (options?: { readonly killSignal?: string }) => void;
  readonly onKillEffect?: (options?: { readonly killSignal?: string }) => Effect.Effect<void>;
  readonly isRunning?: () => boolean;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly all?: Stream.Stream<Uint8Array>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: (options) =>
      Effect.sync(() => {
        input.onKill(options);
      }).pipe(Effect.andThen(input.onKillEffect?.(options) ?? Effect.void)),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: input.all ?? Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("CloudManagedEndpointRuntime", () => {
  it.effect("does not launch a persisted tunnel before desired-link reconciliation", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      yield* buildCloudManagedEndpointRuntime(ChildProcessSpawner.make(spawn));
      expect(spawn).not.toHaveBeenCalled();
    }),
  );

  it("classifies Cloudflare connection and warning output", () => {
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0",
      ),
    ).toBe("connected");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z ERR Failed to serve tunnel connection",
      ),
    ).toBe("warning");
    expect(
      ManagedEndpointRuntime.classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Starting metrics server",
      ),
    ).toBe("debug");
  });

  it.effect("reports a spawned connector as starting until it registers a tunnel connection", () =>
    Effect.gen(function* () {
      const output = new TextEncoder().encode(
        "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0\n",
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              pid: 90,
              onKill: () => undefined,
              all: Stream.make(output),
            }),
          ),
        ),
      );

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      expect(started).toMatchObject({ status: "starting", pid: 90 });
      yield* Effect.yieldNow;
      expect(yield* runtime.getStatus).toMatchObject({ status: "running", pid: 90 });
    }),
  );

  it.effect("keeps a spawned connector pending when Cloudflare reports a warning", () =>
    Effect.gen(function* () {
      const output = new TextEncoder().encode(
        "2026-06-17T02:00:00Z WRN Failed to serve tunnel connection\n",
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeHandle({
              pid: 91,
              onKill: () => undefined,
              all: Stream.make(output),
            }),
          ),
        ),
      );

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      yield* Effect.yieldNow;
      expect(yield* runtime.getStatus).toMatchObject({ status: "starting", pid: 91 });
    }),
  );

  it.effect("starts, deduplicates, rotates, and stops the Cloudflare connector", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.StandardCommand> = [];
      const killed: Array<number> = [];
      let nextPid = 100;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) {
            throw new Error("Expected standard command.");
          }
          spawned.push(command);
          const pid = nextPid;
          nextPid += 1;
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-1",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token-2",
        tunnelId: "tunnel-1",
        tunnelName: "t3-code-env-1",
      });
      const stopped = yield* runtime.applyConfig(null);

      expect(spawned.map((command) => command.command)).toEqual(["cloudflared", "cloudflared"]);
      expect(spawned.map((command) => command.args)).toEqual([
        ["tunnel", "run"],
        ["tunnel", "run"],
      ]);
      expect(spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
        "token-1",
        "token-2",
      ]);
      expect(spawned.map((command) => command.options.stdout)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.stderr)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.detached)).toEqual([false, false]);
      expect(spawned.map((command) => command.options.shell)).toEqual([false, false]);
      expect(spawned.map((command) => command.options.forceKillAfter)).toEqual([
        "1 second",
        "1 second",
      ]);
      expect(killed).toEqual([100, 101]);
      expect(stopped).toEqual({ status: "disabled" });
    }),
  );

  it.effect("stops an active connector when a non-Cloudflare runtime config is applied", () =>
    Effect.gen(function* () {
      const killed: Array<number> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 200,
            onKill: () => {
              killed.push(200);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      const unsupported = yield* runtime.applyConfig({
        providerKind: "manual",
        connectorToken: "manual-token",
      });

      expect(started.status).toBe("starting");
      expect(unsupported).toEqual({ status: "unsupported", providerKind: "manual" });
      expect(killed).toEqual([200]);
    }),
  );

  it.effect("restarts the connector when the active process has exited", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      let firstRunning = true;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 300 : 301;
          spawned.push(pid);
          const handle = makeHandle({
            pid,
            isRunning: () => (pid === 300 ? firstRunning : true),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      const first = yield* runtime.applyConfig(config);
      firstRunning = false;
      const second = yield* runtime.applyConfig(config);

      expect(first).toMatchObject({ status: "starting", pid: 300 });
      expect(second).toMatchObject({ status: "starting", pid: 301 });
      expect(spawned).toEqual([300, 301]);
      expect(killed).toEqual([300]);
    }),
  );

  it.effect("supervises the active connector and restarts it after process exit", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const secondSpawned = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = spawned.length === 0 ? 400 : 401;
          spawned.push(pid);
          if (pid === 401) {
            yield* Deferred.succeed(secondSpawned, undefined);
          }
          const handle = makeHandle({
            pid,
            exitCode:
              pid === 400
                ? Deferred.await(firstExit)
                : (Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>),
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });
      yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
      yield* Deferred.await(secondSpawned);

      expect(started).toMatchObject({ status: "starting", pid: 400 });
      expect(spawned).toEqual([400, 401]);
      yield* Effect.yieldNow;
      expect(yield* runtime.getStatus).toMatchObject({ status: "starting", pid: 401 });
    }),
  );

  it.effect("serializes concurrent connector config changes", () =>
    Effect.gen(function* () {
      const spawned: Array<number> = [];
      const killed: Array<number> = [];
      const firstSpawnEntered = yield* Deferred.make<void>();
      const releaseFirstSpawn = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = 500 + spawned.length;
          spawned.push(pid);
          if (pid === 500) {
            yield* Deferred.succeed(firstSpawnEntered, undefined);
            yield* Deferred.await(releaseFirstSpawn);
          }
          const handle = makeHandle({
            pid,
            onKill: () => {
              killed.push(pid);
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const first = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-1",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSpawnEntered);
      const second = yield* runtime
        .applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-2",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseFirstSpawn, undefined);

      yield* Fiber.join(first);
      const status = yield* Fiber.join(second);

      expect(status).toMatchObject({ status: "starting", pid: 501 });
      expect(spawned).toEqual([500, 501]);
      expect(killed).toEqual([500]);
    }),
  );

  it.effect("reports connector spawn failures", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "cloudflared missing",
          }),
        ),
      );

      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
        tunnelId: "tunnel-1",
      });

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        tunnelId: "tunnel-1",
      });
    }),
  );

  it.effect("retains a failed connector so a later unlink can retry teardown", () =>
    Effect.gen(function* () {
      let firstStop = true;
      const killed: number[] = [];
      const signals: Array<string | undefined> = [];
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle({
            pid: 550,
            onKill: ({ killSignal } = {}) => {
              killed.push(550);
              signals.push(killSignal);
            },
            exitCode: Effect.fail(new Error("Relay client exited after SIGTERM.")),
          });
          yield* Effect.addFinalizer(() => {
            if (firstStop) {
              firstStop = false;
              return Effect.fail(new Error("kill failed"));
            }
            return handle.kill();
          });
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(spawner);

      yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      const stopped = yield* runtime.applyConfig(null);

      expect(stopped).toMatchObject({
        status: "failed",
        reason: "The relay client could not be stopped.",
      });
      expect(yield* runtime.getStatus).toEqual(stopped);
      expect(yield* runtime.applyConfig(null)).toEqual({ status: "disabled" });
      expect(killed).toEqual([550]);
      expect(signals).toEqual(["SIGTERM"]);
    }),
  );

  it.effect("force-kills a stuck connector after the bounded scope-close grace period", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const signals: Array<string | undefined> = [];
        let forceKilled = false;
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const handle = makeHandle({
                pid: 575,
                onKill: ({ killSignal } = {}) => {
                  signals.push(killSignal);
                  forceKilled ||= killSignal === "SIGKILL";
                },
                exitCode: Effect.suspend(() =>
                  forceKilled
                    ? Effect.fail(new Error("Relay client exited after SIGKILL."))
                    : Effect.never,
                ),
              });
              yield* Effect.addFinalizer(() => Effect.never);
              return handle;
            }),
          ),
        );

        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
        const stopping = yield* runtime.applyConfig(null).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(signals).toEqual([]);
        yield* TestClock.adjust("1 second");
        expect(signals).toEqual(["SIGTERM"]);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(stopping)).toEqual({ status: "disabled" });
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("bounds hanging kill effects during runtime finalization", () =>
    Effect.gen(function* () {
      const configured = yield* Deferred.make<void>();
      const signals: Array<string | undefined> = [];
      const finalizing = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* buildCloudManagedEndpointRuntime(
            ChildProcessSpawner.make(() =>
              Effect.gen(function* () {
                const handle = makeHandle({
                  pid: 576,
                  onKill: ({ killSignal } = {}) => {
                    signals.push(killSignal);
                  },
                  onKillEffect: () => Effect.never,
                });
                yield* Effect.addFinalizer(() => Effect.fail(new Error("scope close failed")));
                return handle;
              }),
            ),
          );
          yield* runtime.applyConfig({
            providerKind: "cloudflare_tunnel",
            connectorToken: "token",
          });
          yield* Deferred.succeed(configured, undefined);
        }),
      )
        .pipe(Effect.exit)
        .pipe(Effect.forkDetach);

      yield* Deferred.await(configured);
      yield* Effect.yieldNow;
      expect(signals).toEqual(["SIGTERM"]);
      yield* TestClock.adjust("1 second");
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(finalizing))._tag).toBe("Failure");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries a failed connector stop from the runtime finalizer", () => {
    const signals: Array<string | undefined> = [];
    let firstScopeClose = true;
    return Effect.scoped(
      Effect.gen(function* () {
        const connectorExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const handle = makeHandle({
                pid: 576,
                onKill: ({ killSignal } = {}) => {
                  signals.push(killSignal);
                },
                onKillEffect: () =>
                  Deferred.succeed(connectorExit, ChildProcessSpawner.ExitCode(0)),
                exitCode: Deferred.await(connectorExit),
              });
              yield* Effect.addFinalizer(() => {
                if (firstScopeClose) {
                  firstScopeClose = false;
                  return Effect.fail(new Error("SIGTERM failed"));
                }
                return Effect.void;
              });
              return handle;
            }),
          ),
        );
        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
      }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(signals).toEqual(["SIGTERM"]);
        }),
      ),
    );
  });

  it.effect("clears online status before a replacement connector finishes spawning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const replacementSpawnEntered = yield* Deferred.make<void>();
        const releaseReplacementSpawn = yield* Deferred.make<void>();
        const registered = new TextEncoder().encode(
          "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0\n",
        );
        let spawns = 0;
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const first = spawns++ === 0;
              if (!first) {
                yield* Deferred.succeed(replacementSpawnEntered, undefined);
                yield* Deferred.await(releaseReplacementSpawn);
              }
              return makeHandle({
                pid: first ? 580 : 581,
                onKill: () => undefined,
                exitCode: first ? Deferred.await(firstExit) : Effect.never,
                all: Stream.make(registered),
              });
            }),
          ),
        );

        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
        yield* Effect.yieldNow;
        expect(yield* runtime.getStatus).toMatchObject({ status: "running", pid: 580 });
        yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(1));
        yield* Deferred.await(replacementSpawnEntered);
        expect(yield* runtime.getStatus).toMatchObject({ status: "starting", pid: 580 });
        yield* Deferred.succeed(releaseReplacementSpawn, undefined);
        yield* Effect.yieldNow;
        expect(yield* runtime.getStatus).toMatchObject({ status: "running", pid: 581 });
      }),
    ),
  );

  it.effect("starts the desired replacement after a retained connector exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldConnectorExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const replacementSpawned = yield* Deferred.make<void>();
        let spawns = 0;
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const first = spawns++ === 0;
              const handle = makeHandle({
                pid: first ? 585 : 586,
                onKill: () => undefined,
                exitCode: first ? Deferred.await(oldConnectorExit) : Effect.never,
              });
              if (first) {
                yield* Effect.addFinalizer(() =>
                  Effect.fail(new Error("old connector could not be stopped")),
                );
              } else {
                yield* Deferred.succeed(replacementSpawned, undefined);
              }
              return handle;
            }),
          ),
        );

        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-1",
        });
        expect(
          yield* runtime.applyConfig({
            providerKind: "cloudflare_tunnel",
            connectorToken: "token-2",
          }),
        ).toMatchObject({ status: "failed" });

        yield* Deferred.succeed(oldConnectorExit, ChildProcessSpawner.ExitCode(1));
        yield* Deferred.await(replacementSpawned);
        yield* Effect.yieldNow;
        expect(yield* runtime.getStatus).toMatchObject({ status: "starting", pid: 586 });
      }),
    ),
  );

  it.effect("becomes disabled when a retained connector exits after unlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldConnectorExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const handle = makeHandle({
                pid: 587,
                onKill: () => undefined,
                exitCode: Deferred.await(oldConnectorExit),
              });
              yield* Effect.addFinalizer(() =>
                Effect.fail(new Error("old connector could not be stopped")),
              );
              return handle;
            }),
          ),
        );

        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
        expect(yield* runtime.applyConfig(null)).toMatchObject({ status: "failed" });

        yield* Deferred.succeed(oldConnectorExit, ChildProcessSpawner.ExitCode(1));
        yield* Effect.yieldNow;
        expect(yield* runtime.getStatus).toEqual({ status: "disabled" });
      }),
    ),
  );

  it.effect("becomes unsupported when a retained connector exits after a manual config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const oldConnectorExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const handle = makeHandle({
                pid: 588,
                onKill: () => undefined,
                exitCode: Deferred.await(oldConnectorExit),
              });
              yield* Effect.addFinalizer(() =>
                Effect.fail(new Error("old connector could not be stopped")),
              );
              return handle;
            }),
          ),
        );

        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
        expect(
          yield* runtime.applyConfig({
            providerKind: "manual",
            connectorToken: "manual-token",
          }),
        ).toMatchObject({ status: "failed" });

        yield* Deferred.succeed(oldConnectorExit, ChildProcessSpawner.ExitCode(1));
        yield* Effect.yieldNow;
        expect(yield* runtime.getStatus).toEqual({
          status: "unsupported",
          providerKind: "manual",
        });
      }),
    ),
  );

  it.effect("clears online status before resolving a rotated connector replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const replacementResolutionStarted = yield* Deferred.make<void>();
        const releaseReplacementResolution = yield* Deferred.make<void>();
        const registered = new TextEncoder().encode(
          "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0\n",
        );
        let resolveCalls = 0;
        let spawns = 0;
        const runtime = yield* buildCloudManagedEndpointRuntime(
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeHandle({
                pid: spawns++ === 0 ? 590 : 591,
                onKill: () => undefined,
                all: Stream.make(registered),
              }),
            ),
          ),
          Layer.succeed(
            RelayClient.RelayClient,
            RelayClient.RelayClient.of({
              resolve: Effect.suspend(() => {
                if (resolveCalls++ === 0) {
                  return Effect.succeed({
                    status: "available" as const,
                    executablePath: "cloudflared",
                    source: "path" as const,
                    version: RelayClient.CLOUDFLARED_VERSION,
                  });
                }
                return Deferred.succeed(replacementResolutionStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseReplacementResolution)),
                  Effect.as({
                    status: "available" as const,
                    executablePath: "cloudflared",
                    source: "path" as const,
                    version: RelayClient.CLOUDFLARED_VERSION,
                  }),
                );
              }),
              install: Effect.die("unused"),
              installWithProgress: () => Effect.die("unused"),
            }),
          ),
        );

        yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token-1",
        });
        yield* Effect.yieldNow;
        expect(yield* runtime.getStatus).toMatchObject({ status: "running", pid: 590 });

        const rotating = yield* runtime
          .applyConfig({
            providerKind: "cloudflare_tunnel",
            connectorToken: "token-2",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(replacementResolutionStarted);
        expect(yield* runtime.getStatus).toMatchObject({ status: "starting", pid: 590 });

        yield* Deferred.succeed(releaseReplacementResolution, undefined);
        expect(yield* Fiber.join(rotating)).toMatchObject({ status: "starting", pid: 591 });
      }),
    ),
  );

  it.effect("installs a missing relay client before launching the managed tunnel", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      const spawner = ChildProcessSpawner.make((command) => {
        spawn(command);
        return Effect.succeed(
          makeHandle({
            pid: 600,
            onKill: () => undefined,
          }),
        );
      });
      const install = vi.fn(() =>
        Effect.succeed({
          status: "available" as const,
          executablePath: "managed-cloudflared",
          source: "managed" as const,
          version: RelayClient.CLOUDFLARED_VERSION,
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: install(),
            installWithProgress: () => Effect.die("unused"),
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      expect(status).toMatchObject({
        status: "starting",
        providerKind: "cloudflare_tunnel",
        pid: 600,
      });
      expect(install).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("does not launch a tunnel when managed relay-client installation fails", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      const runtime = yield* buildCloudManagedEndpointRuntime(
        ChildProcessSpawner.make(spawn),
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.succeed({
              status: "missing",
              version: RelayClient.CLOUDFLARED_VERSION,
            }),
            install: Effect.fail(new Error("managed relay-client installation failed")),
            installWithProgress: () => Effect.die("unused"),
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      expect(status).toMatchObject({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason: "The relay client is not installed.",
      });
      expect(spawn).not.toHaveBeenCalled();
    }),
  );
});
