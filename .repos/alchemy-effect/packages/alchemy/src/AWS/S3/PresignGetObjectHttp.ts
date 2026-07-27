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
  PresignGetObject,
  type PresignGetObjectRequest,
} from "./PresignGetObject.ts";

export const PresignGetObjectHttp = Layer.effect(
  PresignGetObject,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      Credentials.Credentials | Region.Region
    >();

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.S3.PresignGetObject(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:GetObjectVersion"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.S3.PresignGetObject(${bucket.LogicalId})`)(
        function* (request: PresignGetObjectRequest) {
          const bucketName = yield* BucketName;
          return yield* Presign.presignS3Url({
            method: "GET",
            bucket: bucketName,
            key: request.key,
            expiresIn: request.expiresIn,
            responseContentType: request.contentType,
          }).pipe(Effect.provideContext(services));
        },
      );
    });
  }),
);
