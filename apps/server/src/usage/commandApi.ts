import {
  UsageLimitSourceAccount,
  UsageLimitSourceError,
  type CommandUsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_ERROR_DETAIL = 200;

interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Bounds cumulative captured bytes, not chunk count: `Stream.take` would only
 * cap how many `Uint8Array` chunks are emitted, so a fast writer could still
 * queue unbounded output before the timeout. Bytes past `maxBytes` are
 * discarded as the stream keeps draining, so the child never blocks on a full
 * pipe and memory stays flat.
 */
const collectBoundedText = (
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxBytes: number,
): Effect.Effect<BoundedText, PlatformError.PlatformError> => {
  const decoder = new TextDecoder();
  return Stream.runFold(
    stream,
    (): { text: string; bytes: number; truncated: boolean } => ({
      text: "",
      bytes: 0,
      truncated: false,
    }),
    (acc, chunk) => {
      const room = maxBytes - acc.bytes;
      const kept = room <= 0 ? chunk.subarray(0, 0) : chunk.subarray(0, room);
      return {
        text: kept.byteLength > 0 ? acc.text + decoder.decode(kept, { stream: true }) : acc.text,
        bytes: acc.bytes + kept.byteLength,
        truncated: acc.truncated || kept.byteLength < chunk.byteLength,
      };
    },
  ).pipe(
    // Flush any buffered incomplete UTF-8 sequence the stream left behind.
    Effect.map((acc) => ({
      text: acc.text + decoder.decode(),
      truncated: acc.truncated,
    })),
  );
};

const CommandAccountsOutput = Schema.Struct({
  accounts: Schema.Array(UsageLimitSourceAccount),
});
const decodeCommandOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CommandAccountsOutput),
);

/**
 * Runs a `kind: "command"` usage-limit source. The command owns credential
 * lookup itself — T3 only reads the `{ "accounts": [...] }` JSON document it
 * prints on stdout.
 */
export const makeCommandApi = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readAccounts = Effect.fn("CommandApi.readAccounts")(function* (
    config: CommandUsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(config.command, [...config.args], {
            forceKillAfter: "1 second",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectBoundedText(child.stdout, MAX_STDOUT_BYTES),
            collectBoundedText(child.stderr, MAX_STDERR_BYTES),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode };
      }),
    ).pipe(
      Effect.timeout(COMMAND_TIMEOUT_MS),
      Effect.mapError((cause) => {
        const detail = Cause.isTimeoutError(cause)
          ? `The command did not finish within ${COMMAND_TIMEOUT_MS / 1000} seconds.`
          : `The command could not be run (${config.command}): ${cause instanceof Error ? cause.message : String(cause)}`;
        return new UsageLimitSourceError({ detail });
      }),
    );

    if (result.stdout.truncated) {
      return yield* new UsageLimitSourceError({
        detail: `The command produced more than ${MAX_STDOUT_BYTES / (1024 * 1024)} MiB of output.`,
      });
    }

    if (result.exitCode !== 0) {
      const stderrTail = result.stderr.text.trim().split("\n").pop()?.slice(0, MAX_ERROR_DETAIL);
      return yield* new UsageLimitSourceError({
        detail: `The command failed with exit code ${result.exitCode}.${stderrTail ? ` ${stderrTail}` : ""}`,
      });
    }

    const output = yield* decodeCommandOutput(result.stdout.text).pipe(
      Effect.mapError(
        () =>
          new UsageLimitSourceError({
            detail:
              'The command\'s output is not valid usage-limit JSON (expected { "accounts": [...] }).',
          }),
      ),
    );
    return output.accounts;
  });

  return { readAccounts };
});
