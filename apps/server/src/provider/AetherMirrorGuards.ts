/**
 * AetherMirrorGuards — the refusal logic behind the Aether cloud-session
 * write guard's ws.ts dispatch sites (spec build item 8a).
 *
 * While an Aether thread owns a cwd, that checkout is a one-way mirror of
 * the cloud VM: local writes never reach the VM and silently break the next
 * turn's reset-and-apply sync. The guarded RPCs dispatch straight into
 * workspaceFileSystem/gitWorkflow (they never cross ProviderAdapter), so the
 * refusal lives at the dispatch sites — extracted here so the guard
 * behavior, including the removeWorktree parent-cwd bypass (spec resolved
 * note 20) and the typed writeFile refusal, is testable against a real
 * registry instead of only readable in ws.ts.
 *
 * @module provider/AetherMirrorGuards
 */
import { AETHER_MIRROR_REFUSAL, GitCommandError, ProjectWriteFileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export { AETHER_MIRROR_REFUSAL };

/** The registry surface the guards need — structurally AetherMirrorRegistry. */
export interface AetherMirrorOwnership {
  /**
   * The check and the mutation it authorises run INSIDE this, so a session
   * cannot register the checkout in between and turn an allowed write into a
   * write onto a live one-way mirror.
   */
  readonly whileClaimsFrozen: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly ownsCwd: (cwd: string) => Effect.Effect<boolean>;
  readonly ownsTargetPath: (cwd: string, target: string) => Effect.Effect<boolean>;
  readonly ownsPathWithin: (cwd: string, target: string) => Effect.Effect<boolean>;
}

/** Refuse a cwd-scoped VCS mutation while an Aether thread owns the cwd. */
export const guardAetherVcsMutation = <A, E, R>(
  registry: AetherMirrorOwnership,
  operation: string,
  cwd: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GitCommandError, R> =>
  registry.whileClaimsFrozen(
    Effect.gen(function* () {
      if (yield* registry.ownsCwd(cwd)) {
        return yield* new GitCommandError({
          operation,
          command: "",
          cwd,
          detail: AETHER_MIRROR_REFUSAL,
        });
      }
      return yield* effect;
    }),
  );

/**
 * removeWorktree is DESTRUCTIVE and takes `{cwd, path}`: guard the resolved
 * TARGET too, so a parent-repo cwd cannot delete an active mirror (spec
 * resolved note 20).
 */
export const guardAetherRemoveWorktree = <A, E, R>(
  registry: AetherMirrorOwnership,
  input: { readonly cwd: string; readonly path: string },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | GitCommandError, R> =>
  registry.whileClaimsFrozen(
    Effect.gen(function* () {
      const ownsCwd = yield* registry.ownsCwd(input.cwd);
      const ownsTarget = yield* registry.ownsTargetPath(input.cwd, input.path);
      if (ownsCwd || ownsTarget) {
        return yield* new GitCommandError({
          operation: "vcs.removeWorktree",
          command: "",
          cwd: input.cwd,
          detail: ownsTarget
            ? `The target worktree is an active Aether cloud-session mirror and cannot be removed mid-thread. ${AETHER_MIRROR_REFUSAL}`
            : AETHER_MIRROR_REFUSAL,
        });
      }
      return yield* effect;
    }),
  );

/**
 * `projects.writeFile` resolves `relativePath` under `cwd`, so a PARENT
 * project cwd can descend into an active mirror — hence `ownsPathWithin`
 * rather than `ownsCwd`. Same frozen region as the VCS guards: the check and
 * the write are one step as far as registration is concerned.
 */
export const guardAetherWriteFile = <A, E, R>(
  registry: AetherMirrorOwnership,
  input: { readonly cwd: string; readonly relativePath: string },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProjectWriteFileError, R> =>
  registry.whileClaimsFrozen(
    Effect.gen(function* () {
      if (yield* registry.ownsPathWithin(input.cwd, input.relativePath)) {
        return yield* aetherMirrorWriteFileError(input);
      }
      return yield* effect;
    }),
  );

/** The typed `projects.writeFile` refusal (fully type-checked construction). */
export const aetherMirrorWriteFileError = (input: {
  readonly cwd: string;
  readonly relativePath: string;
}): ProjectWriteFileError =>
  new ProjectWriteFileError({
    cwd: input.cwd,
    relativePath: input.relativePath,
    failure: "aether_mirror_read_only",
  });
