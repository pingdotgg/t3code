import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  isThreadHiddenFromList,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

describe("isThreadHiddenFromList", () => {
  const failedAt = "2026-06-01T01:00:00.000Z";
  const hidden = {
    ...thread("hidden", false),
    hiddenAt: "2026-06-01T00:30:00.000Z",
    lastVisitedAt: null,
    pendingSubagentRequest: null,
  };
  const failed = {
    ...hidden,
    latestRun: {
      runId: RunId.make("run-failed"),
      status: "failed" as const,
      requestedAt: "2026-06-01T00:59:00.000Z",
      startedAt: "2026-06-01T00:59:00.000Z",
      completedAt: failedAt,
      assistantMessageId: null,
    },
    runtime: {
      status: "failed" as const,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: "boom",
      updatedAt: failedAt,
    },
  };

  it("keeps a hidden thread out of the list while it works or finishes", () => {
    expect(isThreadHiddenFromList(hidden)).toBe(true);
    expect(isThreadHiddenFromList({ ...thread("busy", true), hiddenAt: hidden.hiddenAt })).toBe(
      true,
    );
    expect(isThreadHiddenFromList({ ...hidden, hiddenAt: null })).toBe(false);
  });

  it("brings a hidden thread back while it needs the user", () => {
    expect(isThreadHiddenFromList({ ...hidden, hasPendingApprovals: true })).toBe(false);
    expect(isThreadHiddenFromList({ ...hidden, hasPendingUserInput: true })).toBe(false);
    expect(isThreadHiddenFromList({ ...hidden, pendingSubagentRequest: "approval" })).toBe(false);
  });

  it("shows a failure until the user opens the thread after it", () => {
    expect(isThreadHiddenFromList(failed)).toBe(false);
    expect(isThreadHiddenFromList({ ...failed, lastVisitedAt: "2026-06-01T00:00:00.000Z" })).toBe(
      false,
    );
    expect(isThreadHiddenFromList({ ...failed, lastVisitedAt: "2026-06-01T02:00:00.000Z" })).toBe(
      true,
    );
  });
});
