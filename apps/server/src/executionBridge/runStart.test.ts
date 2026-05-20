import {
  EnvironmentId,
  type OrchestrationCommand,
  type TaskRuntimeMaterializeRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { GitManager } from "../git/GitManager.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  collectTaskPullRequestPreviewLinks,
  commitPushTaskRuntime,
  ExecutionBridgeRunRegistryLive,
  ensureTaskPullRequest,
  materializeTaskRuntime,
  sortTaskPullRequestPreviewLinks,
  taskRuntimeWorktreeCreateInput,
  toVercelBranchPreviewUrl,
} from "./runStart.ts";

describe("task pull request preview links", () => {
  it("uses public GitHub deployment status URLs and filters Vercel dashboard URLs", () => {
    const previews = collectTaskPullRequestPreviewLinks({
      deployments: [
        {
          id: 1,
          environment: "Preview - nextcard-web",
          creator: { login: "vercel[bot]" },
        },
        {
          id: 2,
          environment: "Preview - nextcard-mcp",
          creator: { login: "vercel[bot]" },
        },
      ],
      statusesByDeploymentId: new Map([
        [
          "1",
          [
            {
              state: "success",
              environment_url: "https://nextcard-abc123.nextcard.com",
              target_url: "https://vercel.com/affil/nextcard-web/build",
            },
          ],
        ],
        [
          "2",
          [
            {
              state: "success",
              environment_url: "https://vercel.com/affil/nextcard-mcp/build",
              target_url: "https://nextcard-mcp-abc123.nextcard.com",
            },
          ],
        ],
      ]),
    });

    expect(previews).toEqual([
      {
        provider: "vercel",
        environment: "Preview - nextcard-web",
        url: "https://nextcard-abc123.nextcard.com",
      },
      {
        provider: "vercel",
        environment: "Preview - nextcard-mcp",
        url: "https://nextcard-mcp-abc123.nextcard.com",
      },
    ]);
  });

  it("rewrites nextcard Vercel commit URLs to branch preview aliases", () => {
    expect(
      toVercelBranchPreviewUrl({
        url: "https://nextcard-c2pkvyk7n.nextcard.com",
        environment: "Preview – nextcard-web",
        branch: "t3code/pr-card-smoke",
      }),
    ).toBe("https://nextcard-web-git-t3code-pr-card-smoke.nextcard.com");
  });

  it("collects branch preview aliases for nextcard deployments", () => {
    const previews = collectTaskPullRequestPreviewLinks({
      headBranch: "t3code/pr-card-smoke",
      deployments: [
        {
          id: 1,
          environment: "Preview – nextcard-web",
          creator: { login: "vercel[bot]" },
        },
      ],
      statusesByDeploymentId: new Map([
        [
          "1",
          [
            {
              state: "success",
              environment_url: "https://nextcard-c2pkvyk7n.nextcard.com",
            },
          ],
        ],
      ]),
    });

    expect(previews[0]?.url).toBe("https://nextcard-web-git-t3code-pr-card-smoke.nextcard.com");
  });

  it("prefers the nextcard web preview when multiple deployments are available", () => {
    expect(
      sortTaskPullRequestPreviewLinks([
        {
          provider: "vercel",
          environment: "Preview - nextcard-pdp",
          url: "https://nextcard-pdp.example.com",
        },
        {
          provider: "vercel",
          environment: "Preview - nextcard-web",
          url: "https://nextcard-web.example.com",
        },
      ])[0]?.url,
    ).toBe("https://nextcard-web.example.com");
  });
});

