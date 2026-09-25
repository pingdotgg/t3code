import type {
  DurableObjectNamespace,
  ExportedHandler,
  Fetcher,
  FetcherQueueResult,
  MessageBatchMetadata,
  ServiceBindingQueueMessage,
} from "@cloudflare/workers-types/experimental";
import { DurableObject } from "cloudflare:workers";
import { HttpError } from "../../internal/shared.worker.ts";
import type {
  QueueConsumer,
  QueueContentType,
  QueueProducerEntry,
} from "./QueueOptions.shared.ts";
import {
  BINDING_QUEUE_BROKER,
  BINDING_QUEUE_CONSUMER,
  BINDING_QUEUE_DLQ,
  BINDING_QUEUE_NAME,
  BINDING_QUEUE_PRODUCERS,
  BINDING_QUEUE_USER_WORKER,
} from "./QueueOptions.shared.ts";

interface BrokerEnv {
  [BINDING_QUEUE_BROKER]: DurableObjectNamespace;
  [BINDING_QUEUE_USER_WORKER]: Fetcher;
  [BINDING_QUEUE_NAME]: string;
  [BINDING_QUEUE_CONSUMER]?: QueueConsumer;
  [BINDING_QUEUE_PRODUCERS]?: ReadonlyArray<QueueProducerEntry>;
  [binding: string]: unknown;
}

const QUEUE_CONTENT_TYPES: ReadonlyArray<QueueContentType> = [
  "text",
  "json",
  "bytes",
  "v8",
];
const MAX_MESSAGE_SIZE_BYTES = 128 * 1000;
const MAX_MESSAGE_BATCH_COUNT = 100;
const MAX_MESSAGE_BATCH_SIZE = (256 + 32) * 1000;

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_BATCH_TIMEOUT = 1; // seconds
const DEFAULT_RETRIES = 2;

/**
 * Entry handler for the queue service. workerd converts producer
 * `send()`/`sendBatch()` calls on the `queue` binding (and dead-letter forwards
 * from other brokers) into HTTP requests targeting this service; we forward
 * them unchanged to the queue's singleton broker Durable Object, which is
 * hosted in this same service (a same-service Durable Object binding — direct
 * cross-service Durable Object references are not supported by the runtime).
 */
export default {
  async fetch(request, env) {
    const stub = env[BINDING_QUEUE_BROKER].getByName("global");
    return await stub.fetch(request.url, {
      headers: request.headers,
      method: request.method,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
    });
  },
} satisfies ExportedHandler<BrokerEnv>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MessageBody =
  | { contentType: "text"; body: string }
  | { contentType: "json"; body: unknown }
  | { contentType: "bytes"; body: ArrayBuffer }
  | { contentType: "v8"; body: Uint8Array };

/**
 * The wire format for a single message accepted by the broker's `/batch`
 * endpoint. `body` is base64-encoded. `id` and `timestamp` are only present
 * when re-enqueuing onto a dead-letter queue.
 */
interface QueueIncomingMessage {
  readonly contentType: QueueContentType;
  readonly body: string;
  readonly delaySecs?: number;
  readonly id?: string;
  readonly timestamp?: number;
}

interface QueueBatchRequest {
  readonly messages: ReadonlyArray<QueueIncomingMessage>;
}

const exceptionQueueResult: FetcherQueueResult = {
  outcome: "exception",
  retryBatch: { retry: false },
  ackAll: false,
  retryMessages: [],
  explicitAcks: [],
};

/**
 * In-memory queue broker. Exactly one Durable Object instance per queue (one
 * broker service is created per consumed queue, and the queue name is provided
 * via the {@link QUEUE_NAME_BINDING} env binding). Mirrors Miniflare's
 * `QueueBrokerObject`: messages are buffered, flushed in batches, retried with
 * backoff, and moved to a dead-letter queue (or dropped) after exhausting
 * retries. State is in-memory only and does not survive a runtime restart.
 */
