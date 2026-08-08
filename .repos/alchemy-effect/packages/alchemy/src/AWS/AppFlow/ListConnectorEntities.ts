import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";

export interface ListConnectorEntitiesRequest extends Omit<
  appflow.ListConnectorEntitiesRequest,
  "connectorProfileName"
> {}

/**
 * Runtime binding for `appflow:ListConnectorEntities`.
 *
 * Bind this operation to a {@link ConnectorProfile} in the function's init
 * phase to get a callable that discovers the entities the connected
 * application exposes (e.g. Salesforce objects, database tables) — useful for
 * dynamic schema discovery at runtime. The connector profile name is injected
 * automatically and `appflow:ListConnectorEntities` is granted on the
 * profile. Provide the implementation with
 * `Effect.provide(AWS.AppFlow.ListConnectorEntitiesHttp)`.
 * @binding
 * @section Discovering Connector Entities
 * @example List the Entities Behind a Connector Profile
 * ```typescript
 * // init — bind the operation to the connector profile
 * const listConnectorEntities =
 *   yield* AWS.AppFlow.ListConnectorEntities(profile);
 *
 * // runtime — enumerate the connector's entities
 * const result = yield* listConnectorEntities();
 * // result.connectorEntityMap groups entities by category
 * ```
 */
export interface ListConnectorEntities extends Binding.Service<
  ListConnectorEntities,
  "AWS.AppFlow.ListConnectorEntities",
  (
    profile: ConnectorProfile,
  ) => Effect.Effect<
    (
      request?: ListConnectorEntitiesRequest,
    ) => Effect.Effect<
      appflow.ListConnectorEntitiesResponse,
      appflow.ListConnectorEntitiesError
    >
  >
> {}

export const ListConnectorEntities = Binding.Service<ListConnectorEntities>(
  "AWS.AppFlow.ListConnectorEntities",
);
