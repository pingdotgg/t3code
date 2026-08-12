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
import * as Semaphore from "effect/Semaphore";

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
    /**
     * Run `effect` while no claim can appear over the paths it WRITES. The
     * write guards need this because an ownership check and the mutation it
     * authorises are two steps — a session registering in between would let a
     * local write reach a checkout that is an active one-way mirror by the
     * time it hits disk, breaking the next reset-and-apply.
     *
     * `writes` names every path the effect may write: the mutation's cwd, plus
     * the specific descendant a guard can reach (a file write, a worktree
     * removal). The freeze is SCOPED to those paths and their ancestors, so a
     * mutation on one checkout never blocks a registration on an unrelated
     * one — which matters because a guarded mutation holds this across slow
     * network I/O (a stacked action's push, a pull), and a process-global
     * freeze would let one hung push stall every Aether session start.
     *
     * A registration conflicts with exactly the mutations writing AT or UNDER
     * it. A mutation in an ANCESTOR of the claim does not: git operations in a
     * parent repository do not write its linked worktrees, and the two guards
     * that CAN reach a descendant declare that descendant in `writes`.
     */
    readonly whileClaimsFrozen: <A, E, R>(
      writes: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
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

/**
 * Permits on a path's claim lock: a frozen region takes one, a
 * register/deregister of that exact path takes them all. The count only bounds
 * how many guarded mutations may touch one path at once before they queue —
 * far above anything a user-driven RPC surface produces.
 */
const CLAIM_LOCK_PERMITS = 1024;

/** Every path from the filesystem root down to `path`, root first. */
const ancestorChain = (path: string): ReadonlyArray<string> => {
  const chain: Array<string> = [];
  let current = path;
  for (;;) {
    chain.unshift(current);
    const parent = NodePath.dirname(current);
    if (parent === current) {
      return chain;
    }
    current = parent;
  }
};

export const make = Effect.sync(() => {
  const claims = new Map<string, Set<string>>();
  // One lock per canonical path. A frozen region holds a reader on every
  // ancestor of what it writes; a registration takes its OWN path exclusively.
  // So a claim conflicts with exactly the mutations writing at or under it,
  // and unrelated checkouts share no key. `makeUnsafe` so handing a lock out
  // cannot yield between the map's get and set.
  const pathLocks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (path: string): Semaphore.Semaphore => {
    const existing = pathLocks.get(path);
    if (existing !== undefined) {
      return existing;
    }
    const created = Semaphore.makeUnsafe(CLAIM_LOCK_PERMITS);
    pathLocks.set(path, created);
    return created;
  };

  const whileClaimsFrozen = <A, E, R>(
    writes: ReadonlyArray<string>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const canonical = yield* Effect.forEach(writes, canonicalize);
      // Sorted and de-duplicated: a deterministic acquisition order is what
      // keeps two overlapping mutations from deadlocking each other.
      const keys = [...new Set(canonical.flatMap(ancestorChain))].sort();
      return yield* keys.reduce((guarded, key) => lockFor(key).withPermits(1)(guarded), effect);
    });

  const withClaimsExclusive = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    canonicalize(cwd).pipe(
      Effect.flatMap((path) => lockFor(path).withPermits(CLAIM_LOCK_PERMITS)(effect)),
    );
  return AetherMirrorRegistry.of({
    whileClaimsFrozen,
    register: (cwd, key) =>
      withClaimsExclusive(
        cwd,
        Effect.gen(function* () {
          const normalized = yield* canonicalize(cwd);
          const keys = claims.get(normalized) ?? new Set<string>();
          keys.add(key);
          claims.set(normalized, keys);
        }),
      ),
    deregister: (cwd, key) =>
      withClaimsExclusive(
        cwd,
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
      ),
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
