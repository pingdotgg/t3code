import type * as appflow from "@distilled.cloud/aws/appflow";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConnectorProfile } from "./ConnectorProfile.ts";

export interface DescribeConnectorEntityRequest extends Omit<
  appflow.DescribeConnectorEntityRequest,
  "connectorProfileName"
> {}

/**
 * Runtime binding for `appflow:DescribeConnectorEntity`.
 *
 * Bind this operation to a {@link ConnectorProfile} in the function's init
 * phase to get a callable that describes one entity's fields (the data model
 * of a Salesforce object, a database table, etc.). The connector profile name
 * is injected automatically and `appflow:DescribeConnectorEntity` is granted
 * on the profile. Provide the implementation with
 * `Effect.provide(AWS.AppFlow.DescribeConnectorEntityHttp)`.
 * @binding
 * @section Discovering Connector Entities
 * @example Describe an Entity's Fields
 * ```typescript
 * // init — bind the operation to the connector profile
 * const describeConnectorEntity =
 *   yield* AWS.AppFlow.DescribeConnectorEntity(profile);
 *
 * // runtime — read the entity's field metadata
 * const result = yield* describeConnectorEntity({
 *   connectorEntityName: "Account",
 * });
 * // result.connectorEntityFields lists each field with its type
 * ```
 */
export interface DescribeConnectorEntity extends Binding.Service<
  DescribeConnectorEntity,
  "AWS.AppFlow.DescribeConnectorEntity",
  (
    profile: ConnectorProfile,
  ) => Effect.Effect<
    (
      request: DescribeConnectorEntityRequest,
    ) => Effect.Effect<
      appflow.DescribeConnectorEntityResponse,
      appflow.DescribeConnectorEntityError
    >
  >
> {}

export const DescribeConnectorEntity = Binding.Service<DescribeConnectorEntity>(
  "AWS.AppFlow.DescribeConnectorEntity",
);
