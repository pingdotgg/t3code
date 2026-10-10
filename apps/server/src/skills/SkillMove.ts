/**
 * SkillMove - the two filesystem writes that take a real skill folder somewhere else: moving it,
 * and deleting it.
 *
 * A move is never allowed to leave a half-made skill or to replace one:
 * - On one filesystem it is a single rename, which is all or nothing. Something already at the
 *   destination makes it stop; a rename can only replace an empty folder, which loses nothing.
 * - Across filesystems a rename isn't possible, so the folder is copied next to the destination
 *   under a hidden name no agent reads, checked against the original, and only then renamed into
 *   place. Anything that goes wrong before that removes the copy and leaves the original alone.
 *   The original is removed last, so a crash leaves the skill in both places, never in neither.
 *
 * @module SkillMove
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class SkillMoveError extends Schema.TaggedError<SkillMoveError>()("SkillMoveError", {
  operation: Schema.Literals(["makeDirectory", "inspect", "copy", "verify", "rename", "remove"]),
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Skill folder operation '${this.operation}' failed.`;
  }
}

type MoveFolderResult =
  /** The folder is at the destination and the original is gone. */
  | "moved"
  /** The folder is at the destination, but the original couldn't be removed after a copy. */
  | "movedWithLeftover"
  /** Something is at the destination. Nothing was changed. */
  | "taken"
  /** Another program is using the folder. Nothing was changed. */
  | "inUse";

const errorCode = (error: PlatformError.PlatformError) => {
  const cause: unknown = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
};

/** What a failed rename tells: another device, a busy folder, or something in the way. */
type RenameFailure = "otherDevice" | "inUse" | "taken";

const renameFailure = (
  error: PlatformError.PlatformError,
  platform: NodeJS.Platform,
): RenameFailure | undefined => {
  const code = errorCode(error);
  if (code === "EXDEV") return "otherDevice";
  if (error.reason._tag === "Busy" || (platform === "win32" && code === "EPERM")) return "inUse";
  if (error.reason._tag === "AlreadyExists" || code === "ENOTEMPTY" || code === "ENOTDIR") {
    return "taken";
  }
  return undefined;
};

/** One thing found in a folder, with what a copy has to keep the same. */
interface Surveyed {
  readonly relative: string;
  readonly kind: "directory" | "file" | "link" | "other";
  readonly size: number;
  readonly mode: number;
  /** What a link points at, as written. */
  readonly target: string | undefined;
}

const signature = (entry: Surveyed) =>
  `${entry.kind}\0${entry.relative}\0${entry.kind === "file" ? entry.size : (entry.target ?? "")}`;

/**
 * Moves the folder `from` to `to`, which must not exist. Its parent is made if it is missing.
 * `from` is removed recursively only after a copy of it has been checked and put in place.
 */
