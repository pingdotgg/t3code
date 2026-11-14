import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient } from "effect/http";
import type { RelayManagedEndpointRuntimeConfig } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { buildCloudManagedEndpointRuntime, decodeLogEntry, layerRelayClientAvailable, runtimeDependencies, unusedHttpClient } from "./ManagedEndpointRuntime-part2.testkit.ts";

import { makeHandle } from "./ManagedEndpointRuntime-fixtures.testkit.ts";
describe("CloudManagedEndpointRuntime", () => {
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
        [
          "tunnel",
          "--no-autoupdate",
          "--loglevel",
          "info",
          "--output",
          "default",
          "--metrics",
          "127.0.0.1:0",
          "run",
        ],
        [
          "tunnel",
          "--no-autoupdate",
          "--loglevel",
          "info",
          "--output",
          "default",
          "--metrics",
          "127.0.0.1:0",
          "run",
        ],
      ]);
      expect(spawned.map((command) => command.options.env?.TUNNEL_TOKEN)).toEqual([
        "token-1",
        "token-2",
      ]);
      expect(spawned.map((command) => command.options.stdout)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.stderr)).toEqual(["pipe", "pipe"]);
      expect(spawned.map((command) => command.options.detached)).toEqual([false, false]);
      expect(spawned.map((command) => command.options.shell)).toEqual([false, false]);
      expect(killed).toEqual([100, 101]);
      expect(stopped).toEqual({ status: "disabled" });
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

      expect(started).toMatchObject({ status: "running", pid: 400 });
      expect(spawned).toEqual([400, 401]);
      expect(killed).toEqual([400]);
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

      expect(status).toMatchObject({ status: "running", pid: 501 });
      expect(spawned).toEqual([500, 501]);
      expect(killed).toEqual([500]);
    }),
  );
  it.effect(
    "runs an older relay client while the pinned one installs, then hands off to it and prunes",
    () =>
      Effect.gen(function* () {
        const olderClient = {
          status: "available",
          executablePath: "/managed/2025.9.0/cloudflared",
          source: "managed",
          version: "2025.9.0",
        } as const;
        const pinnedClient = {
          status: "available",
          executablePath: "/managed/pinned/cloudflared",
          source: "managed",
          version: RelayClient.CLOUDFLARED_VERSION,
        } as const;
        let installed = false;
        const releaseInstall = yield* Deferred.make<void>();
        const pruned = yield* Deferred.make<void>();
        const spawned = yield* Queue.unbounded<string>();
        const olderStopped = yield* Deferred.make<void>();
        const output = yield* Queue.unbounded<Uint8Array>();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const executable = ChildProcess.isStandardCommand(command) ? command.command : "";
            yield* Queue.offer(spawned, executable);
            const handle = makeHandle({
              pid: executable === pinnedClient.executablePath ? 2 : 1,
              onKill: () => {
                if (executable === olderClient.executablePath) {
                  Deferred.doneUnsafe(olderStopped, Effect.void);
                }
              },
              ...(executable === pinnedClient.executablePath
                ? { output: Stream.fromQueue(output) }
                : {}),
            });
            yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
            return handle;
          }),
        );
        const runtime = yield* buildCloudManagedEndpointRuntime(
          spawner,
          Layer.succeed(
            RelayClient.RelayClient,
            RelayClient.RelayClient.of({
              resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
              install: Deferred.await(releaseInstall).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    installed = true;
                    return pinnedClient;
                  }),
                ),
              ),
              installWithProgress: () => Effect.die("unused"),
              pruneManagedVersions: Deferred.succeed(pruned, undefined).pipe(Effect.asVoid),
            }),
          ),
        );

        const status = yield* runtime.applyConfig({
          providerKind: "cloudflare_tunnel",
          connectorToken: "token",
        });
        expect(status).toMatchObject({ status: "running", pid: 1 });
        expect(yield* Queue.take(spawned)).toBe(olderClient.executablePath);

        yield* Deferred.succeed(releaseInstall, undefined);
        expect(yield* Queue.take(spawned)).toBe(pinnedClient.executablePath);
        expect(Option.isNone(yield* Deferred.poll(olderStopped))).toBe(true);

        yield* Queue.offer(
          output,
          new TextEncoder().encode(
            "2026-10-08T00:00:00Z INF Registered tunnel connection connIndex=0\n",
          ),
        );
        yield* Deferred.await(olderStopped);
        yield* Deferred.await(pruned);
      }),
  );
  it.effect("installs a missing relay client in the background and then starts it", () =>
    Effect.gen(function* () {
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      const spawned = yield* Deferred.make<string>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(
            spawned,
            ChildProcess.isStandardCommand(command) ? command.command : "",
          );
          const handle = makeHandle({ pid: 3, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() =>
              installed
                ? pinnedClient
                : { status: "missing" as const, version: RelayClient.CLOUDFLARED_VERSION },
            ),
            install: Effect.sync(() => {
              installed = true;
              return pinnedClient;
            }),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      expect(status).toMatchObject({ status: "failed", failure: "not-installed" });
      expect(yield* Deferred.await(spawned)).toBe(pinnedClient.executablePath);
    }),
  );
  it.effect("keeps the older connector when the updated relay client fails to start", () =>
    Effect.gen(function* () {
      const olderClient = {
        status: "available",
        executablePath: "/managed/2025.9.0/cloudflared",
        source: "managed",
        version: "2025.9.0",
      } as const;
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      let olderKilled = false;
      const releaseInstall = yield* Deferred.make<void>();
      const pinnedAttempted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const executable = ChildProcess.isStandardCommand(command) ? command.command : "";
          if (executable === pinnedClient.executablePath) {
            yield* Deferred.succeed(pinnedAttempted, undefined);
            return yield* PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
            });
          }
          const handle = makeHandle({
            pid: 6,
            onKill: () => {
              olderKilled = true;
            },
          });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
            install: Deferred.await(releaseInstall).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  installed = true;
                  return pinnedClient;
                }),
              ),
            ),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );
      const config = { providerKind: "cloudflare_tunnel", connectorToken: "token" } as const;
      expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 6 });

      yield* Deferred.succeed(releaseInstall, undefined);
      yield* Deferred.await(pinnedAttempted);
      expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 6 });
      expect(olderKilled).toBe(false);
    }),
  );
  it.effect("requests recovery when the older connector exited during a failed swap", () =>
    Effect.gen(function* () {
      const olderClient = {
        status: "available",
        executablePath: "/managed/2025.9.0/cloudflared",
        source: "managed",
        version: "2025.9.0",
      } as const;
      const pinnedClient = {
        status: "available",
        executablePath: "/managed/pinned/cloudflared",
        source: "managed",
        version: RelayClient.CLOUDFLARED_VERSION,
      } as const;
      let installed = false;
      const releaseInstall = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const executable = ChildProcess.isStandardCommand(command) ? command.command : "";
          if (executable === pinnedClient.executablePath) {
            return yield* PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
            });
          }
          const handle = makeHandle({ pid: 12, onKill: () => {}, isRunning: () => !installed });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(() => (installed ? pinnedClient : olderClient)),
            install: Deferred.await(releaseInstall).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  installed = true;
                  return pinnedClient;
                }),
              ),
            ),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );
      const config = { providerKind: "cloudflare_tunnel", connectorToken: "token" } as const;
      expect(yield* runtime.applyConfig(config)).toMatchObject({ status: "running", pid: 12 });

      yield* Deferred.succeed(releaseInstall, undefined);
      expect(Option.getOrThrow(yield* Stream.runHead(runtime.recoveryRequests))).toEqual(config);
    }),
  );
  it.effect("restarts a self-updated pinned-folder connector once the pin is reinstalled", () =>
    Effect.gen(function* () {
      const executablePath = "/managed/pinned/cloudflared";
      let version = "2026.9.3";
      const releaseInstall = yield* Deferred.make<void>();
      const spawned = yield* Queue.unbounded<string>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Queue.offer(spawned, version);
          const handle = makeHandle({ pid: 7, onKill: () => {} });
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const current = () =>
        ({ status: "available", executablePath, source: "managed", version }) as const;
      const runtime = yield* buildCloudManagedEndpointRuntime(
        spawner,
        Layer.succeed(
          RelayClient.RelayClient,
          RelayClient.RelayClient.of({
            resolve: Effect.sync(current),
            install: Deferred.await(releaseInstall).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  version = RelayClient.CLOUDFLARED_VERSION;
                  return current();
                }),
              ),
            ),
            installWithProgress: () => Effect.die("unused"),
            pruneManagedVersions: Effect.void,
          }),
        ),
      );

      yield* runtime.applyConfig({ providerKind: "cloudflare_tunnel", connectorToken: "token" });
      expect(yield* Queue.take(spawned)).toBe("2026.9.3");
      yield* Deferred.succeed(releaseInstall, undefined);
      expect(yield* Queue.take(spawned)).toBe(RelayClient.CLOUDFLARED_VERSION);
    }),
  );






  const tunnelConfig = {
    providerKind: "cloudflare_tunnel" as const,
    connectorToken: "token",
    tunnelId: "tunnel-1",
  };
  const quicDialWarning =
    '2026-10-16T20:29:43Z ERR Failed to dial a quic connection error="failed to dial to edge with quic: timeout: no recent network activity" connIndex=1\n';
  const quicDatagramWarning =
    '2026-10-16T20:29:41Z ERR Connection terminated error="datagram manager error: timeout: no recent network activity" connIndex=1\n';

  const makeTransportSpawner = Effect.fnUntraced(function* (
    options: {
      transport?: string;
      failSpawn?: number;
      isRunning?: Effect.Effect<boolean>;
    } = {},
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = process.env.TUNNEL_TRANSPORT_PROTOCOL;
        if (options.transport === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
        else process.env.TUNNEL_TRANSPORT_PROTOCOL = options.transport;
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.TUNNEL_TRANSPORT_PROTOCOL;
          else process.env.TUNNEL_TRANSPORT_PROTOCOL = previous;
        }),
    );
    const spawned: Array<ChildProcess.StandardCommand> = [];
    const killed: Array<number> = [];
    const outputs: Array<Queue.Queue<Uint8Array>> = [];
    const exits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
    const started = yield* Queue.unbounded<number>();
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die("Expected standard command.");
        }
        const index = spawned.length;
        spawned.push(command);
        if (index === options.failSpawn) {
          return yield* PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "cloudflared temporarily unavailable",
          });
        }
        const output = yield* Queue.unbounded<Uint8Array>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        outputs[index] = output;
        exits[index] = exit;
        const handle = ChildProcessSpawner.makeHandle({
          ...makeHandle({
            pid: 800 + index,
            exitCode: Deferred.await(exit),
            output: Stream.fromQueue(output),
            onKill: () => {
              killed.push(800 + index);
              Deferred.doneUnsafe(exit, Exit.succeed(ChildProcessSpawner.ExitCode(143)));
            },
          }),
          isRunning: options.isRunning ?? Effect.succeed(true),
        });
        yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
        yield* Queue.offer(started, index);
        return handle;
      }),
    );
    const emit = (index: number, lines: string) =>
      Queue.offer(outputs[index]!, new TextEncoder().encode(lines));
    const observe = (
      runtime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"],
      index: number,
      lines = "",
    ) =>
      emit(
        index,
        lines + "2026-10-16T20:30:00Z INF Registered tunnel connection connIndex=0\n",
      ).pipe(Effect.andThen(Stream.runHead(runtime.tunnelConnected)));
    return { spawner, spawned, killed, exits, started, emit, observe };
  });















});
