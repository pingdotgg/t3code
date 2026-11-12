import { expect, it } from "@alchemy.run/test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeFileLog } from "../src/FileLog.ts";

it.live("preserves stray output appended between captured log writes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-file-log-",
    });
    const file = path.join(root, "run.log");
    const log = yield* makeFileLog(file);
    yield* Effect.sync(() =>
      log.appendHookLine("file", {
        level: "info",
        message: "before",
        time: new Date(0),
      }),
    );
    yield* fs.writeFileString(file, "stray-output\n", { flag: "a" });
    yield* Effect.sync(() =>
      log.appendTestLine("test", {
        level: "info",
        message: "after",
        time: new Date(0),
      }),
    );
    yield* log.close;
    yield* log.close;
    expect(yield* fs.readFileString(file)).toBe(
      "[hook file] before\nstray-output\n[test test] after\n",
    );
  }).pipe(Effect.provide(BunServices.layer)),
);
