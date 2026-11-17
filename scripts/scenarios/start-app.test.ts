import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { prepareHome } from "./start-app.ts";

// The previous run's server is still closing the database it holds in the home.
const removeBusyOnce = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let busy = true;
    return FileSystem.FileSystem.of({
      ...fs,
      remove: (path, options) =>
        Effect.suspend(() => {
          if (!busy) return fs.remove(path, options);
          busy = false;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "Busy",
              module: "FileSystem",
              method: "remove",
              pathOrDescriptor: `${path}/userdata/statev2.sqlite`,
            }),
          );
        }),
    });
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect("recreates a home whose database the previous server has not let go of yet", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(yield* fs.makeTempDirectoryScoped(), "home");
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
    yield* fs.writeFileString(path.join(home, "userdata/statev2.sqlite"), "previous run");

    const preparing = yield* prepareHome(home).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(preparing);

    expect(yield* fs.exists(path.join(home, "userdata/statev2.sqlite"))).toBe(false);
    expect(yield* fs.exists(path.join(home, "userdata/settings.json"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(removeBusyOnce)),
);
