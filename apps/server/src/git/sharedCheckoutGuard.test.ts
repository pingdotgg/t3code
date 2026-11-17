import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import { assertCheckoutIdle, busyThreadsInCheckout } from "./sharedCheckoutGuard.ts";

const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");

const thread = (
  title: string,
  overrides: {
    readonly projectId?: ProjectId;
    readonly worktreePath?: string | null;
    readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null;
  } = {},
) => ({
  id: ThreadId.make(title),
  title,
  projectId: overrides.projectId ?? projectId,
  worktreePath: overrides.worktreePath ?? null,
  activityRunStatus:
    overrides.activityRunStatus === undefined ? "running" : overrides.activityRunStatus,
});

describe("busyThreadsInCheckout", () => {
  it("finds running local threads in the project root checkout", () => {
    const busy = busyThreadsInCheckout({
      cwd: "/repo",
      projectId,
      threads: [
        thread("local running"),
        thread("local idle", { activityRunStatus: null }),
        thread("worktree running", { worktreePath: "/worktrees/a" }),
        thread("other project", { projectId: otherProjectId }),
      ],
    });

    expect(busy.map(({ title }) => title)).toEqual(["local running"]);
  });

  it("finds running threads that share a worktree", () => {
    const busy = busyThreadsInCheckout({
      cwd: "/worktrees/a",
      projectId: null,
      threads: [
        thread("same worktree", { worktreePath: "/worktrees/a", activityRunStatus: "waiting" }),
        thread("other worktree", { worktreePath: "/worktrees/b" }),
        thread("local running"),
      ],
    });

    expect(busy.map(({ title }) => title)).toEqual(["same worktree"]);
  });
});

describe("assertCheckoutIdle", () => {
  const guardLayer = (input: {
    readonly repositoryRoot: string;
    readonly threads: ReadonlyArray<ReturnType<typeof thread>>;
    readonly failWorktreeLookup?: boolean;
  }) =>
    Layer.mergeAll(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        repositoryRoot: () => Effect.succeed(input.repositoryRoot),
      }),
      Layer.mock(ProjectService.ProjectService)({
        getByWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed(
            workspaceRoot === "/repo"
              ? Option.some({ id: projectId, workspaceRoot } as never)
              : Option.none(),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getShellSnapshot: (options) =>
          options?.worktreePath !== undefined && input.failWorktreeLookup
            ? Effect.fail("worktree lookup failed" as never)
            : Effect.succeed({
                threads: input.threads.filter(
                  (candidate) =>
                    (options?.projectId === undefined ||
                      candidate.projectId === options.projectId) &&
                    (options?.worktreePath === undefined ||
                      candidate.worktreePath === options.worktreePath),
                ),
              } as never),
      }),
    );

  it.effect("refuses a switch from a subdirectory of a busy checkout", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/repo/src").pipe(
        Effect.flip,
        Effect.provide(guardLayer({ repositoryRoot: "/repo", threads: [thread("local running")] })),
      );
      expect(error.detail).toContain("'local running'");
    }),
  );

  it.effect("keeps a busy thread when another lookup fails", () =>
    Effect.gen(function* () {
      const error = yield* assertCheckoutIdle("test", "/repo").pipe(
        Effect.flip,
        Effect.provide(
          guardLayer({
            repositoryRoot: "/repo",
            threads: [thread("local running")],
            failWorktreeLookup: true,
          }),
        ),
      );
      expect(error.detail).toContain("'local running'");
    }),
  );

  it.effect("allows a switch when no thread is working", () =>
    assertCheckoutIdle("test", "/repo").pipe(
      Effect.provide(
        guardLayer({
          repositoryRoot: "/repo",
          threads: [thread("local idle", { activityRunStatus: null })],
        }),
      ),
    ),
  );
});
