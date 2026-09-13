import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  TaskId,
  type OrchestrationTaskShell,
  type OrchestrationThreadShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  type SettlementPullRequest,
  resolveAutoSettlementAt,
  resolveTaskAutoSettlementAt,
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

const makeTask = (overrides: Partial<OrchestrationTaskShell> = {}): OrchestrationTaskShell => ({
  id: TaskId.make("task-1"),
  name: "Task",
  description: null,
  primaryProjectId: ProjectId.make("project-1"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  ...overrides,
});

const decideTask = (
  task = makeTask(),
  members: ReadonlyArray<OrchestrationThreadShell> = [],
  days: number | null = 3,
) =>
  resolveTaskAutoSettlementAt({
    task,
    members,
    settings: { sidebarAutoSettleAfterDays: days },
    nowMs: Date.parse(NOW),
  });

describe("resolveTaskAutoSettlementAt", () => {
  it("settles empty inactive tasks including pinned tasks", () => {
    expect(decideTask()).toBe("2026-08-20T00:00:00.000Z");
    expect(decideTask(makeTask({ pinnedAt: "2026-08-20T00:00:00.000Z" }))).not.toBeNull();
  });
  it("honors the inactivity setting and strict boundary", () => {
    expect(decideTask(makeTask(), [], null)).toBeNull();
    expect(decideTask(makeTask({ updatedAt: "2026-08-25T12:00:00.000Z" }))).toBeNull();
    expect(decideTask(makeTask(), [], 10)).toBeNull();
  });
  it.each([
    { archivedAt: NOW },
    { settledOverride: "active" as const },
    { settledOverride: "settled" as const },
    { snoozedUntil: "2026-08-29T12:00:00.000Z" },
  ])("preserves lifecycle protection %j", (overrides) => {
    expect(decideTask(makeTask(overrides))).toBeNull();
  });
  it("keeps a task live until every visible member is parked", () => {
    const settled = makeThread({
      settledOverride: "settled",
      settledAt: "2026-08-21T00:00:00.000Z",
    });
    expect(decideTask(makeTask(), [settled])).toBe("2026-08-21T00:00:00.000Z");
    expect(decideTask(makeTask(), [settled, makeThread()])).toBeNull();
    expect(decideTask(makeTask(), [settled, makeThread({ archivedAt: NOW })])).not.toBeNull();
  });
  it("starts a full window when the last old member is newly snoozed", () => {
    const member = makeThread({
      snoozedAt: "2026-08-27T12:00:00.000Z",
      snoozedUntil: "2026-09-01T00:00:00.000Z",
    });
    expect(decideTask(makeTask(), [member])).toBeNull();
    expect(decideTask(makeTask(), [{ ...member, snoozedAt: "2026-08-22T12:00:00.000Z" }])).toBe(
      "2026-08-22T12:00:00.000Z",
    );
  });
  it("allows a running snoozed member without applying manual settle guards", () => {
    const member = makeThread({
      snoozedAt: "2026-08-22T12:00:00.000Z",
      snoozedUntil: "2026-09-01T00:00:00.000Z",
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
    });
    expect(decideTask(makeTask(), [member])).not.toBeNull();
    expect(decideTask(makeTask(), [{ ...member, snoozedUntil: NOW }])).toBeNull();
    expect(
      decideTask(makeTask(), [{ ...member, settledOverride: "settled", snoozedUntil: null }]),
    ).toBeNull();
    expect(decideTask(makeTask(), [{ ...member, settledOverride: "settled" }])).not.toBeNull();
  });
  it("keeps a settled member with background work live", () => {
    expect(
      decideTask(makeTask(), [
        makeThread({ settledOverride: "settled", backgroundLiveness: "working" }),
      ]),
    ).toBeNull();
  });

  it("treats pending requests and queued starts as live despite persisted parking", () => {
    const member = makeThread({ settledOverride: "settled" });
    expect(decideTask(makeTask(), [{ ...member, hasPendingApprovals: true }])).toBeNull();
    expect(decideTask(makeTask(), [{ ...member, hasPendingUserInput: true }])).toBeNull();
    expect(decideTask(makeTask(), [{ ...member, latestUserMessageAt: NOW }])).toBeNull();
  });
  it("treats fresh completion during snooze as live", () => {
    expect(
      decideTask(makeTask(), [
        makeThread({
          snoozedAt: "2026-08-21T00:00:00.000Z",
          snoozedUntil: "2026-09-01T00:00:00.000Z",
          latestTurn: {
            turnId: TurnId.make("completed"),
            state: "completed",
            requestedAt: "2026-08-20T00:00:00.000Z",
            startedAt: "2026-08-20T00:00:00.000Z",
            completedAt: "2026-08-22T00:00:00.000Z",
            assistantMessageId: null,
          },
        }),
      ]),
    ).toBeNull();
  });
});
