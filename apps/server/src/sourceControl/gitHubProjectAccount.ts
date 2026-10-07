import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProjectId } from "@t3tools/contracts";
import {
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { GitHubAccount } from "./GitHubApi.ts";

/**
 * Runs GitHub work as the project's own `gh` login (its `githubAccount` setting) for paths that
 * only know a working directory. A worktree belongs to the project whose checkout shares its Git
 * directory. Without any project overrides this answers at once and runs nothing.
 */
export const makeGitHubProjectAccount = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  // A worktree's main checkout never changes, so it is asked of Git once.
  const mainCheckouts = new Map<string, string>();

  const projectAt = (workspaceRoot: string) =>
    projects.findActiveByWorkspaceRoot(workspaceRoot).pipe(
      Effect.map((project) => Option.getOrNull(project)?.projectId ?? null),
      Effect.orElseSucceed(() => null),
    );

  const mainCheckoutOf = (cwd: string) => {
    const held = mainCheckouts.get(cwd);
    if (held !== undefined) return Effect.succeed(Option.some(held));
    return git
      .execute({
        operation: "GitHubProjectAccount.commonDir",
        cwd,
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.map((result) => path.dirname(result.stdout.trim())),
        Effect.tap((root) => Effect.sync(() => mainCheckouts.set(cwd, root))),
        Effect.option,
      );
  };

  const projectOf = Effect.fnUntraced(function* (cwd: string) {
    const direct = yield* projectAt(cwd);
    if (direct !== null) return direct;
    const main = yield* mainCheckoutOf(cwd);
    return Option.isNone(main) ? null : yield* projectAt(main.value);
  });

  /** The login the project at `cwd` (or `projectId`, when the caller knows it) chooses, or null. */
  const accountFor = Effect.fnUntraced(function* (input: {
    readonly cwd: string;
    readonly projectId?: ProjectId | null | undefined;
  }) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null || !hasProjectSettingsOverrides(settings)) return null;
    const projectId = input.projectId ?? (yield* projectOf(input.cwd));
    return projectId === null
      ? null
      : resolveProjectSettings(settings, projectId).settings.githubAccount;
  });

  const actAs = <A, E, R>(
    input: { readonly cwd: string; readonly projectId?: ProjectId | null | undefined },
    effect: Effect.Effect<A, E, R>,
  ) =>
    accountFor(input).pipe(
      Effect.flatMap((account) =>
        account === null ? effect : effect.pipe(Effect.provideService(GitHubAccount, account)),
      ),
    );

  return { accountFor, actAs };
});
