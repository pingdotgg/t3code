import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import WorkerV0 from "./fixtures/version/v0.ts";
import WorkerV1 from "./fixtures/version/v1.ts";

/** A route answered with something other than what the test waits for. */
class NotYet extends Data.TaggedError("NotYet")<{
  readonly status: number;
  readonly body: string;
}> {}

/** Call a route on a fresh connection, so the request reaches the latest deployment. */
const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ connection: "close", "cache-control": "no-cache" }),
    ),
  ).pipe(
    Effect.retry({
      while: (error) => error._tag === "HttpClientError",
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotYet({ status: res.status, body })),
        ),
      ),
    ),
  );

/** Wait until the Worker serves `version`: a redeploy takes a few seconds to roll out. */
const serving = (url: string, version: string) =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

/**
 * Poll a view until an account's row is `expected`. An object keeps the code
 * from before a deploy until it has been idle, so a row can answer from the
 * old code for a while: allow a few minutes.
 */
const row = (url: string, view: "summary" | "latest", account: string, net: number) =>
  call(url, "GET", `/${view}/${account}`).pipe(
    Effect.map((body) => JSON.parse(body) as { net: number } | null),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value?.net === net,
      times: 150,
    }),
  );

/** Poll a view row like `row`, but within a minute. */
const soon = (url: string, view: "summary" | "latest", account: string, net: number) =>
  call(url, "GET", `/${view}/${account}`).pipe(
    Effect.map((body) => JSON.parse(body) as { net: number } | null),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (value) => value?.net === net,
      times: 30,
    }),
  );

/** Read `path` every 250 ms, without retrying, until interrupted: every answer, in order. */
const watch = (url: string, path: string, answers: Array<{ status: number; body: string }>) =>
  HttpClient.execute(
    HttpClientRequest.get(`${url}${path}`).pipe(HttpClientRequest.setHeader("connection", "close")),
  ).pipe(
    Effect.flatMap((res) => Effect.map(res.text, (body) => ({ status: res.status, body }))),
    Effect.catch((error) => Effect.succeed({ status: 0, body: String(error) })),
    Effect.tap((answer) => Effect.sync(() => answers.push(answer))),
    Effect.repeat(Schedule.spaced("250 millis")),
  );

/** The model's Durable Object classes on the Worker, by class name. */
const classes = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const namespaces = yield* durableObjects.listNamespaces
      .items({ accountId })
      .pipe(Stream.runCollect);
    return Object.fromEntries(
      namespaces.flatMap((namespace) =>
        namespace.script === scriptName && namespace.class?.match(/^Bank\.(Summary|Latest)View/)
          ? [[namespace.class, namespace.id]]
          : [],
      ),
    );
  }).pipe(Effect.provide(CloudflareApiLive()), Effect.scoped);

for (const dev of [true, false]) {
  describe(dev ? "local view versions" : "live view versions", () => {
    const { test } = Test.make({ providers: Cloudflare.providers(), dev });

    test.provider(
      `${dev ? "local" : "live"}: bumping a view's version rebuilds it in place, and what reads it from the history`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { worker } = yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* WorkerV0 };
            }),
          );
          const url = worker.url!.replace(/\/+$/, "");
          yield* serving(url, "v0");
          yield* call(url, "POST", "/deposit/a-1/10");
          yield* call(url, "POST", "/withdraw/a-1/4");
          yield* call(url, "POST", "/deposit/a-2/3");
          // Version 0 counts deposits only.
          expect(yield* row(url, "summary", "a-1", 10)).toEqual({ net: 10 });
          expect(yield* row(url, "latest", "a-1", 10)).toEqual({ net: 10 });
          const before = dev ? {} : yield* classes(worker.workerName);

          // Live, keep a-1's summary busy through the deploy, so its object stays on
          // the code from before it (it moves once idle): every read must still answer.
          const answers: Array<{ status: number; body: string }> = [];
          const watcher = dev
            ? undefined
            : yield* Effect.forkChild(watch(url, "/summary/a-1", answers));
          yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* WorkerV1 };
            }),
          );
          yield* serving(url, "v1");
          // The withdrawal, which the old rows never received, counts: at once, even
          // while the busy object runs the old code.
          expect(yield* soon(url, "summary", "a-1", 6)).toEqual({ net: 6 });
          if (watcher) {
            yield* Fiber.interrupt(watcher);
            expect(answers.length).toBeGreaterThan(10);
            expect(answers.filter((answer) => answer.status !== 200)).toEqual([]);
          }
          expect(yield* row(url, "summary", "a-2", 3)).toEqual({ net: 3 });
          // The view built on it is rebuilt from the summary's new rows.
          expect(yield* row(url, "latest", "a-1", 6)).toEqual({ net: 6 });
          // And it keeps up afterwards.
          yield* call(url, "POST", "/withdraw/a-1/1");
          expect(yield* row(url, "summary", "a-1", 5)).toEqual({ net: 5 });
          expect(yield* row(url, "latest", "a-1", 5)).toEqual({ net: 5 });

          if (!dev) {
            const after = yield* classes(worker.workerName);
            // The summary was rebuilt in its own storage; the latest view in a new one.
            expect(after["Bank.SummaryView"]).toBe(before["Bank.SummaryView"]);
            expect(after["Bank.SummaryViewV1"]).toBeUndefined();
            expect(after["Bank.LatestViewV1"]).toBeDefined();
          }

          yield* stack.destroy();
        }),
      { timeout: 900_000 },
    );
  });
}
