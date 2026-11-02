import {
  EnvironmentId,
  type Project as ProjectRecord,
  ProviderInstanceId,
  ThreadId,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as GitWorkflow from "../../../git/GitWorkflowService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as WorktreeHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const CALLER_ID = ThreadId.make("thread-caller");
const TARGET_ID = ThreadId.make("thread-target");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: CALLER_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree"]),
  issuedAt: 1,
};

const listWorktreeRefs = Effect.fn("listWorktreeRefs")(function* (worktreePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-worktree-list-" });
  const target = { ...McpToolAccessTestkit.liveThreadShell(TARGET_ID), worktreePath };
  const project = { workspaceRoot } as ProjectRecord;
  // Git reports a missing cwd as "not a repository" rather than failing.
  const listRefs = (input: { readonly cwd: string }) =>
    fileSystem.exists(input.cwd).pipe(
      Effect.orDie,
      Effect.map((exists): VcsListRefsResult => ({
        refs: exists ? [{ name: "main", current: true, isDefault: true, worktreePath: null }] : [],
        isRepo: exists,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: exists ? 1 : 0,
      })),
    );
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === TARGET_ID ? target : McpToolAccessTestkit.liveThreadShell(threadId),
        ),
      getProjectThreadRecords: () =>
        Effect.succeed(McpToolAccessTestkit.idleThreadProjection(target)),
    }),
    Layer.mock(Project.ProjectService)({ getById: () => Effect.succeedSome(project) }),
    Layer.mock(GitWorkflow.GitWorkflowService)({ listRefs }),
    NodeServices.layer,
  );
  const toolkit = yield* WorktreeToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  return yield* toolkit.handle("t3_worktree_list", { threadId: TARGET_ID }).pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map(
      (chunk) =>
        chunk.at(-1)!.result as Tool.Success<(typeof WorktreeToolkit.tools)["t3_worktree_list"]>,
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provide(layerDependencies),
  );
});

describe("worktree toolkit handlers", () => {
  it.effect("lists a thread's refs from the project root once its worktree was removed", () =>
    Effect.gen(function* () {
      const result = yield* listWorktreeRefs("/nonexistent/t3-removed-worktree");
      expect(result).toMatchObject({ isRepo: true, refs: [{ name: "main" }] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
