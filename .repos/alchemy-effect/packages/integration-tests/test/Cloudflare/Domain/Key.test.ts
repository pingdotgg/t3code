import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import Stack from "./fixtures/tours-stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

// The deploy waits for a backfill on the account's shared Workflow and
// Durable Object capacity. While the backfill benchmarks
// (CatchUp.bench.test.ts) saturate it, the same deploy takes minutes instead
// of seconds, as the other Domain suites' deploys do.
const stack = beforeAll(deploy(Stack), { timeout: 420_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** A tours route answered with something other than 200. */
class ToursRequestFailed extends Data.TaggedError("ToursRequestFailed")<{
  readonly status: number;
}> {}

/** Call a tours route; right after a deploy, retry until the Worker serves it. */
const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeader("connection", "close"),
    ),
  ).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new ToursRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.json),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

test(
  "views, projections, streams and policies keyed by a schema value run on Durable Objects",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const run = yield* Effect.sync(() => crypto.randomUUID());
    const acme = `acme-${run}`;
    const globex = `globex-${run}`;

    // tours of two orgs fold into one OrgSchedule instance per org id
    yield* call(base, "POST", `/book/t1-${run}/${acme}/1A`);
    yield* call(base, "POST", `/book/t3-${run}/${globex}/9Z`);
    expect(yield* call(base, "POST", `/book/t2-${run}/${acme}/2B`)).toEqual({
      org: acme,
      tours: { [`t1-${run}`]: "1A", [`t2-${run}`]: "2B" },
    });
    expect(yield* call(base, "POST", `/cancel/t1-${run}/${acme}`)).toEqual({
      org: acme,
      tours: { [`t2-${run}`]: "2B" },
    });
    expect(yield* call(base, "GET", `/schedule/${globex}`)).toEqual({
      org: globex,
      tours: { [`t3-${run}`]: "9Z" },
    });
    expect(yield* call(base, "GET", `/schedule/none-${run}`)).toBeNull();

    // its emitted events are listed under the org id
    expect(yield* call(base, "GET", `/events/${acme}`)).toEqual([
      { id: acme, open: 1 },
      { id: acme, open: 2 },
      { id: acme, open: 1 },
    ]);

    // OrgBusy follows OrgSchedule by the same org id, with no keyOf
    const busy = yield* call(base, "GET", `/busy/${acme}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => (state as { busy?: boolean } | null)?.busy === false,
        times: 30,
      }),
    );
    expect(busy).toEqual({ org: acme, busy: false });
    yield* call(base, "POST", `/book/t4-${run}/${acme}/4D`);
    const busyAgain = yield* call(base, "GET", `/busy/${acme}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => (state as { busy?: boolean } | null)?.busy === true,
        times: 30,
      }),
    );
    expect(busyAgain).toEqual({ org: acme, busy: true });

    // OrgFeedWriter, keyed by the org id, writes one OrgFeed log per org
    const feed = yield* call(base, "GET", `/feed/${acme}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (entries) => (entries as ReadonlyArray<unknown>).length >= 3,
        times: 30,
      }),
    );
    expect(feed).toEqual([
      { id: acme, _tag: "FeedItem", tour: `t1-${run}`, unit: "1A" },
      { id: acme, _tag: "FeedItem", tour: `t2-${run}`, unit: "2B" },
      { id: acme, _tag: "FeedItem", tour: `t4-${run}`, unit: "4D" },
    ]);

    // NoteBookings, keyed by the org id, sends to the Board with that id
    const board = yield* call(base, "GET", `/board/${acme}`).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (state) => ((state as { notes?: ReadonlyArray<string> }).notes?.length ?? 0) >= 3,
        times: 30,
      }),
    );
    expect(board).toEqual({ notes: [`t1-${run}`, `t2-${run}`, `t4-${run}`] });
  }),
  { timeout: 180_000, tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);
