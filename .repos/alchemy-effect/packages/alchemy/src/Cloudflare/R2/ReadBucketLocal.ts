import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLocalBucketBinding } from "./BucketLocal.ts";
import { ReadBucket } from "./ReadBucket.ts";
import { makeReadR2HttpClient } from "./ReadBucketHttp.ts";

/**
 * Local implementation of the {@link ReadBucket} binding — reads R2 objects
 * over the Cloudflare HTTP API using the **current credentials** instead of a
 * native Worker binding (`ReadBucketBinding`) or a scoped API token
 * (`ReadBucketHttp`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) to read a bucket
 * with the same `head`/`get`/`list` client you'd use inside a Worker.
 *
 * @example Reading an object from an Action
 * ```typescript
 * const Read = Alchemy.Action(
 *   "Read",
 *   Effect.gen(function* () {
 *     const r2 = yield* Cloudflare.R2.ReadBucket(bucket);
 *     return Effect.fn(function* () {
 *       const object = yield* r2.get("hello.txt");
 *       return object ? yield* object.text() : null;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.R2.ReadBucketLocal)),
 * );
 * ```
 */
export const ReadBucketLocal = Layer.effect(
  ReadBucket,
  Effect.suspend(() => makeLocalBucketBinding(makeReadR2HttpClient)),
);
