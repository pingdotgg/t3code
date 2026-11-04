import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import WorkerV1 from "./fixtures/catch-up/v1.ts";
import WorkerLazy from "./fixtures/catch-up/v2-lazy.ts";

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

const deposit = (url: string, account: string, amount: number) =>
  call(url, "POST", `/deposit/${account}/${amount}`).pipe(
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

/**
 * Read an account's deposits: a lazy key answers its first read with its whole
 * history. Only a host still on the code from before the deploy (no such route)
 * is asked again.
 */
const deposits = (url: string, account: string) =>
  call(url, "GET", `/deposits/${account}`).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotYet" && e.status === 404 && e.body === "Not Found",
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
    Effect.map((body) => (JSON.parse(body) as { amounts: ReadonlyArray<number> } | null)?.amounts),
  );

for (const dev of [true, false]) {
  describe(dev ? "local lazy views" : "live lazy views", () => {
    const { test } = Test.make({ providers: Cloudflare.providers(), dev });

    test.provider(
      `${dev ? "local" : "live"}: a lazy view added later fills each key when first read`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const { worker } = yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* WorkerV1 };
            }),
          );
          const url = worker.url!.replace(/\/+$/, "");
          yield* serving(url, "v1");
          yield* deposit(url, "a-1", 10);
          yield* deposit(url, "a-1", 20);
          yield* deposit(url, "a-2", 5);

          // Adding a lazy view starts no backfill: the deploy has nothing to wait for.
          const plan = yield* stack.plan(
            Effect.gen(function* () {
              return { worker: yield* WorkerLazy };
            }),
          );
          expect(plan.resources["Ledger.DomainBackfillRun"]).toBeUndefined();
          yield* stack.deploy(
            Effect.gen(function* () {
              return { worker: yield* WorkerLazy };
            }),
          );
          yield* serving(url, "v2-lazy");

          // The first read of each key reads its account's history.
          expect(yield* deposits(url, "a-1")).toEqual([10, 20]);
          expect(yield* deposits(url, "a-2")).toEqual([5]);
          expect(JSON.parse(yield* call(url, "GET", "/history"))).toEqual({ complete: true });

          // After that, new deposits arrive live.
          yield* deposit(url, "a-1", 30);
          const after = yield* deposits(url, "a-1").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (amounts) => amounts?.length === 3,
              times: 30,
            }),
          );
          expect(after).toEqual([10, 20, 30]);

          yield* stack.destroy();
        }),
      { timeout: 600_000 },
    );
  });
}
