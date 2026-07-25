// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceRootAccess - authorization for the workspace roots a client may
 * address in workspace file RPCs.
 *
 * `WorkspacePaths` only keeps a request inside whatever root the client asked
 * for, so on its own it happily reads `~/.ssh` when that is the root. This
 * module is the missing half: it decides whether the requested root is one the
 * server actually manages — an active project root, or a worktree belonging to
 * one of its threads.
 *
 * Comparison happens on canonical paths. Resolving the request but not the
 * registered roots would let a symlink planted inside a project (`proj/link ->
 * /`) pass as a root and turn the whole filesystem into "inside the project".
 *
 * @module WorkspaceRootAccess
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class WorkspaceRootNotRegisteredError extends Schema.TaggedErrorClass<WorkspaceRootNotRegisteredError>()(
  "WorkspaceRootNotRegisteredError",
  {
    workspaceRoot: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace root '${this.workspaceRoot}' is not a registered project or worktree.`;
  }
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(NodeOS.homedir(), input.slice(2));
  }
  return input;
}

/** Whether `candidate` is `root` itself or a descendant of it. */
export function isPathWithin(input: {
  readonly candidate: string;
  readonly root: string;
  readonly path: Path.Path;
}): boolean {
  if (input.root.length === 0) {
    return false;
  }
  if (input.candidate === input.root) {
    return true;
  }
  const relative = input.path.relative(input.root, input.candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${input.path.sep}`) &&
    !input.path.isAbsolute(relative)
  );
}

/**
 * Resolve symlinks, falling back to the input when the path cannot be read.
 *
 * An unreadable path is not an authorization decision — the caller still has
 * to match it against a registered root, and the file operation itself will
 * surface the real I/O error.
 */
const canonicalize = (candidate: string) =>
  Effect.promise(() => NodeFSP.realpath(candidate).catch(() => candidate));

/**
 * Resolve `workspaceRoot` and check it against the registered roots.
 *
 * Registered roots are only canonicalized when the cheap textual comparison
 * misses, which keeps the common case (a client echoing back the exact root it
 * was given) to a single `realpath`. That shortcut is safe because any prefix
 * of a canonical path is itself canonical: if the canonical request sits under
 * a registered root textually, that root has no symlinks to resolve.
 */
export const authorizeWorkspaceRoot = Effect.fn("WorkspaceRootAccess.authorizeWorkspaceRoot")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly registeredRoots: ReadonlyArray<string>;
    readonly path: Path.Path;
  }) {
    const path = input.path;
    const requested = path.resolve(expandHomePath(input.workspaceRoot.trim(), path));
    const canonicalRequested = yield* canonicalize(requested);

    for (const registeredRoot of input.registeredRoots) {
      const resolvedRoot = path.resolve(expandHomePath(registeredRoot.trim(), path));
      if (isPathWithin({ candidate: canonicalRequested, root: resolvedRoot, path })) {
        return input.workspaceRoot;
      }
      const canonicalRoot = yield* canonicalize(resolvedRoot);
      if (
        canonicalRoot !== resolvedRoot &&
        isPathWithin({ candidate: canonicalRequested, root: canonicalRoot, path })
      ) {
        return input.workspaceRoot;
      }
    }

    return yield* new WorkspaceRootNotRegisteredError({ workspaceRoot: input.workspaceRoot });
  },
);
