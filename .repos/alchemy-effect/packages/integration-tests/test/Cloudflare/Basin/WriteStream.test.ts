import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import { Action } from "alchemy/Action";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import PipelinesHttpWorker from "./fixtures/pipelines-http-worker.ts";
import { PageView, PageViews } from "./fixtures/pipelines-stream.ts";
import PipelinesWorker from "./fixtures/pipelines-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// A fresh workers.dev URL takes a few seconds to serve; retry until 200.
const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.json
        : res.text.pipe(
            Effect.flatMap((body) => Effect.fail(new WorkerNotReady({ status: res.status, body }))),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")]),
        Schedule.recurs(20),
      ]),
    }),
  );

// A just-created stream's ingest host can take a moment to accept writes.
const ingestRetry = {
  while: (e: { _tag: string; reason?: string }) =>
    e._tag === "StreamSendError" && e.reason === "SendFailed",
  schedule: Schedule.exponential("1 second"),
  times: 6,
} as const;

test.provider(
  "typed WriteStream and StreamSink: native binding (Worker) and HTTP ingest (Action)",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const stream = yield* PageViews;
          const worker = yield* PipelinesWorker;

          // WriteStreamLocal / StreamSinkLocal POST to the stream's HTTP
          // ingest endpoint (`http: true`) with the current credentials.
          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const views = yield* Cloudflare.Basin.WriteStream(stream);
              const sink = yield* Cloudflare.Basin.StreamSink(stream);
              return Effect.fn(function* () {
                yield* views
                  .send([new PageView({ url: "/seed", at: new Date(), tags: ["seed"] })])
                  .pipe(Effect.retry(ingestRetry));
                yield* EffectStream.range(1, 50).pipe(
                  EffectStream.map(
                    (i) => new PageView({ url: `/seed/${i}`, at: new Date(), tags: [] }),
                  ),
                  EffectStream.run(sink),
                  Effect.retry(ingestRetry),
                );
                const invalid = yield* views
                  .send([{ url: "/x", at: "nope", tags: [] } as unknown as PageView])
                  .pipe(
                    Effect.as("none"),
                    Effect.catchTag("StreamSendError", (e) =>
                      Effect.succeed(e.reason ?? "unknown"),
                    ),
                  );
                return { invalid };
              });
            }).pipe(
              Effect.provide(Cloudflare.Basin.WriteStreamLocal),
              Effect.provide(Cloudflare.Basin.StreamSinkLocal),
            ),
          );
          const seeded = yield* Seed({});

          return {
            streamId: stream.streamId,
            url: worker.url.as<string>(),
            seeded,
          };
        }),
      );

      expect(deployed.seeded).toEqual({ invalid: "InvalidRecord" });

      const live = yield* pipelines.getStream({ accountId, streamId: deployed.streamId });
      expect(live.http.enabled).toBe(true);
      expect(live.http.authentication).toBe(true);

      expect(yield* getJson(`${deployed.url}/send`)).toEqual({ sent: 2 });
      expect(yield* getJson(`${deployed.url}/sink?count=300`)).toEqual({ sent: 300 });
      expect(yield* getJson(`${deployed.url}/invalid`)).toEqual({
        reason: "InvalidRecord",
        index: 0,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:pipelines",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 240_000,
  },
);

// WriteStreamHttp/StreamSinkHttp mint a scoped `Pipelines Send` API token.
test.provider(
  "WriteStreamHttp and StreamSinkHttp send through a scoped token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          yield* PageViews;
          const worker = yield* PipelinesHttpWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      expect(yield* getJson(`${url}/send`)).toEqual({ sent: 21 });
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:pipelines",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 240_000,
  },
);