export class QueueBroker extends DurableObject<BrokerEnv> {
  private messages: Array<QueueMessage> = [];
  private pendingFlush?: {
    immediate: boolean;
    timeout: ReturnType<typeof setTimeout>;
  };
  private backlogBytes = 0;

  private get queueName(): string {
    return this.env[BINDING_QUEUE_NAME];
  }

  private get consumerOptions(): QueueConsumer | undefined {
    return this.env[BINDING_QUEUE_CONSUMER];
  }

  private get producer(): QueueProducerEntry | undefined {
    const producers = this.env[BINDING_QUEUE_PRODUCERS] ?? [];
    return producers.find((producer) => producer.queueName === this.queueName);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case "/metrics": {
          requireMethod(request, "GET");
          return Response.json(this.getMetrics());
        }
        case "/message": {
          requireMethod(request, "POST");
          return await this.postMessage(request);
        }
        case "/batch": {
          requireMethod(request, "POST");
          return await this.postBatch(request);
        }
        default:
          throw new HttpError(404, "not found");
      }
    } catch (error) {
      if (error instanceof HttpError) {
        return error.toResponse();
      }
      throw error;
    }
  }

  private getMetrics() {
    return {
      backlogCount: this.messages.length,
      backlogBytes: this.backlogBytes,
      oldestMessageTimestamp: this.messages[0]?.timestamp.getTime() ?? 0,
    };
  }

  private async postMessage(request: Request): Promise<Response> {
    const response = { metadata: { metrics: this.getMetrics() } };
    if (this.consumerOptions === undefined) {
      return Response.json(response);
    }

    const size = request.headers.get("Content-Length");
    if (size !== null && Number.parseInt(size) > MAX_MESSAGE_SIZE_BYTES) {
      throw new HttpError(
        413,
        `message length of ${size} bytes exceeds limit of ${MAX_MESSAGE_SIZE_BYTES}`,
      );
    }
    const contentType = validateContentType(request.headers.get("X-Msg-Fmt"));
    const delay = getDelayFromHeaders(request) ?? this.producer?.deliveryDelay;
    const bytes = new Uint8Array(await request.arrayBuffer());

    this.enqueueMessage({
      contentType,
      delaySecs: delay,
      body: bytesToBase64(bytes),
    });
    return Response.json(response);
  }

  private async postBatch(request: Request): Promise<Response> {
    const response = { metadata: { metrics: this.getMetrics() } };
    if (this.consumerOptions === undefined) {
      return Response.json(response);
    }

    validateBatchSizeHeaders(request);
    const delay = getDelayFromHeaders(request) ?? this.producer?.deliveryDelay;
    const body = await request.json<QueueBatchRequest>();
    for (const message of body.messages) {
      this.enqueueMessage({
        ...message,
        delaySecs: message.delaySecs ?? delay,
      });
    }
    return Response.json(response);
  }

  private enqueueMessage(message: QueueIncomingMessage) {
    const id = message.id ?? crypto.randomUUID().replace(/-/g, "");
    const timestamp = new Date(message.timestamp ?? Date.now());
    const body = deserialize(message.contentType, base64ToBytes(message.body));
    const msg = new QueueMessage(id, timestamp, body);
    const delay = message.delaySecs ?? 0;
    const push = () => {
      this.messages.push(msg);
      this.backlogBytes += msg.bytes;
      this.ensurePendingFlush();
    };
    if (delay > 0) {
      setTimeout(push, delay * 1000);
    } else {
      push();
    }
  }

  private ensurePendingFlush() {
    const consumer = this.consumerOptions;
    if (consumer === undefined) {
      return;
    }
    const batchSize = consumer.maxBatchSize ?? DEFAULT_BATCH_SIZE;
    const batchTimeout = consumer.maxBatchTimeout ?? DEFAULT_BATCH_TIMEOUT;
    const batchHasSpace = this.messages.length < batchSize;

    if (this.pendingFlush) {
      if (this.pendingFlush.immediate || batchHasSpace) {
        return;
      }
      clearTimeout(this.pendingFlush.timeout);
      this.pendingFlush = undefined;
    }

    const delay = batchHasSpace ? batchTimeout * 1000 : 0;
    const timeout = setTimeout(() => void this.flush(), delay);
    this.pendingFlush = { immediate: delay === 0, timeout };
  }

  private async flush(): Promise<void> {
    const consumer = this.consumerOptions;
    if (consumer === undefined) {
      this.pendingFlush = undefined;
      return;
    }

    const batchSize = consumer.maxBatchSize ?? DEFAULT_BATCH_SIZE;
    const maxAttempts = (consumer.maxRetries ?? DEFAULT_RETRIES) + 1;

    const batch = this.messages.splice(0, batchSize);
    this.backlogBytes -= batch.reduce((total, msg) => total + msg.bytes, 0);

    const metadata: MessageBatchMetadata = {
      metrics: {
        backlogCount: this.messages.length,
        backlogBytes: this.backlogBytes,
        oldestMessageTimestamp: this.messages[0]?.timestamp,
      },
    };

    const response = await this.dispatch(batch, metadata).catch((error) => {
      console.error(`Queue "${this.queueName}" consumer threw:`, error);
      return exceptionQueueResult;
    });

    const retryAll = response.retryBatch.retry || response.outcome !== "ok";
    const retryMessages = new Map(
      response.retryMessages?.map(
        (message) => [message.msgId, message.delaySeconds] as const,
      ),
    );
    // Explicitly acked messages take precedence over a batch-wide retry (from
    // `batch.retryAll()` or a thrown handler): they have already succeeded and
    // must not be redelivered.
    const explicitAcks = new Set(response.explicitAcks ?? []);
    const globalDelay =
      response.retryBatch.delaySeconds ?? consumer.retryDelay ?? 0;

    const toDeadLetterQueue: Array<QueueMessage> = [];
    for (const message of batch) {
      const shouldRetry =
        retryMessages.has(message.id) ||
        (retryAll && !explicitAcks.has(message.id));
      if (!shouldRetry) {
        continue;
      }
      message.failedAttempts++;
      if (message.failedAttempts < maxAttempts) {
        const delay = retryMessages.get(message.id) ?? globalDelay;
        const requeue = () => {
          this.messages.push(message);
          this.backlogBytes += message.bytes;
          this.ensurePendingFlush();
        };
        if (delay > 0) {
          setTimeout(requeue, delay * 1000);
        } else {
          requeue();
        }
      } else if (consumer.deadLetterQueue !== undefined) {
        toDeadLetterQueue.push(message);
      } else {
        console.warn(
          `Dropped message "${message.id}" on queue "${this.queueName}" after ${maxAttempts} failed attempts`,
        );
      }
    }

    this.pendingFlush = undefined;
    if (this.messages.length > 0) {
      this.ensurePendingFlush();
    }

    if (
      toDeadLetterQueue.length > 0 &&
      consumer.deadLetterQueue !== undefined
    ) {
      await this.sendToDeadLetterQueue(
        consumer.deadLetterQueue,
        toDeadLetterQueue,
      );
    }
  }

  private dispatch(
    batch: Array<QueueMessage>,
    metadata: MessageBatchMetadata,
  ): Promise<FetcherQueueResult> {
    const messages: Array<ServiceBindingQueueMessage> = batch.map((message) => {
      const attempts = message.failedAttempts + 1;
      if (message.body.contentType === "v8") {
        return {
          id: message.id,
          timestamp: message.timestamp,
          attempts,
          serializedBody: message.body.body,
        };
      }
      return {
        id: message.id,
        timestamp: message.timestamp,
        attempts,
        body: message.body.body,
      };
    });
    return this.env[BINDING_QUEUE_USER_WORKER].queue(
      this.queueName,
      messages,
      metadata,
    );
  }

  private async sendToDeadLetterQueue(
    deadLetterQueue: string,
    messages: Array<QueueMessage>,
  ): Promise<void> {
    const binding = this.env[BINDING_QUEUE_DLQ(deadLetterQueue)] as
      | Fetcher
      | undefined;
    if (binding === undefined) {
      console.warn(
        `Cannot move messages on queue "${this.queueName}" to dead letter queue "${deadLetterQueue}": no binding configured`,
      );
      return;
    }
    const request: QueueBatchRequest = { messages: messages.map(serialize) };
    const response = await binding.fetch("http://placeholder/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      console.warn(
        `Failed to move messages on queue "${this.queueName}" to dead letter queue "${deadLetterQueue}": HTTP ${response.status}`,
      );
    }
  }
}

