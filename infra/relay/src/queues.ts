import * as Cloudflare from "alchemy/Cloudflare";

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
);

export const RelayApnsDeliveryQueue = Cloudflare.Queue("RelayApnsDeliveryQueue");
