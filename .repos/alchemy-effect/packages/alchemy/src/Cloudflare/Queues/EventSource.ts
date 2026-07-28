import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Namespace from "../../Namespace.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import * as DurationUtil from "../../Util/Duration.ts";
import { isWorkerEvent, Worker } from "../Workers/Worker.ts";
import type { Queue } from "./Queue.ts";
import { Consumer } from "./Consumer.ts";

/**
 * Subscriber settings — the same shape Cloudflare's `Consumer`
 * accepts. `consumeQueueMessages(queue, props, handler)` passes these
 * through to the auto-created `Cloudflare.Queues.Consumer` so a single
 * call captures both runtime and deploy-time intent.
 */
export interface MessagesProps {
  /** Maximum messages per batch. */
  batchSize?: number;
  /** Maximum concurrent invocations. */
  maxConcurrency?: number;
  /** Maximum delivery attempts before dead-lettering. */
  maxRetries?: number;
  /**
   * Wait time before flushing a partial batch. Rounded up to whole
   * milliseconds when forwarded to Cloudflare.
   */
  maxWaitTime?: Duration.Input;
  /**
   * Backoff applied to a retry. Rounded up to whole seconds when
   * forwarded to Cloudflare.
   */
  retryDelay?: Duration.Input;
  /** Optional dead-letter queue name. */
  deadLetterQueue?: string;
}

/**
 * Convert a {@link MessagesProps} (with `Duration.Input` time fields)
 * into the numeric settings shape Cloudflare's `Consumer` API
 * expects. `maxWaitTime` is rounded up to whole milliseconds and
 * `retryDelay` to whole seconds.
 *
 * Exposed for testing and for callers that want to mirror the
 * conversion when wiring `Consumer` directly.
 */
export const toConsumerSettings = (props: MessagesProps) => ({
  batchSize: props.batchSize,
  maxConcurrency: props.maxConcurrency,
  maxRetries: props.maxRetries,
  maxWaitTimeMs: DurationUtil.toMillis(props.maxWaitTime),
  retryDelay: DurationUtil.toSeconds(props.retryDelay),
});

/**
 * A single queue message handed to the subscribe handler. Mirrors
 * Cloudflare's runtime `Message<Body>` shape so per-message
 * `ack()` / `retry()` semantics match the platform docs.
 */
export type Message<Body = unknown> = cf.Message<Body>;

/**
 * Subscribe to a Cloudflare Queue with an Effect stream handler.
 *
 * Mirrors `AWS.SQS.consumeQueueMessages(queue, handler)` on the
 * Cloudflare side. Wires both halves of the consumer in one call:
 *
 * - **Runtime**: registers a `queue` event listener on the Worker.
 *   Each batch is piped through `process` as a `Stream.Stream`.
 * - **Deploy-time**: yields a `Cloudflare.Queues.Consumer` resource
 *   so Cloudflare actually dispatches messages from `queue` to
 *   this Worker. No manual `Consumer` wiring needed in
 *   `alchemy.run.ts`.
 *
 * Acking semantics: if `process` succeeds, every message in the
 * batch is `ack()`ed; if it fails, every message is `retry()`ed
 * and Cloudflare applies `maxRetries` / `retryDelay` from the
 * settings before dead-lettering. Per-message control is still
 * available by calling `msg.ack()` / `msg.retry()` inside the
 * handler.
 * @binding
 * @product Queues
 * @category Storage & Databases
 * @example
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Duration from "effect/Duration";
 * import * as Effect from "effect/Effect";
 * import * as Stream from "effect/Stream";
 *
 * yield* Cloudflare.Queues.consumeQueueMessages<MyEvent>(
 *   queueResource,
 *   {
 *     batchSize: 25,
 *     maxRetries: 3,
 *     maxWaitTime: "5 seconds",
 *     retryDelay: Duration.seconds(30),
 *   },
 *   (stream) =>
 *     Stream.runForEach(stream, (msg) =>
 *       Effect.log(`event ${msg.body.id}`),
 *     ),
 * );
 * ```
 *
 * @example
 * ```typescript
 * // Without options — handler is the second argument.
 * yield* Cloudflare.Queues.consumeQueueMessages<MyEvent>(queueResource, (stream) =>
 *   Stream.runForEach(stream, (msg) => Effect.log(`event ${msg.body.id}`)),
 * );
 * ```
 */