describe("task runtime worktree creation", () => {
  it("requests an origin base refresh before materializing task worktrees", () => {
    expect(
      taskRuntimeWorktreeCreateInput(
        {
          project: {
            repoName: "nextcard",
            workspaceRoot: "C:\\Users\\Vivek\\Affil\\nextcard",
            defaultBranch: "dev",
          },
        },
        "t3code/fresh-base",
      ),
    ).toEqual({
      cwd: "C:\\Users\\Vivek\\Affil\\nextcard",
      refName: "dev",
      newRefName: "t3code/fresh-base",
      path: null,
      refreshBaseFromOrigin: true,
    });
  });

  it("runs the project setup script runner after materializing orchestrator task worktrees", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: {
          refName: "t3code/task-branch",
          path: "C:\\Users\\Vivek\\Affil\\nextcard-t3-worktree",
        },
      }),
    );
    const runForThread = vi.fn(() => Effect.succeed({ status: "no-script" as const }));
    const request = {
      taskId: "task-1",
      workSessionId: "session-1",
      initialPrompt: "fix it",
      project: {
        repoName: "nextcard",
        workspaceRoot: "C:\\Users\\Vivek\\Affil\\nextcard",
        defaultBranch: "dev",
      },
      title: "Fix it",
      runtimeMode: "full-access",
      interactionMode: "default",
      startCodingAgent: false,
    } satisfies TaskRuntimeMaterializeRequest;

    const layer = Layer.mergeAll(
      ExecutionBridgeRunRegistryLive,
      Layer.mock(ProjectionSnapshotQuery)({
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatchedCommands.push(command);
            return { sequence: dispatchedCommands.length };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
      }),
      Layer.mock(GitVcsDriver)({
        createWorktree,
      }),
      Layer.mock(ProjectSetupScriptRunner)({
        runForThread,
      }),
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-test")),
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("environment-test"),
          label: "Test environment",
          platform: {
            os: "windows",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          capabilities: {
            repositoryIdentity: true,
          },
        }),
      }),
      FileSystem.layerNoop({}),
      Path.layer,
      Layer.succeed(ServerConfig, {
        attachmentsDir: "C:\\Users\\Vivek\\Affil\\t3code\\.test-attachments",
      } as ServerConfigShape),
    );

    const response = await Effect.runPromise(
      materializeTaskRuntime(request).pipe(Effect.provide(layer)),
    );

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "project.create",
      "thread.create",
    ]);
    expect(runForThread).toHaveBeenCalledWith({
      threadId: response.t3ThreadId,
      projectId: response.t3ProjectId,
      projectCwd: "C:\\Users\\Vivek\\Affil\\nextcard",
      worktreePath: "C:\\Users\\Vivek\\Affil\\nextcard-t3-worktree",
    });
    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "C:\\Users\\Vivek\\Affil\\nextcard",
      refName: "dev",
      newRefName: expect.stringMatching(/^t3code\//),
      path: null,
      refreshBaseFromOrigin: true,
    });
  });
});

function makeSuccessfulRunStackedActionResult(action: "create_pr" | "commit_push_pr") {
  return {
    action,
    branch: { status: "skipped_not_requested" as const },
    commit:
      action === "commit_push_pr"
        ? {
            status: "created" as const,
            commitSha: "1234567890abcdef",
            subject: "Improve task flow",
          }
        : { status: "skipped_not_requested" as const },
    push: {
      status: "pushed" as const,
      branch: "t3code/task-branch",
      upstreamBranch: "origin/t3code/task-branch",
      setUpstream: true,
    },
    pr: {
      status: "created" as const,
      url: "https://github.com/acme/app/pull/42",
      number: 42,
      baseBranch: "main",
      headBranch: "t3code/task-branch",
      title: "Fix task",
    },
    toast: {
      title: "Created PR",
      cta: {
        kind: "open_pr" as const,
        label: "Open PR",
        url: "https://github.com/acme/app/pull/42",
      },
    },
  };
}

function ensureTaskPullRequestRequest() {
  return {
    taskId: "task-1",
    workSessionId: "session-1",
    branch: "t3code/task-branch",
    worktreePath: "C:\\Users\\Vivek\\Affil\\app-worktree",
    project: {
      githubOwner: "acme",
      githubRepo: "app",
      defaultBranch: "main",
    },
    title: "Fix task",
    idempotencyKey: "task-pr:task-1:session-1:t3code/task-branch",
  };
}

