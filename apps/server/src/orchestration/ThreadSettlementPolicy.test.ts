import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointRef,
  EventId,
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  type SettlementPullRequest,
  resolveAutoSettlementAt,
  verificationAllowsAutoSettlement,
} from "./ThreadSettlementPolicy.ts";

const NOW = "2026-08-28T12:00:00.000Z";
const makeThread = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: "feature",
  worktreePath: "/repo",
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
  ...overrides,
});

const decide = (
  thread: OrchestrationThreadShell,
  pullRequest: SettlementPullRequest | null = null,
  settings: { days?: number | null; merge?: boolean } = {},
) =>
  resolveAutoSettlementAt({
    thread,
    pullRequest,
    now: NOW,
    autoSettleAfterDays: settings.days === undefined ? 3 : settings.days,
    autoSettleOnMerge: settings.merge ?? true,
  }) !== null;

function toolActivity(input: {
  readonly id: string;
  readonly createdAt: string;
  readonly itemType: "command_execution" | "file_change";
  readonly status: "completed" | "failed";
  readonly detail?: string;
  readonly data?: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(input.id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload: {
      itemType: input.itemType,
      status: input.status,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.data === undefined ? {} : { data: input.data }),
    },
    turnId: TurnId.make("turn-1"),
    createdAt: input.createdAt,
  };
}

function checkpoint(files: ReadonlyArray<string>): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make("turn-1"),
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-1/turn/1"),
    status: "ready",
    files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
    assistantMessageId: null,
    completedAt: "2026-08-28T11:04:00.000Z",
  };
}

describe("verificationAllowsAutoSettlement", () => {
  const mutation = toolActivity({
    id: "mutation",
    createdAt: "2026-08-28T11:00:00.000Z",
    itemType: "file_change",
    status: "completed",
  });

  it("accepts a recognized successful verification after a successful mutation", () => {
    const verification = toolActivity({
      id: "verification",
      createdAt: "2026-08-28T11:01:00.000Z",
      itemType: "command_execution",
      status: "completed",
      detail:
        "/bin/bash -lc 'vp test run apps/server/src/orchestration/ThreadSettlementPolicy.test.ts'",
    });

    expect(
      verificationAllowsAutoSettlement({
        activities: [mutation, verification],
        checkpoints: [checkpoint(["apps/server/src/orchestration/ThreadSettlementPolicy.ts"])],
      }),
    ).toBe(true);
  });

  it("recognizes projected provider command data and package-manager vp execution", () => {
    const verification = toolActivity({
      id: "verification",
      createdAt: "2026-08-28T11:01:00.000Z",
      itemType: "command_execution",
      status: "completed",
      detail: "tests passed",
      data: { command: "corepack pnpm exec vp test run apps/server/src/example.test.ts" },
    });

    expect(
      verificationAllowsAutoSettlement({
        activities: [mutation, verification],
        checkpoints: [checkpoint(["apps/server/src/example.ts"])],
      }),
    ).toBe(true);
  });

  it("rejects output that resembles verification and compound shell commands", () => {
    const outputOnly = toolActivity({
      id: "output-only",
      createdAt: "2026-08-28T11:01:00.000Z",
      itemType: "command_execution",
      status: "completed",
      detail: "tests passed",
      data: { rawOutput: { content: "vp test run" } },
    });
    const compound = toolActivity({
      id: "compound",
      createdAt: "2026-08-28T11:02:00.000Z",
      itemType: "command_execution",
      status: "completed",
      data: { command: "vp test run || true" },
    });

    expect(
      verificationAllowsAutoSettlement({
        activities: [mutation, outputOnly, compound],
        checkpoints: [checkpoint(["apps/server/src/example.ts"])],
      }),
    ).toBe(false);
  });

  it("rejects verification that predates the latest successful mutation", () => {
    const staleVerification = toolActivity({
      id: "stale-verification",
      createdAt: "2026-08-28T10:59:00.000Z",
      itemType: "command_execution",
      status: "completed",
      detail: "vp test run apps/server/src/orchestration/ThreadSettlementPolicy.test.ts",
    });

    expect(
      verificationAllowsAutoSettlement({
        activities: [staleVerification, mutation],
        checkpoints: [checkpoint(["apps/server/src/orchestration/ThreadSettlementPolicy.ts"])],
      }),
    ).toBe(false);
  });

  it("does not recognize a failed verification command", () => {
    const failedVerification = toolActivity({
      id: "failed-verification",
      createdAt: "2026-08-28T11:01:00.000Z",
      itemType: "command_execution",
      status: "failed",
      detail: "vp test run apps/server/src/orchestration/ThreadSettlementPolicy.test.ts",
    });

    expect(
      verificationAllowsAutoSettlement({
        activities: [mutation, failedVerification],
        checkpoints: [checkpoint(["apps/server/src/orchestration/ThreadSettlementPolicy.ts"])],
      }),
    ).toBe(false);
  });

  it("allows threads with no mutation evidence and blocks uninspectable changed checkpoints", () => {
    expect(
      verificationAllowsAutoSettlement({ activities: [], checkpoints: [checkpoint([])] }),
    ).toBe(true);
    expect(
      verificationAllowsAutoSettlement({
        activities: [],
        checkpoints: [checkpoint(["apps/server/src/orchestration/ThreadSettlementPolicy.ts"])],
      }),
    ).toBe(false);
  });
});

