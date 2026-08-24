import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";

export interface ResetConnectorMetadataCacheRequest extends Omit<
  appflow.ResetConnectorMetadataCacheRequest,
  "connectorProfileName"
> {}

/**
 * Runtime binding for `appflow:ResetConnectorMetadataCache`.
 *
 * Bind this operation to a {@link ConnectorProfile} in the function's init
 * phase to get a callable that clears AppFlow's cached entity metadata for
 * the profile, so the next `ListConnectorEntities` /
 * `DescribeConnectorEntity` call fetches fresh metadata from the connected
 * application. The connector profile name is injected automatically and
 * `appflow:ResetConnectorMetadataCache` is granted on the profile. Provide
 * the implementation with
 * `Effect.provide(AWS.AppFlow.ResetConnectorMetadataCacheHttp)`.
 * @binding
 * @section Discovering Connector Entities
 * @example Refresh Cached Entity Metadata
 * ```typescript
 * // init — bind the operation to the connector profile
 * const resetConnectorMetadataCache =
 *   yield* AWS.AppFlow.ResetConnectorMetadataCache(profile);
 *
 * // runtime — drop the cache before re-listing entities
 * yield* resetConnectorMetadataCache();
 * const fresh = yield* listConnectorEntities();
 * ```
 */
export interface ResetConnectorMetadataCache extends Binding.Service<
  ResetConnectorMetadataCache,
  "AWS.AppFlow.ResetConnectorMetadataCache",
  (
    profile: ConnectorProfile,
  ) => Effect.Effect<
    (
      request?: ResetConnectorMetadataCacheRequest,
    ) => Effect.Effect<
      appflow.ResetConnectorMetadataCacheResponse,
      appflow.ResetConnectorMetadataCacheError
    >
  >
> {}

export const ResetConnectorMetadataCache =
  Binding.Service<ResetConnectorMetadataCache>(
    "AWS.AppFlow.ResetConnectorMetadataCache",
  );
