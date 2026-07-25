import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";

import * as AutoArchiveJanitor from "./AutoArchiveJanitor.ts";

const NOW_MS = Date.parse("2026-07-25T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const makeThread = (
  overrides: Partial<AutoArchiveJanitor.AutoArchiveThreadSnapshot> = {},
): AutoArchiveJanitor.AutoArchiveThreadSnapshot => ({
  id: ThreadId.make("thread-1"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestUserMessageAt: iso(NOW_MS - 10 * DAY_MS),
  latestTurn: null,
  ...overrides,
});

const eligible = (
  thread: AutoArchiveJanitor.AutoArchiveThreadSnapshot,
  windowMs = DAY_MS,
  nowMs = NOW_MS,
) => AutoArchiveJanitor.isAutoArchiveEligible(thread, { nowMs, windowMs });

describe("isAutoArchiveEligible", () => {
  it("archives a thread idle longer than the window", () => {
    expect(eligible(makeThread())).toBe(true);
  });

  it("keeps a thread idle less than the window", () => {
    expect(eligible(makeThread({ latestUserMessageAt: iso(NOW_MS - HOUR_MS) }))).toBe(false);
  });

  it("keeps a thread with no recorded activity at all", () => {
    expect(eligible(makeThread({ latestUserMessageAt: null, latestTurn: null }))).toBe(false);
  });

  it("never re-archives an archived thread", () => {
    expect(eligible(makeThread({ archivedAt: iso(NOW_MS - DAY_MS) }))).toBe(false);
  });

  it("keeps threads blocked on approvals, user input, or a live session", () => {
    expect(eligible(makeThread({ hasPendingApprovals: true }))).toBe(false);
    expect(eligible(makeThread({ hasPendingUserInput: true }))).toBe(false);
    expect(
      eligible(
        makeThread({
          session: { status: "running" },
        }),
      ),
    ).toBe(false);
  });

  it("respects the explicit keep-active pin", () => {
    expect(eligible(makeThread({ settledOverride: "active" }))).toBe(false);
  });

  it("times an explicitly settled thread from settledAt, not last activity", () => {
    const thread = makeThread({
      settledOverride: "settled",
      settledAt: iso(NOW_MS - 2 * HOUR_MS),
      latestUserMessageAt: iso(NOW_MS - 10 * DAY_MS),
    });
    expect(eligible(thread, DAY_MS)).toBe(false);
    expect(eligible(thread, HOUR_MS)).toBe(true);
  });

  it("uses turn timestamps as activity when no user message exists", () => {
    const thread = makeThread({
      latestUserMessageAt: null,
      latestTurn: {
        requestedAt: iso(NOW_MS - 2 * DAY_MS),
        startedAt: iso(NOW_MS - 2 * DAY_MS),
        completedAt: iso(NOW_MS - HOUR_MS),
      },
    });
    // completedAt an hour ago is the latest activity — inside a 1-day window.
    expect(eligible(thread, DAY_MS)).toBe(false);
    expect(eligible(thread, 30 * 60 * 1_000)).toBe(true);
  });

  it("treats malformed timestamps as not eligible", () => {
    expect(eligible(makeThread({ latestUserMessageAt: "not-a-date" }))).toBe(false);
  });
});

describe("AutoArchiveJanitor.tick", () => {
  const runTick = (input: {
    autoArchiveSettledAfter: Duration.Duration | null;
    threads: ReadonlyArray<AutoArchiveJanitor.AutoArchiveThreadSnapshot>;
    archiveThread?: (threadId: ThreadId) => Effect.Effect<void, unknown>;
  }) => {
    const archived: Array<ThreadId> = [];
    const deps: AutoArchiveJanitor.AutoArchiveJanitorDeps = {
      getSettings: Effect.succeed({ autoArchiveSettledAfter: input.autoArchiveSettledAfter }),
      listThreads: Effect.succeed(input.threads),
      archiveThread:
        input.archiveThread ??
        ((threadId) =>
          Effect.sync(() => {
            archived.push(threadId);
          })),
    };
    return Effect.runPromise(
      Effect.gen(function* () {
        const janitor = yield* AutoArchiveJanitor.make(deps);
        yield* janitor.tick;
        return archived;
      }),
    );
  };

  it("does nothing when the setting is disabled (null)", async () => {
    const archived = await runTick({
      autoArchiveSettledAfter: null,
      threads: [makeThread()],
    });
    expect(archived).toEqual([]);
  });

  it("archives only eligible threads", async () => {
    const stale = makeThread({ id: ThreadId.make("stale") });
    const fresh = makeThread({
      id: ThreadId.make("fresh"),
      latestUserMessageAt: iso(DateTime.toEpochMillis(DateTime.nowUnsafe()) - HOUR_MS),
    });
    const pinned = makeThread({ id: ThreadId.make("pinned"), settledOverride: "active" });
    const archived = await runTick({
      autoArchiveSettledAfter: Duration.days(1),
      threads: [stale, fresh, pinned],
    });
    expect(archived).toEqual([ThreadId.make("stale")]);
  });

  it("keeps sweeping when one archive fails", async () => {
    const first = makeThread({ id: ThreadId.make("first") });
    const second = makeThread({ id: ThreadId.make("second") });
    const pushed: Array<ThreadId> = [];
    const result = await runTick({
      autoArchiveSettledAfter: Duration.days(1),
      threads: [first, second],
      archiveThread: (threadId) =>
        threadId === ThreadId.make("first")
          ? Effect.fail("boom")
          : Effect.sync(() => {
              pushed.push(threadId);
            }),
    });
    expect(pushed).toEqual([ThreadId.make("second")]);
    expect(result).toEqual([]);
  });
});
