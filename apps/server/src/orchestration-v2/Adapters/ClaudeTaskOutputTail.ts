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
  cwd: string | null,
  platform: NodeJS.Platform,
): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  // Claude Code's macOS build falls back to /tmp and ignores the TMPDIR that
  // launchd always sets. Its other builds use `os.tmpdir()`, which reads these
  // from the environment it was launched with. A relative value is relative
  // to Claude's working directory, not this server's.
  const fallback =
    platform === "darwin"
      ? "/tmp"
      : environment?.TMPDIR || environment?.TMP || environment?.TEMP || "/tmp";
  const base = environment?.CLAUDE_CODE_TMPDIR?.trim() || fallback;
  return path.resolve(cwd ?? ".", base, `claude-${uid}`);
}

const claudeProjectSlug = (cwd: string, path: Path.Path): string =>
  path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");

const taskOutputFile = (
  path: Path.Path,
  root: string,
  project: string,
  sessionId: string,
  taskId: string,
): string => path.join(root, project, sessionId, "tasks", `${taskId}.output`);

const locate = Effect.fn("ClaudeTaskOutputTail.locate")(function* (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<void>;
  readonly abortOnStop: boolean;
  readonly cwd: string | undefined;
  readonly projectCache: Map<string, string>;
  readonly realSlugRef: { resolved: boolean; value: string | undefined };
}) {
  const shouldAbort = () =>
    input.abortOnStop ? Deferred.isDone(input.stop) : Effect.succeed(false);
  if (yield* shouldAbort()) return Option.none<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const probed = new Set<string>();

  // Runs inside the ClaudeTaskOutputTail.locate span.
  const probeKnownProject = Effect.fnUntraced(function* (
    project: string,
    rememberSessionDir: boolean,
  ) {
    probed.add(project);
    const candidate = taskOutputFile(path, input.root, project, input.sessionId, input.taskId);
    if (yield* exists(candidate)) {
      input.projectCache.set(input.sessionId, project);
      return { kind: "found" as const, file: candidate };
    }
    if (yield* exists(path.join(input.root, project, input.sessionId))) {
      if (rememberSessionDir) input.projectCache.set(input.sessionId, project);
      return { kind: "session_exists" as const };
    }
    return { kind: "missing" as const };
  });

  // 1. Check the cached project directory for this session first.
  const cachedProject = input.projectCache.get(input.sessionId);
  if (cachedProject !== undefined) {
    const result = yield* probeKnownProject(cachedProject, false);
    if (result.kind === "found") return Option.some(result.file);
    if (result.kind === "session_exists") return Option.none<string>();
    input.projectCache.delete(input.sessionId);
  }

  // 2. Check Claude Code's deterministic cwd slug before scanning root.
  if (input.cwd !== undefined) {
    const directSlug = claudeProjectSlug(input.cwd, path);
    if (!probed.has(directSlug)) {
      if (yield* shouldAbort()) return Option.none<string>();
      const result = yield* probeKnownProject(directSlug, true);
      if (result.kind === "found") return Option.some(result.file);
      if (result.kind === "session_exists") return Option.none<string>();
    }
    if (!input.realSlugRef.resolved) {
      input.realSlugRef.resolved = true;
      const realCwd = yield* fileSystem
        .realPath(input.cwd)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (realCwd !== undefined) {
        const slug = claudeProjectSlug(realCwd, path);
        if (slug !== directSlug) input.realSlugRef.value = slug;
      }
    }
    const realSlug = input.realSlugRef.value;
    if (realSlug !== undefined && !probed.has(realSlug)) {
      if (yield* shouldAbort()) return Option.none<string>();
      const result = yield* probeKnownProject(realSlug, true);
      if (result.kind === "found") return Option.some(result.file);
      if (result.kind === "session_exists") return Option.none<string>();
    }
  }

  // 3. Fall back to scanning root when cwd is absent or does not match Claude's directory slug.
  if (yield* shouldAbort()) return Option.none<string>();
  const projects = yield* fileSystem.readDirectory(input.root).pipe(Effect.orElseSucceed(() => []));
  for (const project of projects) {
    if (probed.has(project)) continue;
    if (yield* shouldAbort()) return Option.none<string>();
    // Unrelated project dirs and regular files fail in one stat before probing tasks/<id>.output.
    if (!(yield* exists(path.join(input.root, project, input.sessionId)))) continue;
    const candidate = taskOutputFile(path, input.root, project, input.sessionId, input.taskId);
    if (yield* exists(candidate)) {
      input.projectCache.set(input.sessionId, project);
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
  readonly cwd?: string | null | undefined;
  readonly projectCache?: Map<string, string> | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pause = Deferred.await(input.stop).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({
      duration: CLAUDE_TASK_OUTPUT_POLL_MS,
      orElse: () => Effect.succeed(false),
    }),
  );
  const projectCache = input.projectCache ?? new Map<string, string>();
  const trimmedCwd = input.cwd?.trim();
  const cwd = trimmedCwd && trimmedCwd.length > 0 ? trimmedCwd : undefined;
  const realSlugRef = { resolved: false, value: undefined as string | undefined };
  let file = Option.none<string>();
  for (let attempt = 0; Option.isNone(file); attempt += 1) {
    const stoppedBeforeLocate = yield* Deferred.isDone(input.stop);
    if (attempt > 0 && stoppedBeforeLocate) return;
    file = yield* locate({
      root: input.root,
      sessionId: input.sessionId,
      taskId: input.taskId,
      stop: input.stop,
      abortOnStop: !stoppedBeforeLocate,
      cwd,
      projectCache,
      realSlugRef,
    });
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
    if (size < offset) {
      offset = 0;
      decoder = new TextDecoder("utf-8", { fatal: false });
    }
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
        let first = 0;
        if (skipped) {
          // Reset partial UTF-8 bytes, and skip the rest of a code point the cut landed inside.
          decoder = new TextDecoder("utf-8", { fatal: false });
          while (((bytes.value[first] ?? 0) & 0xc0) === 0x80) first += 1;
        }
        offset = start + bytes.value.byteLength;
        const text =
          (skipped ? "\n" : "") + decoder.decode(bytes.value.subarray(first), { stream: true });
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
