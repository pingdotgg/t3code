import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface CreateAssetRevisionRequest extends Omit<
  datazone.CreateAssetRevisionInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:CreateAssetRevision`.
 *
 * Creates a new revision of an existing asset in the bound domain, e.g. after a schema change. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.CreateAssetRevisionHttp)`.
 * @binding
 * @section Publishing Assets
 * @example Revise an Asset
 * ```typescript
 * // init — bind the operation to the domain
 * const createAssetRevision = yield* AWS.DataZone.CreateAssetRevision(domain);
 *
 * // runtime
 * yield* createAssetRevision({ identifier: assetId, name: "daily-orders" });
 * ```
 */
export interface CreateAssetRevision extends Binding.Service<
  CreateAssetRevision,
  "AWS.DataZone.CreateAssetRevision",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: CreateAssetRevisionRequest,
    ) => Effect.Effect<
      datazone.CreateAssetRevisionOutput,
      datazone.CreateAssetRevisionError
    >
  >
> {}
export const CreateAssetRevision = Binding.Service<CreateAssetRevision>(
  "AWS.DataZone.CreateAssetRevision",
);
