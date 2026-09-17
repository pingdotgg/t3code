import type * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type * as FcmDeliveries from "./FcmDeliveries.ts";

export class FcmDeliveryQueueSender extends Context.Service<
  FcmDeliveryQueueSender,
  {
    readonly send: (
      body: FcmDeliveries.FcmDeliveryJob,
    ) => Effect.Effect<void, Cloudflare.Queues.SendError>;
  }
>()("t3code-relay/agentActivity/FcmDeliveryQueueSender") {}
