import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link DeleteQueuedMessages}. The bound device's id is
 * injected automatically. Pass `MessageId: "*"` to purge the whole queue.
 */
export interface DeleteQueuedMessagesRequest extends Omit<
  iotw.DeleteQueuedMessagesRequest,
  "Id"
> {}

/**
 * Runtime binding for `iotwireless:DeleteQueuedMessages` — delete queued
 * downlink messages for the bound wireless device from a deployed Lambda or
 * Task.
 *
 * @binding
 * @section Purging the Downlink Queue
 * Provide the `DeleteQueuedMessagesHttp` implementation layer on the
 * Function effect, bind the device in the init phase, then call the
 * returned client at runtime.
 *
 * @example Purge All Pending Downlinks
 * ```typescript
 * // init
 * const deleteQueued = yield* AWS.IoTWireless.DeleteQueuedMessages(device);
 *
 * // runtime — "*" deletes every queued message
 * yield* deleteQueued({ MessageId: "*" });
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.DeleteQueuedMessagesHttp))
 * ```
 */
export interface DeleteQueuedMessages extends Binding.Service<
  DeleteQueuedMessages,
  "AWS.IoTWireless.DeleteQueuedMessages",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request: DeleteQueuedMessagesRequest,
    ) => Effect.Effect<
      iotw.DeleteQueuedMessagesResponse,
      iotw.DeleteQueuedMessagesError
    >
  >
> {}
export const DeleteQueuedMessages = Binding.Service<DeleteQueuedMessages>(
  "AWS.IoTWireless.DeleteQueuedMessages",
);
