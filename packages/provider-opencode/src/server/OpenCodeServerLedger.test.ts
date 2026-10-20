// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

const SERVE_ARGS = ["serve", "--hostname=127.0.0.1", "--port=4096"];

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

// A group of zombies can be reaped between a check and the kill, so ESRCH just means it is gone.
const killGroup = (pgid: number) =>
  Effect.sync(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  });

const spawnGroup = (args: ReadonlyArray<string>, script = "sleep 600 & wait") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn("/bin/sh", ["-c", script, ...args], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const exited = yield* Deferred.make<NodeJS.Signals | null>();
      const printed = yield* Deferred.make<void>();
      child.once("exit", (_code, signal) => Deferred.doneUnsafe(exited, Effect.succeed(signal)));
      child.stdout.once("data", () => Deferred.doneUnsafe(printed, Effect.void));
      const pid = child.pid;
      if (pid === undefined) return yield* Effect.die("spawn failed");
      return { pid, exited: Deferred.await(exited), printed: Deferred.await(printed) };
    }),
    ({ pid }) => killGroup(pid),
  );

const recordFromDeadServer = (stateDir: string, server: { readonly pid: number }) =>
  Effect.gen(function* () {
    const previousServer = yield* spawnGroup([]);
    const previousLedger = yield* OpenCodeServerLedger.make({
      stateDir,
      ownerPid: previousServer.pid,
    });
    yield* Effect.asVoid(previousLedger.track({ pid: server.pid, port: 4096, args: SERVE_ARGS }));
    process.kill(-previousServer.pid, "SIGKILL");
    yield* previousServer.exited;
  });

const hostPlatform = HostProcess.Platform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux" ? ["linux", "darwin"] : hostPlatform === "darwin" ? ["darwin"] : [];

describe.each(observedPlatforms)("OpenCodeServerLedger observing as %s", (platform) => {
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provide(NodeServices.layer),
    );

  it.live("stops an OpenCode server group left by a server that died", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const orphan = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, orphan);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toHaveLength(1);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(yield* orphan.exited).toBe("SIGTERM");
      expect(groupExists(orphan.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("records a group whose spawned wrapper already exited", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      // The inner shell prints once it has exec'd. Until then it still carries the wrapper's
      // command line, and recording that would make the reaper skip the group as recycled.
      const wrapper = yield* spawnGroup(
        SERVE_ARGS,
        '/bin/sh -c "echo ready; sleep 600 & wait" "$0" "$@" & exit 0',
      );
      yield* wrapper.exited;
      yield* wrapper.printed;
      expect(groupExists(wrapper.pid)).toBe(true);

      yield* recordFromDeadServer(stateDir, wrapper);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toHaveLength(1);

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(wrapper.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("leaves a recycled pid alone when its start time does not match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "opencode-servers", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace(/"startTime":"[^"]+"/, '"startTime":"1"'));

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves a serve process on another port alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "opencode-servers", `${unrelated.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace("--port=4096", "--port=4097"));

      const restarted = yield* OpenCodeServerLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves the servers of a running T3 server alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const running = yield* OpenCodeServerLedger.make({ stateDir });
      const server = yield* spawnGroup(SERVE_ARGS);
      const forget = yield* running.track({ pid: server.pid, port: 4096, args: SERVE_ARGS });

      const other = yield* OpenCodeServerLedger.make({ stateDir });
      yield* other.reapOrphans;
      expect(groupExists(server.pid)).toBe(true);

      yield* forget;
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );
});

describe.skipIf(observedPlatforms.length === 0)("OpenCode server startup", () => {
  it.live("stops the group when interrupted while the server is being recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-startup-" });
      const binaryPath = path.join(tempDir, "opencode");
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\nsleep 600 &\nexit 0\n");
      yield* fs.chmod(binaryPath, 0o755);

      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const recording = yield* Deferred.make<number>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const layerRuntime = OpenCodeRuntime.layer.pipe(
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner
                .spawn(command)
                .pipe(Effect.tap((handle) => Deferred.succeed(spawned, handle))),
            ),
          ),
        ),
        Layer.provide(
          Layer.succeed(
            OpenCodeServerLedger.OpenCodeServerLedger,
            OpenCodeServerLedger.OpenCodeServerLedger.of({
              track: (server) =>
                Effect.gen(function* () {
                  yield* (yield* Deferred.await(spawned)).exitCode.pipe(Effect.ignore);
                  yield* Deferred.succeed(recording, server.pid);
                  return yield* Effect.never;
                }),
            }),
          ),
        ),
      );

      const serverScope = yield* Scope.make();
      const starting = yield* OpenCodeRuntime.OpenCodeRuntime.pipe(
        Effect.flatMap((runtime) =>
          runtime.startOpenCodeServerProcess({ binaryPath, directory: tempDir, port: 4096 }),
        ),
        Effect.provideService(Scope.Scope, serverScope),
        Effect.provide(layerRuntime),
        Effect.forkChild,
      );
      const pgid = yield* Deferred.await(recording);
      yield* Effect.addFinalizer(() => killGroup(pgid));
      expect(groupExists(pgid)).toBe(true);

      yield* Fiber.interrupt(starting);
      yield* Scope.close(serverScope, Exit.void);

      expect(groupExists(pgid)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