class QueueMessage {
  failedAttempts = 0;

  constructor(
    readonly id: string,
    readonly timestamp: Date,
    readonly body: MessageBody,
  ) {}

  get bytes(): number {
    const { contentType, body } = this.body;
    switch (contentType) {
      case "text":
        return encoder.encode(body).byteLength;
      case "json":
        return encoder.encode(JSON.stringify(body)).byteLength;
      case "bytes":
        return body.byteLength;
      case "v8":
        return body.byteLength;
    }
  }
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, `method ${request.method} not allowed`);
  }
}

function validateContentType(value: string | null): QueueContentType {
  const contentType = value ?? "v8";
  if (!QUEUE_CONTENT_TYPES.includes(contentType as QueueContentType)) {
    throw new HttpError(
      400,
      `message content type ${contentType} is invalid; if specified, must be one of 'text', 'json', 'bytes', or 'v8'`,
    );
  }
  return contentType as QueueContentType;
}

function validateBatchSizeHeaders(request: Request) {
  const count = request.headers.get("CF-Queue-Batch-Count");
  if (count !== null && Number.parseInt(count) > MAX_MESSAGE_BATCH_COUNT) {
    throw new HttpError(
      413,
      `batch message count of ${count} exceeds limit of ${MAX_MESSAGE_BATCH_COUNT}`,
    );
  }
  const largest = request.headers.get("CF-Queue-Largest-Msg");
  if (largest !== null && Number.parseInt(largest) > MAX_MESSAGE_SIZE_BYTES) {
    throw new HttpError(
      413,
      `message in batch has length ${largest} bytes which exceeds single message size limit of ${MAX_MESSAGE_SIZE_BYTES}`,
    );
  }
  const batchSize = request.headers.get("CF-Queue-Batch-Bytes");
  if (
    batchSize !== null &&
    Number.parseInt(batchSize) > MAX_MESSAGE_BATCH_SIZE
  ) {
    throw new HttpError(
      413,
      `batch size of ${batchSize} bytes exceeds limit of 256000`,
    );
  }
}