export const moveFolder = Effect.fn("SkillMove.moveFolder")(function* (input: {
  readonly from: string;
  readonly to: string;
  readonly platform: NodeJS.Platform;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(input.to);
  const fail = (operation: SkillMoveError["operation"], target: string) => (cause: unknown) =>
    new SkillMoveError({ operation, path: target, cause });

  /** Anything at the path, even a link that leads nowhere. Doubt counts as taken. */
  const occupied = fileSystem.readLink(input.to).pipe(
    Effect.as(true),
    Effect.catchTags({
      PlatformError: (error) => Effect.succeed(error.reason._tag !== "NotFound"),
    }),
  );
  if (yield* occupied) return "taken" as const satisfies MoveFolderResult;
  yield* fileSystem
    .makeDirectory(parent, { recursive: true })
    .pipe(Effect.mapError(fail("makeDirectory", parent)));

  /** Renames `from` to `to`, or says why it didn't. */
  const rename = (from: string) =>
    fileSystem.rename(from, input.to).pipe(
      Effect.as(undefined),
      Effect.catchTags({
        PlatformError: (error) => {
          const failure = renameFailure(error, input.platform);
          return failure === undefined
            ? Effect.fail(new SkillMoveError({ operation: "rename", path: from, cause: error }))
            : Effect.succeed(failure);
        },
      }),
    );

  const renamed = yield* rename(input.from);
  if (renamed === undefined) return "moved" as const satisfies MoveFolderResult;
  if (renamed !== "otherDevice") return renamed satisfies MoveFolderResult;

  /** Everything under `root`, parents before the folders and files in them. */
  const survey = Effect.fnUntraced(function* (root: string) {
    const found: Surveyed[] = [];
    const pending = [""];
    for (let folder = pending.shift(); folder !== undefined; folder = pending.shift()) {
      const names = yield* fileSystem
        .readDirectory(path.join(root, folder))
        .pipe(Effect.mapError(fail("copy", path.join(root, folder))));
      for (const name of names.toSorted()) {
        const relative = path.join(folder, name);
        const absolute = path.join(root, relative);
        const target = yield* fileSystem.readLink(absolute).pipe(
          Effect.map((value): string | undefined => value),
          Effect.orElseSucceed(() => undefined),
        );
        if (target !== undefined) {
          found.push({ relative, kind: "link", size: 0, mode: 0, target });
          continue;
        }
        const info = yield* fileSystem.stat(absolute).pipe(Effect.mapError(fail("copy", absolute)));
        const kind =
          info.type === "Directory" ? "directory" : info.type === "File" ? "file" : "other";
        found.push({
          relative,
          kind,
          size: Number(info.size),
          mode: info.mode & 0o777,
          target: undefined,
        });
        if (kind === "directory") pending.push(relative);
      }
    }
    return found;
  });

  const original = yield* survey(input.from);
  const stage = yield* fileSystem
    .makeTempDirectory({ directory: parent, prefix: ".t3-moving-" })
    .pipe(Effect.mapError(fail("makeDirectory", parent)));
  const discardStage = fileSystem
    .remove(stage, { recursive: true, force: true })
    .pipe(Effect.ignore);

  const staged = Effect.gen(function* () {
    for (const entry of original) {
      const source = path.join(input.from, entry.relative);
      const copy = path.join(stage, entry.relative);
      const done =
        entry.kind === "directory"
          ? fileSystem.makeDirectory(copy)
          : entry.kind === "file"
            ? fileSystem.copyFile(source, copy)
            : entry.kind === "link" && entry.target !== undefined
              ? fileSystem.symlink(entry.target, copy)
              : // A socket or device can't be copied, and silently skipping it would lose it.
                Effect.fail(new SkillMoveError({ operation: "copy", path: source }));
      yield* done.pipe(Effect.mapError(fail("copy", source)));
    }
    // Folders last, so one without write permission doesn't stop its own contents.
    for (const entry of original.toReversed()) {
      if (entry.kind !== "directory") continue;
      yield* fileSystem
        .chmod(path.join(stage, entry.relative), entry.mode)
        .pipe(Effect.mapError(fail("copy", entry.relative)));
    }
    const rootMode = yield* fileSystem
      .stat(input.from)
      .pipe(Effect.mapError(fail("copy", input.from)));
    yield* fileSystem
      .chmod(stage, rootMode.mode & 0o777)
      .pipe(Effect.mapError(fail("copy", stage)));

    // The copy has to be the original, which must not have changed meanwhile: same entries,
    // sizes and link targets.
    const same = (left: readonly Surveyed[], right: readonly Surveyed[]) =>
      left.length === right.length &&
      left.every((entry, index) => signature(entry) === signature(right[index]!));
    const copied = yield* survey(stage);
    const now = yield* survey(input.from);
    if (!same(copied, original) || !same(now, original)) {
      return yield* new SkillMoveError({ operation: "verify", path: stage });
    }
    const placed = yield* rename(stage);
    if (placed === "otherDevice") {
      return yield* new SkillMoveError({ operation: "rename", path: stage });
    }
    return placed;
  }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? discardStage : Effect.void)));

  const placed = yield* staged;
  if (placed !== undefined) {
    // Put in place by someone else, or in use: the copy goes and the original stays.
    yield* discardStage;
    return placed satisfies MoveFolderResult;
  }
  return yield* fileSystem.remove(input.from, { recursive: true }).pipe(
    Effect.as("moved" as MoveFolderResult),
    // The skill is whole at its new place; what is left behind is reported, not undone.
    Effect.catchTags({
      PlatformError: () => Effect.succeed("movedWithLeftover" as MoveFolderResult),
    }),
  );
});

/**
 * Deletes a skill's real folder and everything in it. The caller has to know the path is the
 * skill's own folder and not a library's: a link at the path is removed, not followed.
 */
export const deleteFolder = Effect.fn("SkillMove.deleteFolder")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .remove(path, { recursive: true })
    .pipe(Effect.mapError((cause) => new SkillMoveError({ operation: "remove", path, cause })));
});
