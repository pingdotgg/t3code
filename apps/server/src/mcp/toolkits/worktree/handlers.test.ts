import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VcsProcessExitError,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type VcsRepositoryIdentity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VcsDriverRegistry, type VcsDriverHandle } from "../../../vcs/VcsDriverRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { WorktreeToolkitHandlersLive } from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ROOT = "/workspace/project";
const LINKED_WORKTREE = "/workspace/project-worktrees/feature";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: PROJECT_ROOT,
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const thread: OrchestrationThreadShell = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const freshness: VcsRepositoryIdentity["freshness"] = {
  source: "live-local",
  observedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
  expiresAt: Option.none(),
};

/** Git reports the main checkout's common dir relative to it and a linked worktree's as absolute. */
const repositories: Record<string, VcsRepositoryIdentity> = {
  [PROJECT_ROOT]: { kind: "git", rootPath: PROJECT_ROOT, metadataPath: ".git", freshness },
  [LINKED_WORKTREE]: {
    kind: "git",
    rootPath: LINKED_WORKTREE,
    metadataPath: `${PROJECT_ROOT}/.git`,
    freshness,
  },
  "/workspace/other": {
    kind: "git",
    rootPath: "/workspace/other",
    metadataPath: ".git",
    freshness,
  },
};

const makeHarness = Effect.fn("makeWorktreeToolkitHarness")(function* (
  options: { readonly headBranch?: string | null; readonly headExitCode?: number } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const headBranch = options.headBranch === undefined ? "feature" : options.headBranch;
  // `git symbolic-ref --quiet` exits 1 for a detached HEAD and 128 for other failures.
  const headExitCode = options.headExitCode ?? (headBranch === null ? 1 : 0);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  const driver = {
    execute: () =>
      Effect.succeed({
        exitCode: headExitCode,
        stdout: headExitCode === 0 ? `${headBranch}\n` : "",
        stderr: headExitCode === 128 ? "fatal: not a git repository\n" : "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  } as unknown as VcsDriverHandle["driver"];
  const detect: VcsDriverRegistry["Service"]["detect"] = ({ cwd }) => {
    // A path inside a worktree resolves to that worktree, like git does.
    const root = Object.keys(repositories).find(
      (candidate) => cwd === candidate || cwd.startsWith(`${candidate}/`),
    );
    if (root === undefined) {
      return Effect.fail(
        new VcsProcessExitError({
          operation: "test",
          command: "git rev-parse",
          cwd,
          exitCode: 128,
          detail: "not a git repository",
        }),
      );
    }
    return Effect.succeed({ kind: "git", repository: repositories[root]!, driver });
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
      getProjectShellById: () => Effect.succeed(Option.some(project)),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(VcsDriverRegistry)({
      detect,
      resolve: () => Effect.die("resolve is not used by the worktree toolkit"),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    NodeServices.layer,
  );
  const toolkit = yield* WorktreeToolkit.pipe(
    Effect.provide(WorktreeToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = (
    params: { readonly path: string },
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["worktree"],
  ) =>
    toolkit.handle("t3_worktree_handoff", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<typeof WorktreeToolkit.tools.t3_worktree_handoff>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("worktree toolkit handlers", () => {
  it.effect("refuses a credential without the worktree capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ path: LINKED_WORKTREE }, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "worktree",
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("binds the thread to a linked worktree of the project repository", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({ path: `${LINKED_WORKTREE}/src` });
      expect(result).toEqual({
        worktreePath: LINKED_WORKTREE,
        branch: "feature",
        previousWorktreePath: null,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.meta.update",
          threadId: THREAD_ID,
          worktreePath: LINKED_WORKTREE,
          branch: "feature",
        },
      ]);
    }),
  );

  it.effect("records a detached HEAD as no branch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ headBranch: null });
      const result = yield* harness.call({ path: LINKED_WORKTREE });
      expect(result.branch).toBeNull();
      expect(yield* Ref.get(harness.commands)).toMatchObject([{ branch: null }]);
    }),
  );

  it.effect("fails without touching the thread when HEAD cannot be read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ headExitCode: 128 });
      const error = yield* harness.call({ path: LINKED_WORKTREE }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeHandoffFailedError" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect.each([
    { path: "relative/worktree", detail: "Pass the worktree's absolute path." },
    { path: "/workspace/missing", detail: "does not exist or is not inside a git worktree" },
    { path: "/workspace/other", detail: "is not a worktree of this thread's project repository" },
    { path: PROJECT_ROOT, detail: "That is the project's own checkout" },
  ])("rejects $path without touching the thread", ({ path, detail }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call({ path }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "WorktreeHandoffPathInvalidError" });
      expect(error.message).toContain(detail);
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );
});