function getDelayFromHeaders(request: Request): number | undefined {
  const value = request.headers.get("X-Msg-Delay-Secs");
  if (!value) {
    return undefined;
  }
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 0) {
    throw new HttpError(400, `message delay ${value} is invalid`);
  }
  return delay;
}

function serialize(message: QueueMessage): QueueIncomingMessage {
  let bytes: Uint8Array;
  switch (message.body.contentType) {
    case "text":
      bytes = encoder.encode(message.body.body);
      break;
    case "json":
      bytes = encoder.encode(JSON.stringify(message.body.body));
      break;
    case "bytes":
      bytes = new Uint8Array(message.body.body);
      break;
    case "v8":
      bytes = message.body.body;
      break;
  }
  return {
    id: message.id,
    timestamp: message.timestamp.getTime(),
    contentType: message.body.contentType,
    body: bytesToBase64(bytes),
  };
}

function deserialize(
  contentType: QueueContentType,
  bytes: Uint8Array,
): MessageBody {
  switch (contentType) {
    case "text":
      return { contentType, body: decoder.decode(bytes) };
    case "json":
      return { contentType, body: JSON.parse(decoder.decode(bytes)) };
    case "bytes":
      return { contentType, body: bytes.slice().buffer };
    case "v8":
      return { contentType, body: bytes };
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
