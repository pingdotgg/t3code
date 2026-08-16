import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const PiSessionCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionFile: Schema.String,
  sessionId: Schema.String.check(
    Schema.makeFilter((value) => value.length > 0 && value.trim() === value),
  ),
});
export type PiSessionCursor = typeof PiSessionCursor.Type;

const decodePiSessionHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export class PiSessionFileError extends Schema.TaggedErrorClass<PiSessionFileError>()(
  "PiSessionFileError",
  {
    operation: Schema.String,
    sessionFile: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const piInstanceStateRoot = Effect.fn("PiSessionFile.piInstanceStateRoot")(
  function* (input: { readonly stateDir: string; readonly instanceId: string }) {
    const path = yield* Path.Path;
    if (!input.instanceId || input.instanceId.trim() !== input.instanceId) {
      return yield* new PiSessionFileError({
        operation: "instanceId",
        sessionFile: input.stateDir,
        detail: "Pi provider instance id must be non-empty and trimmed.",
      });
    }
    return path.resolve(
      input.stateDir,
      "providers",
      "pi",
      encodeURIComponent(input.instanceId),
      "sessions",
    );
  },
);

const canonicalContainedPath = (path: Path.Path, root: string, candidate: string) => {
  const canonicalRoot = path.resolve(root);
  const canonical = path.resolve(candidate);
  return canonical !== canonicalRoot && canonical.startsWith(`${canonicalRoot}${path.sep}`)
    ? canonical
    : undefined;
};

export const validatePiResumeSessionFile = Effect.fn("PiSessionFile.validateResume")(
  function* (input: {
    readonly stateRoot: string;
    readonly cursor: PiSessionCursor;
    readonly cwd: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rootReal = yield* fs.realPath(path.resolve(input.stateRoot));
    const cwdReal = yield* fs.realPath(path.resolve(input.cwd));
    const sessionFile = canonicalContainedPath(path, rootReal, input.cursor.sessionFile);
    if (!sessionFile || sessionFile !== input.cursor.sessionFile || !path.isAbsolute(sessionFile)) {
      return yield* new PiSessionFileError({
        operation: "containment",
        sessionFile: input.cursor.sessionFile,
        detail: "Session file must be an absolute canonical path inside the Pi state root.",
      });
    }
    const fileReal = yield* fs.realPath(sessionFile);
    if (fileReal !== sessionFile || canonicalContainedPath(path, rootReal, fileReal) !== fileReal) {
      return yield* new PiSessionFileError({
        operation: "symlink",
        sessionFile,
        detail: "Session file must not resolve through a symlink.",
      });
    }
    const info = yield* fs.stat(sessionFile);
    if (info.type !== "File")
      return yield* new PiSessionFileError({
        operation: "regularFile",
        sessionFile,
        detail: `Expected a regular file, received ${info.type}.`,
      });
    yield* fs.access(sessionFile, { readable: true });
    const headerPrefix = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(sessionFile, { flag: "r" });
        return yield* file.readAlloc(64 * 1024);
      }),
    );
    const firstLine = Option.match(headerPrefix, {
      onNone: () => "",
      onSome: (bytes) => new TextDecoder().decode(bytes).split(/\r?\n/, 1)[0] ?? "",
    });
    const header = yield* decodePiSessionHeader(firstLine).pipe(
      Effect.mapError(
        (cause) =>
          new PiSessionFileError({
            operation: "header",
            sessionFile,
            detail: "Session header is not valid JSON.",
            cause,
          }),
      ),
    );
    if (
      typeof header !== "object" ||
      header === null ||
      !("type" in header) ||
      header.type !== "session" ||
      !("id" in header) ||
      header.id !== input.cursor.sessionId ||
      !("cwd" in header) ||
      typeof header.cwd !== "string" ||
      (yield* fs.realPath(path.resolve(header.cwd))) !== cwdReal
    ) {
      return yield* new PiSessionFileError({
        operation: "header",
        sessionFile,
        detail: "Session header does not match the expected session id and working directory.",
      });
    }
    return { ...input.cursor, sessionFile };
  },
);

export const allocateFreshPiSessionFile = Effect.fn("PiSessionFile.allocateFresh")(
  function* (input: { readonly stateRoot: string; readonly fileId: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(input.stateRoot);
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    yield* fs.chmod(root, 0o700);
    const rootReal = yield* fs.realPath(root);
    if (!input.fileId || input.fileId.trim() !== input.fileId) {
      return yield* new PiSessionFileError({
        operation: "allocate",
        sessionFile: rootReal,
        detail: "Pi session file id must be non-empty and trimmed.",
      });
    }
    const sessionFile = path.join(rootReal, `${encodeURIComponent(input.fileId)}.jsonl`);
    if (!canonicalContainedPath(path, rootReal, sessionFile)) {
      return yield* new PiSessionFileError({
        operation: "allocate",
        sessionFile,
        detail: "Allocated Pi session file escaped the state root.",
      });
    }
    return yield* Effect.acquireUseRelease(
      fs
        .writeFileString(sessionFile, "", { flag: "wx", mode: 0o600 })
        .pipe(Effect.as({ sessionFile })),
      (fresh) => fs.chmod(sessionFile, 0o600).pipe(Effect.as(fresh)),
      (fresh, exit) =>
        Exit.isFailure(exit)
          ? fs.remove(fresh.sessionFile, { force: true }).pipe(Effect.ignore)
          : Effect.void,
    );
  },
);

export const cleanupFreshPiSessionFile = Effect.fn("PiSessionFile.cleanupFresh")(function* (fresh: {
  readonly sessionFile: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(fresh.sessionFile, { force: true });
});

export const cleanupResumedPiSessionFile = (_cursor: PiSessionCursor): Effect.Effect<void> =>
  Effect.void;

export function piStateMatchesCursor(
  state: { readonly sessionFile?: unknown; readonly sessionId?: unknown },
  cursor: PiSessionCursor,
): boolean {
  return state.sessionFile === cursor.sessionFile && state.sessionId === cursor.sessionId;
}
