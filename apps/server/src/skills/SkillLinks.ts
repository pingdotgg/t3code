/**
 * SkillLinks - the two filesystem writes that give an agent a skill: making a link in the agent's
 * own folder, and removing one.
 *
 * Both are built so the operating system, not an earlier check, is the last guard:
 * - A link is made with a bare create. Something already at the path makes it fail; it is never
 *   removed first, so a real folder or another skill's link can't be replaced.
 * - A link is removed only after it is read again and found to be the one that was inspected, and
 *   with a non-recursive remove. If a folder took its place in between, the remove fails.
 *
 * @module SkillLinks
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type { SkillScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class SkillLinkError extends Schema.TaggedError<SkillLinkError>()("SkillLinkError", {
  operation: Schema.Literals([
    "makeDirectory",
    "realPath",
    "symlink",
    "verify",
    "readLink",
    "remove",
  ]),
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Skill link operation '${this.operation}' failed.`;
  }
}

/**
 * The kind of link to make and what it points at.
 *
 * A project's links are meant to be committed, so they point at a path relative to the link's own
 * folder and survive a clone or a move. A global link points at an absolute path: nobody clones
 * `~/.claude`, and the skill often lives outside the home folder. Windows can't make a symlink
 * without Developer Mode or elevation, but a junction needs neither, so a global link there is one;
 * a junction can't be committed as a link, so a project's stays a symlink and is refused without
 * the privilege.
 */
export const linkSpec = (input: {
  readonly platform: NodeJS.Platform;
  readonly scope: SkillScope;
  readonly home: string;
  /** From the link's real folder to the home, when the home is inside the project. */
  readonly relative: string | undefined;
}) => {
  const junction = input.platform === "win32" && input.scope === "global";
  return {
    type: junction ? "junction" : "dir",
    target: !junction && input.scope === "project" ? (input.relative ?? input.home) : input.home,
  } as const;
};

export type CreateLinkResult =
  /** The link was made. */
  | "created"
  /** What is there already is the skill's folder. */
  | "unchanged"
  /** Something else is there. It was left alone. */
  | "taken"
  /** The system doesn't allow links here. */
  | "notAllowed";

const NOT_ALLOWED_CODES = new Set(["EPERM", "EACCES", "EROFS"]);

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/** What a path is, as far as links go. `stat` follows links, so only `readLink` can tell. */
export const readLinkTarget = Effect.fnUntraced(function* (link: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readLink(link).pipe(
    Effect.map((target): { readonly _tag: "Link"; readonly target: string } => ({
      _tag: "Link",
      target,
    })),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed({ _tag: "Missing" } as const)
          : isNotLinkError(error)
            ? Effect.succeed({ _tag: "NotLink" } as const)
            : Effect.fail(new SkillLinkError({ operation: "readLink", path: link, cause: error })),
    }),
  );
});

/** Reading a path that isn't a link fails with EINVAL; this is how CodexHomeLayout tells too. */
function isNotLinkError(error: PlatformError.PlatformError) {
  return error.reason._tag === "Unknown" && errorCode(error.reason.cause) === "EINVAL";
}

const isInside = (path: Path.Path, folder: string, inner: string) => {
  const relative = path.relative(folder, inner);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

export type RemoveLinkResult =
  /** The link was removed. */
  | "removed"
  /** Nothing was there. */
  | "gone"
  /** What is there isn't the link that was inspected: a folder, a file or a link to elsewhere. */
  | "changed";

/**
 * Removes `path` only if it is still a link with the target it was inspected with. The remove is
 * not recursive, so a folder that took the link's place makes it fail instead of being deleted.
 */
export const removeLink = Effect.fn("SkillLinks.removeLink")(function* (input: {
  readonly path: string;
  readonly expectedTarget: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const state = yield* readLinkTarget(input.path);
  if (state._tag === "Missing") return "gone" as const satisfies RemoveLinkResult;
  if (state._tag === "NotLink" || state.target !== input.expectedTarget) {
    return "changed" as const satisfies RemoveLinkResult;
  }
  yield* fileSystem
    .remove(input.path)
    .pipe(
      Effect.mapError(
        (cause) => new SkillLinkError({ operation: "remove", path: input.path, cause }),
      ),
    );
  return "removed" as const satisfies RemoveLinkResult;
});

/**
 * Makes `link` point at `home`. Nothing is replaced: an existing entry fails the create, and it
 * counts as `unchanged` only when it already is the skill's folder.
 */
export const createLink = Effect.fn("SkillLinks.createLink")(function* (input: {
  readonly link: string;
  /** Absolute and real: the skill's folder after following links. */
  readonly home: string;
  readonly scope: SkillScope;
  readonly platform: NodeJS.Platform;
  /** The project's real folder, when a link may be written relative to it. */
  readonly projectRoot?: string | undefined;
  /**
   * What the link says instead of the home, for a link that goes through another link on its way
   * there, such as a project's link to the library. It has to lead to the home all the same.
   */
  readonly target?: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parent = path.dirname(input.link);
  yield* fileSystem
    .makeDirectory(parent, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) => new SkillLinkError({ operation: "makeDirectory", path: parent, cause }),
      ),
    );
  // A relative target is read from where the link's folder really is, not from the path it was reached by.
  const realParent = yield* fileSystem
    .realPath(parent)
    .pipe(
      Effect.mapError(
        (cause) => new SkillLinkError({ operation: "realPath", path: parent, cause }),
      ),
    );
  const computed = linkSpec({
    platform: input.platform,
    scope: input.scope,
    home: input.home,
    relative:
      input.projectRoot !== undefined && isInside(path, input.projectRoot, input.home)
        ? path.relative(realParent, input.home)
        : undefined,
  });
  const spec = input.target === undefined ? computed : { ...computed, target: input.target };

  const outcome = yield* Effect.tryPromise({
    try: () => NodeFSP.symlink(spec.target, input.link, spec.type),
    catch: (cause) => new SkillLinkError({ operation: "symlink", path: input.link, cause }),
  }).pipe(
    Effect.as("created" as CreateLinkResult),
    Effect.catchTags({
      SkillLinkError: (error) => {
        const code = errorCode(error.cause);
        if (code === "EEXIST") {
          return fileSystem.realPath(input.link).pipe(
            Effect.map((real): CreateLinkResult => (real === input.home ? "unchanged" : "taken")),
            Effect.orElseSucceed((): CreateLinkResult => "taken"),
          );
        }
        return typeof code === "string" && NOT_ALLOWED_CODES.has(code)
          ? Effect.succeed("notAllowed" as CreateLinkResult)
          : Effect.fail(error);
      },
    }),
  );
  if (outcome !== "created") return outcome;

  // The link has to lead where it was meant to; if it doesn't, take back what was just made.
  const real = yield* fileSystem.realPath(input.link).pipe(Effect.orElseSucceed(() => undefined));
  if (real === input.home) return outcome;
  yield* removeLink({ path: input.link, expectedTarget: spec.target }).pipe(Effect.ignore);
  return yield* new SkillLinkError({ operation: "verify", path: input.link });
});
