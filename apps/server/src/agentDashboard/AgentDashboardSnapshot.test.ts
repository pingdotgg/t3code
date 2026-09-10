import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationReadModel,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";

import {
  AgentDashboardSnapshotReadError,
  loadAgentDashboardSnapshot,
} from "./AgentDashboardSnapshot.ts";

const projectId = ProjectId.make("project-1");
const rootThreadId = ThreadId.make("thread-root");
const worktreeThreadId = ThreadId.make("thread-worktree");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const shellSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 7,
  updatedAt: "2026-08-09T12:00:00.000Z",
  projects: [
    {
      id: projectId,
      title: "Known project",
      workspaceRoot: "/repo",
      repositoryIdentity: {
        canonicalKey: "github.com/acme/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/repo.git",
        },
        rootPath: "/repo",
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-09T11:00:00.000Z",
      updatedAt: "2026-08-09T11:00:00.000Z",
    },
  ],
  threads: [
    {
      id: rootThreadId,
      projectId,
      title: "Root thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-09T11:01:00.000Z",
      updatedAt: "2026-08-09T11:02:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      pullRequests: [],
    },
    {
      id: worktreeThreadId,
      projectId,
      title: "Worktree thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/dashboard",
      worktreePath: "/repo-worktree",
      latestTurn: null,
      createdAt: "2026-08-09T11:03:00.000Z",
      updatedAt: "2026-08-09T11:04:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: {
        threadId: worktreeThreadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: TurnId.make("turn-1"),
        lastError: null,
        updatedAt: "2026-08-09T11:04:00.000Z",
      },
      latestUserMessageAt: "2026-08-09T11:04:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      pullRequests: [],
    },
  ],
};

const rootStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/dashboard",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "apps/server/src/ws.ts", insertions: 4, deletions: 1 }],
    insertions: 4,
    deletions: 1,
  },
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 1,
  aheadOfDefaultCount: 2,
  pr: null,
};

const refs: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      isRemote: false,
      current: false,
      isDefault: true,
      worktreePath: null,
    },
  ],
  worktrees: [
    { path: "/repo", refName: "main", isMain: true },
    { path: "/repo-worktree", refName: "feature/dashboard", isMain: false },
    { path: "/repo-detached", refName: null, isMain: false },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

const dashboardShellSnapshot: OrchestrationShellSnapshot = {
  ...shellSnapshot,
  threads: shellSnapshot.threads.map((thread) =>
    thread.id === rootThreadId
      ? {
          ...thread,
          latestTurn: {
            turnId: TurnId.make("turn-completed"),
            state: "completed" as const,
            requestedAt: "2026-08-09T11:05:00.000Z",
            startedAt: "2026-08-09T11:05:01.000Z",
            completedAt: "2026-08-09T11:05:10.000Z",
            assistantMessageId: null,
          },
          hasActionableProposedPlan: true,
        }
      : {
          ...thread,
          hasPendingApprovals: true,
        },
  ),
};

const projectedReadModel: OrchestrationReadModel = {
  snapshotSequence: dashboardShellSnapshot.snapshotSequence,
  updatedAt: dashboardShellSnapshot.updatedAt,
  projects: dashboardShellSnapshot.projects.map((project) => ({
    ...project,
    deletedAt: null,
  })),
  threads: dashboardShellSnapshot.threads.map((thread) => ({
    ...thread,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities:
      thread.id === rootThreadId
        ? [
            {
              id: EventId.make("event-old"),
              tone: "info" as const,
              kind: "research.started",
              summary: "Started research",
              payload: {},
              turnId: null,
              createdAt: "2026-08-09T11:04:00.000Z",
            },
            {
              id: EventId.make("event-new"),
              tone: "tool" as const,
              kind: "tool.completed",
              summary: "Completed repository scan",
              payload: {},
              turnId: null,
              createdAt: "2026-08-09T11:05:20.000Z",
            },
          ]
        : [],
    checkpoints: [],
  })),
};

it.effect("builds one project card and nests projected worktrees", () => {
  const statusCwds: Array<string> = [];
  const refCwds: Array<string> = [];

  return Effect.gen(function* () {
    const snapshot = yield* loadAgentDashboardSnapshot({
      shellSnapshot,
      observedAt: "2026-08-09T12:00:01.000Z",
      readers: {
        readStatus: (cwd) =>
          Effect.sync(() => {
            statusCwds.push(cwd);
            return rootStatus;
          }),
        listRefs: (input) =>
          Effect.sync(() => {
            refCwds.push(input.cwd);
            return refs;
          }),
      },
    });

    const repository = snapshot.repositories[0];
    assert.deepStrictEqual(statusCwds, ["/repo"]);
    assert.deepStrictEqual(refCwds, ["/repo"]);
    assert.equal(repository?.vcs.state, "dirty");
    assert.equal(repository?.vcs.defaultBranch, "main");
    assert.equal(repository?.vcs.behindCount, 1);
    assert.equal(repository?.threads.length, 1);
    assert.equal(repository?.worktrees.length, 2);
    const linkedWorktree = repository?.worktrees.find(
      (worktree) => worktree.path === "/repo-worktree",
    );
    const detachedWorktree = repository?.worktrees.find(
      (worktree) => worktree.path === "/repo-detached",
    );
    assert.equal(linkedWorktree?.threads[0]?.agent?.providerName, "codex");
    assert.equal(detachedWorktree?.branch, null);
    assert.deepStrictEqual(detachedWorktree?.threads, []);
  });
});

it.effect("returns unavailable VCS state without scanning unprojected paths", () =>
  Effect.gen(function* () {
    const snapshot = yield* loadAgentDashboardSnapshot({
      shellSnapshot,
      observedAt: "2026-08-09T12:00:01.000Z",
      readers: {
        readStatus: () =>
          Effect.fail(
            new AgentDashboardSnapshotReadError({
              operation: "test.readStatus",
              message: "status unavailable",
            }),
          ),
        listRefs: () =>
          Effect.fail(
            new AgentDashboardSnapshotReadError({
              operation: "test.listRefs",
              message: "refs unavailable",
            }),
          ),
      },
    });

    assert.equal(snapshot.repositories[0]?.vcs.availability, "unavailable");
    assert.equal(snapshot.repositories[0]?.vcs.state, "unknown");
    assert.deepStrictEqual(snapshot.repositories[0]?.worktrees, []);
  }),
);

it.effect("derives feed and repository research without navigation suggestions", () =>
  Effect.gen(function* () {
    const snapshot = yield* loadAgentDashboardSnapshot({
      shellSnapshot: dashboardShellSnapshot,
      activities: projectedReadModel.threads.flatMap((thread) =>
        thread.activities.map((activity) => ({ ...activity, threadId: thread.id })),
      ),
      observedAt: "2026-08-09T12:00:01.000Z",
      readers: {
        readStatus: () => Effect.succeed(rootStatus),
        listRefs: () => Effect.succeed(refs),
      },
    });

    assert.equal(snapshot.feed[0]?.id, "activity:event-new");
    assert.equal(snapshot.feed[0]?.thread?.threadId, "thread-root");
    assert.equal(snapshot.feed[0]?.status, "running");
    assert.equal(snapshot.research[0]?.id, "repository:project-1");
    assert.equal(snapshot.research[0]?.status, "dirty");
    assert.equal(snapshot.research[0]?.activeThreadCount, 1);
    assert.equal(snapshot.research[0]?.latestThread?.threadId, "thread-worktree");
    assert.deepStrictEqual(snapshot.suggestions, []);
  }),
);
