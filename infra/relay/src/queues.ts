import * as Cloudflare from "alchemy/Cloudflare";

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
);

export const RelayApnsDeliveryQueue = Cloudflare.Queues.Queue("RelayApnsDeliveryQueue");

export const RelayWebPushDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayWebPushDeliveryDeadLetterQueue",
);

export const RelayWebPushDeliveryQueue = Cloudflare.Queues.Queue("RelayWebPushDeliveryQueue");
export const RelayFcmDeliveryQueue = Cloudflare.Queues.Queue("RelayFcmDeliveryQueue");
export const RelayFcmDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayFcmDeliveryDeadLetterQueue",
);
