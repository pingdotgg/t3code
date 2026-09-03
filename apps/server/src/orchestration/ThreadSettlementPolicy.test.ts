import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  ProjectId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { resolveAutoSettlementAt } from "./ThreadSettlementPolicy.ts";

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
  pullRequest: { state: "open" | "closed" | "merged"; updatedAt: string | null } | null = null,
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
        pullRequest: { state: "closed", updatedAt: NOW },
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

  it("keeps open pull requests active", () => {
    expect(decide(makeThread(), { state: "open", updatedAt: NOW })).toBe(false);
  });

  it("settles closed requests and honors the merge setting", () => {
    expect(decide(makeThread(), { state: "closed", updatedAt: NOW }, { merge: false })).toBe(true);
    expect(decide(makeThread(), { state: "merged", updatedAt: NOW }, { merge: false })).toBe(true);
    expect(
      decide(makeThread(), { state: "merged", updatedAt: NOW }, { merge: false, days: null }),
    ).toBe(false);
  });

  it("does not settle again after user activity newer than the PR", () => {
    expect(
      decide(
        makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" }),
        { state: "merged", updatedAt: "2026-08-26T00:00:00.000Z" },
        { days: null },
      ),
    ).toBe(false);
  });

  it("does not inherit a terminal pull request older than the thread", () => {
    expect(
      decide(
        makeThread({ createdAt: "2026-08-20T00:00:00.000Z", latestUserMessageAt: null }),
        { state: "closed", updatedAt: "2026-08-19T00:00:00.000Z" },
        { days: null },
      ),
    ).toBe(false);
  });

  it("requires a comparable PR timestamp for immediate settlement", () => {
    const recentThread = makeThread({ latestUserMessageAt: "2026-08-27T00:00:00.000Z" });
    expect(decide(recentThread, { state: "closed", updatedAt: null })).toBe(false);
    expect(decide(recentThread, { state: "merged", updatedAt: "unknown" })).toBe(false);
    expect(decide(makeThread(), { state: "closed", updatedAt: null })).toBe(true);
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
    expect(decide(thread, { state: "merged", updatedAt: "2026-08-26T00:00:00.000Z" })).toBe(true);
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
