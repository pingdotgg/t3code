import * as Cloudflare from "@alchemy.run/cloudflare";

// Nothing consumes the dead-letter queues, and their jobs carry push tokens and thread titles.
const DEAD_LETTER_RETENTION_SECONDS = 24 * 60 * 60;

export const RelayApnsDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayApnsDeliveryDeadLetterQueue",
  { messageRetentionPeriod: DEAD_LETTER_RETENTION_SECONDS },
);

export const RelayApnsDeliveryQueue = Cloudflare.Queues.Queue("RelayApnsDeliveryQueue");

export const RelayFcmDeliveryQueue = Cloudflare.Queues.Queue("RelayFcmDeliveryQueue");
export const RelayFcmDeliveryDeadLetterQueue = Cloudflare.Queues.Queue(
  "RelayFcmDeliveryDeadLetterQueue",
  { messageRetentionPeriod: DEAD_LETTER_RETENTION_SECONDS },
);
