import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";

export interface CompleteMultipartUploadRequest extends Omit<
  S3.CompleteMultipartUploadRequest,
  "Bucket"
> {}

export class CompleteMultipartUpload extends Binding.Service<
  CompleteMultipartUpload,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: CompleteMultipartUploadRequest,
    ) => Effect.Effect<
      S3.CompleteMultipartUploadOutput,
      S3.CompleteMultipartUploadError
    >
  >
>()("AWS.S3.CompleteMultipartUpload") {}

export const CompleteMultipartUploadLive = Layer.effect(
  CompleteMultipartUpload,
  Effect.gen(function* () {
    const Policy = yield* CompleteMultipartUploadPolicy;
    const completeMultipartUpload = yield* S3.completeMultipartUpload;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: CompleteMultipartUploadRequest) {
        return yield* completeMultipartUpload({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class CompleteMultipartUploadPolicy extends Binding.Policy<
  CompleteMultipartUploadPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.CompleteMultipartUpload") {}

export const CompleteMultipartUploadPolicyLive =
  CompleteMultipartUploadPolicy.layer.succeed(
    Effect.fn(function* (host, bucket) {
      if (isFunction(host)) {
        yield* host.bind`Allow(${host}, AWS.S3.CompleteMultipartUpload(${bucket}))`(
          {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["s3:PutObject"],
                Resource: [Output.interpolate`${bucket.bucketArn}/*`],
              },
            ],
          },
        );
      } else {
        return yield* Effect.die(
          `CompleteMultipartUploadPolicy does not support runtime '${host.Type}'`,
        );
      }
    }),
  );
