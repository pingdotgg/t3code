// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import * as ProviderProcessLedger from "./ProviderProcessLedger.ts";

const SERVE_ARGS = ["serve", "--hostname=127.0.0.1", "--port=4096"];

const groupExists = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const killGroup = (pgid: number) =>
  Effect.sync(() => {
    if (groupExists(pgid)) process.kill(-pgid, "SIGKILL");
  });

/**
 * Spawns a throwaway process group shaped like `opencode serve`: by default a
 * shell leader whose argv ends in the serve arguments, plus a `sleep` member.
 */
const spawnGroup = (args: ReadonlyArray<string>, script = "sleep 600 & wait") =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const child = NodeChildProcess.spawn("/bin/sh", ["-c", script, ...args], {
        detached: true,
        stdio: "ignore",
      });
      const exited = yield* Deferred.make<NodeJS.Signals | null>();
      child.once("exit", (_code, signal) => Deferred.doneUnsafe(exited, Effect.succeed(signal)));
      const pid = child.pid;
      if (pid === undefined) return yield* Effect.die("spawn failed");
      return { pid, exited: Deferred.await(exited) };
    }),
    ({ pid }) => killGroup(pid),
  );

/** A T3 server that recorded its OpenCode server and then died without cleanup. */
const recordFromDeadServer = (stateDir: string, server: { readonly pid: number }) =>
  Effect.gen(function* () {
    const previousServer = yield* spawnGroup([]);
    const previousLedger = yield* ProviderProcessLedger.make({
      stateDir,
      ownerPid: previousServer.pid,
    });
    // The previous server never gets to forget its entry.
    yield* Effect.asVoid(
      previousLedger.track({ pid: server.pid, args: SERVE_ARGS, label: "OpenCode server" }),
    );
    process.kill(-previousServer.pid, "SIGKILL");
    yield* previousServer.exited;
  });

const hostPlatform = HostProcessPlatform.defaultValue();
// procps accepts the same `ps` flags as macOS, so Linux also covers the macOS path.
const observedPlatforms: ReadonlyArray<NodeJS.Platform> =
  hostPlatform === "linux" ? ["linux", "darwin"] : hostPlatform === "darwin" ? ["darwin"] : [];

describe.each(observedPlatforms)("ProviderProcessLedger observing as %s", (platform) => {
  const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provide(NodeServices.layer),
    );

  it.live("stops an OpenCode server group left by a server that died", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const orphan = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, orphan);
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toHaveLength(1);

      const restarted = yield* ProviderProcessLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(yield* orphan.exited).toBe("SIGTERM");
      expect(groupExists(orphan.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("stops an OpenCode server recorded by a server from before the shared ledger", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const orphan = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, orphan);
      const entryPath = path.join(stateDir, "provider-processes", `${orphan.pid}.json`);
      const entry = yield* fs.readFileString(entryPath);
      const command = `/bin/sh -c sleep 600 & wait ${SERVE_ARGS.join(" ")}`;
      const commandHash = NodeCrypto.createHash("sha256").update(command).digest("hex");
      const recorded = `"commandHash":"${commandHash}","label":"OpenCode server"`;
      expect(entry).toContain(recorded);
      // What an older server wrote: the raw command line and port, in its own directory.
      yield* fs.remove(entryPath);
      yield* fs.makeDirectory(path.join(stateDir, "opencode-servers"));
      yield* fs.writeFileString(
        path.join(stateDir, "opencode-servers", `${orphan.pid}.json`),
        entry.replace(recorded, `"command":"${command}","port":4096`),
      );

      const restarted = yield* ProviderProcessLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(yield* orphan.exited).toBe("SIGTERM");
      expect(yield* fs.readDirectory(path.join(stateDir, "opencode-servers"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("records a group whose spawned wrapper already exited", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      // The wrapper starts the serve process in its group and exits.
      const wrapper = yield* spawnGroup(
        SERVE_ARGS,
        '/bin/sh -c "sleep 600 & wait" "$0" "$@" & exit 0',
      );
      yield* wrapper.exited;
      expect(groupExists(wrapper.pid)).toBe(true);

      yield* recordFromDeadServer(stateDir, wrapper);
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toHaveLength(1);

      const restarted = yield* ProviderProcessLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(wrapper.pid)).toBe(false);
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toEqual([]);
    }).pipe(provideHost),
  );

  it.live("leaves a recycled pid alone when its start time does not match", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "provider-processes", `${unrelated.pid}.json`);
      // Same pid, a different process: what a recycled pid looks like.
      const entry = yield* fs.readFileString(entryPath);
      yield* fs.writeFileString(entryPath, entry.replace(/"startTime":"[^"]+"/, '"startTime":"1"'));

      const restarted = yield* ProviderProcessLedger.make({ stateDir });
      yield* restarted.reapOrphans;

      expect(groupExists(unrelated.pid)).toBe(true);
      expect(yield* fs.exists(entryPath)).toBe(false);
    }).pipe(provideHost),
  );

  it.live("leaves a process with another command line alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-ledger-" });
      const unrelated = yield* spawnGroup(SERVE_ARGS);
      yield* recordFromDeadServer(stateDir, unrelated);
      const entryPath = path.join(stateDir, "provider-processes", `${unrelated.pid}.json`);
      // Same pid and start second, but not the process T3 started.
      const entry = yield* fs.readFileString(entryPath);
      expect(entry).not.toContain("--port=4096");
      yield* fs.writeFileString(
        entryPath,
        entry.replace(/"commandHash":"[^"]+"/, `"commandHash":"${"0".repeat(64)}"`),
      );

      const restarted = yield* ProviderProcessLedger.make({ stateDir });
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
      const running = yield* ProviderProcessLedger.make({ stateDir });
      const server = yield* spawnGroup(SERVE_ARGS);
      const forget = yield* running.track({
        pid: server.pid,
        args: SERVE_ARGS,
        label: "OpenCode server",
      });

      const other = yield* ProviderProcessLedger.make({ stateDir });
      yield* other.reapOrphans;
      expect(groupExists(server.pid)).toBe(true);

      yield* forget;
      expect(yield* fs.readDirectory(path.join(stateDir, "provider-processes"))).toEqual([]);
    }).pipe(provideHost),
  );
});

describe.skipIf(observedPlatforms.length === 0)("OpenCode server startup", () => {
  it.live("stops the group when interrupted while the server is being recorded", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-startup-" });
      // A wrapper that leaves the serve process running in its group and exits 0,
      // which the spawner's own cleanup does not stop.
      const binaryPath = path.join(tempDir, "opencode");
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\nsleep 600 &\nexit 0\n");
      yield* fs.chmod(binaryPath, 0o755);

      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const recording = yield* Deferred.make<number>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtimeLayer = OpenCodeRuntime.OpenCodeRuntimeLive.pipe(
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
            ProviderProcessLedger.ProviderProcessLedger,
            ProviderProcessLedger.ProviderProcessLedger.of({
              // Recording stalls until the scope is interrupted, after the wrapper exited.
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
        Effect.provide(runtimeLayer),
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
