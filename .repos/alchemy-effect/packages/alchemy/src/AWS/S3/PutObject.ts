import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";

export interface PutObjectRequest extends Omit<S3.PutObjectRequest, "Bucket"> {}

/**
 * Runtime binding for `s3:PutObject`.
 *
 * Bind this operation to a bucket to get a callable that writes objects without
 * manually supplying the bucket name on every request.
 *
 * @section Writing Objects
 * @example Put an Object
 * ```typescript
 * const putObject = yield* PutObject.bind(bucket);
 *
 * yield* putObject({
 *   Key: "hello.txt",
 *   Body: "Hello, world!",
 *   ContentType: "text/plain",
 * });
 * ```
 */
export class PutObject extends Binding.Service<
  PutObject,
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: PutObjectRequest,
    ) => Effect.Effect<S3.PutObjectOutput, S3.PutObjectError>
  >
>()("AWS.S3.PutObject") {}

export const PutObjectLive = Layer.effect(
  PutObject,
  Effect.gen(function* () {
    const bind = yield* PutObjectPolicy;
    const putObject = yield* S3.putObject;

    return Effect.fn(function* (bucket: Bucket) {
      const BucketName = yield* bucket.bucketName;
      yield* bind(bucket);
      return Effect.fn(function* (request: PutObjectRequest) {
        return yield* putObject({
          ...request,
          Bucket: yield* BucketName,
        });
      });
    });
  }),
);

export class PutObjectPolicy extends Binding.Policy<
  PutObjectPolicy,
  (bucket: Bucket) => Effect.Effect<void>
>()("AWS.S3.PutObject") {}

export const PutObjectPolicyLive = PutObjectPolicy.layer.succeed(
  Effect.fn(function* (host, bucket) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.S3.PutObject(${bucket}))`({
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
        `PutObjectPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
