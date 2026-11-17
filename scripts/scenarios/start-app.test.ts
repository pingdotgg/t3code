import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import { prepareHome } from "./start-app.ts";

it.effect.each([
  { code: "EBUSY", tag: "Busy" },
  { code: "ENOTEMPTY", tag: "Unknown" },
  { code: "EPERM", tag: "PermissionDenied" },
] as const)("recreates a home the previous server still holds ($code)", ({ code, tag }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = path.join(yield* fs.makeTempDirectoryScoped(), "home");
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
    yield* fs.writeFileString(path.join(home, "userdata/statev2.sqlite"), "previous run");

    let held = true;
    const preparing = yield* prepareHome(home).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          remove: (target, options) =>
            Effect.suspend(() => {
              if (!held) return fs.remove(target, options);
              held = false;
              return Effect.fail(
                PlatformError.systemError({
                  _tag: tag,
                  module: "FileSystem",
                  method: "remove",
                  pathOrDescriptor: target,
                  cause: Object.assign(new Error(code), { code }),
                }),
              );
            }),
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(preparing);

    expect(yield* fs.exists(path.join(home, "userdata/statev2.sqlite"))).toBe(false);
    expect(yield* fs.exists(path.join(home, "userdata/settings.json"))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
