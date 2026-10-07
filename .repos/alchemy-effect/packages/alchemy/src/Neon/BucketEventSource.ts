import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Bucket } from "./Bucket.ts";
import type { BucketEvent } from "./FunctionTriggerEvent.ts";

export interface BucketEventSourceProps {
  /** Unique trigger and route name. */ name: string;
  /** Byte-exact object-key prefix. */ prefix?: string;
  /** Enable future delivery. @default true */ enabled?: boolean;
}
export type BucketEventSourceService = <R = never>(
  bucket: Bucket,
  props: BucketEventSourceProps,
  handler: (event: BucketEvent) => Effect.Effect<void, unknown, R>,
) => Effect.Effect<void, never, Exclude<R, RuntimeContext | Scope>>;
/**
 * Subscribe a Neon Function to successful uploads in a same-branch bucket.
 * Registers the handler route and creates a tracked FunctionTrigger automatically.
 * Provide BucketEventSourceHttp on the Function initialization Effect. The trigger
 * is deleted before its Function/bucket. Use invocationId for application idempotency.
 * Delivery is HTTP POST, not a queue: no acknowledgement, retry or exactly-once
 * policy is added. Local development does not generate cloud upload events.
 *
 * ### Process Uploads
 * **Example:** Register an upload handler
 * ```typescript
 * yield* Neon.BucketEventSource(uploads, { name: "Uploads", prefix: "incoming/" }, event => Effect.log(event.objectKey));
 * ```
 *
 * @binding
 * @product Bucket
 */
export interface BucketEventSource extends Binding.Service<
  BucketEventSource,
  "Neon.BucketEventSource",
  BucketEventSourceService
> {
  <R = never>(
    bucket: Bucket,
    props: BucketEventSourceProps,
    handler: (event: BucketEvent) => Effect.Effect<void, unknown, R>,
  ): Effect.Effect<
    void,
    never,
    BucketEventSource | Exclude<R, RuntimeContext | Scope>
  >;
}
export const BucketEventSource = Binding.Service<BucketEventSource>(
  "Neon.BucketEventSource",
);
