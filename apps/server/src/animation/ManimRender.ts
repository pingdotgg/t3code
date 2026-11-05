import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const MAX_CODE_BYTES = 64 * 1024;
const MAX_CLIP_BYTES = 8 * 1024 * 1024;

export class ManimUnavailableError extends Schema.TaggedError<ManimUnavailableError>()(
  "ManimUnavailableError",
  {},
) {
  override get message() {
    return "Animations aren't available on this server (Manim isn't installed). Show it as an HTML demo instead.";
  }
}

export class ManimFailedError extends Schema.TaggedError<ManimFailedError>()("ManimFailedError", {
  output: Schema.String,
}) {
  override get message() {
    return `Manim failed. Fix the scene and call again (at most twice); if it still fails, skip the clip and say nothing about it.\n\n${this.output}`;
  }
}

export class ManimClipTooLargeError extends Schema.TaggedError<ManimClipTooLargeError>()(
  "ManimClipTooLargeError",
  {},
) {
  override get message() {
    return "Clip too large; make it shorter.";
  }
}

export class ManimRender extends Context.Service<
  ManimRender,
  {
    readonly render: (
      code: string,
    ) => Effect.Effect<
      Uint8Array,
      ManimUnavailableError | ManimFailedError | ManimClipTooLargeError
    >;
  }
>()("t3/animation/ManimRender") {}

export const make = Effect.fn("ManimRender.make")(function* (command = "manim") {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failed = (cause: unknown) => new ManimFailedError({ output: String(cause) });

  const render = Effect.fn("ManimRender.render")(
    function* (code: string) {
      if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
        return yield* new ManimFailedError({ output: "The scene is larger than 64 KB." });
      }
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-animation-" });
      yield* fileSystem.writeFileString(path.join(directory, "scene.py"), code);
      const media = path.join(directory, "media");
      const result = yield* runner
        .run({
          command,
          args: [
            "-ql",
            "--disable_caching",
            "--media_dir",
            media,
            "-o",
            "lesson",
            "scene.py",
            "Lesson",
          ],
          cwd: directory,
          env: { ...process.env, PYTHONNOUSERSITE: "1" },
          timeout: "120 seconds",
          timeoutBehavior: "timedOutResult",
          outputMode: "truncate",
        })
        .pipe(
          Effect.catchTags({ ProcessSpawnError: () => Effect.fail(new ManimUnavailableError()) }),
        );
      const clipPath = path.join(media, "videos", "scene", "480p15", "lesson.mp4");
      if (result.code !== 0 || result.timedOut || !(yield* fileSystem.exists(clipPath))) {
        const output = `${result.stdout}\n${result.stderr}${result.timedOut ? "\nTimed out after 120 seconds." : ""}`;
        return yield* new ManimFailedError({ output: output.trim().slice(-2500) });
      }
      const clip = yield* fileSystem.readFile(clipPath);
      if (clip.byteLength > MAX_CLIP_BYTES) return yield* new ManimClipTooLargeError();
      return clip;
    },
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (cause) => Effect.fail(failed(cause)),
      ProcessStdinError: (cause) => Effect.fail(failed(cause)),
      ProcessOutputLimitError: (cause) => Effect.fail(failed(cause)),
      ProcessReadError: (cause) => Effect.fail(failed(cause)),
      ProcessTimeoutError: (cause) => Effect.fail(failed(cause)),
    }),
  );

  return ManimRender.of({ render });
});

export const layer = Layer.effect(ManimRender, make()).pipe(Layer.provide(ProcessRunner.layer));
