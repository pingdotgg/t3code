import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DedicatedQueue } from "./dedicated-consumer-queue.ts";

/** Produces to the queue consumed by `dedicated-consumer-worker.ts`. */
export default class ProducerWorker extends Cloudflare.Worker<ProducerWorker>()(
  "dedicated-producer-worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const queue = yield* Cloudflare.Queues.WriteQueue(yield* DedicatedQueue);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/send") {
          yield* queue
            .send({ text: url.searchParams.get("text") ?? "hello" })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { sent: true },
            { status: 202 },
          );
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Queues.WriteQueueBinding)),
) {}
