import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  type OrchestrationThreadShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { type SettlementPullRequest, resolveAutoSettlementAt } from "./ThreadSettlementPolicy.ts";

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
  settings: { days?: number | null; merge?: boolean; scope?: "all" | "without-pr" } = {},
) =>
  resolveAutoSettlementAt({
    thread,
    pullRequest,
    now: NOW,
    autoSettleAfterDays: settings.days === undefined ? 3 : settings.days,
    autoSettleOnMerge: settings.merge ?? true,
    autoSettleScope: settings.scope ?? "all",
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

  it.each(["linkedPullRequest", "branchPullRequest"] as const)(
    "excludes %s from inactivity regardless of PR state",
    (link) => {
      const settings = { scope: "without-pr" as const, merge: false };
      const thread = makeThread({
        [link]: {
          projectId: ProjectId.make("project-1"),
          repository: "owner/repo",
          number: 1,
          url: "https://example.test/owner/repo/pull/1",
        },
      });
      expect(decide(thread, null, settings)).toBe(false);
      expect(decide(thread, { state: "open" }, settings)).toBe(false);
      expect(decide(thread, { state: "merged", mergedAt: NOW }, settings)).toBe(false);
      expect(decide(thread, { state: "closed", closedAt: NOW }, settings)).toBe(true);
      expect(
        decide(
          thread,
          { state: "merged", mergedAt: NOW },
          { ...settings, merge: true, days: null },
        ),
      ).toBe(true);
      expect(decide(makeThread(), null, settings)).toBe(true);
      expect(decide(makeThread(), null, { ...settings, days: null })).toBe(false);
      expect(decide(thread, null, { ...settings, scope: "all" })).toBe(true);
    },
  );

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
  });

  it("never settles a thread whose auto-settle is turned off, by inactivity or merge", () => {
    const held = makeThread({ autoSettleDisabledAt: "2026-08-21T00:00:00.000Z" });
    expect(decide(held)).toBe(false);
    expect(
      decide(held, { state: "merged", mergedAt: "2026-08-21T00:00:00.000Z", closedAt: null }),
    ).toBe(false);
    expect(decide(makeThread({ autoSettleDisabledAt: null }))).toBe(true);
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

describe("per-thread auto-settle opt out", () => {
  it("blocks both inactivity and merge settlement while auto-settle is off", () => {
    const merged = linkedRequest(1, terminalSnapshot("merged", NOW));
    expect(decide(makeThread({ latestUserMessageAt: "2026-08-01T00:00:00.000Z" }))).toBe(true);
    expect(decide(makeThread({ pullRequests: [merged] }), null, { days: null })).toBe(true);
    const held = { autoSettleDisabledAt: NOW };
    expect(decide(makeThread({ ...held, latestUserMessageAt: "2026-08-01T00:00:00.000Z" }))).toBe(
      false,
    );
    expect(decide(makeThread({ ...held, pullRequests: [merged] }), null, { days: null })).toBe(
      false,
    );
  });
});

describe("PR-link inactivity scope", () => {
  it.each(["manual", "created", "agent", "stack"] as const)(
    "excludes %s links even when their PR is already closed",
    (source) => {
      const link = {
        ...linkedRequest(1, terminalSnapshot("closed", "2026-08-01T00:00:00.000Z")),
        source,
      };
      const thread = makeThread({ pullRequests: [link] });
      expect(decide(thread, null, { scope: "without-pr" })).toBe(false);
      expect(decide(thread, null, { scope: "all" })).toBe(true);
    },
  );

  it("ignores dismissed stack links but still checks the saved branch PR", () => {
    const thread = makeThread({
      pullRequests: [{ ...linkedRequest(1, null), source: "stack-dismissed" }],
    });
    expect(decide(thread, null, { scope: "without-pr" })).toBe(true);
    expect(
      decide(
        {
          ...thread,
          branchPullRequest: {
            projectId: thread.projectId,
            repository: "org/repo",
            number: 2,
            url: "https://github.com/org/repo/pull/2",
          },
        },
        null,
        { scope: "without-pr" },
      ),
    ).toBe(false);
  });
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
