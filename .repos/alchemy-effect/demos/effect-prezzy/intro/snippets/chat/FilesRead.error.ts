import { R2 } from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Files, UploadError } from "./Files.ts";

// #region show
export const FilesR2 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* R2.Bucket("Files");
    const files = yield* R2.ReadBucket(bucket);

    return {
      upload: (name: string, body: string) =>
        files
          .put(name, body) /*hide*/
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new UploadError({ cause })),
          ) /*end*/,
    };
  }),
) /*hide*/
  .pipe(Layer.provide(R2.ReadBucketBinding)); /*end*/
// #endregion show
