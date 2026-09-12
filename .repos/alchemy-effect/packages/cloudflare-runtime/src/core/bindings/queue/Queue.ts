import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
const QueueBrokerWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/queue/QueueBroker.worker",
    ),
};
const QueueShimForwardWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/queue/QueueShimForward.worker",
    ),
};
import { SERVICE_USER_WORKER } from "../../internal/constants.ts";
import { formatInternalWorkerModules } from "../../internal/internal-modules.ts";
import * as Plugin from "../../Plugin.ts";
import * as PluginContext from "../../PluginContext.ts";
import { RegistryProxy } from "../../registry/RegistryProxy.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import * as WorkerdConfig from "../../workerd/Config.ts";
import type {
  QueueConsumer,
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

const BROKER_COMPATIBILITY_DATE = "2024-10-22";

export class Queue extends Plugin.Service<
  Queue,
  {
    /**
     * Record a producer binding and resolve the workerd `queue` designator it
     * should target: the local broker service when this worker also consumes the
     * queue, otherwise the dev-registry `ExternalQueueProxy` (which forwards to
     * whichever instance consumes the queue).
     */
    readonly registerProducer: (
      props: QueueProducerProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
    /**
     * Record a remote producer binding: the workerd `queue` designator
     * targets a pass-through forwarder service that relays the queue wire
     * protocol to a REAL deployed shim worker holding the actual queue
     * binding (see {@link QueueRemoteProducerProps}).
     */
    readonly registerRemote: (
      props: QueueRemoteProducerProps,
    ) => Effect.Effect<WorkerdConfig.ServiceDesignator>;
  }
>()("cloudflare-runtime/plugin/Queue") {}

export const QueueLive = Layer.effect(
  Queue,
  Effect.gen(function* () {
    // Captured for the pull loops (consumers of REAL Cloudflare queues):
    // the distilled pull/ack ops need cloud credentials + an HttpClient.
    // The full ambient context is captured lazily so a credential-free
    // embedder (e.g. the local-only test suites) pays nothing — pull
    // consumers simply require an embedder that provides `Credentials`.
    const ambient = yield* Effect.context<never>();

    return Queue.of(
      Effect.gen(function* () {
        const ctx = yield* PluginContext.PluginContext;
        const proxy = yield* ctx.get(RegistryProxy);
        const consumers = ctx.worker.queueConsumers ?? [];
        const producers: Array<QueueProducerEntry> = [];
        const remoteProducers: Array<QueueRemoteProducerProps> = [];

        const queueServiceName = (queueName: string): string =>
          `queues:${queueName}`;

        for (const consumer of consumers) {
          if (
            consumer.maxBatchTimeout !== undefined &&
            (consumer.maxBatchTimeout < 0 || consumer.maxBatchTimeout > 60)
          ) {
            return yield* new ConfigError({
              subtag: "Queue",
              message: `Invalid maxBatchTimeout for queue "${consumer.queueName}": must be between 0 and 60 seconds`,
              hint: "Set `maxBatchTimeout` to a value between 0 and 60 (seconds).",
              detail: {
                queueName: consumer.queueName,
                maxBatchTimeout: consumer.maxBatchTimeout,
              },
            });
          }
          if (
            consumer.deadLetterQueue !== undefined &&
            consumer.deadLetterQueue === consumer.queueName
          ) {
            return yield* new ConfigError({
              subtag: "Queue",
              message: `Dead letter queue for queue "${consumer.queueName}" cannot be itself`,
              hint: "Point `deadLetterQueue` at a different queue name.",
              detail: { queueName: consumer.queueName },
            });
          }
          yield* proxy.api.publish({
            kind: "queue-consumer",
            queueName: consumer.queueName,
            service: queueServiceName(consumer.queueName),
          });
        }

        const queueConsumerServiceDesignator = (queueName: string) =>
          consumers.find((consumer) => consumer.queueName === queueName)
            ? Effect.succeed<WorkerdConfig.ServiceDesignator>({
                name: queueServiceName(queueName),
              })
            : proxy.api.subscribe({
                kind: "queue-consumer",
                queueName,
              });

        // Dead-letter-queue targets are resolved eagerly, at plugin init:
        // `defer` phases run concurrently across plugins, so a registry
        // `subscribe` issued from inside this plugin's defer can land after
        // the RegistryProxy's defer has already decided (from an empty
        // subscriber list) not to emit the proxy service — the DLQ binding
        // would then reference `cloudflare-runtime:registry-proxy` without it
        // being defined and workerd would fail to start.
        const dlqNames = new Set(
          consumers.flatMap((consumer) => consumer.deadLetterQueue ?? []),
        );
        const dlqServices = new Map(
          yield* Effect.all(
            Array.from(dlqNames, (queueName) =>
              Effect.map(
                queueConsumerServiceDesignator(queueName),
                (service) => [queueName, service] as const,
              ),
            ),
            { concurrency: "unbounded" },
          ),
        );

        /**
         * Build the workerd service for a single consumed queue. A single service both
         * hosts the `QueueBrokerObject` Durable Object and exposes the entry `fetch`
         * handler (from `broker.worker.ts`) that producer `queue` bindings target. The
         * entry forwards to the broker via a **same-service** Durable Object binding;
         * splitting the entry and broker into separate services would require a direct
         * cross-service Durable Object reference, which the runtime does not support.
         */
        const queueConsumerService = Effect.fnUntraced(function* (
          consumer: QueueConsumer,
        ) {
          return {
            name: queueServiceName(consumer.queueName),
            worker: {
              compatibilityDate: BROKER_COMPATIBILITY_DATE,
              compatibilityFlags: [
                "experimental",
                "service_binding_extra_handlers",
              ],
              modules: formatInternalWorkerModules(
                yield* Effect.promise(QueueBrokerWorker.worker),
              ),
              durableObjectNamespaces: [
                {
                  className: "QueueBroker",
                  // Unique per queue so each broker gets an isolated DO namespace.
                  uniqueKey: `cloudflare-runtime-QueueBroker-${consumer.queueName}`,
                  preventEviction: true,
                },
              ],
              durableObjectStorage: { inMemory: WorkerdConfig.kVoid },
              bindings: [
                {
                  name: BINDING_QUEUE_BROKER,
                  durableObjectNamespace: { className: "QueueBroker" },
                },
                {
                  name: BINDING_QUEUE_USER_WORKER,
                  service: { name: SERVICE_USER_WORKER },
                },
                { name: BINDING_QUEUE_NAME, text: consumer.queueName },
                {
                  name: BINDING_QUEUE_CONSUMER,
                  json: JSON.stringify(consumer),
                },
                {
                  name: BINDING_QUEUE_PRODUCERS,
                  json: JSON.stringify(producers),
                },
                ...(consumer.deadLetterQueue
                  ? [
                      {
                        name: BINDING_QUEUE_DLQ(consumer.deadLetterQueue),
                        service: dlqServices.get(consumer.deadLetterQueue)!,
                      },
                    ]
                  : []),
              ],
            },
          };
        });

        const remoteShimServiceName = (binding: string): string =>
          `queue-shim:${binding}`;

        /**
         * Build the pass-through forwarder service for one remote producer
         * binding. Outbound fetches from the forwarder use workerd's default
         * global outbound (the internet), which is exactly where the shim
         * lives.
         */
        const remoteShimService = Effect.fnUntraced(function* (
          props: QueueRemoteProducerProps,
        ) {
          return {
            name: remoteShimServiceName(props.binding),
            worker: {
              compatibilityDate: BROKER_COMPATIBILITY_DATE,
              modules: formatInternalWorkerModules(
                yield* Effect.promise(QueueShimForwardWorker.worker),
              ),
              bindings: [
                { name: "SHIM_URL", text: props.url },
                { name: "SHIM_TOKEN", text: props.token },
              ],
            },
          };
        });

        /**
         * Consumers of REAL Cloudflare queues: each gets a loopback socket
         * onto its local broker service plus a Node-side pull loop that
         * drains the real queue via the HTTP pull API and feeds the wire
         * protocol into the broker, which then delivers to the user worker's
         * `queue()` handler with the usual local batching/retry semantics.
         */
        const pullConsumers = consumers.filter(
          (consumer) => consumer.pull !== undefined,
        );
        const pullSocketName = (queueName: string): string =>
          `queue-pull:${queueName}`;

        const pullLoop = (
          consumer: QueueConsumer,
          pull: { queueId: string; accountId: string },
          port: number,
        ) =>
          Effect.gen(function* () {
            const endpoint = `http://127.0.0.1:${port}/message`;

            const iteration = Effect.gen(function* () {
              const res = yield* queues.pullMessage({
                accountId: pull.accountId,
                queueId: pull.queueId,
                batchSize: consumer.maxBatchSize ?? 10,
                visibilityTimeoutMs: 30_000,
              });
              const messages = res.messages ?? [];
              const acks: Array<{ leaseId: string }> = [];
              for (const message of messages) {
                if (!message.leaseId) continue;
                const { body, contentType } = decodePulledMessage(message);
                const response = yield* Effect.tryPromise(() =>
                  fetch(endpoint, {
                    method: "POST",
                    headers: { "X-Msg-Fmt": contentType },
                    body,
                  }),
                );
                if (response.ok) {
                  acks.push({ leaseId: message.leaseId });
                }
                // Non-ok: leave unacked — the visibility timeout redelivers.
              }
              if (acks.length > 0) {
                yield* queues.ackMessage({
                  accountId: pull.accountId,
                  queueId: pull.queueId,
                  acks,
                });
              }
              return messages.length > 0;
            });

            yield* iteration.pipe(
              Effect.flatMap((busy) =>
                busy ? Effect.void : Effect.sleep("1 second"),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `[queue-pull:${consumer.queueName}] pull iteration failed`,
                  Cause.squash(cause),
                ).pipe(Effect.andThen(Effect.sleep("2 seconds"))),
              ),
              Effect.forever,
            );
          }).pipe(
            // Credentials + HttpClient come from the embedder's ambient
            // context; `Context<never>` can't prove that statically.
            Effect.provideContext(ambient),
          ) as Effect.Effect<never>;

        return {
          api: {
            registerProducer: (props) =>
              Effect.suspend(() => {
                producers.push({
                  queueName: props.queueName,
                  deliveryDelay: props.deliveryDelay,
                });
                return queueConsumerServiceDesignator(props.queueName);
              }),
            registerRemote: (props) =>
              Effect.sync(() => {
                remoteProducers.push(props);
                return { name: remoteShimServiceName(props.binding) };
              }),
          },
          sockets: pullConsumers.map((consumer) => ({
            name: pullSocketName(consumer.queueName),
            address: "127.0.0.1:0",
            service: { name: queueServiceName(consumer.queueName) },
          })),
          start: (ports) =>
            Effect.forEach(
              pullConsumers,
              (consumer) => {
                const port = ports[pullSocketName(consumer.queueName)];
                return port === undefined
                  ? Effect.void
                  : Effect.forkScoped(pullLoop(consumer, consumer.pull!, port));
              },
              { discard: true },
            ),
          defer: Effect.suspend(() =>
            Effect.all(
              [
                Effect.forEach(consumers, queueConsumerService, {
                  concurrency: "unbounded",
                }),
                Effect.forEach(remoteProducers, remoteShimService, {
                  concurrency: "unbounded",
                }),
              ],
              { concurrency: "unbounded" },
            ).pipe(
              Effect.map(([consumerServices, shimServices]) => ({
                services: [...consumerServices, ...shimServices],
              })),
            ),
          ),
        };
      }),
    );
  }),
);

/**
 * Decode one pulled message into the queue wire protocol's `POST /message`
 * shape. The pull API returns `body` as a string; binary formats (`bytes`,
 * `v8`) arrive base64-encoded, text/json arrive verbatim. The content type
 * rides on the message metadata when present, defaulting to text.
 */
const decodePulledMessage = (message: {
  body?: string | null;
  metadata?: unknown;
}): { body: string | Uint8Array; contentType: string } => {
  const metadata = message.metadata;
  const contentType =
    typeof metadata === "object" &&
    metadata !== null &&
    "contentType" in metadata &&
    typeof (metadata as { contentType: unknown }).contentType === "string"
      ? (metadata as { contentType: string }).contentType
      : "text";
  const raw = message.body ?? "";
  const body =
    contentType === "bytes" || contentType === "v8"
      ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
      : raw;
  return { body, contentType };
};

/** Options for a queue producer binding (`env.QUEUE.send()`). */
export interface QueueProducerProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /** Logical name of the queue this binding produces to. */
  readonly queueName: string;
  /** Default delay (seconds, 0-86400) applied to every message. */
  readonly deliveryDelay?: number;
}

