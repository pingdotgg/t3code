import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { AsyncOrders, K2AsyncWorker } from "./fixtures/k2-async-stack.ts";
import K2BindingWorker from "./fixtures/k2-binding-worker.ts";
import K2HttpWorker from "./fixtures/k2-http-worker.ts";
import { BindingOrders, HttpOrders } from "./fixtures/k2-shared.ts";
import { drainSubscription, type VerifiedRecord, waitForStreamGone } from "./k2-test-utils.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotProduced extends Data.TaggedError("NotProduced")<{ path: string; status: number }> {}

/**
 * `POST {route}`, retrying while a fresh workers.dev URL comes up (bounded
 * to ~60 s). A 500 carries the typed K2 error tag in its JSON body.
 */
const produce = (url: string, path: string, run: string, count: number) =>
  HttpClient.post(`${url}${path}?run=${run}&count=${count}`).pipe(
    Effect.flatMap((res) =>
      res.status === 202
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) => {
              if (res.status === 500) console.error(`${path} failed: ${body}`);
              return Effect.fail(new NotProduced({ path, status: res.status }));
            }),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        Schedule.recurs(25),
      ]),
    }),
  );

const byRun = (records: ReadonlyArray<VerifiedRecord>, run: string) =>
  records.filter(
    (r) =>
      r.headers.run === run || r.text.startsWith(`${run}:`) || r.text.includes(`"run":"${run}"`),
  );

const verifyRoutes = (url: string, streamId: string, subscriptionId: string) =>
  Effect.gen(function* () {
    yield* produce(url, "/typed", "typed", 4);
    yield* produce(url, "/sink", "sink", 250);

    const records = yield* drainSubscription(streamId, subscriptionId, 4 + 250);

    // Typed records are JSON with a content-type header.
    const typed = byRun(records, "typed");
    expect(typed.map((r) => JSON.parse(r.text).index).sort()).toEqual([0, 1, 2, 3]);
    expect(typed.every((r) => r.headers["content-type"] === "application/json")).toBe(true);

    // The sink appends every element, in order.
    const sink = byRun(records, "sink").map((r) => JSON.parse(r.text).index as number);
    expect(new Set(sink).size).toEqual(250);
    expect(sink).toEqual([...sink].sort((a, b) => a - b));
  });

test.provider(
  "WriteStream and StreamSink produce through the k2 Worker binding",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const orders = yield* BindingOrders;
          const verifier = yield* Cloudflare.K2.Subscription("BindingVerifier", {
            stream: orders,
            startAt: "earliest",
          });
          const worker = yield* K2BindingWorker;
          return {
            url: worker.url.as<string>(),
            streamId: orders.streamId,
            subscriptionId: verifier.subscriptionId,
          };
        }),
      );

      yield* verifyRoutes(deployed.url, deployed.streamId, deployed.subscriptionId);

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, deployed.streamId);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:k2", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

test.provider(
  "an async Worker produces through a K2 stream in env",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const orders = yield* AsyncOrders;
          const verifier = yield* Cloudflare.K2.Subscription("AsyncVerifier", {
            stream: orders,
            startAt: "earliest",
          });
          const worker = yield* K2AsyncWorker;
          return {
            url: worker.url.as<string>(),
            streamId: orders.streamId,
            subscriptionId: verifier.subscriptionId,
          };
        }),
      );

      yield* produce(deployed.url, "/send", "async", 5);

      const records = yield* drainSubscription(deployed.streamId, deployed.subscriptionId, 5);
      expect(records.map((r) => r.text).sort()).toEqual([
        "async:0",
        "async:1",
        "async:2",
        "async:3",
        "async:4",
      ]);
      expect(records.every((r) => r.headers.run === "async")).toBe(true);

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, deployed.streamId);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:k2", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);

// WriteStreamHttp / StreamSinkHttp mint a scoped `K2 Produce` API token, so
// the deploying credentials need the K2 permission groups (K2 Config
// Read/Write, K2 Consume, K2 Produce). Without them even the stream read fails
// with `Unauthorized: Authentication error` (code 10000).
test.provider(
  "WriteStream and StreamSink produce over HTTP with a scoped token",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const orders = yield* HttpOrders;
          const verifier = yield* Cloudflare.K2.Subscription("HttpVerifier", {
            stream: orders,
            startAt: "earliest",
          });
          const worker = yield* K2HttpWorker;
          return {
            url: worker.url.as<string>(),
            streamId: orders.streamId,
            subscriptionId: verifier.subscriptionId,
          };
        }),
      );

      yield* verifyRoutes(deployed.url, deployed.streamId, deployed.subscriptionId);

      yield* stack.destroy();
      yield* waitForStreamGone(accountId, deployed.streamId);
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:k2", "provider:cloudflare:worker", "live"],
    timeout: 180_000,
  },
);
