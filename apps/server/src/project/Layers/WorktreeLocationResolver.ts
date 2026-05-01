import { Effect, Layer } from "effect";
import { WorktreeLocationResolverError } from "@t3tools/contracts";

import {
  createWorktreeLocationTemplateContext,
  resolveWorktreeLocation,
  sanitizeWorktreeName,
} from "@t3tools/shared/worktreeLocation";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  WorktreeLocationResolver,
  type WorktreeLocationResolverShape,
} from "../Services/WorktreeLocationResolver.ts";

function createWorktreeLocationResolverError(
  projectRoot: string,
  detail: string,
  cause?: unknown,
): WorktreeLocationResolverError {
  return new WorktreeLocationResolverError({
    projectRoot,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export const makeWorktreeLocationResolver = Effect.gen(function* () {
  const { baseDir, worktreesDir } = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;

  const resolveCreateWorktreePath: WorktreeLocationResolverShape["resolveCreateWorktreePath"] =
    Effect.fn("WorktreeLocationResolver.resolveCreateWorktreePath")(function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((error) =>
          createWorktreeLocationResolverError(input.projectRoot, error.message, error),
        ),
      );
      const resolvedLocation = resolveWorktreeLocation({
        mode: settings.worktreeLocation.mode,
        template: settings.worktreeLocation.template,
        context: createWorktreeLocationTemplateContext({
          t3Home: baseDir,
          projectRoot: input.projectRoot,
          worktreeName: sanitizeWorktreeName(input.name),
        }),
        defaultWorktreesDir: worktreesDir,
      });
      if (!resolvedLocation.ok) {
        return yield* createWorktreeLocationResolverError(
          input.projectRoot,
          `invalid custom worktree template: ${resolvedLocation.error}`,
        );
      }

      return resolvedLocation.path;
    });

  return {
    resolveCreateWorktreePath,
  } satisfies WorktreeLocationResolverShape;
});

export const WorktreeLocationResolverLive = Layer.effect(
  WorktreeLocationResolver,
  makeWorktreeLocationResolver,
);
