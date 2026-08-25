import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface GetAssetRequest extends Omit<
  datazone.GetAssetInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetAsset`.
 *
 * Reads an asset in the bound domain — its forms, glossary terms, and latest revision. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetAssetHttp)`.
 * @binding
 * @section Searching the Catalog
 * @example Read an Asset
 * ```typescript
 * // init — bind the operation to the domain
 * const getAsset = yield* AWS.DataZone.GetAsset(domain);
 *
 * // runtime
 * const asset = yield* getAsset({ identifier: assetId });
 * ```
 */
export interface GetAsset extends Binding.Service<
  GetAsset,
  "AWS.DataZone.GetAsset",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetAssetRequest,
    ) => Effect.Effect<datazone.GetAssetOutput, datazone.GetAssetError>
  >
> {}
export const GetAsset = Binding.Service<GetAsset>("AWS.DataZone.GetAsset");
