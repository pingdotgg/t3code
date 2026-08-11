/**
 * AetherMirrorRegistry — the server-side ownership registry behind the
 * fork-side cloud-session write guard (spec build item 8a).
 *
 * While an Aether thread runs, its local checkout is a driver-owned one-way
 * mirror of the cloud VM. Local writes never reach the VM and silently break
 * the next reset-and-apply, so the mutating RPC dispatch sites in `ws.ts`
 * (`projects.writeFile`, `git.runStackedAction`, `vcs.pull`/`createWorktree`/
 * `removeWorktree`/`createRef`/`switchRef`) refuse with a typed error while a
 * registered mirror owns the cwd. `vcs.removeWorktree` is ADDITIONALLY keyed
 * on its resolved TARGET path — its `{cwd, path}` input lets a caller pass
 * the parent repository as cwd and the active mirror as target, and a
 * cwd-only key would leave the mirror deletable mid-thread (spec resolved
 * note 20).
 *
 * The AetherAdapter registers each session's cwd at startSession and
 * deregisters on disconnect AND adapter teardown, keyed per
 * (instance, thread) so overlapping registrations refcount instead of
 * clobbering each other.
 *
 * @module provider/AetherMirrorRegistry
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * `realpath`, or `undefined` when the path is simply not on disk yet. ENOENT
 * and ENOTDIR are the only two errnos that mean that; every other failure is
 * real and rethrown rather than normalized into a wrong key.
 */
const realpathIfExists = async (candidate: string): Promise<string | undefined> => {
  try {
    return await NodeFSP.realpath(candidate);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw cause;
  }
};

/**
 * The claim key for a checkout path: the REAL path of its nearest existing
 * ancestor plus the segments below it. `NodePath.resolve` alone collapses
 * `..`/`.` but does NOT resolve symlinks, so a mirror registered by its real
 * path and looked up through a symlinked path to the same checkout (macOS
 * `/tmp` → `/private/tmp`, a symlinked worktree root) produced two different
 * keys — and every `owns*` guard answered `false` for the very checkout it
 * exists to protect. Deregistration canonicalizes the same way and stays
 * stable after the worktree is removed, because the walk resumes at the
 * surviving parent.
 */
const canonicalize = (target: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const resolved = NodePath.resolve(target);
    const trailing: Array<string> = [];
    let probe = resolved;
    for (;;) {
      const real = await realpathIfExists(probe);
      if (real !== undefined) {
        return trailing.length === 0 ? real : NodePath.join(real, ...trailing);
      }
      const parent = NodePath.dirname(probe);
      if (parent === probe) {
        // Not even the filesystem root resolved — nothing left to canonicalize.
        return resolved;
      }
      trailing.unshift(NodePath.basename(probe));
      probe = parent;
    }
  });

export class AetherMirrorRegistry extends Context.Service<
  AetherMirrorRegistry,
  {
    /** Claim `cwd` for an Aether thread (key = instance:thread). */
    readonly register: (cwd: string, key: string) => Effect.Effect<void>;
    /** Release one claim; the cwd unlocks when its last claim goes. */
    readonly deregister: (cwd: string, key: string) => Effect.Effect<void>;
    /** Does any active Aether thread own this cwd? */
    readonly ownsCwd: (cwd: string) => Effect.Effect<boolean>;
    /**
     * Does `target` (resolved against `cwd` when relative) name an active
     * mirror? The removeWorktree guard: a parent-repo cwd must not bypass.
     */
    readonly ownsTargetPath: (cwd: string, target: string) => Effect.Effect<boolean>;
    /**
     * Does `target` (resolved against `cwd` when relative) sit AT or UNDER
     * an active mirror? The file-write guard: `projects.writeFile` resolves
     * `relativePath` under its `cwd`, so a PARENT project cwd can descend
     * into a mirror (`cwd=/repo, relativePath=.worktrees/mirror/app.ts`)
     * without ever owning the cwd itself.
     */
    readonly ownsPathWithin: (cwd: string, target: string) => Effect.Effect<boolean>;
  }
>()("t3/provider/AetherMirrorRegistry") {}

export const make = Effect.sync(() => {
  const claims = new Map<string, Set<string>>();
  return AetherMirrorRegistry.of({
    register: (cwd, key) =>
      Effect.gen(function* () {
        const normalized = yield* canonicalize(cwd);
        const keys = claims.get(normalized) ?? new Set<string>();
        keys.add(key);
        claims.set(normalized, keys);
      }),
    deregister: (cwd, key) =>
      Effect.gen(function* () {
        const normalized = yield* canonicalize(cwd);
        const keys = claims.get(normalized);
        if (keys === undefined) {
          return;
        }
        keys.delete(key);
        if (keys.size === 0) {
          claims.delete(normalized);
        }
      }),
    ownsCwd: (cwd) => canonicalize(cwd).pipe(Effect.map((normalized) => claims.has(normalized))),
    ownsTargetPath: (cwd, target) =>
      Effect.gen(function* () {
        const resolved = yield* canonicalize(
          NodePath.isAbsolute(target) ? target : NodePath.join(cwd, target),
        );
        if (claims.has(resolved)) {
          return true;
        }
        // `git worktree remove` also accepts a bare UNIQUE last path
        // component: `{cwd: parent, path: "aether-mirror"}` deletes
        // `parent/.worktrees/aether-mirror` even though the resolved path
        // never matches the claim. Refuse on a basename match against any
        // active mirror too — over-refusal is a loud, recoverable
        // inconvenience; deleting a live mirror mid-thread is not (spec
        // resolved note 20).
        const targetBasename = NodePath.basename(resolved);
        for (const claim of claims.keys()) {
          if (NodePath.basename(claim) === targetBasename) {
            return true;
          }
        }
        return false;
      }),
    ownsPathWithin: (cwd, target) =>
      Effect.gen(function* () {
        const resolved = yield* canonicalize(
          NodePath.isAbsolute(target) ? target : NodePath.join(cwd, target),
        );
        for (const claim of claims.keys()) {
          if (resolved === claim || resolved.startsWith(claim + NodePath.sep)) {
            return true;
          }
        }
        return false;
      }),
  });
});

export const layer = Layer.effect(AetherMirrorRegistry, make);
