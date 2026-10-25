import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** The SDK withholds stdout until tool results; tail task_started files for live output.
 * The private Claude layout can change; failures omit live output and retain the final result. */

const CLAUDE_TASK_OUTPUT_POLL_MS = 250;
/** Bound discovery when Claude never writes the file. */
const MAX_LOCATE_ATTEMPTS = 40;
/** Skip ahead of fast writers; only the tail is displayed. */
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

/** Complete stop on tool result or turn end, then await the effect; it performs a final read before returning. */
export const tailClaudeTaskOutput = Effect.fn("ClaudeTaskOutputTail.tail")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<void>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
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
        // Reset partial UTF-8 bytes when skipping output.
        if (skipped) decoder = new TextDecoder("utf-8", { fatal: false });
        offset = start + bytes.value.byteLength;
        const text = (skipped ? "\n" : "") + decoder.decode(bytes.value, { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
    }
    if (last) {
      const rest = decoder.decode();
      if (rest.length > 0) yield* input.onChunk(rest);
      return;
    }
    last = yield* pause;
  }
});
