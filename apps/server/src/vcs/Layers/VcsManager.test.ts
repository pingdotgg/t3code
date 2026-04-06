import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";

import { type GitManagerShape, GitManager } from "../../git/Services/GitManager.ts";
import { JjManager } from "../../jj/Services/JjManager.ts";
import { makeTempDir } from "../../jj/Layers/JjTestUtils.ts";
import { VcsManager } from "../Services/VcsManager.ts";
import { VcsManagerLive } from "./VcsManager.ts";

function createManagerStub(kind: "git" | "jj") {
  const calls = {
    status: [] as string[],
    preparePullRequestThread: [] as string[],
  };

  const manager: GitManagerShape = {
    status: (input) =>
      Effect.sync(() => {
        calls.status.push(input.cwd);
        return {
          isRepo: true,
          hasOriginRemote: kind === "git",
          isDefaultBranch: false,
          branch: `${kind}-branch`,
          hasWorkingTreeChanges: false,
          workingTree: {
            files: [],
            insertions: 0,
            deletions: 0,
          },
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        };
      }),
    resolvePullRequest: () =>
      Effect.succeed({
        pullRequest: {
          number: kind === "git" ? 7 : 11,
          title: `${kind} PR`,
          url: `https://github.com/pingdotgg/t3code/pull/${kind === "git" ? 7 : 11}`,
          baseBranch: "main",
          headBranch: `${kind}-head`,
          state: "open" as const,
        },
      }),
    preparePullRequestThread: (input) =>
      Effect.sync(() => {
        calls.preparePullRequestThread.push(input.cwd);
        return {
          pullRequest: {
            number: kind === "git" ? 7 : 11,
            title: `${kind} PR`,
            url: `https://github.com/pingdotgg/t3code/pull/${kind === "git" ? 7 : 11}`,
            baseBranch: "main",
            headBranch: `${kind}-head`,
            state: "open" as const,
          },
          branch: `${kind}-branch`,
          worktreePath: kind === "jj" ? path.join(input.cwd, "workspace") : null,
        };
      }),
    runStackedAction: () =>
      Effect.succeed({
        action: "commit",
        branch: {
          status: "skipped_not_requested" as const,
        },
        commit: {
          status: "skipped_no_changes" as const,
        },
        push: {
          status: "skipped_not_requested" as const,
        },
        pr: {
          status: "skipped_not_requested" as const,
        },
        toast: {
          title: `${kind} action`,
          description: `${kind} action was skipped`,
          cta: {
            kind: "none" as const,
          },
        },
      }),
  };

  return { manager, calls };
}

function makeVcsManager() {
  const git = createManagerStub("git");
  const jj = createManagerStub("jj");
  const dependencies = Layer.mergeAll(
    Layer.succeed(GitManager, git.manager),
    Layer.succeed(JjManager, jj.manager),
  );
  const layer = VcsManagerLive.pipe(Layer.provide(dependencies));

  return Effect.gen(function* () {
    const vcsManager = yield* VcsManager;
    return { vcsManager, gitCalls: git.calls, jjCalls: jj.calls };
  }).pipe(Effect.provide(layer));
}

const TestLayer = Layer.mergeAll(NodeServices.layer);

it.layer(TestLayer)("VcsManager", (it) => {
  it.effect("routes manager status to git repositories", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-vcs-manager-git-");
      fs.mkdirSync(path.join(repoDir, ".git"));
      const { vcsManager, gitCalls, jjCalls } = yield* makeVcsManager();

      const status = yield* vcsManager.status({ cwd: repoDir });

      expect(status.branch).toBe("git-branch");
      expect(gitCalls.status).toEqual([repoDir]);
      expect(jjCalls.status).toEqual([]);
    }),
  );

  it.effect("routes pull request thread prep to jj repositories", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-vcs-manager-jj-");
      fs.mkdirSync(path.join(repoDir, ".jj"));
      const { vcsManager, gitCalls, jjCalls } = yield* makeVcsManager();

      const result = yield* vcsManager.preparePullRequestThread({
        cwd: repoDir,
        reference: "11",
        mode: "worktree",
      });

      expect(result.branch).toBe("jj-branch");
      expect(result.worktreePath).toBe(path.join(repoDir, "workspace"));
      expect(gitCalls.preparePullRequestThread).toEqual([]);
      expect(jjCalls.preparePullRequestThread).toEqual([repoDir]);
    }),
  );
});
