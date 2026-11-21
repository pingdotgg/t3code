import * as Context from "effect/Context";

import type * as FcmDeliveries from "./FcmDeliveries.ts";
import type * as Ports from "../host/ports.ts";

export class FcmDeliveryQueueSender extends Context.Service<
  FcmDeliveryQueueSender,
  {
    readonly send: Ports.DeliveryQueueSender<FcmDeliveries.FcmDeliveryJob>["send"];
  }
>()("t3code-relay/agentActivity/FcmDeliveryQueueSender") {}
