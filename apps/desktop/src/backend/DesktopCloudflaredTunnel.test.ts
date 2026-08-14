import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as RelayClient from "@t3tools/shared/relayClient";

import * as DesktopCloudflaredTunnel from "./DesktopCloudflaredTunnel.ts";

const relayClientLayer = Layer.succeed(
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

function makeHandle(
  pid: number,
  onKill: () => Effect.Effect<void, never>,
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, never> = Effect.never,
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(pid),
    exitCode,
    isRunning: Effect.succeed(true),
    kill: onKill,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function buildRuntime(spawner: ReturnType<typeof ChildProcessSpawner.make>) {
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      DesktopCloudflaredTunnel.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            relayClientLayer,
          ),
        ),
      ),
    );
    return yield* Effect.service(DesktopCloudflaredTunnel.DesktopCloudflaredTunnel).pipe(
      Effect.provide(context),
    );
  });
}

describe("DesktopCloudflaredTunnel", () => {
  it.effect("starts one configured process, rotates it, and stops it when disabled", () =>
    Effect.gen(function* () {
      const commands: Array<ChildProcess.StandardCommand> = [];
      const killed: Array<number> = [];
      let nextPid = 100;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            throw new Error("Expected standard command");
          commands.push(command);
          const pid = nextPid++;
          const handle = makeHandle(pid, () => Effect.sync(() => killed.push(pid)));
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildRuntime(spawner);

      const first = yield* runtime.apply({ enabled: true, configPath: "/tmp/first.yml" });
      yield* runtime.apply({ enabled: true, configPath: "/tmp/first.yml" });
      const second = yield* runtime.apply({ enabled: true, configPath: "/tmp/second.yml" });
      const disabled = yield* runtime.apply({ enabled: false, configPath: "/tmp/second.yml" });

      expect(first.status).toBe("running");
      expect(second.status).toBe("running");
      expect(disabled.status).toBe("disabled");
      expect(commands.map((command) => command.args)).toEqual([
        ["tunnel", "--config", "/tmp/first.yml", "run"],
        ["tunnel", "--config", "/tmp/second.yml", "run"],
      ]);
      expect(killed).toEqual([100, 101]);
    }),
  );

  it.effect("preserves meaningful whitespace in the config path", () =>
    Effect.gen(function* () {
      const commands: Array<ChildProcess.StandardCommand> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            throw new Error("Expected standard command");
          commands.push(command);
          const handle = makeHandle(150, () => Effect.void);
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildRuntime(spawner);

      yield* runtime.apply({ enabled: true, configPath: " /tmp/tunnel.yml " });

      expect(commands[0]?.args).toEqual(["tunnel", "--config", " /tmp/tunnel.yml ", "run"]);
    }),
  );

  it.effect("fails clearly when enabled without a config path", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.sync(() => {
          spawnCount += 1;
          throw new Error("spawn should not be called");
        }),
      );
      const runtime = yield* buildRuntime(spawner);

      const state = yield* runtime.apply({ enabled: true, configPath: null });

      expect(state).toEqual({
        status: "failed",
        enabled: true,
        configPath: null,
        pid: null,
        error: "A cloudflared config file is required.",
      });
      expect(spawnCount).toBe(0);
    }),
  );

  it.effect("reports a spawn failure", () =>
    Effect.gen(function* () {
      const spawnCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: "cloudflared",
        description: "spawn failed",
      });
      const spawner = ChildProcessSpawner.make(() => Effect.fail(spawnCause));
      const runtime = yield* buildRuntime(spawner);

      const state = yield* runtime.apply({ enabled: true, configPath: "/tmp/tunnel.yml" });

      expect(state.status).toBe("failed");
      expect(state.error).toBe("cloudflared could not be started.");
    }),
  );

  it.effect("marks an unexpectedly exited process as failed", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const handle = makeHandle(
            200,
            () => Effect.void,
            Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(1))),
          );
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildRuntime(spawner);
      yield* runtime.apply({ enabled: true, configPath: "/tmp/tunnel.yml" });

      yield* Deferred.succeed(exited, undefined);
      yield* Effect.yieldNow;

      const state = yield* runtime.getState;
      expect(state.status).toBe("failed");
      expect(state.error).toBe("cloudflared exited with code 1.");
    }),
  );

  it.effect("does not replace a process that failed to stop", () =>
    Effect.gen(function* () {
      let nextPid = 300;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          const pid = nextPid++;
          const handle = makeHandle(pid, () => Effect.die("kill failed"));
          yield* Effect.addFinalizer(() => handle.kill().pipe(Effect.ignore));
          return handle;
        }),
      );
      const runtime = yield* buildRuntime(spawner);
      yield* runtime.apply({ enabled: true, configPath: "/tmp/first.yml" });

      const state = yield* runtime.apply({ enabled: true, configPath: "/tmp/second.yml" });

      expect(state.status).toBe("running");
      expect(state.configPath).toBe("/tmp/first.yml");
      expect(state.pid).toBe(300);
      expect(state.error).toBe("The previous cloudflared process could not be stopped.");
      expect(nextPid).toBe(301);
    }),
  );
});
