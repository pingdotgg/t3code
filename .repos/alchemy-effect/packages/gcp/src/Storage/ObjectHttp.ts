import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor, type GcpHttpOp } from "../HttpBinding.ts";
import type { Bucket } from "./Bucket.ts";

/**
 * Grant `role` on the bound bucket's own IAM policy (not the project), the
 * way AWS S3 bindings scope statements to the bucket ARN.
 */
export const GrantOnBucket = Effect.gen(function* () {
  const bind = yield* GCPBindings.Bind;
  return Effect.fn(function* (tag: string, bucket: Bucket, role: string) {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    yield* bind`${tag}(${bucket})`({
      iam: [grantFor({ role, on: "storage.bucket" }, bucket.bucketName)],
    });
  });
});

/**
 * Shared HTTP scaffolding for Cloud Storage object metadata bindings
 * (`DeleteObject`): yields the distilled operation once at Layer
 * construction and injects the bound bucket's name.
 * NOT exported from index.ts.
 */
export const makeObjectHttpBinding = <I extends { bucket?: string }, A, E>(options: {
  tag: string;
  role: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const grantOnBucket = yield* GrantOnBucket;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (bucket: Bucket) {
      yield* grantOnBucket(options.tag, bucket, options.role);
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request: Omit<I, "bucket">,
      ) {
        return yield* run({
          ...request,
          bucket: yield* bucketName,
        } as I);
      });
    });
  });
