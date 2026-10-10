/**
 * InstructionLinks - the two writes that make an agent read the shared instruction file: a link at
 * the agent's own file, and, when the agent already has a file of its own, a link that takes the
 * file's place.
 *
 * Like `SkillLinks`, the operating system is the last guard. A link is made with a bare create, so
 * anything already at the path makes it fail and nothing is removed first. Only `replaceWithLink`
 * ever takes a file's place, and only after the caller has kept the file's text somewhere else.
 *
 * @module InstructionLinks
 */
// @effect-diagnostics nodeBuiltinImport:off - A temp link's name needs a random part.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type CreateFileLinkResult =
  /** The link was made. */
  | "created"
  /** What is there already leads to the shared file. */
  | "unchanged"
  /** Something else is there. It was left alone. */
  | "taken"
  /** The system doesn't allow links here (Windows without Developer Mode, a read-only folder). */
  | "notAllowed";

/** Whether the path leads to `target`, or is a link to it that leads nowhere yet. */
const leadsTo = Effect.fnUntraced(function* (link: string, target: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [real, expected] = yield* Effect.all([
    fileSystem.realPath(link).pipe(Effect.option),
    fileSystem.realPath(target).pipe(Effect.option),
  ]);
  if (real._tag === "Some" && expected._tag === "Some") return real.value === expected.value;
  const written = yield* fileSystem.readLink(link).pipe(Effect.option);
  return written._tag === "Some" && path.resolve(path.dirname(link), written.value) === target;
});

/**
 * Makes `link` a symlink to `target`, an absolute path. Nothing is replaced: an existing entry
 * fails the create, and counts as `unchanged` only when it already leads to `target`.
 */
export const createFileLink = Effect.fn("InstructionLinks.createFileLink")(function* (input: {
  readonly link: string;
  readonly target: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(input.link), { recursive: true });
  return yield* fileSystem.symlink(input.target, input.link).pipe(
    Effect.as("created" as CreateFileLinkResult),
    Effect.catchTags({
      PlatformError: (error) => {
        const reason = error.reason._tag;
        if (reason === "AlreadyExists") {
          return leadsTo(input.link, input.target).pipe(
            Effect.map((same): CreateFileLinkResult => (same ? "unchanged" : "taken")),
          );
        }
        if (reason === "PermissionDenied") return Effect.succeed("notAllowed" as const);
        return Effect.fail(error);
      },
    }),
  );
});

/**
 * Makes `file` a link to `target` in one step: the link is made under a temp name beside the file
 * and renamed over it, so there is never a moment without a file. `stillSame` is asked right before
 * the rename, and the file is left alone when it says no. Returns whether the file was replaced.
 */
export const replaceWithLink = Effect.fn("InstructionLinks.replaceWithLink")(function* (input: {
  readonly file: string;
  readonly target: string;
  readonly stillSame: Effect.Effect<boolean>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = path.join(
    path.dirname(input.file),
    `.${path.basename(input.file)}.${NodeCrypto.randomUUID()}.link`,
  );
  yield* fileSystem.symlink(input.target, temp);
  return yield* Effect.gen(function* () {
    if (!(yield* input.stillSame)) return false;
    yield* fileSystem.rename(temp, input.file);
    return true;
  }).pipe(Effect.ensuring(fileSystem.remove(temp, { force: true }).pipe(Effect.ignore)));
});
