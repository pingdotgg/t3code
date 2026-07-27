// @effect-diagnostics nodeBuiltinImport:off
/**
 * Poll a file until a mock agent has written the line a test is waiting for.
 *
 * The ACP mock agent (`apps/server/scripts/acp-mock-agent.ts`) appends every
 * incoming raw JSON-RPC message to `T3_ACP_REQUEST_LOG_PATH`, which makes that
 * file the only synchronous proof a test has that the *agent* — not just the
 * client — observed a request. Tests that need to act after the agent received
 * something (cancel an in-flight prompt, assert on a reply payload) must wait
 * on this rather than on a fixed delay: a sleep that is long enough on an idle
 * machine becomes a race as soon as the suite runs in parallel with the other
 * 178 server test files.
 */

import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";

/** Interval between reads. Small enough that the wait is invisible when the write is already done. */
const pollInterval = "25 millis";

/**
 * Resolve with the file's contents once it is non-empty and, when
 * `expectedContent` is given, contains that substring.
 *
 * Dies rather than fails when `attempts` runs out: a missing barrier is a
 * broken test, not a modelled error the caller can recover from.
 */
export function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(
          new Error(
            expectedContent === undefined
              ? `Timed out waiting for file content at ${filePath}`
              : `Timed out waiting for '${expectedContent}' in ${filePath}`,
          ),
        );
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep(pollInterval);
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}
