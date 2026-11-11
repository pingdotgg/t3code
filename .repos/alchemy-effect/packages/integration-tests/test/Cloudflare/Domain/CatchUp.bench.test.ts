import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import BenchV1 from "./fixtures/bench/v1.ts";
import BenchV2Summary from "./fixtures/bench/v2-summary.ts";
import BenchV2Total from "./fixtures/bench/v2-total.ts";
import BenchV2 from "./fixtures/bench/v2.ts";

/**
 * What a backfill costs and how long a deploy waits for it on Cloudflare. Each
 * run deploys accounts, seeds history, then deploys a view and reads the
 * Durable Object requests and SQLite rows of its backfill from Cloudflare's
 * analytics, printing a `BENCH` line of JSON. Three shapes:
 *
 * - width (`DOMAIN_BENCH_INSTANCES`, default 1000): N accounts with 10 deposits
 *   each, then a view keyed by account;
 * - depth (`DOMAIN_BENCH_DEPTH`, default 1000): one account with N deposits,
 *   then a summary per account;
 * - bank-wide (`DOMAIN_BENCH_TOTAL`, `<accounts>x<events>`, default 100x100):
 *   accounts with deposits, then one total that every account feeds.
 *
 * Sizes are comma-separated; an empty variable skips that shape.
 */

const EVENTS = 10;
// A Worker request runs at most 6 outgoing calls at once: seed in small batches, many at a time.
const SEED_BATCH = 10;
// Deposits to one account per request: one object takes them in order.
const DEPOSIT_BATCH = 1000;
const list = (name: string, fallback: string) =>
  (process.env[name] ?? fallback).split(",").filter((size) => size !== "");
const widths = list("DOMAIN_BENCH_INSTANCES", "1000").map(Number);
const depths = list("DOMAIN_BENCH_DEPTH", "1000").map(Number);
const totals = list("DOMAIN_BENCH_TOTAL", "100x100").map(
  (size) => size.split("x").map(Number) as [number, number],
);

class NotYet extends Data.TaggedError("NotYet")<{
  readonly status: number;
  readonly body: string;
}> {}

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

const serving = (url: string, version: string) =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

interface Usage {
  readonly requests: number;
  readonly byType: Record<string, number>;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Billed duration, in GB-seconds. */
  readonly duration: number;
}

/** The Worker's Durable Object usage between two instants, from Cloudflare's GraphQL analytics. */
const usage = (scriptName: string, from: Date, to: Date) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const headers = formatHeaders(yield* yield* Credentials);
    const client = yield* HttpClient.HttpClient;
    const query = <T>(query: string) =>
      client
        .execute(
          HttpClientRequest.post("https://api.cloudflare.com/client/v4/graphql").pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe({ query }),
          ),
        )
        .pipe(
          Effect.flatMap((res) => res.json),
          Effect.map(
            (body) => (body as { data: { viewer: { accounts: [T] } } }).data.viewer.accounts[0],
          ),
        );
    const window = `datetime_geq: "${from.toISOString()}", datetime_leq: "${to.toISOString()}"`;
    const { invocations } = yield* query<{
      invocations: ReadonlyArray<{
        sum: { requests: number };
        dimensions: { namespaceId: string; type: string };
      }>;
    }>(`{ viewer { accounts(filter: { accountTag: "${accountId}" }) {
      invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { scriptName: "${scriptName}", ${window} }) {
        sum { requests } dimensions { namespaceId type }
      } } } }`);
    const namespaces = [...new Set(invocations.map((row) => row.dimensions.namespaceId))];
    const { periodic } =
      namespaces.length === 0
        ? { periodic: [] }
        : yield* query<{
            periodic: ReadonlyArray<{
              sum: { rowsRead: number; rowsWritten: number; duration: number };
            }>;
          }>(`{ viewer { accounts(filter: { accountTag: "${accountId}" }) {
            periodic: durableObjectsPeriodicGroups(limit: 1000, filter: { namespaceId_in: ${JSON.stringify(namespaces)}, ${window} }) {
              sum { rowsRead rowsWritten duration } dimensions { namespaceId }
            } } } }`);
    const byType: Record<string, number> = {};
    for (const row of invocations) {
      byType[row.dimensions.type] = (byType[row.dimensions.type] ?? 0) + row.sum.requests;
    }
    return {
      requests: invocations.reduce((total, row) => total + row.sum.requests, 0),
      byType,
      rowsRead: periodic.reduce((total, row) => total + row.sum.rowsRead, 0),
      rowsWritten: periodic.reduce((total, row) => total + row.sum.rowsWritten, 0),
      duration: periodic.reduce((total, row) => total + row.sum.duration, 0),
    } satisfies Usage;
  });

