import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canSettle,
  effectiveSettled,
  threadLastActivityAt,
  type ChangeRequestStateLike,
} from "./threadSettled.ts";

const NOW = "2026-04-10T00:00:00.000Z";
const FRESH = "2026-04-09T00:00:00.000Z";
const STALE = "2026-04-06T23:59:59.999Z";

function makeShell(input: {
  readonly archivedAt: string | null;
  readonly activityAt: string | null;
  readonly sessionStatus?: "starting" | "running";
  readonly pending?: "approval" | "user-input";
}): OrchestrationThreadShell {
  const threadId = ThreadId.make("thread-1");
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.activityAt === null
        ? null
        : {
            turnId: TurnId.make("turn-1"),
            state: "completed",
            requestedAt: input.activityAt,
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: input.archivedAt,
    settledOverride: null,
    settledAt: null,
    session:
      input.sessionStatus === undefined
        ? null
        : {
            threadId,
            status: input.sessionStatus,
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
    latestUserMessageAt: null,
    hasPendingApprovals: input.pending === "approval",
    hasPendingUserInput: input.pending === "user-input",
    hasActionableProposedPlan: false,
  };
}

describe("threadLastActivityAt", () => {
  it("returns the latest real user or turn activity and ignores thread/session updates", () => {
    const shell = makeShell({ archivedAt: null, activityAt: null, sessionStatus: "running" });
    const withActivity: OrchestrationThreadShell = {
      ...shell,
      latestUserMessageAt: "2026-04-04T00:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-03T00:00:00.000Z",
        startedAt: "2026-04-05T00:00:00.000Z",
        completedAt: "2026-04-06T00:00:00.000Z",
        assistantMessageId: null,
      },
    };

    expect(threadLastActivityAt(withActivity)).toBe("2026-04-06T00:00:00.000Z");
    expect(threadLastActivityAt(shell)).toBeNull();
  });
});

describe("effectiveSettled", () => {
  const archivedCases = [null, NOW] as const;
  const changeRequestStates = [undefined, "open", "merged"] as const;
  const inactivityCases = [
    ["fresh", FRESH],
    ["stale", STALE],
    ["no-activity", null],
  ] as const;
  const runningCases = [false, true] as const;
  const pendingCases = [undefined, "approval", "user-input"] as const;
  const truthTable = archivedCases.flatMap((archivedAt) =>
    changeRequestStates.flatMap((changeRequestState) =>
      inactivityCases.flatMap(([inactivity, activityAt]) =>
        runningCases.flatMap((running) =>
          pendingCases.map((pending) => ({
            archivedAt,
            changeRequestState,
            inactivity,
            activityAt,
            running,
            pending,
            // Settled iff nothing blocks (pending work / live session) AND
            // any positive signal holds: archived, merged PR, or staleness.
            expected:
              pending === undefined &&
              !running &&
              (archivedAt !== null || changeRequestState === "merged" || inactivity === "stale"),
          })),
        ),
      ),
    ),
  );

  it.each(truthTable)(
    "archived=$archivedAt pr=$changeRequestState inactivity=$inactivity running=$running pending=$pending",
    ({ archivedAt, changeRequestState, activityAt, running, pending, expected }) => {
      const shell = makeShell({
        archivedAt,
        activityAt,
        ...(running ? { sessionStatus: "running" as const } : {}),
        ...(pending === undefined ? {} : { pending }),
      });
      const changeRequestOptions =
        changeRequestState === undefined
          ? {}
          : { changeRequestState: changeRequestState as ChangeRequestStateLike };

      expect(
        effectiveSettled(shell, {
          now: NOW,
          autoSettleAfterDays: 3,
          ...changeRequestOptions,
        }),
      ).toBe(expected);
    },
  );

  it("treats closed change requests like merged ones", () => {
    const shell = makeShell({ archivedAt: null, activityAt: null });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: null,
        changeRequestState: "closed",
      }),
    ).toBe(true);
  });

  it("never settles a starting session, even when archived", () => {
    const shell = makeShell({
      archivedAt: NOW,
      activityAt: STALE,
      sessionStatus: "starting",
    });
    expect(
      effectiveSettled(shell, {
        now: NOW,
        autoSettleAfterDays: 3,
        changeRequestState: "merged",
      }),
    ).toBe(false);
  });

  it("uses a strict inactivity boundary and honors a null threshold", () => {
    const boundary = makeShell({
      archivedAt: null,
      activityAt: "2026-04-07T00:00:00.000Z",
    });
    const stale = makeShell({ archivedAt: null, activityAt: STALE });

    expect(effectiveSettled(boundary, { now: NOW, autoSettleAfterDays: 3 })).toBe(false);
    expect(effectiveSettled(stale, { now: NOW, autoSettleAfterDays: null })).toBe(false);
  });
});

describe("canSettle", () => {
  it("blocks every state effectiveSettled refuses to classify as settled", () => {
    expect(canSettle(makeShell({ archivedAt: null, activityAt: FRESH }))).toBe(true);
    expect(
      canSettle(makeShell({ archivedAt: null, activityAt: FRESH, sessionStatus: "starting" })),
    ).toBe(false);
    expect(
      canSettle(makeShell({ archivedAt: null, activityAt: FRESH, sessionStatus: "running" })),
    ).toBe(false);
    expect(canSettle(makeShell({ archivedAt: null, activityAt: FRESH, pending: "approval" }))).toBe(
      false,
    );
    expect(
      canSettle(makeShell({ archivedAt: null, activityAt: FRESH, pending: "user-input" })),
    ).toBe(false);
  });

  it("agrees with effectiveSettled's blockers for archived shells", () => {
    // Anything canSettle rejects must render as active even when archived.
    const blocked = makeShell({
      archivedAt: FRESH,
      activityAt: FRESH,
      pending: "user-input",
    });
    expect(canSettle(blocked)).toBe(false);
    expect(effectiveSettled(blocked, { now: NOW, autoSettleAfterDays: 3 })).toBe(false);
  });
});
