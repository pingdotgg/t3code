import { expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Latch } from "effect";
import { TestClock } from "effect/testing";

import { GitCommandError, type GitResolveReviewChangesContextResult } from "@t3tools/contracts";

import {
  REVIEW_CONTEXT_PREWARM_MAX_ENTRIES,
  REVIEW_CONTEXT_PREWARM_TTL_MS,
  makeReviewContextPrewarmCache,
  reviewContextPrewarmKey,
} from "./ReviewContextPrewarmCache.ts";

const result = (branch: string) => ({ branch }) as unknown as GitResolveReviewChangesContextResult;

const failure = new GitCommandError({
  operation: "test",
  command: "git diff",
  cwd: "/repo",
  detail: "boom",
});

/** Counts captures so a test can tell a claimed capture from a fresh one. */
const countingCapture = () => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    capture: Effect.sync(() => {
      calls += 1;
      return result(`capture-${calls}`);
    }),
  };
};

it("does not park scopes whose diff can change between hover and click", () => {
  expect(reviewContextPrewarmKey({ cwd: "/repo", scope: "uncommitted" })).toBeNull();
  expect(reviewContextPrewarmKey({ cwd: "/repo", scope: "against-base" })).toBeNull();
  expect(
    reviewContextPrewarmKey({ cwd: "/repo", scope: "pull-request", pullRequestNumber: undefined }),
  ).toBeNull();
});

it("keys pull requests by repository and number", () => {
  const key = reviewContextPrewarmKey({
    cwd: "/repo",
    scope: "pull-request",
    pullRequestNumber: 7,
  });
  expect(key).not.toBeNull();
  expect(key).not.toBe(
    reviewContextPrewarmKey({ cwd: "/repo", scope: "pull-request", pullRequestNumber: 8 }),
  );
  expect(key).not.toBe(
    reviewContextPrewarmKey({ cwd: "/other", scope: "pull-request", pullRequestNumber: 7 }),
  );
});

it.effect("always captures fresh when there is no key", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const { capture } = countingCapture();

    yield* cache.claim(null, capture);
    const second = yield* cache.claim(null, capture);

    expect(second).toStrictEqual(result("capture-2"));
  }),
);

it.effect("a click claims the capture its hover parked", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const capturer = countingCapture();

    yield* cache.prewarm("pr", capturer.capture);
    const claimed = yield* cache.claim("pr", capturer.capture);

    expect(capturer.calls).toBe(1);
    expect(claimed).toStrictEqual(result("capture-1"));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a parked capture answers one claim only", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const capturer = countingCapture();

    yield* cache.prewarm("pr", capturer.capture);
    yield* cache.claim("pr", capturer.capture);
    // A pull request's head can move, so the capture must not be reused for a
    // second review.
    const second = yield* cache.claim("pr", capturer.capture);

    expect(capturer.calls).toBe(2);
    expect(second).toStrictEqual(result("capture-2"));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not claim a capture that has stood past its TTL", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const capturer = countingCapture();

    yield* cache.prewarm("pr", capturer.capture);
    yield* TestClock.adjust(Duration.millis(REVIEW_CONTEXT_PREWARM_TTL_MS));
    const claimed = yield* cache.claim("pr", capturer.capture);

    expect(capturer.calls).toBe(2);
    expect(claimed).toStrictEqual(result("capture-2"));
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("repeated hovers do not stack captures", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const capturer = countingCapture();

    yield* cache.prewarm("pr", capturer.capture);
    yield* cache.prewarm("pr", capturer.capture);

    expect(capturer.calls).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("a click waits for a capture that is still running", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const release = yield* Latch.make(false);
    let calls = 0;
    const capture = Effect.gen(function* () {
      calls += 1;
      yield* Latch.await(release);
      return result("parked");
    });

    const prewarm = yield* Effect.forkChild(cache.prewarm("pr", capture));
    // Let the prewarm park its entry before the click arrives.
    yield* Effect.yieldNow;
    const click = yield* Effect.forkChild(cache.claim("pr", capture));

    yield* Latch.open(release);
    yield* Fiber.join(prewarm);

    expect(yield* Fiber.join(click)).toStrictEqual(result("parked"));
    expect(calls).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not leave a failed capture to be claimed", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    let calls = 0;
    const capture = Effect.suspend(() => {
      calls += 1;
      return calls === 1 ? Effect.fail(failure) : Effect.succeed(result("fresh"));
    });

    const prewarm = yield* cache.prewarm("pr", capture).pipe(Effect.exit);
    expect(Exit.isFailure(prewarm)).toBe(true);

    expect(yield* cache.claim("pr", capture)).toStrictEqual(result("fresh"));
    expect(calls).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an interrupted prewarm does not interrupt or stall the click", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const started = yield* Latch.make(false);
    let calls = 0;
    const capture = Effect.gen(function* () {
      calls += 1;
      if (calls === 1) {
        yield* Latch.open(started);
        return yield* Effect.never;
      }
      return result("fresh");
    });

    const prewarm = yield* Effect.forkChild(cache.prewarm("pr", capture));
    yield* Latch.await(started);
    const click = yield* Effect.forkChild(cache.claim("pr", capture));
    // The click must already be waiting on the parked entry, so that
    // interrupting the prewarm exercises the claim's recovery path.
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(prewarm);

    expect(yield* Fiber.join(click)).toStrictEqual(result("fresh"));
    expect(calls).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an interrupted click does not disturb a healthy capture", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const release = yield* Latch.make(false);
    let calls = 0;
    const capture = Effect.gen(function* () {
      calls += 1;
      yield* Latch.await(release);
      return result(`capture-${calls}`);
    });

    const prewarm = yield* Effect.forkChild(cache.prewarm("pr", capture));
    yield* Effect.yieldNow;
    const click = yield* Effect.forkChild(cache.claim("pr", capture));
    yield* Effect.yieldNow;

    // Cancelling a waiter must stay that waiter's business: it must not be read
    // as the capture failing, and must not start a duplicate capture.
    yield* Fiber.interrupt(click);
    yield* Latch.open(release);
    yield* Fiber.join(prewarm);

    expect(calls).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("bounds how many captures are parked at once", () =>
  Effect.gen(function* () {
    const cache = makeReviewContextPrewarmCache();
    const capturer = countingCapture();

    for (let index = 0; index <= REVIEW_CONTEXT_PREWARM_MAX_ENTRIES; index += 1) {
      yield* cache.prewarm(`pr-${index}`, capturer.capture);
    }
    const parked = capturer.calls;

    // The oldest was dropped to stay within the bound; the newest is claimable.
    yield* cache.claim("pr-0", capturer.capture);
    expect(capturer.calls).toBe(parked + 1);
    yield* cache.claim(`pr-${REVIEW_CONTEXT_PREWARM_MAX_ENTRIES}`, capturer.capture);
    expect(capturer.calls).toBe(parked + 1);
  }).pipe(Effect.provide(TestClock.layer())),
);
