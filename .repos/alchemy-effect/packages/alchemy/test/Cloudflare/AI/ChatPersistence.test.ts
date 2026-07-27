import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Gateway } from "./fixtures/Gateway.ts";
import ChatPersistenceTestWorker from "./fixtures/ChatPersistenceWorker.ts";

// Fresh `workers.dev` URLs return non-200 (404 / 500 "Script not
// found") for a few seconds while the edge propagates. Each test uses
// `HttpClient.filterStatusOk(yield* HttpClient.HttpClient)` so the
// existing `Effect.retry` rides through these by converting the
// bad-status response into a retryable Effect failure.

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "AiGatewayChatPersistenceStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* ChatPersistenceTestWorker;
    const gateway = yield* Gateway;
    return {
      gatewayId: gateway.gatewayId,
      url: worker.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cap exponential backoff at 3s so retries stay bounded when the CF edge is
// slow (otherwise the geometric blow-up dominates wall time).
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// `filterStatusOk` turns a cold-start non-200 (e.g. a 500 HTML error page)
// into a retryable failure, and `catchDefect` promotes any cold-start defect
// (`Handler does not export a fetch() function.`) into a failure too — so the
// readiness retry absorbs both while the worker propagates to the edge.
const retryReady = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry({ schedule: readinessSchedule, times: 15 }),
  );

test(
  "first turn against a fresh thread persists user + assistant messages",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const id = `fresh-${Date.now()}`;

    const res = yield* client
      .get(
        `${out.url}/chat?id=${id}&prompt=${encodeURIComponent("Say the single word 'pong'.")}`,
      )
      .pipe(retryReady);
    expect(res.status).toBe(200);

    const body = (yield* res.json) as { text: string; turns: number };
    expect(typeof body.text).toBe("string");
    expect(body.text.length).toBeGreaterThan(0);
    // The empty chat starts with no messages; one turn appends the user
    // prompt and the assistant reply.
    expect(body.turns).toBe(2);
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "persisted chat survives across DO invocations",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const id = `memory-${Date.now()}`;

    const r1 = yield* client
      .get(
        `${out.url}/chat?id=${id}&prompt=${encodeURIComponent("My name is Sam. Remember it.")}`,
      )
      .pipe(retryReady);
    expect(r1.status).toBe(200);
    const b1 = (yield* r1.json) as { text: string; turns: number };
    expect(b1.turns).toBe(2);

    // Second request hits the same DO instance (same `id`). The chat
    // history is reloaded from `state.storage`, so the model can recall
    // the name from the first turn.
    const r2 = yield* client
      .get(
        `${out.url}/chat?id=${id}&prompt=${encodeURIComponent("What is my name? Answer with just the name.")}`,
      )
      .pipe(retryReady);
    expect(r2.status).toBe(200);
    const b2 = (yield* r2.json) as { text: string; turns: number };

    expect(b2.text.toLowerCase()).toContain("sam");
    // The second turn appends another user + assistant pair on top of the
    // restored history.
    expect(b2.turns).toBe(4);
  }).pipe(logLevel),
  { timeout: 240_000 },
);

test(
  "distinct thread ids map to isolated histories",
  Effect.gen(function* () {
    const out = yield* stack;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const stamp = Date.now();
    const idA = `iso-a-${stamp}`;
    const idB = `iso-b-${stamp}`;

    const ra = yield* client
      .get(
        `${out.url}/chat?id=${idA}&prompt=${encodeURIComponent("My favorite color is teal. Remember it.")}`,
      )
      .pipe(retryReady);
    expect(ra.status).toBe(200);
    expect(((yield* ra.json) as { turns: number }).turns).toBe(2);

    // A different id is a different DO instance with its own storage, so
    // its first turn also starts from an empty history (turns === 2),
    // proving the two threads don't share state.
    const rb = yield* client
      .get(
        `${out.url}/chat?id=${idB}&prompt=${encodeURIComponent("Say the single word 'pong'.")}`,
      )
      .pipe(retryReady);
    expect(rb.status).toBe(200);
    expect(((yield* rb.json) as { turns: number }).turns).toBe(2);
  }).pipe(logLevel),
  { timeout: 180_000 },
);
