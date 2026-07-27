import type * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Presign from "@distilled.cloud/aws/Presign";
import type * as Region from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";
import {
  PresignPutObject,
  type PresignPutObjectRequest,
} from "./PresignPutObject.ts";

export const PresignPutObjectHttp = Layer.effect(
  PresignPutObject,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Credentials.Credentials | Region.Region
    >();

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.PresignPutObject(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:PutObject"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.PresignPutObject(${bucket.LogicalId})`)(
        function* (request: PresignPutObjectRequest) {
          const bucketName = yield* BucketName;
          return yield* Presign.presignS3Url({
            method: "PUT",
            bucket: bucketName,
            key: request.key,
            expiresIn: request.expiresIn,
            contentType: request.contentType,
          }).pipe(Effect.provideContext(services));
        },
      );
    });
  }),
);
