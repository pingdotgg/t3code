import { expect, it } from "@effect/vitest";
import { ProjectId, type ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { GitHubAccount } from "./GitHubApi.ts";
import { makeGitHubProjectAccount } from "./gitHubProjectAccount.ts";

const WORK = ProjectId.make("work");
const PERSONAL = ProjectId.make("personal");
const ROOTS: Record<string, ProjectId> = { "/code/work": WORK, "/code/personal": PERSONAL };

function harness(overrides: ServerSettingsSchema["projectSettingsOverrides"]) {
  const gitCalls: string[] = [];
  const row = (projectId: ProjectId, workspaceRoot: string): ProjectStore.ProjectRow => ({
    projectId,
    title: projectId,
    workspaceRoot,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  });
  const layer = Layer.mergeAll(
    ServerSettings.ServerSettingsService.layerTest({ projectSettingsOverrides: overrides }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      findActiveByWorkspaceRoot: (root) => {
        const projectId = ROOTS[root];
        return Effect.succeed(
          projectId === undefined ? Option.none() : Option.some(row(projectId, root)),
        );
      },
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      // A worktree's common directory lives in its main checkout.
      execute: (input) =>
        Effect.sync(() => {
          gitCalls.push(input.cwd);
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "/code/work/.git\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    }),
    Path.layer,
  );
  return { layer, gitCalls };
}

it.effect("runs a project's checkouts and worktrees as its own account", () => {
  const { layer, gitCalls } = harness({ [WORK]: { githubAccount: "bek-work" } });
  return Effect.gen(function* () {
    const { accountFor, actAs } = yield* makeGitHubProjectAccount;
    expect(yield* accountFor({ cwd: "/code/work" })).toBe("bek-work");
    expect(yield* accountFor({ cwd: "/code/personal" })).toBeNull();
    expect(yield* accountFor({ cwd: "/worktrees/work/feature" })).toBe("bek-work");
    expect(yield* accountFor({ cwd: "/worktrees/work/feature" })).toBe("bek-work");
    expect(gitCalls).toEqual(["/worktrees/work/feature"]);
    expect(yield* actAs({ cwd: "/worktrees/work/feature" }, GitHubAccount)).toBe("bek-work");
    expect(yield* actAs({ cwd: "/code/personal" }, GitHubAccount)).toBeNull();
  }).pipe(Effect.provide(layer));
});

it.effect("asks nothing of Git or the project store without project overrides", () => {
  const { layer, gitCalls } = harness({});
  return Effect.gen(function* () {
    const { accountFor } = yield* makeGitHubProjectAccount;
    expect(yield* accountFor({ cwd: "/worktrees/work/feature" })).toBeNull();
    expect(gitCalls).toEqual([]);
  }).pipe(Effect.provide(layer));
});
