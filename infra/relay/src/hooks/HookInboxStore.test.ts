import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as HookInboxStore from "./HookInboxStore.ts";

const BASE_URL = "https://env.example.test/";

const hook = (id: string, overrides: Partial<HookInboxStore.HeldHook> = {}) =>
  Effect.map(Clock.currentTimeMillis, (now): HookInboxStore.HeldHook => ({
    id,
    receivedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
    method: "POST",
    rawHookId: "hook-1",
    hookKey: "hook-1",
    rawToken: "tok%2Fen",
    query: "a=1",
    headers: { "content-type": "application/json", "x-sig": "s" },
    body: new Uint8Array([0, 255, 10]),
    ...overrides,
  }));

/** Delivers with `outcome` per request and records what the environment was sent. */
const deliverer = (outcome: (hook: HookInboxStore.HeldHook) => HookInboxStore.DeliveryOutcome) => {
  const sent: Array<{ readonly baseUrl: string; readonly hook: HookInboxStore.HeldHook }> = [];
  const send = (baseUrl: string, held: HookInboxStore.HeldHook) =>
    Effect.sync(() => {
      sent.push({ baseUrl, hook: held });
      return outcome(held);
    });
  return { sent, send };
};

const withInbox = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  HookInboxStore.migrate.pipe(
    Effect.andThen(effect),
    Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

describe("HookInboxStore", () => {
  it.effect("delivers held requests oldest first, byte for byte", () =>
    withInbox(
      Effect.gen(function* () {
        const first = yield* hook("first");
        expect(yield* HookInboxStore.hold(first, BASE_URL)).not.toBeNull();
        yield* HookInboxStore.hold(yield* hook("second"), BASE_URL);
        const { sent, send } = deliverer(() => "delivered");
        expect(yield* HookInboxStore.deliverDue(send)).toBeNull();
        expect(sent.map((entry) => entry.hook.id)).toEqual(["first", "second"]);
        expect(sent[0]).toEqual({ baseUrl: BASE_URL, hook: first });
        // Delivered requests are gone.
        expect(yield* HookInboxStore.deliverDue(send)).toBeNull();
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("keeps a request the environment did not take and backs off", () =>
    withInbox(
      Effect.gen(function* () {
        yield* HookInboxStore.hold(yield* hook("first"), BASE_URL);
        yield* HookInboxStore.hold(yield* hook("second"), BASE_URL);
        const offline = deliverer(() => "unreachable");
        const now = yield* Clock.currentTimeMillis;
        // Stops at the first failure, so order is kept.
        expect(yield* HookInboxStore.deliverDue(offline.send)).toBe(now + 10_000);
        expect(offline.sent.map((entry) => entry.hook.id)).toEqual(["first"]);
        expect(yield* HookInboxStore.deliverDue(offline.send)).toBe(now + 10_000);

        const online = deliverer(() => "delivered");
        expect(yield* HookInboxStore.deliverDue(online.send)).toBeNull();
        expect(online.sent.map((entry) => entry.hook.id)).toEqual(["first", "second"]);
      }),
    ),
  );

  it.effect("lets other hooks through while one hook's environment is busy", () =>
    withInbox(
      Effect.gen(function* () {
        const stuck = { rawHookId: "stuck", hookKey: "stuck" };
        yield* HookInboxStore.hold(yield* hook("stuck-1", stuck), BASE_URL);
        yield* HookInboxStore.hold(yield* hook("other-1"), BASE_URL);
        yield* HookInboxStore.hold(yield* hook("stuck-2", stuck), BASE_URL);
        const busy = deliverer((held) => (held.hookKey === "stuck" ? "busy" : "delivered"));
        const now = yield* Clock.currentTimeMillis;
        // The other hook is delivered; the busy hook keeps its order and runs again soon.
        expect(yield* HookInboxStore.deliverDue(busy.send)).toBe(now);
        expect(busy.sent.map((entry) => entry.hook.id)).toEqual(["stuck-1", "other-1"]);
        // Only the busy hook is left, so the next run waits rather than spinning.
        expect(yield* HookInboxStore.deliverDue(busy.send)).toBe(now + 30_000);

        const drained = deliverer(() => "delivered");
        expect(yield* HookInboxStore.deliverDue(drained.send)).toBeNull();
        expect(drained.sent.map((entry) => entry.hook.id)).toEqual(["stuck-1", "stuck-2"]);
      }),
    ),
  );

  it.effect("reaches a hook queued behind busy hooks' full backlogs in the same run", () =>
    withInbox(
      Effect.gen(function* () {
        for (const name of ["stuck-a", "stuck-b"]) {
          const stuck = { rawHookId: name, hookKey: name };
          for (let index = 0; index < HookInboxStore.HOOK_INBOX_MAX_PER_HOOK; index++) {
            yield* HookInboxStore.hold(yield* hook(`${name}-${index}`, stuck), BASE_URL);
          }
        }
        yield* HookInboxStore.hold(yield* hook("other-1"), BASE_URL);
        const busy = deliverer((held) => (held.hookKey.startsWith("stuck") ? "busy" : "delivered"));
        yield* HookInboxStore.deliverDue(busy.send);
        expect(busy.sent.map((entry) => entry.hook.id)).toEqual([
          "stuck-a-0",
          "stuck-b-0",
          "other-1",
        ]);
      }),
    ),
  );

  it.effect("drops a held request it cannot read instead of stalling on it", () =>
    withInbox(
      Effect.gen(function* () {
        yield* HookInboxStore.hold(yield* hook("broken"), BASE_URL);
        yield* HookInboxStore.hold(yield* hook("fine"), BASE_URL);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE held_hooks SET headers = 'not json' WHERE id = 'broken'`;
        const { sent, send } = deliverer(() => "delivered");
        expect(yield* HookInboxStore.deliverDue(send)).toBeNull();
        expect(sent.map((entry) => entry.hook.id)).toEqual(["fine"]);
      }),
    ),
  );

  it.effect("retries every 10 s for 3 minutes, then backs off to 10 minutes", () =>
    Effect.gen(function* () {
      const delays = yield* Effect.forEach(
        [1, 18, 19, 20, 21, 23, 24, 40],
        HookInboxStore.retryDelayMs,
      );
      expect(delays).toEqual([10_000, 10_000, 30_000, 60_000, 120_000, 480_000, 600_000, 600_000]);
    }),
  );

  it.effect("waking resets the backoff and reports whether anything waits", () =>
    withInbox(
      Effect.gen(function* () {
        expect(yield* HookInboxStore.wake(BASE_URL)).toBe(false);
        yield* HookInboxStore.hold(yield* hook("first"), "https://old.example.test/");
        const offline = deliverer(() => "unreachable");
        yield* HookInboxStore.deliverDue(offline.send);
        yield* HookInboxStore.deliverDue(offline.send);

        // Past the fast phase: the environment was away a while.
        for (let failure = 0; failure < 20; failure++) {
          yield* HookInboxStore.deliverDue(offline.send);
        }
        const now = yield* Clock.currentTimeMillis;
        expect(yield* HookInboxStore.deliverDue(offline.send)).toBeGreaterThan(now + 60_000);

        // A wake means its tunnel just connected, which Cloudflare may not
        // route to for a few minutes: back to retrying every 10 s, sent to
        // where the environment is now.
        expect(yield* HookInboxStore.wake(BASE_URL)).toBe(true);
        expect(yield* HookInboxStore.deliverDue(offline.send)).toBe(now + 10_000);
        expect(offline.sent.at(-1)?.baseUrl).toBe(BASE_URL);
      }),
    ),
  );

  it.effect("starts the schedule over once the inbox drains", () =>
    withInbox(
      Effect.gen(function* () {
        yield* HookInboxStore.hold(yield* hook("old"), BASE_URL);
        const offline = deliverer(() => "unreachable");
        for (let failure = 0; failure < 30; failure++) {
          yield* HookInboxStore.deliverDue(offline.send);
        }
        // Nothing got through before the request expired.
        yield* TestClock.adjust(Duration.hours(25));
        expect(yield* HookInboxStore.deliverDue(offline.send)).toBeNull();

        const now = yield* Clock.currentTimeMillis;
        expect(yield* HookInboxStore.hold(yield* hook("new"), BASE_URL)).toBe(now + 10_000);
      }),
    ),
  );

  it.effect("drops requests older than 24 hours", () =>
    withInbox(
      Effect.gen(function* () {
        yield* HookInboxStore.hold(yield* hook("old"), BASE_URL);
        yield* TestClock.adjust(Duration.hours(1));
        yield* HookInboxStore.hold(yield* hook("new"), BASE_URL);
        yield* TestClock.adjust(Duration.minutes(23 * 60 + 1));
        const { sent, send } = deliverer(() => "delivered");
        yield* HookInboxStore.deliverDue(send);
        expect(sent.map((entry) => entry.hook.id)).toEqual(["new"]);
      }),
    ),
  );

  it.effect("refuses requests past the per-hook cap", () =>
    withInbox(
      Effect.gen(function* () {
        for (let index = 0; index < HookInboxStore.HOOK_INBOX_MAX_PER_HOOK; index++) {
          expect(yield* HookInboxStore.hold(yield* hook(`a-${index}`), BASE_URL)).not.toBeNull();
        }
        expect(yield* HookInboxStore.hold(yield* hook("one-too-many"), BASE_URL)).toBeNull();
        // Another hook still has room.
        const other = yield* hook("other", { rawHookId: "hook-2", hookKey: "hook-2" });
        expect(yield* HookInboxStore.hold(other, BASE_URL)).not.toBeNull();
      }),
    ),
  );

  it.effect("refuses a request that would pass the byte cap", () =>
    withInbox(
      Effect.gen(function* () {
        const big = new Uint8Array(HookInboxStore.HOOK_INBOX_MAX_BYTES - 10);
        expect(
          yield* HookInboxStore.hold(yield* hook("big", { body: big }), BASE_URL),
        ).not.toBeNull();
        const small = new Uint8Array(11);
        expect(
          yield* HookInboxStore.hold(
            yield* hook("small", { rawHookId: "x", hookKey: "x", body: small }),
            BASE_URL,
          ),
        ).toBeNull();
      }),
    ),
  );

  it.effect("stores a request id once", () =>
    withInbox(
      Effect.gen(function* () {
        const first = yield* hook("same");
        expect(yield* HookInboxStore.hold(first, BASE_URL)).not.toBeNull();
        expect(yield* HookInboxStore.hold(first, BASE_URL)).toBeNull();
      }),
    ),
  );

  it.effect("clear drops everything held", () =>
    withInbox(
      Effect.gen(function* () {
        yield* HookInboxStore.hold(yield* hook("first"), BASE_URL);
        yield* HookInboxStore.clear;
        const { sent, send } = deliverer(() => "delivered");
        expect(yield* HookInboxStore.deliverDue(send)).toBeNull();
        expect(sent).toHaveLength(0);
      }),
    ),
  );
});
