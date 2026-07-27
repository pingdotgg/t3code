import type * as ram from "@distilled.cloud/aws/ram";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ram:ListResourceTypes`.
 *
 * Lists the resource types that can be shared through RAM.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListResourceTypesHttp)`.
 * @binding
 * @section Discovering Shares & Shared Resources
 * @example List the Shareable Resource Types
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResourceTypes = yield* AWS.RAM.ListResourceTypes();
 *
 * // runtime
 * const { resourceTypes } = yield* listResourceTypes();
 * ```
 */
export interface ListResourceTypes extends Binding.Service<
  ListResourceTypes,
  "AWS.RAM.ListResourceTypes",
  () => Effect.Effect<
    (
      request?: ram.ListResourceTypesRequest,
    ) => Effect.Effect<
      ram.ListResourceTypesResponse,
      ram.ListResourceTypesError
    >
  >
> {}
export const ListResourceTypes = Binding.Service<ListResourceTypes>(
  "AWS.RAM.ListResourceTypes",
);
