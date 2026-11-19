import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Files, UploadError } from "./Files.ts";

// #region show
export const FilesS3 = Layer.effect(
  Files,
  Effect.gen(function* () {
    const bucket = yield* AWS.S3.Bucket("Files");
    const putObject = yield* AWS.S3.PutObject(bucket);

    return {
      upload: (name: string, body: string) =>
        putObject({ Key: name, Body: body }) /*hide*/
          .pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new UploadError({ cause })),
          ) /*end*/,
    };
  }),
) /*hide*/
  .pipe(Layer.provide(AWS.S3.PutObjectHttp)); /*end*/
// #endregion show
