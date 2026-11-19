import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

const warnRuntimeTempLeftovers = Effect.logWarning(
  "Could not remove leftover Antigravity runtime temp files.",
);

/**
 * Sweep only private runtimes before launch; Windows does not protect live extracted data files from deletion.
 * Moves leftovers aside and returns their slow deletion (seconds on Windows) to run off the startup path.
 */
export const retireAntigravityRuntimeTempDirs = Effect.fn("retireAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = path.dirname(tempDirectory);
    const prefix = `${path.basename(tempDirectory)}.old-`;
    if (yield* fs.exists(tempDirectory)) {
      yield* fs.makeTempDirectory({ directory: parent, prefix }).pipe(
        Effect.flatMap((retired) => fs.rename(tempDirectory, path.join(retired, "runtime"))),
        Effect.catch(() => fs.remove(tempDirectory, { recursive: true, force: true })),
      );
    }
    const entries = yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []));
    return Effect.forEach(
      entries.filter((entry) => entry.startsWith(prefix)),
      (entry) =>
        fs
          .remove(path.join(parent, entry), { recursive: true, force: true })
          .pipe(Effect.catch(() => warnRuntimeTempLeftovers)),
      { discard: true },
    );
  },
  Effect.catch(() => warnRuntimeTempLeftovers.pipe(Effect.as(Effect.void))),
);

/**
 * Points `link` at `target`, replacing a stale link of ours. Returns the path the agent should use:
 * `link`, or `target` when the link cannot be made (another user's entry, a real directory there).
 */
export const linkAntigravityRuntimeTemp = Effect.fn("linkAntigravityRuntimeTemp")(function* (
  link: string,
  target: string,
) {
  if (link === target) return target;
  const fs = yield* FileSystem.FileSystem;
  const pointsAtTarget = fs.readLink(link).pipe(
    Effect.option,
    Effect.map((current) => Option.contains(current, target)),
  );
  if (yield* pointsAtTarget) return link;
  yield* fs.remove(link).pipe(Effect.ignore);
  // Another driver for the same instance may have made it between the check and here.
  const linked = yield* fs.symlink(target, link).pipe(
    Effect.as(true),
    Effect.catch(() => pointsAtTarget),
  );
  return linked ? link : target;
});