describe("resolveAutoSettlementAt", () => {
  it("returns the last activity time for persisted settlement", () => {
    expect(
      resolveAutoSettlementAt({
        thread: makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-terminal"),
            state: "completed",
            requestedAt: "2026-08-19T00:00:00.000Z",
            startedAt: "2026-08-19T00:01:00.000Z",
            completedAt: "2026-08-21T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
        pullRequest: null,
        now: NOW,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: true,
      }),
    ).toBe("2026-08-21T00:00:00.000Z");
  });

  it("uses creation time for PR settlement when the thread has no activity", () => {
    expect(
      resolveAutoSettlementAt({
        thread: makeThread({
          latestUserMessageAt: null,
          latestTurn: null,
          updatedAt: "2026-08-27T00:00:00.000Z",
        }),
        pullRequest: { state: "closed", closedAt: NOW },
        now: NOW,
        autoSettleAfterDays: null,
        autoSettleOnMerge: true,
      }),
    ).toBe("2026-08-01T00:00:00.000Z");
  });

  it("settles inactive threads and leaves never-used threads active", () => {
    expect(decide(makeThread())).toBe(true);
    expect(decide(makeThread({ latestUserMessageAt: null }))).toBe(false);
    expect(decide(makeThread(), null, { days: null })).toBe(false);
  });

  it("keeps a thread active at the exact inactivity boundary", () => {
    expect(decide(makeThread({ latestUserMessageAt: "2026-08-25T12:00:00.000Z" }))).toBe(false);
  });

  it("settles inactive threads with open pull requests", () => {
    expect(decide(makeThread(), { state: "open", updatedAt: NOW })).toBe(true);
  });

  it("settles closed requests and honors the merge setting", () => {
    expect(decide(makeThread(), { state: "closed", closedAt: NOW }, { merge: false })).toBe(true);
    expect(decide(makeThread(), { state: "merged", mergedAt: NOW }, { merge: false })).toBe(true);
    expect(
      decide(makeThread(), { state: "merged", mergedAt: NOW }, { merge: false, days: null }),
    ).toBe(false);
  });

  it("does not settle again after user activity newer than the PR", () => {
    expect(
      decide(
        makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }),
        { state: "merged", mergedAt: "2026-08-26T00:00:00.000Z" },
        { days: null },
      ),
    ).toBe(false);
  });

  it.each(["closed", "merged"] as const)(
    "ignores metadata edits after resumed work for %s requests",
    (state) => {
      expect(
        decide(
          makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }),
          {
            state,
            closedAt: "2026-08-26T00:00:00.000Z",
            mergedAt: "2026-08-26T00:00:00.000Z",
            updatedAt: NOW,
          },
          { days: null },
        ),
      ).toBe(false);
      expect(decide(makeThread(), { state, updatedAt: NOW }, { days: null })).toBe(false);
    },
  );

  it("does not inherit a terminal pull request older than the thread", () => {
    expect(
      decide(
        makeThread({ createdAt: "2026-08-20T00:00:00.000Z", latestUserMessageAt: null }),
        { state: "closed", closedAt: "2026-08-19T00:00:00.000Z" },
        { days: null },
      ),
    ).toBe(false);
  });

  it("requires a comparable PR timestamp for immediate settlement", () => {
    const recentThread = makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" });
    expect(decide(recentThread, { state: "closed", closedAt: null })).toBe(false);
    expect(decide(recentThread, { state: "merged", mergedAt: "unknown" })).toBe(false);
    expect(decide(makeThread(), { state: "closed", closedAt: null })).toBe(true);
  });

  it("uses user request time instead of completion time as the PR anchor", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-25T00:00:00.000Z",
        startedAt: "2026-08-25T00:01:00.000Z",
        completedAt: "2026-08-27T00:00:00.000Z",
        assistantMessageId: null,
      },
    });
    expect(decide(thread, { state: "merged", mergedAt: "2026-08-26T00:00:00.000Z" })).toBe(true);
  });

  it("blocks pins, snooze, pending work, live sessions, and queued starts", () => {
    expect(decide(makeThread({ settledOverride: "active" }))).toBe(false);
    expect(decide(makeThread({ snoozedUntil: "2026-08-29T00:00:00.000Z" }))).toBe(false);
    expect(decide(makeThread({ hasPendingApprovals: true }))).toBe(false);
    expect(decide(makeThread({ hasPendingUserInput: true }))).toBe(false);
    expect(decide(makeThread({ backgroundLiveness: "working" }))).toBe(false);
    expect(decide(makeThread({ backgroundLiveness: "monitoring" }))).toBe(false);
    expect(
      decide(
        makeThread({
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            updatedAt: NOW,
          },
        }),
      ),
    ).toBe(false);
    expect(
      decide(makeThread({ latestUserMessageAt: "2026-08-28T11:59:00.000Z", latestTurn: null })),
    ).toBe(false);
  });

  it("allows a fresh completion to wake snooze before settlement", () => {
    expect(
      decide(
        makeThread({
          snoozedAt: "2026-08-19T00:00:00.000Z",
          snoozedUntil: "2026-08-29T00:00:00.000Z",
          latestTurn: {
            turnId: TurnId.make("turn-woke"),
            state: "completed",
            requestedAt: "2026-08-18T00:00:00.000Z",
            startedAt: "2026-08-18T00:01:00.000Z",
            completedAt: "2026-08-20T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
      ),
    ).toBe(true);
  });
});

function linkedRequest(
  number: number,
  snapshot: ThreadPullRequestLink["snapshot"],
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "org/repo",
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    source: "manual",
    linkedAt: NOW,
    stack: null,
    snapshot,
  };
}

