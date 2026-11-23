import * as NodeServices from "@effect/platform-node/NodeServices";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { watchDirectoryPath } from "./watchDirectoryReplacements.ts";

it.live.skipIf(!symlinksSupported)(
  "backs off stopped watches for an unchanged linked directory",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped();
      const entry = path.join(base, "linked");
      const first = path.join(base, "first", "themes");
      const second = path.join(base, "second", "themes");
      yield* fs.makeDirectory(first, { recursive: true });
      yield* fs.makeDirectory(second, { recursive: true });
      yield* fs.symlink(first, entry);
      const firstIdentity = yield* fs.stat(first);
      const secondIdentity = yield* fs.stat(second);
      let identity = firstIdentity;
      const events = yield* Queue.unbounded<"probe" | "refresh">();

      // An ended child emits a final refresh, as it does when registration fails.
      yield* watchDirectoryPath(entry, Stream.succeed(undefined), Effect.succeed(false)).pipe(
        Stream.runForEach(() => Queue.offer(events, "refresh")),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            stat: (file) =>
              file === entry
                ? Queue.offer(events, "probe").pipe(Effect.map(() => identity))
                : fs.stat(file),
          }),
        ),
        Effect.forkScoped,
      );
      assert.equal(yield* Queue.take(events), "probe");
      assert.equal(yield* Queue.take(events), "refresh");
      assert.equal(yield* Queue.take(events), "probe");
      assert.equal(yield* Queue.take(events), "refresh");
      assert.equal(yield* Queue.take(events), "probe");
      assert.equal(yield* Queue.take(events), "probe");
      assert.equal(yield* Queue.take(events), "refresh");

      identity = secondIdentity;
      assert.equal(yield* Queue.take(events), "probe");
      assert.equal(yield* Queue.take(events), "refresh");
    }).pipe(Effect.provide(NodeServices.layer)),
);
