import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Host-neutral shapes the relay logic depends on. Cloudflare and Node hosts implement them.

export class DeliveryQueueSendError extends Schema.TaggedError<DeliveryQueueSendError>()(
  "DeliveryQueueSendError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not enqueue a relay delivery job.";
  }
}

export class QueueHandlerError extends Schema.TaggedError<QueueHandlerError>()(
  "QueueHandlerError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "A relay delivery job failed and will be retried.";
  }
}

export class RateLimitUnavailableError extends Schema.TaggedError<RateLimitUnavailableError>()(
  "RateLimitUnavailableError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The rate limiter is unavailable.";
  }
}

export interface DeliveryQueueSender<A> {
  readonly send: (body: A) => Effect.Effect<void, DeliveryQueueSendError>;
}

/** One queued delivery job. The consumer settles it once, with `ack` or `retry`. */
export interface DeliveryQueueMessage {
  readonly body: unknown;
  readonly ack: Effect.Effect<void>;
  /** Redelivers the job after the retry delay; past `maxRetries` the host drops or dead-letters it. */
  readonly retry: (error: QueueHandlerError) => Effect.Effect<void>;
}

export interface DeliveryQueueConsumerOptions {
  readonly batchSize: number;
  readonly maxRetries: number;
  readonly retryDelay: `${number} seconds`;
  readonly deadLetterQueue?: string;
}
