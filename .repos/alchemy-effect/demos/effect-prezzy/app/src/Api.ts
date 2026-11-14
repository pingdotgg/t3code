import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import LinkRoom from "./LinkRoom.ts";
import { Links, type Link } from "./Links.ts";
import { LinksDynamo } from "./LinksDynamo.ts";
import { Clicks, Jobs, type ClickEvent, type UnfurlJob } from "./Queues.ts";
import { ShortyApi } from "./ShortyApi.ts";
import { unfurl } from "./unfurl.ts";

const DAY = 24 * 60 * 60 * 1000;

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const links = yield* Links;
    const rooms = yield* LinkRoom;
    const jobsQueue = yield* Jobs;
    const clicksQueue = yield* Clicks;
    const jobs = yield* Cloudflare.Queues.WriteQueue(jobsQueue);
    const jobsSink = yield* Cloudflare.Queues.QueueSink(jobsQueue);
    const clicks = yield* Cloudflare.Queues.WriteQueue(clicksQueue);

    // Every chunk of the stream becomes one sendBatch call.
    const enqueueUnfurls = (stream: Stream.Stream<UnfurlJob>) =>
      stream.pipe(Stream.rechunk(100), Stream.run(jobsSink));

    const withClicks = (link: Link) =>
      rooms
        .getByName(link.code)
        .clicks()
        .pipe(Effect.map((clicks) => ({ ...link, clicks })));

    // Background job: fetch each new link's page and store its title.
    yield* Cloudflare.Queues.consumeQueueMessages<UnfurlJob>(
      jobsQueue,
      { batchSize: 10, maxRetries: 3 },
      (messages) =>
        messages.pipe(
          Stream.mapEffect(
            ({ body }) =>
              unfurl(body.url).pipe(
                Effect.flatMap((preview) => links.setPreview(body.code, preview)),
                Effect.tap(() => Effect.log(`unfurled ${body.code} → ${body.url}`)),
                // A deleted link has nothing left to unfurl.
                Effect.catchTag("LinkNotFound", () => Effect.void),
              ),
            { concurrency: 5 },
          ),
          Stream.runDrain,
        ),
    );

    // Event source: count clicks per link, one Durable Object call per link per batch.
    yield* Cloudflare.Queues.consumeQueueMessages<ClickEvent>(
      clicksQueue,
      { batchSize: 100, maxWaitTime: "1 second" },
      (messages) =>
        messages.pipe(
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
                  .pipe(Effect.tap((total) => Effect.log(`${code}: +${n} → ${total}`))),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
    );

    // Hourly: re-unfurl previews older than a day.
    yield* Cloudflare.Workers.cron("0 * * * *", () =>
      Effect.gen(function* () {
        const all = yield* links.list();
        yield* Stream.fromIterable(all).pipe(
          Stream.filter((link) => (link.preview?.fetchedAt ?? 0) < Date.now() - DAY),
          Stream.map((link) => ({ code: link.code, url: link.url })),
          enqueueUnfurls,
        );
      }),
    );

    const handlers = HttpApiBuilder.group(ShortyApi, "links", (handlers) =>
      handlers
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const link = yield* links.create(payload.url);
            yield* jobs.send({ code: link.code, url: link.url } satisfies UnfurlJob);
            return { ...link, clicks: 0 };
          }).pipe(Effect.orDie),
        )
        .handle("import", ({ payload }) =>
          Effect.gen(function* () {
            const created = yield* Stream.fromIterable(payload.urls).pipe(
              Stream.mapEffect(links.create, { concurrency: 10 }),
              Stream.runCollect,
            );
            yield* Stream.fromIterable(created).pipe(
              Stream.map((link) => ({ code: link.code, url: link.url })),
              enqueueUnfurls,
            );
            return created.map((link) => ({ ...link, clicks: 0 }));
          }).pipe(Effect.orDie),
        )
        .handle("list", () =>
          links.list().pipe(
            Effect.flatMap((all) => Effect.forEach(all, withClicks, { concurrency: "unbounded" })),
            Effect.orDie,
          ),
        )
        .handle("get", ({ params }) =>
          links
            .get(params.code)
            .pipe(Effect.flatMap(withClicks), Effect.catchTag("LinkStoreError", Effect.die)),
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

        // Live click counts: hand the WebSocket to the link's Durable Object.
        if (first === "links" && code && action === "live") {
          return yield* rooms.getByName(code).fetch(request);
        }

        // Short links: redirect now, count the click in the background.
        if (first && first !== "links" && !code && request.method === "GET") {
          const link = yield* links.get(first);
          yield* clicks.send({ code: link.code, at: Date.now() } satisfies ClickEvent);
          return HttpServerResponse.redirect(link.url, { status: 302 });
        }

        return yield* api;
      }).pipe(
        Effect.catchTags({
          LinkNotFound: ({ code }) =>
            HttpServerResponse.json({ error: `no link ${code}` }, { status: 404 }),
          LinkStoreError: () =>
            HttpServerResponse.json({ error: "storage unavailable" }, { status: 503 }),
          SendError: () => HttpServerResponse.json({ error: "queue unavailable" }, { status: 503 }),
        }),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        LinksDynamo,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.QueueSinkBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.Workers.CronEventSourceLive,
        FetchHttpClient.layer,
      ),
    ),
  ),
) {}
