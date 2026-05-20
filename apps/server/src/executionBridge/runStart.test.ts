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
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  collectTaskPullRequestPreviewLinks,
  ExecutionBridgeRunRegistryLive,
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
