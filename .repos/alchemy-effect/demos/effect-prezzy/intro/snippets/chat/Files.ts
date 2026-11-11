import { R2 } from "@alchemy.run/cloudflare";
import type * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
// #region service
export class UploadError extends Data.TaggedError("UploadError")<{ cause: unknown }> {}

export class Files extends Context.Service<
  Files,
  {
    upload(name: string, body: string): Effect.Effect<void, UploadError, Alchemy.RuntimeContext>;
  }
>()("Files") {}
// #endregion service
// #region live

export const FilesR2 = Layer.effect(
  Files,
  Effect.gen(function* () {
    // #region construct
    // #region bucket
    const bucket = yield* R2.Bucket("Files");
    // #endregion bucket
    // #region binding
    const files = yield* R2.ReadWriteBucket(bucket);
    // #endregion binding
    // #endregion construct
    // #region methods

    return {
      upload: (name: string, body: string) =>
        files
          .put(name, body) /*hide*/
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new UploadError({ cause })),
          ) /*end*/,
    };
    // #endregion methods
  }),
) /*hide*/
  .pipe(Layer.provide(R2.ReadWriteBucketBinding)); /*end*/
// #endregion live
// #endregion show
