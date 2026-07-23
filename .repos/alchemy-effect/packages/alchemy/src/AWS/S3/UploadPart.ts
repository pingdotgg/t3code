import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";

export interface UploadPartRequest extends Omit<
  S3.UploadPartRequest,
  "Bucket"
> {}

export class UploadPart extends Binding.Service<
  UploadPart,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: UploadPartRequest,
    ) => Effect.Effect<S3.UploadPartOutput, S3.UploadPartError>
  >
>()("AWS.S3.UploadPart") {}

export const UploadPartLive = Layer.effect(
  UploadPart,
  Effect.gen(function* () {
    const Policy = yield* UploadPartPolicy;
    const uploadPart = yield* S3.uploadPart;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* Policy(bucket);
      return Effect.fn(function* (request: UploadPartRequest) {
        return yield* uploadPart({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class UploadPartPolicy extends Binding.Policy<
  UploadPartPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.UploadPart") {}

export const UploadPartPolicyLive = UploadPartPolicy.layer.succeed(
  Effect.fn(function* (host, bucket: Bucket) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.S3.UploadPart(${bucket}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["s3:PutObject"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `UploadPartPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
