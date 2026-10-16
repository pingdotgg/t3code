import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Live output for a foreground Claude Bash call.
 *
 * The Agent SDK sends no stdout until the tool result. Claude Code does write
 * each running command's combined output to
 * `<tmp>/claude-<uid>/<project>/<session_id>/tasks/<task_id>.output`, naming
 * the task in its `task_started` frame (`task_type: "local_bash"`). This path is
 * Claude Code's private layout, not SDK API, so every step degrades to "no live
 * output": the row still gets its full output from the tool result.
 */

/** How often the file is checked while its command runs. */
const CLAUDE_TASK_OUTPUT_POLL_MS = 250;
/** Give up looking for a file Claude Code never wrote (a newer layout, or Windows). */
const MAX_LOCATE_ATTEMPTS = 40;
/** Bytes read per poll. A faster writer skips ahead: only the tail is shown anyway. */
const MAX_READ_BYTES = 256 * 1024;

/** Claude Code's per-user temp root, or none where it has no uid (Windows). */
export function claudeTaskOutputRoot(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  path: Path.Path,
): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const base = environment?.CLAUDE_CODE_TMPDIR?.trim() || "/tmp";
  return path.join(base, `claude-${uid}`);
}

const locate = Effect.fn("ClaudeTaskOutputTail.locate")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* fileSystem.readDirectory(input.root).pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    const candidate = path.join(
      input.root,
      project,
      input.sessionId,
      "tasks",
      `${input.taskId}.output`,
    );
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }
  return Option.none<string>();
});

/**
 * Reads appended output until `stop` completes, then reads once more so the
 * last bytes written before the command exited still reach live viewers. The
 * caller completes `stop` when the tool result arrives or the turn ends, and
 * awaits the returned effect.
 */
export const tailClaudeTaskOutput = Effect.fn("ClaudeTaskOutputTail.tail")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<void>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  // True once stopped: the next read is the last.
  const pause = Effect.raceFirst(
    Effect.sleep(CLAUDE_TASK_OUTPUT_POLL_MS).pipe(Effect.as(false)),
    Deferred.await(input.stop).pipe(Effect.as(true)),
  );
  let file = Option.none<string>();
  for (let attempt = 0; Option.isNone(file); attempt += 1) {
    file = yield* locate(input);
    if (Option.isSome(file)) break;
    if (attempt + 1 >= MAX_LOCATE_ATTEMPTS || (yield* pause)) return;
  }
  const filePath = file.value;
  // `stream: true` keeps a multi-byte character split across reads intact;
  // invalid bytes become U+FFFD.
  let decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;
  let last = yield* Deferred.isDone(input.stop);
  while (true) {
    const size = yield* fileSystem.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => offset),
    );
    if (size < offset) offset = 0;
    if (size > offset) {
      const start = size - offset > MAX_READ_BYTES ? size - MAX_READ_BYTES : offset;
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(filePath, { flag: "r" });
          yield* handle.seek(BigInt(start), "start");
          return yield* handle.readAlloc(size - start);
        }),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(bytes)) {
        // Skipped output must not splice two unrelated lines together.
        const skipped = start > offset;
        // Bytes held from before the gap belong to a character we never finished reading.
        if (skipped) decoder = new TextDecoder("utf-8", { fatal: false });
        offset = start + bytes.value.byteLength;
        const text = (skipped ? "\n" : "") + decoder.decode(bytes.value, { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
    }
    if (last) {
      // A command that ended mid-character still shows a replacement character.
      const rest = decoder.decode();
      if (rest.length > 0) yield* input.onChunk(rest);
      return;
    }
    last = yield* pause;
  }
});