/**
 * Analytics arrive minutes late, and later the more there are: wait five minutes,
 * then read until three reads a minute apart agree. Read before the stack is
 * destroyed: a deleted Worker's rows lose its script name.
 */
const settledUsage = (scriptName: string, from: Date, to: Date) =>
  Effect.gen(function* () {
    yield* Effect.sleep("5 minutes");
    let last = yield* usage(scriptName, from, to);
    let agreed = 0;
    for (let attempt = 0; attempt < 15 && agreed < 2; attempt++) {
      yield* Effect.sleep("1 minute");
      const next = yield* usage(scriptName, from, to);
      agreed =
        next.requests === last.requests && next.rowsWritten === last.rowsWritten ? agreed + 1 : 0;
      last = next;
    }
    return last;
  });

const now = Effect.sync(() => new Date());

const { test } = Test.make({ providers: Cloudflare.providers() });

/** Retry a seed request, logging why: a slow seed is otherwise silent. */
const seedRetry = <A, E extends { readonly _tag: string }, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    // A seed request can hang for many minutes: fail it and send it again (seeds are idempotent).
    Effect.timeout("2 minutes"),
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.log(
          `SEED-RETRY ${path} ${error._tag}${"status" in error ? ` ${String(error.status)}` : ""}${"body" in error ? ` ${String(error.body).slice(0, 120)}` : ""}`,
        ),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
  );

const seedAccounts = (url: string, accounts: number, events: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(accounts / SEED_BATCH) }, (_, i) => i * SEED_BATCH),
    (from) => {
      const path = `/seed/${from}/${Math.min(SEED_BATCH, accounts - from)}/${events}`;
      return seedRetry(path, call(url, "POST", path));
    },
    { concurrency: 64, discard: true },
  );

const seedOne = (url: string, account: string, events: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(events / DEPOSIT_BATCH) }, (_, i) => i * DEPOSIT_BATCH + 1),
    (from) => {
      const path = `/deposit/${account}/${from}/${Math.min(DEPOSIT_BATCH, events - from + 1)}`;
      return seedRetry(path, call(url, "POST", path));
    },
    { concurrency: 4, discard: true },
  );

type Next = typeof BenchV2 | typeof BenchV2Summary | typeof BenchV2Total;

/**
 * Deploy accounts, seed them, deploy `next` and wait for its backfill; check
 * the view, then read the backfill's usage from analytics.
 */
