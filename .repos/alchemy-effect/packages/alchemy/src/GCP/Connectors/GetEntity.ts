import type * as connectors from "@distilled.cloud/gcp/connectors_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ConnectionsEntityTypesEntity } from "./ConnectionsEntityTypesEntity.ts";

export interface GetEntityRequest extends Omit<
  connectors.GetProjectsLocationsConnectionsEntityTypesEntitiesRequest,
  "name"
> {}

/**
 * Runtime binding for Integration Connectors `entities.get`.
 *
 * Bind this operation to a {@link ConnectionsEntityTypesEntity} in a
 * Function/Action init phase. Provide {@link GetEntityHttp}.
 *
 * ### Reading an Entity
 * **Example:** Get the current row
 * ```typescript
 * const getEntity = yield* GCP.Connectors.GetEntity(account);
 * const live = yield* getEntity();
 * ```
 *
 * @binding
 * @category Connectors
 */
export interface GetEntity extends Binding.Service<
  GetEntity,
  "GCP.Connectors.GetEntity",
  (
    entity: ConnectionsEntityTypesEntity,
  ) => Effect.Effect<
    (
      request?: GetEntityRequest,
    ) => Effect.Effect<
      connectors.Entity,
      connectors.GetProjectsLocationsConnectionsEntityTypesEntitiesError,
      RuntimeContext
    >
  >
> {}

export const GetEntity = Binding.Service<GetEntity>("GCP.Connectors.GetEntity");
