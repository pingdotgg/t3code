import type * as iotw from "@distilled.cloud/aws/iot-wireless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WirelessDevice } from "./WirelessDevice.ts";

/**
 * Request for {@link ListQueuedMessages}. The bound device's id is injected
 * automatically.
 */
export interface ListQueuedMessagesRequest extends Omit<
  iotw.ListQueuedMessagesRequest,
  "Id"
> {}

/**
 * Runtime binding for `iotwireless:ListQueuedMessages` — list the downlink
 * messages queued for the bound wireless device from a deployed Lambda or
 * Task.
 *
 * @binding
 * @section Inspecting the Downlink Queue
 * Provide the `ListQueuedMessagesHttp` implementation layer on the Function
 * effect, bind the device in the init phase, then call the returned client
 * at runtime.
 *
 * @example Count Pending Downlinks
 * ```typescript
 * // init
 * const listQueued = yield* AWS.IoTWireless.ListQueuedMessages(device);
 *
 * // runtime
 * const { DownlinkQueueMessagesList } = yield* listQueued();
 * const pending = DownlinkQueueMessagesList?.length ?? 0;
 * // on the Function effect:
 * // .pipe(Effect.provide(AWS.IoTWireless.ListQueuedMessagesHttp))
 * ```
 */
export interface ListQueuedMessages extends Binding.Service<
  ListQueuedMessages,
  "AWS.IoTWireless.ListQueuedMessages",
  (
    device: WirelessDevice,
  ) => Effect.Effect<
    (
      request?: ListQueuedMessagesRequest,
    ) => Effect.Effect<
      iotw.ListQueuedMessagesResponse,
      iotw.ListQueuedMessagesError
    >
  >
> {}
export const ListQueuedMessages = Binding.Service<ListQueuedMessages>(
  "AWS.IoTWireless.ListQueuedMessages",
);
