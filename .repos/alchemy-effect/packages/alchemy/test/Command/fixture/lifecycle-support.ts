import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";

export const pidAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      )
        return false;
      throw error;
    }
  });

export const assertDead = (pid: number) =>
  pidAlive(pid).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: (alive) => !alive,
      times: 120,
    }),
    Effect.flatMap((alive) =>
      alive
        ? Effect.fail(new Error(`Fixture PID ${pid} survived cleanup`))
        : Effect.void,
    ),
  );

export const pgid = (pid: number) =>
  ChildProcess.make("ps", ["-o", "pgid=", "-p", String(pid)]).pipe(
    Effect.flatMap((child) =>
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
    ),
    Effect.map((text) => Number(text.trim())),
    Effect.scoped,
  );

export const lifecycleFixture = Effect.fn(function* (mode = "cooperative") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "command-lifecycle-",
  });
  const entry = yield* path.fromFileUrl(
    new URL("./lifecycle.ts", import.meta.url),
  );
  const manifest = path.join(directory, "pids.json");
  const read = fs
    .readFileString(manifest)
    .pipe(
      Effect.map(
        (text) => JSON.parse(text) as { wrapper: number; leaf: number },
      ),
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(manifest))) return;
      const pids = yield* read;
      yield* Effect.sync(() => {
        for (const pid of [pids.leaf, pids.wrapper]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      });
    }).pipe(Effect.orDie),
  );
  const ready = fs.exists(path.join(directory, "wrapper.ready")).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("25 millis"),
      until: Boolean,
      times: 300,
    }),
    Effect.andThen(read),
  );
  return {
    directory,
    entry,
    ready,
    props: {
      command: `bun run ${entry}`,
      env: { LIFECYCLE_DIR: directory, LIFECYCLE_MODE: mode },
    },
    crash: fs.writeFileString(path.join(directory, "crash"), "crash"),
    has: (name: string) => fs.exists(path.join(directory, name)),
  };
});
