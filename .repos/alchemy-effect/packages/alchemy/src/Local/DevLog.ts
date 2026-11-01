/**
 * Per-resource dev log files.
 *
 * Layout under `{dotAlchemy}/log`:
 *
 *   log/{stage}/{fqn…}/{timestamp}.log        — one file per instance start
 *                                               (a restart opens a new file;
 *                                               the FQN nests as directories,
 *                                               e.g. log/dev/Site/Worker/)
 *   log/{stage}/{timestamp}.log               — the dev child's mixed tail
 *
 * Retention: opening a new log prunes its sibling `*.log` files first — the
 * newest `LOG_RETENTION_GENERATIONS` survive, and anything older than
 * `LOG_RETENTION_MS` (7 days, judged by stat mtime — file names are never
 * trusted) is deleted regardless. Pruning is best-effort: any failure is
 * swallowed so it can never break dev startup.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { AlchemyContext } from "../AlchemyContext.ts";
import { stripVTControlCharacters } from "node:util";

const LOG_RETENTION = Duration.days(7);
const LOG_RETENTION_GENERATIONS = 10;

/**
 * Delete a resource's stale sibling logs before a new one is opened: keep
 * the newest `LOG_RETENTION_GENERATIONS - 1` (the file about to be created
 * fills the last slot) and drop anything older than `LOG_RETENTION_MS`.
 * Ages come from stat mtime — file names are never trusted. Best-effort:
 * every step (including a missing directory) is swallowed.
 */
const pruneDevLogs = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dir: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const logs: Array<{ file: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".log")) continue;
      const file = path.join(dir, entry);
      const info = yield* fs
        .stat(file)
        .pipe(Effect.orElseSucceed(() => undefined));
      const mtime =
        info === undefined ? undefined : Option.getOrUndefined(info.mtime);
      if (mtime !== undefined) logs.push({ file, mtime: mtime.getTime() });
    }
    const cutoff =
      (yield* Clock.currentTimeMillis) - Duration.toMillis(LOG_RETENTION);
    logs.sort((a, b) => b.mtime - a.mtime);
    for (const [index, log] of logs.entries()) {
      if (index >= LOG_RETENTION_GENERATIONS - 1 || log.mtime < cutoff) {
        yield* fs.remove(log.file).pipe(Effect.ignore);
      }
    }
  }).pipe(Effect.ignore);

/**
 * Resolves the directory a resource's dev logs land in, for surfacing in
 * startup messages ("Started … → url (logs: …)") without opening a file.
 * Must join the same segments the opener is later called with.
 */
export const makeDevLogDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  return (...segments: ReadonlyArray<string>) =>
    path.join(dotAlchemy, "log", ...segments);
});

/**
 * Resolves the file-system services once (at provider/process init) and
 * returns an opener whose only requirement is the ambient `Scope` — local
 * provider `start` signatures are Scope-only, so the opener composes into
 * them without widening their requirements.
 *
 * The opener creates `{dotAlchemy}/log/{...segments}/{timestamp}.log`
 * (pruning stale siblings per the module retention policy first) and
 * returns the file's `path` plus synchronous `write`/`writeLine` sinks —
 * chunks queue through a drain fiber, so they're safe to call from
 * non-Effect callbacks (workerd output pumps, stream mirrors). The file and
 * drain close with the scope, which ties one log file to one
 * process/serve generation.
 */
export const makeDevLogOpener = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const devLogDirectory = yield* makeDevLogDirectory;
  const encoder = new TextEncoder();

  return Effect.fn(function* (...segments: ReadonlyArray<string>) {
    const dir = devLogDirectory(...segments);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* pruneDevLogs(fs, path, dir);
    const name = yield* Effect.sync(
      () => `${new Date().toISOString().replaceAll(":", "-")}.log`,
    );
    const filePath = path.join(dir, name);
    const file = yield* fs.open(filePath, { flag: "a" });
    const queue = yield* Queue.make<Uint8Array>();
    yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((chunk) => file.write(chunk).pipe(Effect.ignore)),
      Effect.forkScoped,
    );
    // ANSI is stripped: colors belong to the terminal path (FORCE_COLOR
    // rides the sidecar pipes); the files stay plain-text grep-able.
    return {
      /** Absolute path of this generation's log file. */
      path: filePath,
      write: (chunk: string): void => {
        Queue.offerUnsafe(
          queue,
          encoder.encode(stripVTControlCharacters(chunk)),
        );
      },
      /** `write` + a trailing newline — for line-based sources. */
      writeLine: (line: string): void => {
        Queue.offerUnsafe(
          queue,
          encoder.encode(`${stripVTControlCharacters(line)}\n`),
        );
      },
    };
  });
});
