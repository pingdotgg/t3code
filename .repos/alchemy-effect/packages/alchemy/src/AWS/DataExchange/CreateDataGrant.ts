import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:CreateDataGrant`.
 *
 * Creates a data grant sharing an owned data set with another AWS
 * account directly (without an AWS Marketplace product). The receiver
 * must accept the grant to get an entitled copy of the data set.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.CreateDataGrantHttp)`.
 * @binding
 * @section Data Grants
 * @example Grant A Data Set To Another Account
 * ```typescript
 * const createDataGrant = yield* AWS.DataExchange.CreateDataGrant();
 *
 * // runtime
 * const grant = yield* createDataGrant({
 *   Name: "prices-for-analytics",
 *   SourceDataSetId: dataSetId,
 *   ReceiverPrincipal: "111122223333",
 *   GrantDistributionScope: "NONE",
 * });
 * ```
 */
export interface CreateDataGrant extends Binding.Service<
  CreateDataGrant,
  "AWS.DataExchange.CreateDataGrant",
  () => Effect.Effect<
    (
      request: dataexchange.CreateDataGrantRequest,
    ) => Effect.Effect<
      dataexchange.CreateDataGrantResponse,
      dataexchange.CreateDataGrantError
    >
  >
> {}
export const CreateDataGrant = Binding.Service<CreateDataGrant>(
  "AWS.DataExchange.CreateDataGrant",
);
