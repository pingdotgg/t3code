import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Per-key counter that the queue handler increments on every
 * message it processes, and that the test polls back via the
 * worker's `GET /count?name=...` route. Persists in DO storage so
 * the count survives DO hibernation.
 */
export class Counter extends Cloudflare.DurableObjectNamespace<Counter>()(
  "Counter",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let count = (yield* state.storage.get<number>("count")) ?? 0;
      const lastBodies =
        (yield* state.storage.get<string[]>("lastBodies")) ?? [];
      return {
        record: Effect.fn(function* (body: string) {
          count += 1;
          lastBodies.push(body);
          yield* state.storage.put("count", count);
          yield* state.storage.put("lastBodies", lastBodies);
        }),
        snapshot: () =>
          Effect.succeed({
            count,
            lastBodies,
          }),
      };
    });
  }),
) {}

/**
 * The queue resource the worker produces to and consumes from. The
 * test deploys this stack, sends N messages via `POST /send?name=K`,
 * waits for the consumer to push them through to the Counter DO,
 * and polls `GET /count?name=K` until the count matches.
 *
 * `Cloudflare.messages(...).subscribe(...)` (in QueueWorker below)
 * auto-creates the matching `Cloudflare.QueueConsumer` resource at
 * deploy time, so this fixture has no separate consumer wiring.
 */
export const RoundTripQueue = Cloudflare.Queue("RoundTripQueue");

interface QueueMessageBody {
  name: string;
  text: string;
}

export default class QueueWorker extends Cloudflare.Worker<QueueWorker>()(
  "QueueRoundTripWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const counters = yield* Counter;
    const queueResource = yield* RoundTripQueue;
    const queue = yield* Cloudflare.QueueBinding.bind(queueResource);

    // Effect-style queue consumer. The handler delegates to the
    // Counter DO so the test can verify the message landed by
    // polling the DO's snapshot.
    //
    // Mixed `Duration.Input` forms are intentional: the e2e test
    // exercises that a `Duration` value (`maxWaitTime`) and a
    // string (`retryDelay: "1 second"`) both type-check at the
    // `Cloudflare.messages(...)` call site and survive the convert-
    // and-forward path into Cloudflare's QueueConsumer settings.
    // Values are kept small so the round-trip latency stays well
    // under the test's 240s timeout.
    yield* Cloudflare.messages<QueueMessageBody>(queueResource, {
      batchSize: 10,
      maxRetries: 3,
      maxWaitTime: Duration.millis(500),
      retryDelay: "1 second",
    }).subscribe((stream) =>
      Stream.runForEach(stream, (msg) =>
        counters.getByName(msg.body.name).record(msg.body.text),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "POST" && url.pathname === "/send") {
          const name = url.searchParams.get("name") ?? "default";
          const text = yield* request.text;
          yield* queue.send({ name, text }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { sent: { name, text } },
            { status: 202 },
          );
        }

        if (request.method === "GET" && url.pathname === "/count") {
          const name = url.searchParams.get("name") ?? "default";
          const snapshot = yield* counters.getByName(name).snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide(Cloudflare.QueueBindingLive),
    Effect.provide(Cloudflare.QueueEventSourceLive),
  ),
) {}
