import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalBucketBinding } from "./BucketLocal.ts";
import { WriteBucket } from "./WriteBucket.ts";
import { makeWriteR2HttpClient } from "./WriteBucketHttp.ts";

/**
 * Local implementation of the {@link WriteBucket} binding — writes R2 objects
 * over the Cloudflare HTTP API using the **current credentials** instead of a
 * native Worker binding (`WriteBucketBinding`) or a scoped API token
 * (`WriteBucketHttp`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to write a bucket
 * with the same `put`/`delete` client you'd use inside a Worker. Multipart
 * uploads are unsupported over the HTTP API (mirrors `WriteBucketHttp`).
 *
 * @example Seeding a bucket from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const r2 = yield* Cloudflare.R2.WriteBucket(bucket);
 *     return Effect.fn(function* () {
 *       yield* r2.put("hello.txt", "Hello, World!");
 *     });
 *   }).pipe(Effect.provide(Cloudflare.R2.WriteBucketLocal)),
 * );
 * ```
 */
export const WriteBucketLocal = Layer.effect(
  WriteBucket,
  Effect.suspend(() => makeLocalBucketBinding(makeWriteR2HttpClient)),
);
