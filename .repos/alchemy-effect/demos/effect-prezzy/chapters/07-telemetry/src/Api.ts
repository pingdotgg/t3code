import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Clicks, type ClickEvent } from "./Clicks.ts";
import LinkRoom from "./LinkRoom.ts";
import { Links, LinksSql } from "./Links.ts";
import { Telemetry } from "./Observability.ts";
import { ShortyApi } from "./ShortyApi.ts";
import { NeonStorage } from "./Storage.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const links = yield* Links;
    const rooms = yield* LinkRoom;
    const clicksQueue = yield* Clicks;
    const clicks = yield* Cloudflare.Queues.WriteQueue(clicksQueue);

    // Count clicks in batches: one Durable Object call per link per batch.
    yield* Cloudflare.Queues.consumeQueueMessages<ClickEvent>(
      clicksQueue,
      { batchSize: 100, maxWaitTime: "1 second", maxRetries: 10, retryDelay: "3 seconds" },
      (events) =>
        events.pipe(
          Stream.runFold(
            () => new Map<string, number>(),
            (counts, { body }) => counts.set(body.code, (counts.get(body.code) ?? 0) + 1),
          ),
          Effect.flatMap((counts) =>
            Effect.forEach(
              counts,
              ([code, n]) =>
                rooms
                  .getByName(code)
                  .record(n)
                  .pipe(Effect.withSpan("clicks.record", { attributes: { code, n } })),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
    );

    const handlers = HttpApiBuilder.group(ShortyApi, "links", (handlers) =>
      handlers
        .handle("create", ({ payload }) => links.create(payload.url).pipe(Effect.orDie))
        .handle("list", () => links.list().pipe(Effect.orDie))
        .handle("get", ({ params }) =>
          links.get(params.code).pipe(Effect.catchTag("LinkStoreError", Effect.die)),
        ),
    );

    const api = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(ShortyApi).pipe(
        Layer.provide(handlers),
        Layer.provide(Http.Platform),
        Layer.provide(HttpRouter.cors()),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, first, code, action] = new URL(request.url, "http://localhost").pathname.split(
          "/",
        );

        // GET /links/:code/live → a WebSocket to the link's room
        if (first === "links" && code && action === "live") {
          return yield* rooms.getByName(code).fetch(request);
        }

        // GET /:code → queue the click, redirect straight away
        if (request.method === "GET" && first && first !== "links" && code === undefined) {
          const link = yield* links.get(first);
          yield* clicks.send({
            code: link.code,
            at: new Date().toISOString(),
          } satisfies ClickEvent);
          return HttpServerResponse.redirect(link.url, { status: 302 });
        }

        return yield* api;
      }).pipe(
        Effect.catchTags({
          LinkNotFound: ({ code }) =>
            HttpServerResponse.json({ _tag: "LinkNotFound", code }, { status: 404 }),
          LinkStoreError: () =>
            HttpServerResponse.json({ error: "storage unavailable" }, { status: 503 }),
          SendError: () => HttpServerResponse.json({ error: "queue unavailable" }, { status: 503 }),
        }),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        LinksSql.pipe(Layer.provide(NeonStorage)),
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Telemetry,
      ),
    ),
  ),
) {}
