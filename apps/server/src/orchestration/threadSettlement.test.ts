import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveAutomaticSettlementReason,
  resolveAutomaticSettlementVerdict,
  shellHasQueuedTurnStart,
  threadLastActivityAt,
} from "./threadSettlement.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

function makeShell(
  input: Partial<OrchestrationThreadShell> & {
    readonly activityAt?: string | null;
  } = {},
): OrchestrationThreadShell {
  const threadId = ThreadId.make("thread-1");
  const { activityAt = FRESH, ...overrides } = input;
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/settlement",
    worktreePath: null,
    latestTurn:
      activityAt === null
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function resolve(
  shell: OrchestrationThreadShell,
  options: {
    readonly changeRequestState?: "open" | "merged" | "closed" | null;
    readonly autoSettleAfterDays?: 3 | null;
    readonly now?: string;
  } = {},
) {
  return resolveAutomaticSettlementReason(shell, {
    now: options.now ?? NOW,
    autoSettleAfterDays:
      options.autoSettleAfterDays === undefined ? 3 : options.autoSettleAfterDays,
    changeRequestState: options.changeRequestState ?? null,
  });
}

describe("resolveAutomaticSettlementReason", () => {
  it("settles stale unpinned threads for inactivity", () => {
    expect(resolve(makeShell({ activityAt: STALE }))).toBe("inactivity");
    expect(resolve(makeShell({ activityAt: "2026-04-07T00:00:00.000Z" }))).toBeNull();
    expect(resolve(makeShell({ activityAt: STALE }), { autoSettleAfterDays: null })).toBeNull();
  });

  it("never timer-settles a pinned thread", () => {
    const pinned = makeShell({
      activityAt: STALE,
      pinnedAt: "2026-04-07T00:00:00.000Z",
    });

    expect(resolve(pinned)).toBeNull();
    expect(resolve(pinned, { changeRequestState: "closed" })).toBeNull();
  });

  it("settles and therefore unpins a pinned thread only when its PR merges", () => {
    const pinned = makeShell({
      activityAt: FRESH,
      pinnedAt: "2026-04-07T00:00:00.000Z",
    });

    expect(resolve(pinned, { changeRequestState: "open" })).toBeNull();
    expect(resolve(pinned, { changeRequestState: "closed" })).toBeNull();
    expect(resolve(pinned, { changeRequestState: "merged" })).toBe("pr-merged");
  });

  it("does not treat a closed PR as an immediate settlement signal", () => {
    expect(
      resolve(makeShell({ activityAt: FRESH }), {
        autoSettleAfterDays: null,
        changeRequestState: "closed",
      }),
    ).toBeNull();
    expect(resolve(makeShell({ activityAt: STALE }), { changeRequestState: "closed" })).toBe(
      "inactivity",
    );
  });

  it("keeps open-PR threads active regardless of inactivity", () => {
    expect(resolve(makeShell({ activityAt: STALE }), { changeRequestState: "open" })).toBeNull();
  });

  it("honors explicit lifecycle state until real activity clears it", () => {
    for (const settledOverride of ["active", "settled"] as const) {
      expect(
        resolve(makeShell({ activityAt: STALE, settledOverride }), {
          changeRequestState: "merged",
        }),
      ).toBeNull();
    }
  });

  it("never settles live, blocked, or newly queued work", () => {
    const queued = makeShell({
      activityAt: null,
      latestUserMessageAt: "2026-04-09T12:00:00.000Z",
    });
    const mergedOptions = {
      now: "2026-04-09T12:00:30.000Z",
      changeRequestState: "merged" as const,
    };

    expect(resolve(queued, mergedOptions)).toBeNull();
    expect(resolve(makeShell({ hasPendingApprovals: true }), mergedOptions)).toBeNull();
    expect(resolve(makeShell({ hasPendingUserInput: true }), mergedOptions)).toBeNull();
    expect(
      resolve(
        makeShell({
          session: {
            threadId: queued.id,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-active"),
            lastError: null,
            updatedAt: NOW,
          },
        }),
        mergedOptions,
      ),
    ).toBeNull();
  });
});

describe("resolveAutomaticSettlementVerdict", () => {
  it("re-verifies cached or unknown PR state even for pinned threads", () => {
    const pinned = makeShell({
      activityAt: FRESH,
      pinnedAt: "2026-04-07T00:00:00.000Z",
    });

    for (const changeRequestState of ["unknown", "open-cached", "closed-cached"] as const) {
      expect(
        resolveAutomaticSettlementVerdict(pinned, {
          now: NOW,
          autoSettleAfterDays: 3,
          changeRequestState,
        }),
      ).toEqual({ kind: "verify-pr" });
    }
  });

  it("does not re-verify terminal live states", () => {
    const pinned = makeShell({
      activityAt: STALE,
      pinnedAt: "2026-04-07T00:00:00.000Z",
    });

    expect(
      resolveAutomaticSettlementVerdict(pinned, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequestState: "closed",
      }),
    ).toEqual({ kind: "skip" });
    expect(
      resolveAutomaticSettlementVerdict(pinned, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequestState: "merged",
      }),
    ).toEqual({ kind: "settle", reason: "pr-merged" });
  });
});

describe("server settlement activity guards", () => {
  it("uses the latest user or turn activity timestamp", () => {
    const shell = makeShell({
      latestUserMessageAt: "2026-04-04T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-03T00:00:00.000Z",
        startedAt: "2026-04-05T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:00.000Z",
        assistantMessageId: null,
      },
    });

    expect(threadLastActivityAt(shell)).toBe("2026-04-06T00:00:00.000Z");
  });

  it("bounds the queued-turn guard so failed starts do not block forever", () => {
    const shell = makeShell({
      activityAt: null,
      latestUserMessageAt: "2026-04-09T12:00:00.000Z",
    });

    expect(shellHasQueuedTurnStart(shell, "2026-04-09T12:00:30.000Z")).toBe(true);
    expect(shellHasQueuedTurnStart(shell, "2026-04-09T12:03:00.000Z")).toBe(false);
  });
});
