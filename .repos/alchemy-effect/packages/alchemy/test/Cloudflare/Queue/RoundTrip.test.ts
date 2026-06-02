import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import QueueWorker, { Counter, RoundTripQueue } from "./round-trip-worker.ts";

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
 * `Cloudflare.messages(queue).subscribe(...)`.
 *
 * Stack:
 *
 * - `Counter` Durable Object (per-key count + last-bodies tail).
 * - `RoundTripQueue` (Cloudflare.Queue).
 * - `QueueRoundTripWorker` — exposes:
 *     - `POST /send?name=K`  →  enqueues a message via the
 *       `Cloudflare.QueueBinding` producer.
 *     - subscribe handler    →  increments the named Counter DO
 *       and stores the body, via
 *       `Cloudflare.messages(RoundTripQueue).subscribe(...)`.
 *     - `GET /count?name=K`  →  reads the DO snapshot.
 * - `Cloudflare.QueueConsumer` is auto-created by the policy
 *   side of `messages().subscribe(...)` — there is no explicit
 *   `QueueConsumer(...)` yield in the stack.
 *
 * The test sends N messages, then polls `/count?name=K` with
 * exponential backoff until the DO reports `count >= N`. The
 * round-trip proves: producer binding writes, Cloudflare dispatches
 * to the registered consumer, the subscribe handler runs, the DO
 * RPC stub from inside the queue handler works, and the test
 * client can read the resulting DO state.
 */
test.provider(
  "send → subscribe handler → DO state → polled by test client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          // The Worker's init body yields Counter and
          // RoundTripQueue internally — yielding QueueWorker is
          // enough to bring the whole stack (Queue +
          // QueueConsumer + Counter DO + Worker) into the plan.
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
      const messages = ["alpha", "beta", "gamma", "delta"];

      for (const text of messages) {
        // Cloudflare's edge takes a few seconds to start serving a fresh
        // workers.dev URL — retry until the worker returns 202.
        const sendResponse = yield* HttpClient.execute(
          HttpClientRequest.post(
            `${baseUrl}/send?name=${encodeURIComponent(name)}`,
          ).pipe(HttpClientRequest.bodyText(text)),
        ).pipe(
          Effect.flatMap((res) =>
            res.status === 202
              ? Effect.succeed(res)
              : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
          ),
          Effect.retry({
            schedule: Schedule.exponential("500 millis").pipe(
              Schedule.both(Schedule.recurs(15)),
            ),
          }),
        );
        expect(sendResponse.status).toBe(202);
        const sent = (yield* sendResponse.json) as {
          sent: { name: string; text: string };
        };
        expect(sent.sent.name).toBe(name);
        expect(sent.sent.text).toBe(text);
      }

      // Poll the DO snapshot until the consumer has caught up. The
      // exponential schedule + recurs cap gives Cloudflare ~60s to
      // dispatch and ack — comfortably above the typical 1–5s
      // dispatch latency we saw in practice without flaking.
      const snapshot = yield* HttpClient.get(
        `${baseUrl}/count?name=${encodeURIComponent(name)}`,
      ).pipe(
        Effect.flatMap((res) => res.json),
        Effect.flatMap((body) => {
          const snap = body as { count: number; lastBodies: string[] };
          return snap.count >= messages.length
            ? Effect.succeed(snap)
            : Effect.fail(
                new CountMismatch({
                  expected: messages.length,
                  actual: snap.count,
                }),
              );
        }),
        Effect.retry({
          while: (e): e is CountMismatch => e instanceof CountMismatch,
          schedule: Schedule.exponential("500 millis").pipe(
            Schedule.both(Schedule.recurs(40)),
          ),
        }),
      );

      // The DO observed every message. The order is best-effort
      // (Cloudflare may dispatch batches in parallel) so we
      // compare as a multiset.
      expect(snapshot.count).toBeGreaterThanOrEqual(messages.length);
      expect([...snapshot.lastBodies].sort()).toEqual([...messages].sort());

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
