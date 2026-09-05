import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Test helpers for asserting against Cloudflare Worker state via the
 * official workers SDK. These wrap the common "exists / get tags / wait
 * for delete" patterns used across `Worker.test.ts` and the website
 * tests so callers don't reimplement the retry plumbing each time.
 */

class WorkerStillExists extends Data.TaggedError("WorkerStillExists") {}

/**
 * Poll Cloudflare's `getScriptSubdomain` until it reports `expected`,
 * then assert. Cloudflare's subdomain toggle is eventually consistent
 * with respect to a freshly-completed `putScript` /
 * `createScriptSubdomain` call, so a same-tick read may still return
 * the previous value for a second or two. Retries indefinitely with a
 * fixed cadence; the surrounding test's own timeout bounds the wait.
 */
export const expectWorkersDevSubdomain = Effect.fn(function* (
  workerName: string,
  accountId: string,
  expected: boolean,
) {
  const final = yield* workers
    .getScriptSubdomain({ accountId, scriptName: workerName })
    .pipe(
      Effect.flatMap((s) =>
        s.enabled === expected
          ? Effect.succeed(s)
          : Effect.fail(
              `subdomain not yet ${expected ? "enabled" : "disabled"}`,
            ),
      ),
      Effect.tapError(Effect.logInfo),
      Effect.retry({ schedule: Schedule.spaced("500 millis") }),
    );
  expect(final.enabled).toBe(expected);
});

/**
 * Poll Cloudflare's `getScriptSubdomain` until both `enabled` and
 * `previewsEnabled` match the expected values, then assert. Like
 * `expectWorkersDevSubdomain`, the subdomain toggle is eventually
 * consistent with respect to a freshly-completed `putScript` /
 * `createScriptSubdomain` call, so a same-tick read may still return the
 * previous value for a second or two. Retries indefinitely with a fixed
 * cadence; the surrounding test's own timeout bounds the wait.
 */
export const expectWorkersDevPreviews = Effect.fn(function* (
  workerName: string,
  accountId: string,
  expected: { enabled: boolean; previewsEnabled: boolean },
) {
  const final = yield* workers
    .getScriptSubdomain({ accountId, scriptName: workerName })
    .pipe(
      Effect.flatMap((s) =>
        s.enabled === expected.enabled &&
        s.previewsEnabled === expected.previewsEnabled
          ? Effect.succeed(s)
          : Effect.fail(
              `subdomain not yet { enabled: ${expected.enabled}, previewsEnabled: ${expected.previewsEnabled} }`,
            ),
      ),
      Effect.tapError(Effect.logInfo),
      Effect.retry({ schedule: Schedule.spaced("500 millis") }),
    );
  expect(final).toEqual(expected);
});

/**
 * Look up a worker by name. Returns `undefined` if no script with that
 * name exists in the account.
 */
export const findWorker = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  const matches = yield* workers.searchScript({
    accountId,
    name: workerName,
  });
  return matches.find((worker) => worker.scriptName === workerName);
});

/**
 * Read the tags currently attached to a worker's live script settings.
 * Useful for asserting `alchemy:stack:*` / `alchemy:stage:*` ownership
 * tags without round-tripping through `searchScript`.
 */
export const getWorkerTags = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  const settings = yield* workers.getScriptScriptAndVersionSetting({
    accountId,
    scriptName: workerName,
  });
  return settings.tags ?? [];
});

/**
 * Asserts that a worker exists on Cloudflare. Use as a deploy
 * checkpoint that doesn't take a propagation dependency on the
 * workers.dev subdomain.
 */
export const expectWorkerExists = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  const settings = yield* workers.getScriptScriptAndVersionSetting({
    accountId,
    scriptName: workerName,
  });
  expect(settings).toBeDefined();
});

/**
 * Block until Cloudflare reports the worker is gone. Uses exponential
 * backoff; safe to call after `stack.destroy()` to ensure subsequent
 * tests in the same file don't observe the about-to-be-deleted worker.
 */
export const waitForWorkerToBeDeleted = Effect.fn(function* (
  workerName: string,
  accountId: string,
) {
  yield* workers.getScript({ accountId, scriptName: workerName }).pipe(
    Effect.flatMap(() => Effect.fail(new WorkerStillExists())),
    Effect.retry({
      while: (e): e is WorkerStillExists => e instanceof WorkerStillExists,
      schedule: Schedule.max([Schedule.exponential(100), Schedule.recurs(20)]),
    }),
    Effect.catchTag("WorkerNotFound", () => Effect.void),
  );
});
