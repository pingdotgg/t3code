import type { ProviderRuntimeEvent } from "@t3tools/contracts";

const PROVIDER = "codex" as const;
const SESSION_ID = "fixture-session";
const THREAD_ID = "fixture-thread";
const TURN_ID = "fixture-turn";

function baseEvent(eventId: string, createdAt: string): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "sessionId" | "createdAt"
> {
  return {
    eventId,
    provider: PROVIDER,
    sessionId: SESSION_ID,
    createdAt,
  };
}

export const codexTurnTextFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-1", "2026-02-23T00:00:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
  },
  {
    type: "message.delta",
    ...baseEvent("evt-2", "2026-02-23T00:00:00.100Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    delta: "I will make a small update.\n",
  },
  {
    type: "message.delta",
    ...baseEvent("evt-3", "2026-02-23T00:00:00.200Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    delta: "Done.\n",
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-4", "2026-02-23T00:00:00.300Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    status: "completed",
  },
] satisfies ReadonlyArray<ProviderRuntimeEvent>;

export const codexTurnToolFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-11", "2026-02-23T00:01:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
  },
  {
    type: "tool.started",
    ...baseEvent("evt-12", "2026-02-23T00:01:00.100Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    toolKind: "command",
    title: "Command run",
    detail: "echo integration",
  },
  {
    type: "tool.completed",
    ...baseEvent("evt-13", "2026-02-23T00:01:00.200Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    toolKind: "command",
    title: "Command run",
    detail: "echo integration",
  },
  {
    type: "message.delta",
    ...baseEvent("evt-14", "2026-02-23T00:01:00.300Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    delta: "Applied the requested edit.\n",
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-15", "2026-02-23T00:01:00.400Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    status: "completed",
  },
] satisfies ReadonlyArray<ProviderRuntimeEvent>;

export const codexTurnApprovalFixture = [
  {
    type: "turn.started",
    ...baseEvent("evt-21", "2026-02-23T00:02:00.000Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
  },
  {
    type: "approval.requested",
    ...baseEvent("evt-22", "2026-02-23T00:02:00.100Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    requestId: "req-1",
    requestKind: "command",
    detail: "Please approve command",
  },
  {
    type: "approval.resolved",
    ...baseEvent("evt-23", "2026-02-23T00:02:00.200Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    requestId: "req-1",
    requestKind: "command",
    decision: "accept",
  },
  {
    type: "message.delta",
    ...baseEvent("evt-24", "2026-02-23T00:02:00.300Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    delta: "Approval received and command executed.\n",
  },
  {
    type: "turn.completed",
    ...baseEvent("evt-25", "2026-02-23T00:02:00.400Z"),
    threadId: THREAD_ID,
    turnId: TURN_ID,
    status: "completed",
  },
] satisfies ReadonlyArray<ProviderRuntimeEvent>;
