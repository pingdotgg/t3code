import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import * as DurationUtil from "../../Util/Duration.ts";
import { isWorker, isWorkerEvent } from "../Workers/Worker.ts";
import type { Queue } from "./Queue.ts";
import { QueueConsumer } from "./QueueConsumer.ts";

/**
 * Subscriber settings — the same shape Cloudflare's `QueueConsumer`
 * accepts. `messages(queue, props).subscribe(...)` passes these
 * through to the auto-created `Cloudflare.QueueConsumer` so a single
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
 * into the numeric settings shape Cloudflare's `QueueConsumer` API
 * expects. `maxWaitTime` is rounded up to whole milliseconds and
 * `retryDelay` to whole seconds.
 *
 * Exposed for testing and for callers that want to mirror the
 * conversion when wiring `QueueConsumer` directly.
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
export type QueueMessage<Body = unknown> = cf.Message<Body>;

/**
 * Subscribe to a Cloudflare Queue with an Effect stream handler.
 *
 * Mirrors `AWS.SQS.messages(queue).subscribe(...)` on the
 * Cloudflare side. Wires both halves of the consumer in one call:
 *
 * - **Runtime**: registers a `queue` event listener on the Worker.
 *   Each batch is piped through `process` as a `Stream.Stream`.
 * - **Deploy-time**: yields a `Cloudflare.QueueConsumer` resource
 *   so Cloudflare actually dispatches messages from `queue` to
 *   this Worker. No manual `QueueConsumer` wiring needed in
 *   `alchemy.run.ts`.
 *
 * Acking semantics: if `process` succeeds, every message in the
 * batch is `ack()`ed; if it fails, every message is `retry()`ed
 * and Cloudflare applies `maxRetries` / `retryDelay` from the
 * settings before dead-lettering. Per-message control is still
 * available by calling `msg.ack()` / `msg.retry()` inside the
 * handler.
 *
 * @example
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Duration from "effect/Duration";
 * import * as Effect from "effect/Effect";
 * import * as Stream from "effect/Stream";
 *
 * yield* Cloudflare.messages<MyEvent>(queueResource, {
 *   batchSize: 25,
 *   maxRetries: 3,
 *   maxWaitTime: "5 seconds",
 *   retryDelay: Duration.seconds(30),
 * }).subscribe((stream) =>
 *   Stream.runForEach(stream, (msg) =>
 *     Effect.log(`event ${msg.body.id}`),
 *   ),
 * );
 * ```
 */
export const messages = <Body = unknown>(
  queue: Queue,
  props: MessagesProps = {},
) => ({
  subscribe: <Req = never>(
    process: (
      stream: Stream.Stream<QueueMessage<Body>>,
    ) => Effect.Effect<void, unknown, Req>,
  ) =>
    QueueEventSource.use((source) => source<Body, Req>(queue, props, process)),
});

// `Req` is the handler's requirements. The service registers the
// handler with the Worker's runtime context, where the runtime
// machinery provides bindings and `WorkerEnvironment` when the
// dispatch fires — so the requirement is satisfied at handler
// invocation, NOT at subscribe time. We drop `Req` from the return
// to keep init effects clean (mirrors `AWS.SQS.QueueEventSourceService`).
export type QueueEventSourceService = <Body = unknown, Req = never>(
  queue: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<QueueMessage<Body>>,
  ) => Effect.Effect<void, unknown, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Service tag for the Cloudflare Queue event source. Provided by
 * {@link QueueEventSourceLive} on the Worker's runtime layer.
 */
export class QueueEventSource extends Context.Service<
  QueueEventSource,
  QueueEventSourceService
>()("Cloudflare.Queue.QueueEventSource") {}

/**
 * Deploy-time policy that yields a `Cloudflare.QueueConsumer`
 * resource pointing the host Worker at the queue. Provided in
 * `Cloudflare.providers()` and used by {@link QueueEventSourceLive}
 * via `yield* QueueEventSourcePolicy(...)`. At runtime the policy
 * is absent, so the call is a no-op.
 */
export class QueueEventSourcePolicy extends Binding.Policy<
  QueueEventSourcePolicy,
  (queue: Queue, props: MessagesProps) => Effect.Effect<void>
>()("Cloudflare.Queue.QueueEventSource") {}

export const QueueEventSourcePolicyLive = QueueEventSourcePolicy.layer.succeed(
  // Cast: yielding `QueueConsumer(...)` requires the Cloudflare
  // `Providers` services, which the deploy-time stack provides
  // when this policy runs (the worker's init scope inherits the
  // stack's services). `Binding.Policy.layer.succeed` types the
  // body as `Effect<void, never, never>` to keep most policies
  // simple; we step around that constraint here because we
  // genuinely need to spawn a sibling resource at deploy time.
  ((host: ResourceLike, queue: Queue, props: MessagesProps) =>
    Effect.gen(function* () {
      if (!isWorker(host)) {
        return yield* Effect.die(
          `Cloudflare.messages(...).subscribe(...) is only supported on ` +
            `Cloudflare.Worker hosts (got '${host.Type}').`,
        );
      }
      // Yield the QueueConsumer resource as a sibling of the
      // Worker. The engine creates / updates / destroys it
      // alongside the Worker's lifecycle; the consumer's
      // reconciler waits for the Worker upload to expose the
      // `queue` handler before completing (see PR #257 for the
      // 11001 retry).
      yield* QueueConsumer(`${queue.LogicalId}Consumer`, {
        queueId: queue.queueId,
        scriptName: host.workerName,
        settings: toConsumerSettings(props),
        deadLetterQueue: props.deadLetterQueue,
      });
    })) as unknown as (
    host: ResourceLike,
    queue: Queue,
    props: MessagesProps,
  ) => Effect.Effect<void>,
);

/**
 * Runtime layer for {@link messages}. Wires each
 * `messages(queue).subscribe(...)` call in the Worker init phase to
 * a `queue` event listener on the runtime context, and asks the
 * deploy-time policy ({@link QueueEventSourcePolicy}, provided in
 * `Cloudflare.providers()`) to yield the matching
 * `Cloudflare.QueueConsumer` resource.
 *
 * Provide alongside other Cloudflare runtime layers (e.g.
 * `QueueBindingLive`) on the Worker effect.
 */
export const QueueEventSourceLive = Layer.effect(
  QueueEventSource,
  Effect.gen(function* () {
    const policy = yield* QueueEventSourcePolicy;
    return Effect.fn(function* <Body, Req>(
      queue: Queue,
      props: MessagesProps,
      process: (
        stream: Stream.Stream<QueueMessage<Body>>,
      ) => Effect.Effect<void, unknown, Req>,
    ) {
      // Deploy-time: ensure the QueueConsumer resource exists. At
      // runtime this Layer's `policy` resolves to the no-op variant
      // (Binding.Policy provides that automatically via
      // `Effect.serviceOption`), so this becomes a no-op.
      yield* policy(queue, props);

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
                  `[QueueEventSource] handler failed on queue ` +
                    `"${queueName}": ${Cause.pretty(cause)}`,
                );
                for (const msg of batch.messages) msg.retry();
              }),
            ),
            Effect.catchCause(() => Effect.void),
          );
        });
      });
    }) as QueueEventSourceService;
  }),
);