const terminalSnapshot = (
  state: "closed" | "merged",
  terminalAt: string,
  updatedAt = terminalAt,
) => ({
  state,
  title: "Change",
  headBranch: "feature",
  baseBranch: "main",
  isDraft: false,
  closedAt: terminalAt,
  mergedAt: state === "merged" ? terminalAt : null,
  updatedAt,
  syncedAt: NOW,
});

describe("linked request settlement", () => {
  it.each(["closed", "merged"] as const)(
    "uses the latest actual %s transition despite later comments on another PR",
    (state) => {
      const old = linkedRequest(1, terminalSnapshot(state, "2026-08-19T00:00:00.000Z", NOW));
      const recent = linkedRequest(2, terminalSnapshot(state, "2026-08-21T00:00:00.000Z"));
      expect(decide(makeThread({ pullRequests: [old, recent] }), null, { days: null })).toBe(true);
      expect(decide(makeThread({ pullRequests: [recent, old] }), null, { days: null })).toBe(true);
      expect(decide(makeThread({ pullRequests: [old] }), null, { days: null })).toBe(false);
    },
  );

  it("keeps unknown and open links active even after the inactivity window", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    const unknown = linkedRequest(2, null);
    const open = linkedRequest(3, {
      ...terminalSnapshot("closed", NOW),
      state: "open",
      closedAt: null,
    });
    expect(decide(makeThread({ pullRequests: [merged, unknown] }))).toBe(false);
    expect(decide(makeThread({ pullRequests: [merged, open] }))).toBe(false);
    expect(
      decide(makeThread({ pullRequests: [merged, { ...unknown, source: "stack-dismissed" }] })),
    ).toBe(true);
  });

  it("honors merge settings and ignores missing terminal timestamps", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    expect(decide(makeThread({ pullRequests: [merged] }), null, { days: null, merge: false })).toBe(
      false,
    );
    const missing = linkedRequest(2, { ...terminalSnapshot("merged", NOW), mergedAt: null });
    expect(decide(makeThread({ pullRequests: [missing] }), null, { days: null })).toBe(false);
    expect(decide(makeThread({ pullRequests: [missing, merged] }), null, { days: null })).toBe(
      true,
    );
  });
});
