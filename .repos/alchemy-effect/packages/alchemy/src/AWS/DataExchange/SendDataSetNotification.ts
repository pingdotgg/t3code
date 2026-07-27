import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSet } from "./DataSet.ts";

/**
 * Runtime binding for `dataexchange:SendDataSetNotification`.
 *
 * Sends a provider-generated notification about the bound data set to
 * its subscribers (`DATA_UPDATE`, `DATA_DELAY`, `SCHEMA_CHANGE`, or
 * `DEPRECATION`) — delivered to each subscriber's default EventBridge
 * bus. The data set id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.SendDataSetNotificationHttp)`.
 * @binding
 * @section Notifying Subscribers
 * @example Announce A Data Update
 * ```typescript
 * const notify = yield* AWS.DataExchange.SendDataSetNotification(dataSet);
 *
 * // runtime — after publishing a new revision
 * yield* notify({ Type: "DATA_UPDATE", Comment: "Daily prices refreshed" });
 * ```
 */
export interface SendDataSetNotification extends Binding.Service<
  SendDataSetNotification,
  "AWS.DataExchange.SendDataSetNotification",
  (
    dataSet: DataSet,
  ) => Effect.Effect<
    (
      request: Omit<dataexchange.SendDataSetNotificationRequest, "DataSetId">,
    ) => Effect.Effect<
      dataexchange.SendDataSetNotificationResponse,
      dataexchange.SendDataSetNotificationError
    >
  >
> {}
export const SendDataSetNotification = Binding.Service<SendDataSetNotification>(
  "AWS.DataExchange.SendDataSetNotification",
);
