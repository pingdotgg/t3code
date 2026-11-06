import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";

/** Queues and helpers shared by the QueueSink fixtures. */

/** Produced by `POST /produce` into the source queue. */
export interface Click {
  run: string;
  index: number;
  padding?: string;
}

/** The transformed message the source consumer sinks into the result queue. */
export interface EnrichedClick extends Click {
  doubled: number;
}

export const SourceQueue = Cloudflare.Queues.Queue("QueueSinkSource");
export const ResultQueue = Cloudflare.Queues.Queue("QueueSinkResult");

/**
 * `POST /produce?run=K&count=N[&padding=B]`: drain N clicks into `sink` as a
 * single stream chunk, so the sink must split it into batches.
 */
export const produceRoute = (sink: Cloudflare.Queues.QueueSinkClient, url: URL) =>
  Effect.gen(function* () {
    const run = url.searchParams.get("run") ?? "default";
    const count = Number(url.searchParams.get("count") ?? "1");
    const padding = Number(url.searchParams.get("padding") ?? "0");
    const events = Array.from({ length: count }, (_, index): Click => ({
      run,
      index,
      ...(padding > 0 ? { padding: "x".repeat(padding) } : {}),
    }));
    yield* Stream.fromIterable(events).pipe(Stream.run(sink), Effect.orDie);
    return yield* HttpServerResponse.json({ produced: count }, { status: 202 });
  });
