import type * as iot from "@distilled.cloud/aws/iot";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListThingsRequest extends iot.ListThingsRequest {}

/**
 * Runtime binding for the `ListThings` operation (IAM action
 * `iot:ListThings`, granted on `*` — the action does not support
 * resource-level permissions).
 *
 * Lists things in the registry, optionally filtered by attribute or thing
 * type. Provide the implementation with
 * `Effect.provide(AWS.IoT.ListThingsHttp)`.
 * @binding
 * @section Registry
 * @example List Things by Attribute
 * ```typescript
 * const listThings = yield* AWS.IoT.ListThings();
 *
 * const { things } = yield* listThings({
 *   attributeName: "location",
 *   attributeValue: "warehouse-a",
 * });
 * ```
 */
export interface ListThings extends Binding.Service<
  ListThings,
  "AWS.IoT.ListThings",
  () => Effect.Effect<
    (
      request?: ListThingsRequest,
    ) => Effect.Effect<iot.ListThingsResponse, iot.ListThingsError>
  >
> {}

export const ListThings = Binding.Service<ListThings>("AWS.IoT.ListThings");
