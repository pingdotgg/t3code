/**
 * Shared types and constants for the Queues binding. This file is imported by
 * both Node.js plugin code and the internal `.worker.ts` broker, so it must
 * not reference Node.js or Workers-specific APIs.
 */

export type QueueContentType = "text" | "json" | "bytes" | "v8";

/** Options for a queue consumer (the worker's `queue()` handler). */
export interface QueueConsumer {
  /** Logical name of the queue this worker consumes. */
  readonly queueName: string;
  /**
   * When set, this consumer's queue is a REAL Cloudflare queue: the runtime
   * attaches a pull loop that drains it via the HTTP pull API (the queue
   * must have an `http_pull` consumer attached) and feeds the batches into
   * the local broker, which delivers them to this worker's `queue()`
   * handler with the usual local batching/retry semantics.
   */
  readonly pull?: {
    /** Id of the real Cloudflare queue to pull from. */
    readonly queueId: string;
    /** Cloudflare account the queue lives in. */
    readonly accountId: string;
  };
  /** Maximum number of messages per batch (0-100, default 5). */
  readonly maxBatchSize?: number;
  /** Maximum seconds to wait before flushing a partial batch (0-60, default 1). */
  readonly maxBatchTimeout?: number;
  /** Maximum number of retries before dropping/dead-lettering (0-100, default 2). */
  readonly maxRetries?: number;
  /** Name of the queue failed messages are moved to after `maxRetries`. */
  readonly deadLetterQueue?: string;
  /** Default delay (seconds, 0-86400) applied to retried messages. */
  readonly retryDelay?: number;
}

/**
 * A producer entry passed to the broker via JSON env. Mirrors
 * {@link QueueProducerOptions} without the binding name.
 */
export interface QueueProducerEntry {
  readonly queueName: string;
  readonly deliveryDelay?: number;
}

/** Env binding names used inside the broker / entry workers. */
export const BINDING_QUEUE_CONSUMER = "QUEUE_CONSUMER";
export const BINDING_QUEUE_PRODUCERS = "QUEUE_PRODUCERS";
export const BINDING_QUEUE_USER_WORKER = "USER_WORKER";
export const BINDING_QUEUE_BROKER = "BROKER";
export const BINDING_QUEUE_NAME = "QUEUE_NAME";

/** Name of the service binding the broker uses to forward to a dead-letter queue. */
export const BINDING_QUEUE_DLQ = (queueName: string): string =>
  `DLQ:${queueName}`;
