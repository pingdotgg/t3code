import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Layer from "effect/Layer";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  PlatformServices,
  runMain,
  httpServer,
} from "alchemy/Util/PlatformServices";

const mode = process.env.LIFECYCLE_MODE ?? "cooperative";
const leaf = process.env.LIFECYCLE_LEAF === "1";
const directory = process.env.LIFECYCLE_DIR!;

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prefix = path.join(directory, leaf ? "leaf" : "wrapper");
  if (mode !== "cooperative") {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onTerm = () =>
          Effect.runFork(
            fs
              .writeFileString(`${prefix}.term`, "TERM")
              .pipe(
                Effect.andThen(
                  mode === "early-exit" && !leaf
                    ? Effect.sync(() => process.exit(0))
                    : Effect.void,
                ),
              ),
          );
        process.on("SIGTERM", onTerm);
        return onTerm;
      }),
      (listener) =>
        Effect.sync(() => {
          process.removeListener("SIGTERM", listener);
        }),
    );
  }
  if (leaf) {
    yield* fs.writeFileString(`${prefix}.ready`, "ready");
  } else {
    const entry = yield* path.fromFileUrl(new URL(import.meta.url));
    const child = yield* ChildProcess.make("bun", ["run", entry], {
      detached: mode === "cooperative",
      env: { LIFECYCLE_LEAF: "1" },
      extendEnv: true,
      stdout: "ignore",
      stderr: "inherit",
      forceKillAfter: "200 millis",
    });
    const pid = yield* Effect.sync(() => process.pid);
    yield* fs.writeFileString(
      path.join(directory, "pids.json"),
      JSON.stringify({ wrapper: pid, leaf: child.pid }),
    );
    yield* fs.exists(path.join(directory, "leaf.ready")).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        until: Boolean,
        times: 500,
      }),
    );
    if (mode === "cooperative") {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* fs.writeFileString(`${prefix}.term`, "TERM");
          yield* Effect.sleep("150 millis");
          yield* child
            .kill({ forceKillAfter: "200 millis" })
            .pipe(Effect.ignore);
          yield* fs.writeFileString(`${prefix}.clean`, "clean");
        }).pipe(Effect.orDie),
      );
    }
    yield* fs.writeFileString(path.join(directory, "wrapper.ready"), "ready");
    const server = yield* HttpServer.HttpServer;
    yield* server.serve(Effect.succeed(HttpServerResponse.text("ready")));
    yield* fs.writeFileString(
      path.join(directory, "url"),
      HttpServer.formatAddress(server.address),
    );
    yield* Effect.sync(() =>
      console.log(HttpServer.formatAddress(server.address)),
    );
  }
  if (mode === "crash" && !leaf) {
    yield* fs.exists(path.join(directory, "crash")).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 millis"),
        until: Boolean,
        times: 1000,
      }),
    );
    yield* Effect.sync(() => process.exit(2));
  }
  yield* Effect.never;
});
const runnable = program.pipe(
  Effect.scoped,
  Effect.provide(
    Layer.provideMerge(
      httpServer(0, "127.0.0.1", { gracefulShutdownTimeout: 0 }),
      PlatformServices,
    ),
  ),
);
if (mode === "cooperative") runMain(runnable);
else
  void Effect.runPromise(runnable).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
