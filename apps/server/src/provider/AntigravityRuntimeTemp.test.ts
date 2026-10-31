import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AntigravityRuntimeTemp from "./AntigravityRuntimeTemp.ts";

it.layer(NodeServices.layer)("AntigravityRuntimeTemp", (it) => {
  it.effect("cleans up when Node is available only in the provider environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const actualNode = yield* HostProcess.ExecutablePath;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-node-" });
      yield* Effect.gen(function* () {
        const cleanup = yield* AntigravityRuntimeTemp.make(path.join(root, "gc"));
        const pending = yield* cleanup.makeDirectory.pipe(
          Effect.provideService(HostProcess.Environment, { PATH: path.dirname(actualNode) }),
          Effect.scoped,
        );
        yield* cleanup.drain;
        expect(yield* fs.exists(pending)).toBe(false);
      }).pipe(
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.ExecutablePath, path.join(root, "t3-server")),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the provider environment when spawning cleanup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const environment = yield* HostProcess.Environment;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-env-" });
      const cleanup = yield* AntigravityRuntimeTemp.make(path.join(root, "gc")).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
            return spawner.spawn(
              ChildProcess.make(
                command.command,
                [
                  "--eval",
                  `if (process.env.T3_CLEANUP_RUNTIME_TEST !== "provider") process.exit(126); ${command.args[1]}`,
                  command.args[2]!,
                ],
                command.options,
              ),
            );
          }),
        ),
      );
      const pending = yield* cleanup.makeDirectory.pipe(
        Effect.provideService(HostProcess.Environment, {
          ...environment,
          T3_CLEANUP_RUNTIME_TEST: "provider",
        }),
        Effect.scoped,
      );
      yield* cleanup.drain;
      expect(yield* fs.exists(pending)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("hands off slow cleanup, bounds deletion, and preserves live siblings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-" });
      const directory = path.join(root, "gc");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let starts = 0;
      const cleanup = yield* AntigravityRuntimeTemp.make(directory).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              starts += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* spawner.spawn(command);
            }),
          ),
        ),
      );
      const liveScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(liveScope, exit));
      const live = yield* cleanup.makeDirectory.pipe(Effect.provideService(Scope.Scope, liveScope));
      yield* fs.writeFileString(path.join(live, "keep.txt"), "live");
      yield* cleanup.makeDirectory.pipe(Effect.scoped);
      yield* Deferred.await(entered);
      for (let index = 0; index < 7; index += 1) {
        yield* cleanup.makeDirectory.pipe(Effect.scoped);
      }
      expect(yield* cleanup.makeDirectory.pipe(Effect.scoped, Effect.flip)).toBeInstanceOf(
        AntigravityRuntimeTemp.BacklogFullError,
      );
      expect(starts).toBe(1);
      expect((yield* fs.readDirectory(directory)).length).toBe(9);
      expect(yield* fs.readFileString(path.join(live, "keep.txt"))).toBe("live");
      yield* Deferred.succeed(release, undefined);
      yield* cleanup.drain;
      expect(yield* fs.readDirectory(directory)).toEqual([path.basename(live)]);
      yield* cleanup.makeDirectory.pipe(Effect.scoped);
      yield* Scope.close(liveScope, Exit.void);
      yield* cleanup.drain;
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("retries failed cleanup without dropping pending directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-retry-" });
      const pending = path.join(root, "run-failed");
      yield* fs.makeDirectory(pending);
      const finished = yield* Queue.unbounded<void>();
      let fail = true;
      yield* AntigravityRuntimeTemp.make(root).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Queue.offer(finished, undefined));
              return yield* spawner.spawn(
                fail && command._tag === "StandardCommand"
                  ? ChildProcess.make(
                      command.command,
                      ["--eval", "process.exit(1)"],
                      command.options,
                    )
                  : command,
              );
            }),
          ),
        ),
      );
      yield* Queue.take(finished);
      expect(yield* fs.exists(pending)).toBe(true);
      fail = false;
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(finished);
      expect(yield* fs.readDirectory(path.dirname(pending))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts stalled cleanup on shutdown and recovers the directory on restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-cleanup-restart-" });
      const directory = path.join(root, "gc");
      const serviceScope = yield* Scope.make();
      const entered = yield* Deferred.make<void>();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const children: ChildProcessSpawner.ChildProcessHandle[] = [];
      const first = yield* AntigravityRuntimeTemp.make(directory).pipe(
        Effect.provideService(Scope.Scope, serviceScope),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              if (command._tag !== "StandardCommand")
                return yield* Effect.die("Unexpected pipeline");
              const child = yield* spawner.spawn(
                ChildProcess.make(command.command, ["--eval", "process.stdin.resume()"], {
                  ...command.options,
                  stdin: "pipe",
                }),
              );
              children.push(child);
              yield* Deferred.succeed(entered, undefined);
              return child;
            }),
          ),
        ),
      );
      const pending = yield* first.makeDirectory.pipe(Effect.scoped);
      yield* Deferred.await(entered);
      yield* Scope.close(serviceScope, Exit.void);
      expect(children).toHaveLength(1);
      for (const child of children) expect(yield* child.isRunning).toBe(false);
      expect(yield* fs.exists(pending)).toBe(true);
      const second = yield* AntigravityRuntimeTemp.make(directory);
      yield* second.drain;
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
