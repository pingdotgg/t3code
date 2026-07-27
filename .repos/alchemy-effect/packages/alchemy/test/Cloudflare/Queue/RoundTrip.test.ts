import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import QueueWorker from "./round-trip-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class CountMismatch extends Data.TaggedError("CountMismatch")<{
  expected: number;
  actual: number;
}> {}

/**
 * End-to-end Cloudflare Queue round-trip via
 * `Cloudflare.Queues.consumeQueueMessages(queue, handler)`.
 *
 * Stack:
 *
 * - `Counter` Durable Object (per-key count + last-bodies tail).
 * - `RoundTripQueue` and `SecondaryRoundTripQueue`
 *   (Cloudflare.Queues.Queue).
 * - `QueueRoundTripWorker` — exposes:
 *     - `POST /send?name=K`  →  enqueues a message via the
 *       `Cloudflare.Queues.WriteQueue` producer.
 *     - `POST /send-secondary?name=K`  →  enqueues to a second
 *       Queue bound to the same Worker.
 *     - subscribe handlers   →  increment the named Counter DO
 *       and stores the body, via
 *       `Cloudflare.Queues.consumeQueueMessages(RoundTripQueue, handler)`.
 *     - `GET /count?name=K`  →  reads the DO snapshot.
 * - `Cloudflare.Queues.Consumer` is auto-created by the policy
 *   side of `consumeQueueMessages(...)` — there is no explicit
 *   `Consumer(...)` yield in the stack.
 *
 * The test sends N messages, then polls `/count?name=K` with
 * exponential backoff until the DO reports `count >= N`. The
 * round-trip proves: producer binding writes, Cloudflare dispatches
 * to the registered consumer, the subscribe handler runs, the DO
 * RPC stub from inside the queue handler works, and the test
 * client can read the resulting DO state.
 *
 * The second queue catches regressions where Worker dispatch stops
 * after the first registered queue listener. The listener generated
 * by `consumeQueueMessages(...)` performs its queue-name check inside
 * the returned Effect, so dispatch must invoke every listener for
 * the event type.
 */
test.provider.skipIf(!!process.env.FAST)(
  "send → subscribe handlers → DO state → polled by test client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          // The Worker's init body yields Counter and
          // both Queue resources internally — yielding QueueWorker
          // is enough to bring the whole stack (Queues +
          // QueueConsumers + Counter DO + Worker) into the plan.
          const worker = yield* QueueWorker;
          return { url: worker.url };
        }),
      );
      const url = out.url;
      expect(url).toBeTypeOf("string");
      const baseUrl = url as string;

      // Use a unique counter key per test run so we don't
      // accumulate state from prior runs (the DO survives across
      // deploys when the namespace logical id is stable).
      const name = `roundtrip-${Math.random().toString(36).slice(2, 8)}`;
      const secondaryName = `roundtrip-secondary-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const messages = ["alpha", "beta", "gamma", "delta"];
      const secondaryMessages = ["one", "two"];

      const sendMessage = (
        pathname: string,
        counterName: string,
        text: string,
      ) =>
        HttpClient.execute(
          HttpClientRequest.post(
            `${baseUrl}${pathname}?name=${encodeURIComponent(counterName)}`,
          ).pipe(HttpClientRequest.bodyText(text)),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 202
              ? Effect.succeed(res)
              : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
          ),
          Effect.retry({
            // Cap the exponential at 3s — uncapped, the sleeps double each
            // attempt and a handful of misses burns minutes of the test
            // timeout on a single send.
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("3 seconds"),
              ]),
              Schedule.recurs(15),
            ]),
          }),
        );

      for (const text of messages) {
        // Cloudflare's edge takes a few seconds to start serving a fresh
        // workers.dev URL — retry until the worker returns 202.
        const sendResponse = yield* sendMessage("/send", name, text);
        expect(sendResponse.status).toBe(202);
        const sent = (yield* sendResponse.json) as {
          sent: { name: string; text: string };
        };
        expect(sent.sent.name).toBe(name);
        expect(sent.sent.text).toBe(text);
      }

      for (const text of secondaryMessages) {
        const sendResponse = yield* sendMessage(
          "/send-secondary",
          secondaryName,
          text,
        );
        expect(sendResponse.status).toBe(202);
        const sent = (yield* sendResponse.json) as {
          sent: { name: string; text: string };
        };
        expect(sent.sent.name).toBe(secondaryName);
        expect(sent.sent.text).toBe(text);
      }

      // GET /count is idempotent, so we retry on *any* failure — not
      // just CountMismatch. A fresh/hibernating DO can briefly return a
      // 500 ("Internal Server Error", which isn't valid JSON and would
      // otherwise surface as a decode error), and edge propagation can
      // 404 the first calls; both are transient and must be retried.
      const readSnapshot = (counterName: string, expected: number) =>
        HttpClient.get(
          `${baseUrl}/count?name=${encodeURIComponent(counterName)}`,
        ).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((res) => res.json),
          Effect.flatMap((body) => {
            const snap = body as { count: number; lastBodies: string[] };
            return snap.count >= expected
              ? Effect.succeed(snap)
              : Effect.fail(
                  new CountMismatch({
                    expected,
                    actual: snap.count,
                  }),
                );
          }),
          Effect.retry({
            // Cap the exponential at 4s so 40 attempts sample for ~2.5 minutes.
            // Uncapped, the doubling sleeps pass the whole 240s test budget
            // after ~9 attempts and the test dies in a single long sleep even
            // though the consumer would have caught up moments later.
            schedule: Schedule.max([
              Schedule.min([
                Schedule.exponential("500 millis"),
                Schedule.spaced("4 seconds"),
              ]),
              Schedule.recurs(40),
            ]),
          }),
        );

      // Poll the DO snapshot until each consumer has caught up.
      const snapshot = yield* readSnapshot(name, messages.length);
      const secondarySnapshot = yield* readSnapshot(
        secondaryName,
        secondaryMessages.length,
      );

      // The DO observed every message. Cloudflare Queues are
      // *at-least-once*: a message can be delivered (and thus recorded)
      // more than once, so `lastBodies` may legitimately contain
      // duplicates and `count` may exceed `messages.length`. Order is
      // also best-effort (batches dispatch in parallel). So assert every
      // expected message was observed at least once (set containment),
      // not exact multiset equality — the latter flakes whenever
      // Cloudflare redelivers a message.
      expect([...new Set(snapshot.lastBodies)].sort()).toEqual(
        [...messages].sort(),
      );
      expect(secondarySnapshot.count).toBeGreaterThanOrEqual(
        secondaryMessages.length,
      );
      expect([...new Set(secondarySnapshot.lastBodies)].sort()).toEqual(
        [...secondaryMessages].sort(),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
