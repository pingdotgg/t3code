import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationLatestTurn } from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DEFAULT_RUNTIME_MODE } from "../types";
import {
  classifyThreadForSidebarV3,
  isThreadWoke,
  resolveActivityTimestampMs,
  sortAttentionThreadsForSidebarV3,
  sortThreadsForSidebarV3,
  type SidebarV3AttentionKind,
} from "./SidebarV3.logic";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
  requestedAt?: string;
}): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: overrides?.requestedAt ?? "2026-03-09T10:00:00.000Z",
    startedAt:
      overrides?.startedAt !== undefined ? overrides.startedAt : "2026-03-09T10:00:00.000Z",
    completedAt:
      overrides?.completedAt !== undefined ? overrides.completedAt : "2026-03-09T10:05:00.000Z",
  };
}

const runningSession = {
  threadId: ThreadId.make("thread-1"),
  status: "running" as const,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: DEFAULT_RUNTIME_MODE,
  activeTurnId: "turn-1" as never,
  lastError: null,
  updatedAt: "2026-03-09T10:00:00.000Z",
};

const idleThread = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestTurn: null,
  session: null,
};

const noContext = { lastVisitedAt: undefined, wokeAt: null };

describe("isThreadWoke", () => {
  it("shows the wake until a visit after it", () => {
    expect(isThreadWoke({ wokeAt: "2026-03-09T10:00:00.000Z", lastVisitedAt: undefined })).toBe(
      true,
    );
    expect(
      isThreadWoke({
        wokeAt: "2026-03-09T10:00:00.000Z",
        lastVisitedAt: "2026-03-09T09:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isThreadWoke({
        wokeAt: "2026-03-09T10:00:00.000Z",
        lastVisitedAt: "2026-03-09T10:01:00.000Z",
      }),
    ).toBe(false);
  });

  it("treats a corrupt visit timestamp as never-visited", () => {
    expect(isThreadWoke({ wokeAt: "2026-03-09T10:00:00.000Z", lastVisitedAt: "not-a-date" })).toBe(
      true,
    );
  });

  it("never wakes without a wake timestamp", () => {
    expect(isThreadWoke({ wokeAt: null, lastVisitedAt: undefined })).toBe(false);
  });
});

describe("classifyThreadForSidebarV3", () => {
  it("routes approval, input, and failed into Needs attention", () => {
    expect(
      classifyThreadForSidebarV3({ ...idleThread, hasPendingApprovals: true }, noContext),
    ).toMatchObject({ section: "attention", attentionKind: "approval" });
    expect(
      classifyThreadForSidebarV3({ ...idleThread, hasPendingUserInput: true }, noContext),
    ).toMatchObject({ section: "attention", attentionKind: "input" });
    expect(
      classifyThreadForSidebarV3(
        { ...idleThread, session: { ...runningSession, status: "error" as const } },
        noContext,
      ),
    ).toMatchObject({ section: "attention", attentionKind: "failed" });
  });

  it("routes a woken thread into Needs attention even while otherwise ready", () => {
    expect(
      classifyThreadForSidebarV3(idleThread, {
        lastVisitedAt: undefined,
        wokeAt: "2026-03-09T10:00:00.000Z",
      }),
    ).toMatchObject({ section: "attention", attentionKind: "woke" });
  });

  it("routes finished-but-unread work into Needs attention as done", () => {
    expect(
      classifyThreadForSidebarV3(
        { ...idleThread, latestTurn: makeLatestTurn() },
        { lastVisitedAt: "2026-03-09T10:04:00.000Z", wokeAt: null },
      ),
    ).toMatchObject({ section: "attention", attentionKind: "done" });
  });

  it("routes running and monitoring threads into Working", () => {
    expect(
      classifyThreadForSidebarV3({ ...idleThread, session: runningSession }, noContext),
    ).toMatchObject({ section: "working", attentionKind: null });
    expect(
      classifyThreadForSidebarV3(
        { ...idleThread, backgroundLiveness: "monitoring" as const },
        noContext,
      ),
    ).toMatchObject({ section: "working", attentionKind: null });
  });

  it("routes quiet, read threads into Ready — never-visited counts as read", () => {
    expect(
      classifyThreadForSidebarV3({ ...idleThread, latestTurn: makeLatestTurn() }, noContext),
    ).toMatchObject({ section: "ready", attentionKind: null });
  });

  it("lets a pending approval outrank the woke and done signals", () => {
    expect(
      classifyThreadForSidebarV3(
        { ...idleThread, hasPendingApprovals: true, latestTurn: makeLatestTurn() },
        { lastVisitedAt: undefined, wokeAt: "2026-03-09T10:00:00.000Z" },
      ),
    ).toMatchObject({ section: "attention", attentionKind: "approval" });
  });
});

