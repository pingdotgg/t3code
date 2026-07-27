import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { TestQueue } from "./queue.ts";
import { producerRoutes } from "./producer-routes.ts";

/** Producer (send) access via a scoped HTTP API token (`WriteQueueHttp`). */
export default class QueueWriteHttpWorker extends Cloudflare.Worker<QueueWriteHttpWorker>()(
  "QueueWriteHttpWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const queue = yield* TestQueue;
    const producer = yield* Cloudflare.Queues.WriteQueue(queue);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* producerRoutes(producer, request, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Queues.WriteQueueHttp)),
) {}
