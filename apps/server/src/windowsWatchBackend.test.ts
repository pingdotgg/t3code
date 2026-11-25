import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as WindowsWatchBackend from "./windowsWatchBackend.ts";

const layerWindowsFs = NodeServices.layer.pipe(Layer.provide(WindowsWatchBackend.layer));

it.effect("returns Option.none on non-Windows platforms", () =>
  Effect.gen(function* () {
    const backend = yield* WindowsWatchBackend.make;
    const result = backend.register("/tmp", { type: "Directory" } as FileSystem.File.Info);
    assert.isTrue(Option.isNone(result));
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it.live.runIf(HostProcess.Platform.defaultValue() === "win32")(
  "closes a watched directory stream when the directory is removed while downstream is busy",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-watch-" });
      const watched = path.join(root, "worktree-meta");
      yield* fs.makeDirectory(watched);
      yield* fs.writeFileString(path.join(watched, "HEAD"), "ref: refs/heads/main\n");

      const ready = yield* Deferred.make<void>();
      const firstEvent = yield* Deferred.make<void>();
      const releaseDownstream = yield* Deferred.make<void>();
      let eventsSeen = 0;

      const fiber = yield* fs
        .watch(watched, {
          onReady: () => Deferred.doneUnsafe(ready, Exit.void),
        })
        .pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              eventsSeen++;
            }),
          ),
          Stream.mapEffect(() =>
            Deferred.succeed(firstEvent, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDownstream)),
            ),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );

      yield* Deferred.await(ready);
      yield* fs.remove(watched, { recursive: true });
      yield* Deferred.await(firstEvent);
      yield* Deferred.succeed(releaseDownstream, undefined);
      yield* Fiber.join(fiber).pipe(Effect.timeout("5 seconds"));

      assert.isAbove(eventsSeen, 0);
      assert.isBelow(eventsSeen, 50);
    }).pipe(Effect.scoped, Effect.provide(layerWindowsFs)),
);
