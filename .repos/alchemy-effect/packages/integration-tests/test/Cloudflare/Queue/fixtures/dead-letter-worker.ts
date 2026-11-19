import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";

/**
 * Name of the dead-letter queue. Explicit so the `"name"` source can pass it
 * as a plain string; derived from the stage so concurrent stages never share it.
 */
export const deadLetterQueueName = (stage: string) =>
  `alchemy-test-dead-letters-${stage.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

/**
 * The dead-letter queue every source queue below dead-letters into. The
 * suite deploys it on its own first so `Queue.ref("DeadLetters")` resolves.
 */
export const DeadLetters = Effect.gen(function* () {
  return yield* Cloudflare.Queues.Queue("DeadLetters", {
    name: deadLetterQueueName(yield* Stage),
  });
});

export const ByResourceQueue = Cloudflare.Queues.Queue("DeadLetterByResourceQueue");
export const ByRefQueue = Cloudflare.Queues.Queue("DeadLetterByRefQueue");
export const ByNameQueue = Cloudflare.Queues.Queue("DeadLetterByNameQueue");

export type DeadLetterSource = "resource" | "ref" | "name";

interface PoisonBody {
  source: DeadLetterSource;
  text: string;
}

class PoisonMessage extends Data.TaggedError("PoisonMessage")<{ text: string }> {}

/** Records every message the dead-letter consumer receives. */
export class DeadLetterLog extends Cloudflare.DurableObject<DeadLetterLog>()(
  "DeadLetterLog",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const received = (yield* state.storage.get<string[]>("received")) ?? [];
      return {
        record: Effect.fn(function* (entry: string) {
          received.push(entry);
          yield* state.storage.put("received", received);
        }),
        list: () => Effect.succeed(received),
      };
    });
  }),
) {}

/**
 * Three source queues whose handlers always fail. Each names the same
 * dead-letter queue a different way: the Queue resource, a
 * `Queue.ref(...)`, and the queue's name as a string. The dead-letter
 * queue's own consumer records what arrives, tagged with its source.
 */
export default class DeadLetterWorker extends Cloudflare.Worker<DeadLetterWorker>()(
  "DeadLetterWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const log = yield* DeadLetterLog;
    const deadLetters = yield* DeadLetters;
    const sources = {
      resource: yield* ByResourceQueue,
      ref: yield* ByRefQueue,
      name: yield* ByNameQueue,
    };
    const deadLetterQueues = {
      resource: deadLetters,
      ref: yield* Cloudflare.Queues.Queue.ref("DeadLetters"),
      name: deadLetterQueueName(yield* Stage),
    };

    const senders = {
      resource: yield* Cloudflare.Queues.WriteQueue(sources.resource),
      ref: yield* Cloudflare.Queues.WriteQueue(sources.ref),
      name: yield* Cloudflare.Queues.WriteQueue(sources.name),
    };

    for (const source of ["resource", "ref", "name"] as const) {
      yield* Cloudflare.Queues.consumeQueueMessages<PoisonBody>(
        sources[source],
        {
          batchSize: 1,
          maxRetries: 1,
          retryDelay: 0,
          deadLetterQueue: deadLetterQueues[source],
        },
        (stream) =>
          Stream.runForEach(stream, (msg) =>
            Effect.fail(new PoisonMessage({ text: msg.body.text })),
          ),
      );
    }

    yield* Cloudflare.Queues.consumeQueueMessages<PoisonBody>(
      deadLetters,
      { batchSize: 1 },
      (stream) =>
        Stream.runForEach(stream, (msg) =>
          log.getByName("all").record(`${msg.body.source}:${msg.body.text}`),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        const source = url.pathname.match(/^\/send\/(resource|ref|name)$/)?.[1] as
          | DeadLetterSource
          | undefined;
        if (request.method === "POST" && source) {
          const text = yield* request.text;
          yield* senders[source].send({ source, text }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ sent: { source, text } }, { status: 202 });
        }

        if (request.method === "GET" && url.pathname === "/dead-letters") {
          return yield* HttpServerResponse.json({
            received: yield* log.getByName("all").list(),
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.Queues.WriteQueueBinding),
    Effect.provide(Cloudflare.Queues.EventSourceLive),
  ),
) {}
