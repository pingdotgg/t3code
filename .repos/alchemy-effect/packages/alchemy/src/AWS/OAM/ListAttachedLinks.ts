import type * as oam from "@distilled.cloud/aws/oam";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Sink } from "./Sink.ts";

/**
 * Request for {@link ListAttachedLinks} — the bound sink's ARN is injected
 * as `SinkIdentifier`, so only pagination knobs remain.
 */
export interface ListAttachedLinksRequest extends Omit<
  oam.ListAttachedLinksInput,
  "SinkIdentifier"
> {}

/**
 * Runtime binding for `oam:ListAttachedLinks` — enumerate the source-account
 * links attached to the bound monitoring-account {@link Sink} (each item
 * carries the link's ARN, resolved label, and shared resource types). The
 * sink's ARN is injected automatically.
 *
 * Provide `AWS.OAM.ListAttachedLinksHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Listing Attached Links
 * @example Enumerate the source accounts connected to a sink
 * ```typescript
 * // init — grants oam:ListAttachedLinks on the sink
 * const listAttachedLinks = yield* AWS.OAM.ListAttachedLinks(sink);
 *
 * // runtime
 * const { Items } = yield* listAttachedLinks();
 * for (const item of Items) {
 *   yield* Effect.log(`${item.Label} shares ${item.ResourceTypes?.join(", ")}`);
 * }
 * ```
 */
export interface ListAttachedLinks extends Binding.Service<
  ListAttachedLinks,
  "AWS.OAM.ListAttachedLinks",
  (
    sink: Sink,
  ) => Effect.Effect<
    (
      request?: ListAttachedLinksRequest,
    ) => Effect.Effect<oam.ListAttachedLinksOutput, oam.ListAttachedLinksError>
  >
> {}

export const ListAttachedLinks = Binding.Service<ListAttachedLinks>(
  "AWS.OAM.ListAttachedLinks",
);