export function consumeQueueMessages<Body = unknown>(
  queue: Queue,
  process: (
    stream: Stream.Stream<Message<Body>>,
  ) => Effect.Effect<void, unknown, any>,
): Effect.Effect<void, never, EventSource>;
export function consumeQueueMessages<Body = unknown>(
  queue: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<Message<Body>>,
  ) => Effect.Effect<void, unknown, any>,
): Effect.Effect<void, never, EventSource>;
export function consumeQueueMessages<Body = unknown>(
  queue: Queue,
  propsOrProcess:
    | MessagesProps
    | ((
        stream: Stream.Stream<Message<Body>>,
      ) => Effect.Effect<void, unknown, any>),
  maybeProcess?: (
    stream: Stream.Stream<Message<Body>>,
  ) => Effect.Effect<void, unknown, any>,
): Effect.Effect<void, never, EventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as MessagesProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return EventSource.use((source) => source<Body>(queue, props, process));
}

// `Req` is the handler's requirements. The service registers the
// handler with the Worker's runtime context, where the runtime
// machinery provides bindings and `WorkerEnvironment` when the
// dispatch fires — so the requirement is satisfied at handler
// invocation, NOT at subscribe time. We drop `Req` from the return
// to keep init effects clean (mirrors `AWS.SQS.EventSourceService`).
export type EventSourceService = <Body = unknown>(
  queue: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<Message<Body>>,
  ) => Effect.Effect<void, unknown, any>,
) => Effect.Effect<void, never, never>;

/**
 * Service tag for the Cloudflare Queue event source. Provided by
 * {@link EventSourceLive} on the Worker's runtime layer.
 */
export class EventSource extends Context.Service<
  EventSource,
  EventSourceService
>()("Cloudflare.Queues.EventSource") {}

/**
 * Runtime layer for {@link consumeQueueMessages}. Wires each
 * `consumeQueueMessages(queue, handler)` call in the Worker init phase to
 * a `queue` event listener on the runtime context, and (at deploy
 * time) yields the matching `Cloudflare.Queues.Consumer` resource so
 * Cloudflare dispatches messages from the queue to this Worker.
 *
 * Provide alongside other Cloudflare runtime layers (e.g.
 * `WriteQueueBinding`) on the Worker effect.
 */
export const EventSourceLive = Layer.effect(
  EventSource,
  Effect.gen(function* () {
    const host = yield* Worker;
    return Effect.fn(function* <Body, Req>(
      queue: Queue,
      props: MessagesProps,
      process: (
        stream: Stream.Stream<Message<Body>>,
      ) => Effect.Effect<void, unknown, any>,
    ) {
      // Deploy-time: yield the Consumer resource as a sibling of the
      // Worker so Cloudflare dispatches messages from the queue to it.
      // Skipped once running inside the deployed Worker (the global
      // guard), where the only work is registering the runtime handler
      // below. Namespaced under the host so the Consumer's logical
      // identity matches the previous Binding.Policy.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            // The engine creates / updates / destroys the Consumer
            // alongside the Worker's lifecycle; the consumer's
            // reconciler waits for the Worker upload to expose the
            // `queue` handler before completing (see PR #257 for the
            // 11001 retry).
            yield* Consumer(`${queue.LogicalId}Consumer`, {
              queueId: queue.queueId,
              scriptName: host.workerName,
              settings: toConsumerSettings(props),
              deadLetterQueue: props.deadLetterQueue,
            });
          }),
        );
      }

      // Resolve the runtime context per-call rather than at layer
      // construction. Capturing it on the layer would leak the
      // requirement past `PlatformServices` exclusion when the
      // Worker typechecks its init effect.
      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      // Capture the queue-name accessor once; the listener body
      // re-resolves it per event via `yield* QueueName`. A worker
      // can consume multiple queues — each subscribe registers its
      // own listener and they all see every queue event, so the
      // queue-name match is what scopes the handler.
      const QueueName = yield* queue.queueName;

      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "queue") return;
        const batch = event.input as cf.MessageBatch<Body>;

        return Effect.gen(function* () {
          const queueName = yield* QueueName;
          if (batch.queue !== queueName) return;

          yield* process(Stream.fromIterable(batch.messages)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                for (const msg of batch.messages) msg.ack();
              }),
            ),
            Effect.onError((cause) =>
              Effect.sync(() => {
                // Surface the failure so the operator sees what
                // tripped the retry path; without this the only
                // signal is the message reappearing on the next
                // attempt.
                console.error(
                  `[EventSource] handler failed on queue ` +
                    `"${queueName}": ${Cause.pretty(cause)}`,
                );
                for (const msg of batch.messages) msg.retry();
              }),
            ),
            Effect.catchCause(() => Effect.void),
          );
        });
      });
    }) as EventSourceService;
  }),
);
