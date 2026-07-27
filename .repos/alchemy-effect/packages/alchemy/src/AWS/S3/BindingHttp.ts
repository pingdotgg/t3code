import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Bucket } from "./Bucket.ts";

/**
 * Shared scaffolding for AWS S3 HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, makeBucketHttpBinding({ … }))` over
 * this builder. Everything except the operation, the IAM action(s), and the
 * IAM resource shape is boilerplate:
 *
 * - the deploy-time half registers `Allow(host, tag(bucket))` with the
 *   requested actions on the bound bucket (object-level `${arn}/*` or the
 *   bucket ARN itself, per `iamResources`);
 * - the runtime callable injects the resolved bucket name as `Bucket`.
 *
 * Genuinely-different bindings stay bespoke: `PresignGetObject` /
 * `PresignPutObject` (SigV4 presigners, not API operations).
 */
export const makeBucketHttpBinding = <
  I extends { Bucket?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.S3.GetObject`. */
  tag: string;
  /** The distilled operation; `Bucket` is injected from the bound bucket. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the bound bucket. */
  actions: readonly string[];
  /**
   * Which ARNs the actions are granted on:
   * - `"objects"` (default): `${bucketArn}/*` — object-level actions
   *   (`s3:GetObject`, `s3:PutObject`, …);
   * - `"bucket"`: the bucket ARN — bucket-level actions (`s3:ListBucket`,
   *   `s3:ListBucketVersions`, `s3:ListBucketMultipartUploads`).
   */
  iamResources?: "objects" | "bucket";
  /**
   * Additionally grant `s3:ListBucket` on the bucket ARN. Required by
   * object-read actions so a missing key surfaces as `NoSuchKey`/`NotFound`
   * (404) instead of `AccessDenied` (403).
   * @see https://repost.aws/articles/ARe3OTZ3SCTWWqGtiJ6aHn8Q/why-does-s-3-return-403-instead-of-404-when-the-object-doesnt-exist
   */
  listBucket?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <B extends Bucket>(bucket: B) {
      const BucketName = yield* bucket.bucketName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${bucket}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource:
                  options.iamResources === "bucket"
                    ? [bucket.bucketArn]
                    : [Output.interpolate`${bucket.bucketArn}/*`],
              },
              ...(options.listBucket
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: ["s3:ListBucket"],
                      Resource: [bucket.bucketArn],
                    },
                  ]
                : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request?: Omit<I, "Bucket">,
      ) {
        return yield* op({
          ...request,
          Bucket: yield* BucketName,
        } as I);
      });
    });
  });
