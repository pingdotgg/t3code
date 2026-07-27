import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface PostLineageEventRequest extends Omit<
  datazone.PostLineageEventInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:PostLineageEvent`.
 *
 * Posts an OpenLineage run event to the bound domain, recording the lineage of a data transformation the function performed. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.PostLineageEventHttp)`.
 * @binding
 * @section Data Lineage
 * @example Emit a Lineage Event
 * ```typescript
 * // init — bind the operation to the domain
 * const postLineageEvent = yield* AWS.DataZone.PostLineageEvent(domain);
 *
 * // runtime
 * yield* postLineageEvent({ event: JSON.stringify(openLineageRunEvent) });
 * ```
 */
export interface PostLineageEvent extends Binding.Service<
  PostLineageEvent,
  "AWS.DataZone.PostLineageEvent",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: PostLineageEventRequest,
    ) => Effect.Effect<
      datazone.PostLineageEventOutput,
      datazone.PostLineageEventError
    >
  >
> {}
export const PostLineageEvent = Binding.Service<PostLineageEvent>(
  "AWS.DataZone.PostLineageEvent",
);
