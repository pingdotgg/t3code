import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as RelayClient from "@t3tools/shared/relayClient";

import {
  classifyRelayClientOutput,
  makeCloudManagedEndpointRuntime,
} from "./ManagedEndpointRuntime.ts";

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

const runtimeDependencies = (spawner: ReturnType<typeof ChildProcessSpawner.make>) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    relayClientAvailableLayer,
  );

function makeHandle(input: {
  readonly pid: number;
  readonly onKill: () => void;
  readonly isRunning?: () => boolean;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(input.pid),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.sync(() => input.isRunning?.() ?? true),
    kill: () =>
      Effect.sync(() => {
        input.onKill();
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("CloudManagedEndpointRuntime", () => {
  it("classifies Cloudflare connection and warning output", () => {
    expect(
      classifyRelayClientOutput(
        "2026-06-17T02:00:00Z INF Registered tunnel connection connIndex=0",
      ),
    ).toBe("connected");
    expect(
      classifyRelayClientOutput("2026-06-17T02:00:00Z ERR Failed to serve tunnel connection"),
    ).toBe("warning");
    expect(classifyRelayClientOutput("2026-06-17T02:00:00Z INF Starting metrics server")).toBe(
      "debug",
    );
  });

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
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(runtimeDependencies(spawner)),
      );

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
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(runtimeDependencies(spawner)),
      );

      const started = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });
      const unsupported = yield* runtime.applyConfig({
        providerKind: "manual",
        connectorToken: "manual-token",
      });

      expect(started.status).toBe("running");
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
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(runtimeDependencies(spawner)),
      );
      const config = {
        providerKind: "cloudflare_tunnel" as const,
        connectorToken: "token",
        tunnelId: "tunnel-1",
      };

      const first = yield* runtime.applyConfig(config);
      firstRunning = false;
      const second = yield* runtime.applyConfig(config);

      expect(first).toMatchObject({ status: "running", pid: 300 });
      expect(second).toMatchObject({ status: "running", pid: 301 });
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
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(runtimeDependencies(spawner)),
      );

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
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(runtimeDependencies(spawner)),
      );

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
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(runtimeDependencies(spawner)),
      );

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

  it.effect("reports a missing relay client executable without spawning", () =>
    Effect.gen(function* () {
      const spawn = vi.fn();
      const spawner = ChildProcessSpawner.make(spawn);
      const runtime = yield* makeCloudManagedEndpointRuntime.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Layer.succeed(
              RelayClient.RelayClient,
              RelayClient.RelayClient.of({
                resolve: Effect.succeed({
                  status: "missing",
                  version: RelayClient.CLOUDFLARED_VERSION,
                }),
                install: Effect.die("unused"),
                installWithProgress: () => Effect.die("unused"),
              }),
            ),
          ),
        ),
      );

      const status = yield* runtime.applyConfig({
        providerKind: "cloudflare_tunnel",
        connectorToken: "token",
      });

      expect(status).toEqual({
        status: "failed",
        providerKind: "cloudflare_tunnel",
        reason: "The relay client is not installed.",
      });
      expect(spawn).not.toHaveBeenCalled();
    }),
  );
});
