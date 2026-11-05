import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ManimRender from "./ManimRender.ts";

const SCENE = "from manim import *\nclass Lesson(Scene): pass\n";

/** Renders SCENE with a fake `manim` whose body is `script` (null: no executable at all). */
const renderWith = (script: string | null) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const command = path.join(yield* fileSystem.makeTempDirectoryScoped(), "manim");
    if (script !== null) {
      yield* fileSystem.writeFileString(command, `#!/bin/sh\n${script}\n`);
      yield* fileSystem.chmod(command, 0o755);
    }
    const manim = yield* ManimRender.make(command);
    return yield* manim.render(SCENE);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer)),
  );

describe("ManimRender", () => {
  it.effect("returns the clip Manim wrote at the 480p path", () =>
    Effect.gen(function* () {
      // $4 is --media_dir.
      const clip = yield* renderWith(
        'mkdir -p "$4/videos/scene/480p15" && printf fake-mp4 > "$4/videos/scene/480p15/lesson.mp4"',
      );
      assert.strictEqual(new TextDecoder().decode(clip), "fake-mp4");
    }),
  );

  it.effect("carries Manim's traceback when the render fails", () =>
    Effect.gen(function* () {
      const failure = yield* renderWith("echo 'Traceback ... NameError' >&2; exit 1").pipe(
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "ManimFailedError");
      assert.include(failure.message, "Traceback ... NameError");
    }),
  );

  it.effect("says animations are unavailable when Manim is missing", () =>
    Effect.gen(function* () {
      const failure = yield* renderWith(null).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "ManimUnavailableError");
    }),
  );
});
