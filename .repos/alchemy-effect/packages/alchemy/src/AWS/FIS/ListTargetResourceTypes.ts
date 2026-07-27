import type * as fis from "@distilled.cloud/aws/fis";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `fis:ListTargetResourceTypes`.
 *
 * Enumerates the resource types FIS experiments can target
 * (`aws:ec2:instance`, `aws:ecs:task`, `aws:rds:cluster`, …). Provide the
 * implementation with `Effect.provide(AWS.FIS.ListTargetResourceTypesHttp)`.
 * @binding
 * @section Browsing the Action Catalog
 * @example List Targetable Resource Types
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listTargetResourceTypes = yield* AWS.FIS.ListTargetResourceTypes();
 *
 * // runtime
 * const { targetResourceTypes } = yield* listTargetResourceTypes();
 * console.log((targetResourceTypes ?? []).map((t) => t.resourceType));
 * ```
 */
export interface ListTargetResourceTypes extends Binding.Service<
  ListTargetResourceTypes,
  "AWS.FIS.ListTargetResourceTypes",
  () => Effect.Effect<
    (
      request?: fis.ListTargetResourceTypesRequest,
    ) => Effect.Effect<
      fis.ListTargetResourceTypesResponse,
      fis.ListTargetResourceTypesError
    >
  >
> {}
export const ListTargetResourceTypes = Binding.Service<ListTargetResourceTypes>(
  "AWS.FIS.ListTargetResourceTypes",
);