const run = (
  stack: Test.ScratchStack,
  shape: Record<string, unknown> & { readonly events: number; readonly instances: number },
  seed: (url: string) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
  next: Next,
  check: (url: string) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const { worker } = yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* BenchV1 };
      }),
    );
    const url = worker.url!.replace(/\/+$/, "");
    const scriptName = worker.workerName;
    yield* serving(url, "v1");

    // History before the view exists.
    const seedStart = yield* now;
    yield* seed(url);
    const seedEnd = yield* now;
    // Keep the seed out of the backfill's analytics window.
    yield* Effect.sleep("2 minutes");

    const deployStart = yield* now;
    yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* next };
      }),
    );
    const deployEnd = yield* now;
    yield* serving(url, "v2");

    // The deploy returned once the backfill was done.
    const history = JSON.parse(yield* call(url, "GET", "/history")) as { complete: boolean };
    expect(history.complete).toBe(true);
    yield* check(url);

    const timing = {
      ...shape,
      deploySeconds: +((deployEnd.getTime() - deployStart.getTime()) / 1000).toFixed(1),
      seedSeconds: +((seedEnd.getTime() - seedStart.getTime()) / 1000).toFixed(1),
    };
    // DOMAIN_BENCH_TIME_ONLY: report the deploy's time without waiting minutes for analytics.
    if (process.env.DOMAIN_BENCH_TIME_ONLY) {
      yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(timing)}`));
      return yield* stack.destroy();
    }
    const settleEnd = new Date(deployEnd.getTime() + 2 * 60_000);
    const seedUsage = yield* settledUsage(scriptName, seedStart, seedEnd);
    const backfill = yield* settledUsage(scriptName, deployStart, settleEnd);
    const result = {
      ...timing,
      backfill,
      seed: seedUsage,
      requestsPerInstance: +(backfill.requests / shape.instances).toFixed(2),
      rowsWrittenPerEvent: +(backfill.rowsWritten / shape.events).toFixed(2),
      rowsReadPerEvent: +(backfill.rowsRead / shape.events).toFixed(2),
    };
    yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(result)}`));
    yield* stack.destroy();
  });

const viewOf = (url: string, key: string) =>
  call(url, "GET", `/view/${key}`).pipe(Effect.map((body) => JSON.parse(body)));

// Each run has its own Worker and stack: run them at once, or a full sweep takes hours.
describe.concurrent("live backfill benchmarks", () => {
  for (const instances of widths) {
    test.provider.skipIf(!!process.env.FAST)(
      `live: backfill of ${instances} instances with ${EVENTS} events each`,
      (stack) =>
        run(
          stack,
          { shape: "width", instances, events: instances * EVENTS },
          (url) => seedAccounts(url, instances, EVENTS),
          BenchV2,
          (url) =>
            Effect.gen(function* () {
              const expected = Array.from({ length: EVENTS }, (_, n) => n + 1);
              for (const i of [0, Math.floor(instances / 2), instances - 1]) {
                const account = JSON.parse(yield* call(url, "GET", `/account/b${i}`)) as {
                  balance: number;
                };
                expect(account.balance).toBe((EVENTS * (EVENTS + 1)) / 2);
                expect(
                  ((yield* viewOf(url, `b${i}`)) as { amounts: Array<number> }).amounts,
                ).toEqual(expected);
              }
            }),
        ),
      { timeout: 7_200_000 },
    );
  }

  for (const events of depths) {
    test.provider.skipIf(!!process.env.FAST)(
      `live: backfill of one account with ${events} events`,
      (stack) =>
        run(
          stack,
          { shape: "depth", instances: 1, events },
          (url) => seedOne(url, "deep", events),
          BenchV2Summary,
          (url) =>
            Effect.gen(function* () {
              expect(yield* viewOf(url, "deep")).toEqual({
                count: events,
                total: (events * (events + 1)) / 2,
              });
            }),
        ),
      { timeout: 7_200_000 },
    );
  }

  for (const [accounts, events] of totals) {
    test.provider.skipIf(!!process.env.FAST)(
      `live: backfill of a bank-wide total over ${accounts} accounts with ${events} events each`,
      (stack) =>
        run(
          stack,
          { shape: "total", instances: accounts, events: accounts * events },
          (url) => seedAccounts(url, accounts, events),
          BenchV2Total,
          (url) =>
            Effect.gen(function* () {
              expect(yield* viewOf(url, "bank")).toEqual({
                count: accounts * events,
                total: (accounts * events * (events + 1)) / 2,
              });
            }),
        ),
      { timeout: 7_200_000 },
    );
  }
});
