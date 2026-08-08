import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalBucketBinding } from "./BucketLocal.ts";
import { ReadWriteBucket } from "./ReadWriteBucket.ts";
import { makeReadWriteR2HttpClient } from "./ReadWriteBucketHttp.ts";

/**
 * Local implementation of the {@link ReadWriteBucket} binding — reads and
 * writes R2 objects over the Cloudflare HTTP API using the **current
 * credentials** instead of a native Worker binding (`ReadWriteBucketBinding`)
 * or a scoped API token (`ReadWriteBucketHttp`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to use the same
 * `head`/`get`/`list`/`put`/`delete` client you'd use inside a Worker.
 * Multipart uploads are unsupported over the HTTP API (mirrors
 * `ReadWriteBucketHttp`).
 *
 * @example Seeding then reading a bucket from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const r2 = yield* Cloudflare.R2.ReadWriteBucket(bucket);
 *     return Effect.fn(function* () {
 *       yield* r2.put("hello.txt", "Hello, World!");
 *       const object = yield* r2.get("hello.txt");
 *       return object ? yield* object.text() : null;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
 * );
 * ```
 */
export const ReadWriteBucketLocal = Layer.effect(
  ReadWriteBucket,
  Effect.suspend(() => makeLocalBucketBinding(makeReadWriteR2HttpClient)),
);
