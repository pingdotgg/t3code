import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DedicatedQueue } from "./dedicated-consumer-queue.ts";

/** Records the bodies the queue handler observed, so the test can poll them. */
export class Inbox extends Cloudflare.DurableObject<Inbox>()(
  "DedicatedInbox",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const bodies = (yield* state.storage.get<string[]>("bodies")) ?? [];
      return {
        record: Effect.fn(function* (body: string) {
          bodies.push(body);
          yield* state.storage.put("bodies", bodies);
        }),
        snapshot: () => Effect.succeed({ bodies }),
      };
    });
  }),
) {}

/**
 * A Worker that ONLY consumes — it never binds the queue as a producer, so
 * the queue's name reaches it exclusively through the
 * `DedicatedQueue_queueName` env binding that `consumeQueueMessages` reads
 * to scope its handler. This is the topology of #1243.
 *
 * `GET /binding` returns that binding RAW from `WorkerEnvironment` (not
 * through the unpacking `ctx.get` accessor) so the test can pin the wire
 * format Cloudflare actually stores.
 */
export default class ConsumerWorker extends Cloudflare.Worker<ConsumerWorker>()(
  "dedicated-consumer-worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const inbox = yield* Inbox;
    const queue = yield* DedicatedQueue;
    const env = yield* Cloudflare.WorkerEnvironment;

    yield* Cloudflare.Queues.consumeQueueMessages<{ text: string }>(
      queue,
      (stream) =>
        Stream.runForEach(stream, (msg) =>
          inbox.getByName("default").record(msg.body.text),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/binding") {
          return yield* HttpServerResponse.json({
            queueName: (env as Record<string, unknown>)
              .DedicatedQueue_queueName,
          });
        }
        if (url.pathname === "/received") {
          return yield* HttpServerResponse.json(
            yield* inbox.getByName("default").snapshot(),
          );
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Queues.EventSourceLive)),
) {}
