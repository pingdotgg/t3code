import * as Cloudflare from "alchemy/Cloudflare";

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
);

export const RelayApnsDeliveryQueue = Cloudflare.Queues.Queue("RelayApnsDeliveryQueue");
