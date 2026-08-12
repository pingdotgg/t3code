import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationSessionStatus,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isLatestTurnSettled } from "../session-logic";
import {
  hasUnseenCompletion,
  resolveSidebarV2Status,
  resolveThreadStatusPill,
  type SidebarV2Status,
  type ThreadStatusPill,
} from "../components/Sidebar.logic";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { resolveThreadRuntimeState } from "./threadRuntimeState";

const SESSION_STATUSES: ReadonlyArray<OrchestrationSessionStatus | null> = [
  null,
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
];

function makeLatestTurn(settled: boolean): OrchestrationLatestTurn {
  return {
    turnId: "turn-1" as never,
    state: settled ? "completed" : "running",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: settled ? "2026-03-09T10:05:00.000Z" : null,
  };
}

function makeSession(status: OrchestrationSessionStatus | null): OrchestrationSession | null {
  if (status === null) return null;
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: status === "running" ? ("turn-1" as never) : null,
    lastError: status === "error" ? "boom" : null,
    updatedAt: "2026-03-09T10:05:00.000Z",
  };
}

type RuntimeFixture = ReturnType<typeof makeFixture>;

function makeFixture(input: {
  hasActionableProposedPlan: boolean;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  interactionMode: ProviderInteractionMode;
  latestTurnSettled: boolean;
  sessionStatus: OrchestrationSessionStatus | null;
}) {
  return {
    hasActionableProposedPlan: input.hasActionableProposedPlan,
    hasPendingApprovals: input.hasPendingApprovals,
    hasPendingUserInput: input.hasPendingUserInput,
    interactionMode: input.interactionMode,
    latestTurn: makeLatestTurn(input.latestTurnSettled),
    lastVisitedAt: "2026-03-09T10:04:00.000Z",
    session: makeSession(input.sessionStatus),
  };
}

function fixtureMatrix(): RuntimeFixture[] {
  const fixtures: RuntimeFixture[] = [];
  for (const hasPendingApprovals of [false, true]) {
    for (const hasPendingUserInput of [false, true]) {
      for (const hasActionableProposedPlan of [false, true]) {
        for (const sessionStatus of SESSION_STATUSES) {
          for (const interactionMode of ["default", "plan"] as const) {
            for (const latestTurnSettled of [false, true]) {
              fixtures.push(
                makeFixture({
                  hasActionableProposedPlan,
                  hasPendingApprovals,
                  hasPendingUserInput,
                  interactionMode,
                  latestTurnSettled,
                  sessionStatus,
                }),
              );
            }
          }
        }
      }
    }
  }
  return fixtures;
}

// Frozen copy of the pre-P1 v1 resolver. Keep this independent of the shared
// resolver: it proves the projection preserves every legacy output byte-for-byte.
function frozenV1StatusOracle(thread: RuntimeFixture): ThreadStatusPill | null {
  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }
  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }
  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }
  if (thread.session?.status === "starting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }
  if (
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan
  ) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }
  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }
  return null;
}

// Frozen copy of the pre-P1 v2 resolver. It intentionally folds every resting
// outcome, including plan-ready, into ready.
function frozenV2StatusOracle(thread: RuntimeFixture): SidebarV2Status {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") return "failed";
  return "ready";
}

describe("sidebar runtime-state projections", () => {
  it("matches both frozen pre-P1 resolvers across the complete fixture matrix", () => {
    for (const thread of fixtureMatrix()) {
      expect(resolveThreadStatusPill({ thread })).toEqual(frozenV1StatusOracle(thread));
      expect(resolveSidebarV2Status(thread)).toBe(frozenV2StatusOracle(thread));
    }
  });
});

describe("resolveThreadRuntimeState", () => {
  it("keeps background agents and watch loops visible after the turn settles", () => {
    const resting = makeFixture({
      hasActionableProposedPlan: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      interactionMode: "default",
      latestTurnSettled: true,
      sessionStatus: "ready",
    });

    expect(resolveThreadRuntimeState({ ...resting, backgroundLiveness: "working" })).toBe(
      "working",
    );
    expect(resolveThreadRuntimeState({ ...resting, backgroundLiveness: "monitoring" })).toBe(
      "monitoring",
    );
  });

  it.each([
    [
      "approval outranks every other signal",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
        interactionMode: "plan",
        latestTurnSettled: true,
        sessionStatus: "running",
      }),
      "approval",
    ],
    [
      "input outranks active work",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
        interactionMode: "plan",
        latestTurnSettled: true,
        sessionStatus: "running",
      }),
      "input",
    ],
    [
      "running is working",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "plan",
        latestTurnSettled: true,
        sessionStatus: "running",
      }),
      "working",
    ],
    [
      "starting is connecting",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "plan",
        latestTurnSettled: true,
        sessionStatus: "starting",
      }),
      "connecting",
    ],
    [
      "an errored session is failed",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "plan",
        latestTurnSettled: true,
        sessionStatus: "error",
      }),
      "failed",
    ],
    [
      "a settled plan turn with an actionable proposal is plan-ready",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "plan",
        latestTurnSettled: true,
        sessionStatus: "ready",
      }),
      "plan-ready",
    ],
    [
      "an actionable proposal outside plan mode is idle",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurnSettled: true,
        sessionStatus: "ready",
      }),
      "idle",
    ],
    [
      "an actionable proposal from an unsettled turn is idle",
      makeFixture({
        hasActionableProposedPlan: true,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "plan",
        latestTurnSettled: false,
        sessionStatus: "ready",
      }),
      "idle",
    ],
    [
      "a resting thread is idle",
      makeFixture({
        hasActionableProposedPlan: false,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        interactionMode: "default",
        latestTurnSettled: true,
        sessionStatus: null,
      }),
      "idle",
    ],
  ] as const)("%s", (_name, thread, expected) => {
    expect(resolveThreadRuntimeState(thread)).toBe(expected);
  });
});
