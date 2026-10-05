// @effect-diagnostics nodeBuiltinImport:off - FileSystem cannot open with O_NONBLOCK.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Wraps `read` so callers wait at most `timeout`, and so at most one native
 * read is outstanding: an open() that never returns (a macOS privacy prompt
 * nobody answers, a stalled mount) holds a libuv pool thread until the OS
 * call returns, and fiber interruption does not give it back.
 */
export const makeBoundedFileReader = (
  read: (filePath: string) => Promise<string>,
  timeout: Duration.Input,
) => {
  const timeoutMs = Duration.toMillis(timeout);
  let inFlight: { readonly settled: Promise<void>; readonly startedAtMs: number } | null = null;

  const attempt = (filePath: string): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const busy = inFlight;
      if (busy === null) {
        const pending = read(filePath);
        const entry = { settled: pending.then(noop, noop), startedAtMs: now };
        inFlight = entry;
        void entry.settled.then(() => {
          if (inFlight === entry) inFlight = null;
        });
        return yield* Effect.promise(() => pending.then(Option.some, () => Option.none()));
      }
      const remainingMs = timeoutMs - (now - busy.startedAtMs);
      if (remainingMs <= 0) return Option.none();
      const freed = yield* Effect.promise(() => busy.settled).pipe(
        Effect.timeoutOption(Duration.millis(remainingMs)),
      );
      return Option.isSome(freed) ? yield* attempt(filePath) : Option.none();
    });

  return (filePath: string): Effect.Effect<Option.Option<string>> =>
    attempt(filePath).pipe(Effect.timeoutOption(timeout), Effect.map(Option.flatten));
};

/** Reads a regular file of at most `maxBytes`; anything else rejects. */
export const readSmallRegularFile = async (filePath: string, maxBytes: number) => {
  // O_NONBLOCK keeps a FIFO from parking open(); the fstat below rejects it.
  const handle = await NodeFSP.open(
    filePath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error(`Not a regular file of at most ${maxBytes} bytes: ${filePath}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

const noop = () => {};