/**
 * Bind a queue producer (`env.<binding>.send()` / `.sendBatch()`).
 *
 * Messages are routed to the queue's broker, which lives in whichever instance
 * consumes the queue:
 * - If this worker consumes the queue, the broker is local.
 * - Otherwise the binding routes through the dev-registry proxy to the
 *   consuming instance (or accepts-and-drops if no consumer is running).
 */
export const local = (
  props: QueueProducerProps,
): PluginContext.BindingHook<Queue | RegistryProxy> =>
  Plugin.use(Queue, (queues) =>
    Effect.map(queues.api.registerProducer(props), (queue) => ({
      name: props.binding,
      queue,
    })),
  );

/** Options for a remote queue producer binding targeting a deployed shim. */
export interface QueueRemoteProducerProps {
  /** Binding name exposed on `env`. */
  readonly binding: string;
  /** Logical name of the real queue this binding produces to. */
  readonly queueName: string;
  /** HTTPS URL of the deployed shim worker holding the real queue binding. */
  readonly url: string;
  /** Bearer token the shim requires. */
  readonly token: string;
}

/**
 * Bind a queue producer to a REAL Cloudflare queue.
 *
 * Cloudflare's preview/remote-binding sessions reject queue bindings
 * outright (cloudflare/workers-sdk#9929), so remote production goes through
 * a deployed shim worker instead: the local binding targets a pass-through
 * forwarder service that relays workerd's queue wire protocol to the shim
 * over HTTPS with a bearer token, and the shim decodes it back into
 * `send()`/`sendBatch()` on its real queue binding.
 *
 * Producer-only: consuming a remote queue locally is not covered by this
 * binding — Cloudflare pushes to deployed consumers.
 */
export const remote = (
  props: QueueRemoteProducerProps,
): PluginContext.BindingHook<Queue | RegistryProxy> =>
  Plugin.use(Queue, (queues) =>
    Effect.map(queues.api.registerRemote(props), (queue) => ({
      name: props.binding,
      queue,
    })),
  );
