import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";

export interface GetObjectRequest extends Omit<S3.GetObjectRequest, "Bucket"> {}

export class GetObject extends Binding.Service<
  GetObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: GetObjectRequest,
    ) => Effect.Effect<S3.GetObjectOutput, S3.GetObjectError>
  >
>()("AWS.S3.GetObject") {}

export const GetObjectLive = Layer.effect(
  GetObject,
  Effect.gen(function* () {
    const Policy = yield* GetObjectPolicy;
    const getObject = yield* S3.getObject;

    return Effect.fn(function* (bucket: Bucket) {
      const b = bucket.bucketName;
      const BucketName = yield* b;
      yield* Policy(bucket);
      return Effect.fn(function* (request: GetObjectRequest) {
        return yield* getObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class GetObjectPolicy extends Binding.Policy<
  GetObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.GetObject") {}

export const GetObjectPolicyLive = GetObjectPolicy.layer.succeed(
  Effect.fn(function* (host, bucket) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.S3.GetObject(${bucket}))`({
        policyStatements: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:GetObjectVersion"],
            Resource: [Output.interpolate`${bucket.bucketArn}/*`],
          },
          {
            Effect: "Allow",
            Action: [
              // ListBucket is required to check if the object exists (otherwise a non-existent key returns 403)
              // https://repost.aws/articles/ARe3OTZ3SCTWWqGtiJ6aHn8Q/why-does-s-3-return-403-instead-of-404-when-the-object-doesnt-exist
              "s3:ListBucket",
            ],
            Resource: [bucket.bucketArn],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `GetObjectPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