function makeNoopOrchestrationEngineLayer() {
  return Layer.mock(OrchestrationEngineService)({
    dispatch: () => Effect.succeed({ sequence: 1 }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
  });
}

describe("task pull request ensure", () => {
  function makeExecuteMock(aheadCount: number) {
    return vi.fn((input: { readonly args: readonly string[] }) => {
      if (input.args[0] === "rev-list") {
        return Effect.succeed({
          exitCode: 0,
          stdout: `${aheadCount}\n`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
      return Effect.succeed({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    });
  }

  function makeTaskPullRequestLayer(input: {
    readonly hasWorkingTreeChanges: boolean;
    readonly aheadCount: number;
    readonly runStackedAction: ReturnType<typeof vi.fn>;
  }) {
    return Layer.mergeAll(
      Layer.mock(GitVcsDriver)({
        statusDetails: () =>
          Effect.succeed({
            isRepo: true,
            hasOriginRemote: true,
            isDefaultBranch: false,
            branch: "t3code/task-branch",
            upstreamRef: null,
            hasWorkingTreeChanges: input.hasWorkingTreeChanges,
            workingTree: {
              files: input.hasWorkingTreeChanges
                ? [{ path: "src/app.ts", insertions: 4, deletions: 1 }]
                : [],
              insertions: input.hasWorkingTreeChanges ? 4 : 0,
              deletions: input.hasWorkingTreeChanges ? 1 : 0,
            },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: input.aheadCount,
          }),
        execute: makeExecuteMock(input.aheadCount) as any,
      }),
      Layer.mock(GitManager)({
        runStackedAction: input.runStackedAction as any,
      }),
      makeNoopOrchestrationEngineLayer(),
    );
  }

  it("uses T3's generated commit-message flow for dirty worktrees", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.succeed(makeSuccessfulRunStackedActionResult("commit_push_pr")),
    );

    const response = await Effect.runPromise(
      ensureTaskPullRequest(ensureTaskPullRequestRequest()).pipe(
        Effect.provide(
          makeTaskPullRequestLayer({
            hasWorkingTreeChanges: true,
            aheadCount: 0,
            runStackedAction,
          }),
        ),
      ),
    );

    expect(response.status).toBe("created");
    expect(runStackedAction).toHaveBeenCalledWith(
      {
        actionId: "task-pr:task-1:session-1:t3code/task-branch",
        cwd: "C:\\Users\\Vivek\\Affil\\app-worktree",
        action: "commit_push_pr",
        sourceControlRepository: "acme/app",
      },
      { draftPullRequest: true },
    );
  });

  it("uses T3's push and PR flow for clean local commits without an upstream", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.succeed(makeSuccessfulRunStackedActionResult("create_pr")),
    );

    const response = await Effect.runPromise(
      ensureTaskPullRequest(ensureTaskPullRequestRequest()).pipe(
        Effect.provide(
          makeTaskPullRequestLayer({
            hasWorkingTreeChanges: false,
            aheadCount: 1,
            runStackedAction,
          }),
        ),
      ),
    );

    expect(response.status).toBe("created");
    expect((response as any).pullRequest?.url).toBe("https://github.com/acme/app/pull/42");
    expect(runStackedAction).toHaveBeenCalledWith(
      {
        actionId: "task-pr:task-1:session-1:t3code/task-branch",
        cwd: "C:\\Users\\Vivek\\Affil\\app-worktree",
        action: "create_pr",
        sourceControlRepository: "acme/app",
      },
      { draftPullRequest: true },
    );
  });
});

describe("task runtime commit and push", () => {
  it("uses T3's commit/push workflow without supplying a commit message", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.succeed({
        action: "commit_push" as const,
        branch: { status: "skipped_not_requested" as const },
        commit: {
          status: "created" as const,
          commitSha: "1234567890abcdef",
          subject: "Improve billing chart",
        },
        push: {
          status: "pushed" as const,
          branch: "t3code/bilt-compare-chart-bug",
          upstreamBranch: "origin/t3code/bilt-compare-chart-bug",
          setUpstream: true,
        },
        pr: { status: "skipped_not_requested" as const },
        toast: {
          title: "Pushed 1234567",
          cta: { kind: "none" as const },
        },
      }),
    );

    const layer = Layer.mergeAll(
      Layer.mock(GitVcsDriver)({
        statusDetails: () =>
          Effect.succeed({
            isRepo: true,
            hasOriginRemote: true,
            isDefaultBranch: false,
            branch: "t3code/bilt-compare-chart-bug",
            upstreamRef: null,
            hasWorkingTreeChanges: true,
            workingTree: {
              files: [{ path: "src/chart.ts", insertions: 12, deletions: 2 }],
              insertions: 12,
              deletions: 2,
            },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          }),
      }),
      Layer.mock(GitWorkflowService)({
        runStackedAction: runStackedAction as any,
      }),
      makeNoopOrchestrationEngineLayer(),
    );

    const response = await Effect.runPromise(
      commitPushTaskRuntime({
        taskId: "task-1",
        workSessionId: "session-1",
        branch: "t3code/bilt-compare-chart-bug",
        worktreePath: "C:\\Users\\Vivek\\Affil\\app-worktree",
        idempotencyKey: "task-commit-push:task-1:session-1:t3code/bilt-compare-chart-bug",
      }).pipe(Effect.provide(layer)),
    );

    expect(response).toMatchObject({
      status: "pushed",
      commitSha: "1234567890abcdef",
      commitSubject: "Improve billing chart",
      branch: "t3code/bilt-compare-chart-bug",
      upstreamBranch: "origin/t3code/bilt-compare-chart-bug",
    });
    expect(runStackedAction).toHaveBeenCalledWith({
      actionId: "task-commit-push:task-1:session-1:t3code/bilt-compare-chart-bug",
      cwd: "C:\\Users\\Vivek\\Affil\\app-worktree",
      action: "commit_push",
    });
  });
});
