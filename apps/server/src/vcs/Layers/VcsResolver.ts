import type { VcsCapabilities } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { VcsUnsupportedError } from "../Errors.ts";
import { VcsProcess } from "../Services/VcsProcess.ts";
import { VcsResolver, type VcsResolverShape } from "../Services/VcsResolver.ts";

const GIT_CAPABILITIES: VcsCapabilities = {
  supportsPull: true,
  supportsRunStackedAction: true,
  supportsCreateWorkspace: true,
  supportsRemoveWorkspace: true,
  supportsCreateRef: true,
  supportsCheckoutRef: true,
  supportsInit: true,
  supportsCheckpointing: true,
};

const JJ_CAPABILITIES: VcsCapabilities = {
  supportsPull: false,
  supportsRunStackedAction: false,
  supportsCreateWorkspace: true,
  supportsRemoveWorkspace: true,
  supportsCreateRef: false,
  supportsCheckoutRef: false,
  supportsInit: true,
  supportsCheckpointing: true,
};

function isCommandMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Command not found");
}

function catchMissingCommandAsNull<A, E>(effect: Effect.Effect<A, E>) {
  return effect.pipe(
    Effect.catch((error) => (isCommandMissing(error) ? Effect.succeed(null) : Effect.fail(error))),
  );
}

const makeVcsResolver = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess;

  const tryResolveGit = (cwd: string) =>
    vcsProcess
      .execute({
        operation: "VcsResolver.resolveGit",
        command: "git",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) =>
          result.code === 0 && result.stdout.trim().length > 0
            ? {
                backend: "git" as const,
                capabilities: GIT_CAPABILITIES,
                workspaceRoot: result.stdout.trim(),
              }
            : null,
        ),
      );

  const tryResolveJjGitRoot = (cwd: string, operation: string) =>
    vcsProcess
      .execute({
        operation,
        command: "jj",
        cwd,
        args: ["git", "root"],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        catchMissingCommandAsNull,
        Effect.map((result) =>
          result && result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null,
        ),
      );

  const tryResolveJj = (cwd: string, operation: string) =>
    Effect.gen(function* () {
      const workspaceRootResult = yield* vcsProcess
        .execute({
          operation,
          command: "jj",
          cwd,
          args: ["workspace", "root"],
          allowNonZeroExit: true,
          timeoutMs: 5_000,
        })
        .pipe(catchMissingCommandAsNull);
      if (!workspaceRootResult || workspaceRootResult.code !== 0) {
        return null;
      }
      const workspaceRoot = workspaceRootResult.stdout.trim();
      if (workspaceRoot.length === 0) {
        return null;
      }

      const gitRoot = yield* tryResolveJjGitRoot(cwd, `${operation}.jjGitRoot`);
      if (!gitRoot) {
        return yield* new VcsUnsupportedError({
          operation,
          cwd,
          detail: "Only colocated jj workspaces are supported in v1.",
        });
      }

      return {
        backend: "jj" as const,
        capabilities: JJ_CAPABILITIES,
        workspaceRoot,
      };
    });

  const resolve: VcsResolverShape["resolve"] = (input) =>
    Effect.gen(function* () {
      if (input.backend === "jj") {
        const jjResolution = yield* tryResolveJj(input.cwd, "VcsResolver.resolve");
        if (jjResolution) {
          return jjResolution;
        }
        return yield* new VcsUnsupportedError({
          operation: "VcsResolver.resolve",
          cwd: input.cwd,
          detail: "No jj repository was detected in the target directory.",
        });
      }
      if (input.backend === "git") {
        const gitResolution = yield* catchMissingCommandAsNull(tryResolveGit(input.cwd));
        return (
          gitResolution ?? {
            backend: "git" as const,
            capabilities: GIT_CAPABILITIES,
            workspaceRoot: input.cwd,
          }
        );
      }

      const jjResolution = yield* tryResolveJj(input.cwd, "VcsResolver.resolve");
      if (jjResolution) {
        return jjResolution;
      }

      const gitResolution = yield* catchMissingCommandAsNull(tryResolveGit(input.cwd));
      return (
        gitResolution ?? {
          backend: "git" as const,
          capabilities: GIT_CAPABILITIES,
          workspaceRoot: input.cwd,
        }
      );
    });

  return { resolve } satisfies VcsResolverShape;
});

export const VcsResolverLive = Layer.effect(VcsResolver, makeVcsResolver);
