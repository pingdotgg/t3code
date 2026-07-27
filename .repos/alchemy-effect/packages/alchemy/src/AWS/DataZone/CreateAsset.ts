import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface CreateAssetRequest extends Omit<
  datazone.CreateAssetInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:CreateAsset`.
 *
 * Creates an asset in the bound domain's inventory, e.g. to register data produced by the function itself. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.CreateAssetHttp)`.
 * @binding
 * @section Publishing Assets
 * @example Register an Asset
 * ```typescript
 * // init — bind the operation to the domain
 * const createAsset = yield* AWS.DataZone.CreateAsset(domain);
 *
 * // runtime
 * const asset = yield* createAsset({
 *   name: "daily-orders",
 *   typeIdentifier: "amazon.datazone.S3ObjectCollectionAssetType",
 *   owningProjectIdentifier: projectId,
 * });
 * ```
 */
export interface CreateAsset extends Binding.Service<
  CreateAsset,
  "AWS.DataZone.CreateAsset",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: CreateAssetRequest,
    ) => Effect.Effect<datazone.CreateAssetOutput, datazone.CreateAssetError>
  >
> {}
export const CreateAsset = Binding.Service<CreateAsset>(
  "AWS.DataZone.CreateAsset",
);