function makeSortable(input: {
  id: string;
  createdAt: string;
  latestUserMessageAt?: string | null;
}) {
  return {
    id: input.id,
    createdAt: input.createdAt,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    latestTurn: null,
  };
}

describe("resolveActivityTimestampMs", () => {
  it("takes the latest of user message and turn stamps", () => {
    expect(
      resolveActivityTimestampMs({
        latestUserMessageAt: "2026-03-09T10:00:00.000Z",
        latestTurn: makeLatestTurn({ completedAt: "2026-03-09T11:00:00.000Z" }),
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-03-09T11:00:00.000Z"));
  });

  it("ignores updatedAt-style churn entirely — it is not part of the input", () => {
    // No latestUserMessageAt/latestTurn: a thread touched only by background
    // projection writes (title regen, pin, session heartbeat) must NOT look
    // "active" — that was the bug behind rows reordering on noise.
    expect(
      resolveActivityTimestampMs({
        latestUserMessageAt: null,
        latestTurn: null,
        createdAt: "2026-03-01T10:00:00.000Z",
      }),
    ).toBe(Date.parse("2026-03-01T10:00:00.000Z"));
  });

  it("skips malformed stamps and falls back to createdAt", () => {
    expect(
      resolveActivityTimestampMs({
        latestUserMessageAt: "not-a-date",
        latestTurn: null,
        createdAt: "2026-03-09T10:30:00.000Z",
      }),
    ).toBe(Date.parse("2026-03-09T10:30:00.000Z"));
  });
});

describe("sortThreadsForSidebarV3", () => {
  const older = makeSortable({
    id: "a-older",
    createdAt: "2026-03-01T10:00:00.000Z",
    // A genuine, recent user message — real activity, not projection churn.
    latestUserMessageAt: "2026-03-09T12:00:00.000Z",
  });
  const newer = makeSortable({
    id: "b-newer",
    createdAt: "2026-03-05T10:00:00.000Z",
  });

  it("created: newest creation first, activity never reorders", () => {
    expect(sortThreadsForSidebarV3([older, newer], "created").map((t) => t.id)).toEqual([
      "b-newer",
      "a-older",
    ]);
  });

  it("activity: most recently touched first", () => {
    expect(sortThreadsForSidebarV3([newer, older], "activity").map((t) => t.id)).toEqual([
      "a-older",
      "b-newer",
    ]);
  });

  it("breaks timestamp ties by id for a deterministic order", () => {
    const twinA = makeSortable({ id: "twin-a", createdAt: "2026-03-01T10:00:00.000Z" });
    const twinB = makeSortable({ id: "twin-b", createdAt: "2026-03-01T10:00:00.000Z" });
    expect(sortThreadsForSidebarV3([twinB, twinA], "created").map((t) => t.id)).toEqual([
      "twin-a",
      "twin-b",
    ]);
  });
});

describe("sortAttentionThreadsForSidebarV3", () => {
  it("orders by severity bucket, then the chosen sort within a bucket", () => {
    const kinds = new Map<string, SidebarV3AttentionKind>([
      ["done-new", "done"],
      ["approval-old", "approval"],
      ["failed-new", "failed"],
      ["approval-new", "approval"],
    ]);
    const threads = [
      makeSortable({ id: "done-new", createdAt: "2026-03-09T10:00:00.000Z" }),
      makeSortable({ id: "approval-old", createdAt: "2026-03-01T10:00:00.000Z" }),
      makeSortable({ id: "failed-new", createdAt: "2026-03-08T10:00:00.000Z" }),
      makeSortable({ id: "approval-new", createdAt: "2026-03-07T10:00:00.000Z" }),
    ];
    expect(
      sortAttentionThreadsForSidebarV3(threads, "created", (thread) =>
        kinds.get(thread.id) === undefined ? "done" : kinds.get(thread.id)!,
      ).map((t) => t.id),
    ).toEqual(["approval-new", "approval-old", "failed-new", "done-new"]);
  });
});
