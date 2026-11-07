import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { inMemoryState } from "alchemy/State";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import makeStack from "./fixtures/batches-stack.ts";

/** A route answered with something other than 200. */
class BatchRequestFailed extends Data.TaggedError("BatchRequestFailed")<{
  readonly status: number;
}> {}

/** Call a route; right after a deploy, retry until the Worker serves it. */
const call = (request: HttpClientRequest.HttpClientRequest) =>
  requestWorker(request.pipe(HttpClientRequest.setHeader("connection", "close"))).pipe(
    Effect.filterOrFail(
      (res) => res.status === 200,
      (res) => new BatchRequestFailed({ status: res.status }),
    ),
    Effect.flatMap((res) => res.text),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 10 }),
  );

describe.concurrent.each([
  { dev: true, stage: `${Test.defaultStage()}-domain-batches-local` },
  { dev: false, stage: `${Test.defaultStage()}-domain-batches-live` },
] as const)("batched projections on Durable Objects (dev: $dev)", ({ dev, stage }) => {
  const state = dev ? inMemoryState() : Cloudflare.state();
  const Stack = makeStack(state);
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state,
    dev,
    stage,
  });

  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      return yield* deploy(Stack);
    }),
    { timeout: 240_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 60_000 });

  /** A fresh group's routes, so a retried test never reads an earlier attempt's pongs. */
  const group = Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const group = yield* Effect.sync(() => crypto.randomUUID());
    return {
      ping: (id: string, slow = false) =>
        call(HttpClientRequest.post(`${base}/ping/${group}/${id}${slow ? "?slow=true" : ""}`)),
      pongs: call(HttpClientRequest.get(`${base}/pongs/${group}`)).pipe(
        Effect.map((body) => JSON.parse(body) as string[]),
      ),
    };
  });

  test(
    "a short batch runs once its wait is up",
    Effect.gen(function* () {
      const { ping, pongs } = yield* group;
      const started = yield* Clock.currentTimeMillis;
      yield* ping("only");
      const answered = yield* pongs.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (entries) => entries.length > 0,
          times: 80,
        }),
      );
      expect(answered).toEqual(["only"]);
      // A new key's first ping arrives through backfill, from inside one of
      // its callbacks, after a 5-second poll; then the batch waits 5 seconds:
      // about 10. A wake-up lost with that callback's invocation leaves it to
      // the backstop, which inherits the callback's 30-second backoff: about 35.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(20_000);
    }),
    { timeout: 120_000 },
  );

  test(
    "a batch that starts while another runs waits its batch wait, not a retry backoff",
    Effect.gen(function* () {
      const { ping, pongs } = yield* group;
      // A new key's first ping arrives through backfill; once it's answered,
      // the next ones arrive live.
      yield* ping("warm");
      yield* pongs.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (entries) => entries.length > 0,
          times: 80,
        }),
      );

      const started = yield* Clock.currentTimeMillis;
      // The slow ping's batch waits 5 seconds, then the drain's own callback
      // runs it for 12.
      yield* ping("slow", true);
      // Halfway through that run, a second ping arrives. The drain finds it
      // when the slow run ends, younger than the batch wait, and waits for it
      // from inside its own callback.
      yield* Effect.sleep("14 seconds");
      yield* ping("late");
      const answered = yield* pongs.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (entries) => entries.includes("late"),
          times: 60,
        }),
      );
      expect(answered).toEqual(["warm", "slow", "late"]);
      // On time: answered about 19 seconds in. Waiting out the drain's 30-second
      // retry backoff instead: about 47.
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(32_000);
    }),
    { timeout: 150_000 },
  );
});
