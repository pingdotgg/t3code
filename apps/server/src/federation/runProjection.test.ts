import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationCheckpointSummary,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationLatestTurnState,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  FEDERATION_PREVIEW_MAX_CHARS,
  federationRunStatus,
  isFederationRunActive,
  projectFederationArtifacts,
  projectFederationRun,
  summarizeFederationRunEvent,
  truncatePreview,
} from "./runProjection.ts";

const environmentId = EnvironmentId.make("environment-origin");
const projectId = ProjectId.make("project-t3code");
const threadId = ThreadId.make("thread-fix-checkpoints");
const otherThreadId = ThreadId.make("thread-unrelated");
const turnId = TurnId.make("turn-1");
const messageId = MessageId.make("message-1");
const createdAt = "2026-03-01T09:00:00.000Z";
const requestedAt = "2026-03-01T09:30:00.000Z";
const startedAt = "2026-03-01T09:30:01.000Z";
const completedAt = "2026-03-01T09:42:17.000Z";
const occurredAt = "2026-03-01T09:31:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const makeThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Fix flaky checkpoint test",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const makeLatestTurn = (
  overrides: Partial<OrchestrationLatestTurn> = {},
): OrchestrationLatestTurn => ({
  turnId,
  state: "running",
  requestedAt,
  startedAt,
  completedAt: null,
  assistantMessageId: null,
  ...overrides,
});

const eventBase = (
  sequence: number,
  aggregateId: ThreadId | ProjectId = threadId,
  aggregateKind: "thread" | "project" = "thread",
) => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind,
  aggregateId,
  occurredAt,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const messageSentEvent = (input: {
  readonly text: string;
  readonly role?: "user" | "assistant";
  readonly aggregateId?: ThreadId;
}): OrchestrationEvent => {
  const aggregateId = input.aggregateId ?? threadId;
  return {
    ...eventBase(7, aggregateId),
    type: "thread.message-sent",
    payload: {
      threadId: aggregateId,
      messageId,
      role: input.role ?? "user",
      text: input.text,
      turnId,
      streaming: false,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
  };
};

const sessionSetEvent = (lastError: string | null): OrchestrationEvent => ({
  ...eventBase(9),
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status: lastError === null ? "ready" : "error",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError,
      updatedAt: occurredAt,
    },
  },
});

const turnDiffCompletedEvent = (fileCount: number): OrchestrationEvent => ({
  ...eventBase(11),
  type: "thread.turn-diff-completed",
  payload: {
    threadId,
    turnId,
    checkpointTurnCount: 1,
    checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-fix-checkpoints/1"),
    status: "ready",
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
      kind: "modified",
      additions: 3,
      deletions: 1,
    })),
    assistantMessageId: null,
    completedAt,
  },
});

const makeCheckpoint = (
  overrides: Partial<OrchestrationCheckpointSummary> = {},
): OrchestrationCheckpointSummary => ({
  turnId,
  checkpointTurnCount: 1,
  checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-fix-checkpoints/1"),
  status: "ready",
  files: [
    { path: "src/server.ts", kind: "modified", additions: 12, deletions: 4 },
    { path: "src/server.test.ts", kind: "added", additions: 40, deletions: 0 },
  ],
  assistantMessageId: null,
  completedAt,
  ...overrides,
});

describe("federationRunStatus", () => {
  it.each<{ readonly state: OrchestrationLatestTurnState | null; readonly expected: string }>([
    { state: null, expected: "queued" },
    { state: "running", expected: "running" },
    { state: "completed", expected: "completed" },
    { state: "interrupted", expected: "interrupted" },
    { state: "error", expected: "error" },
  ])("maps latest turn state $state to $expected", ({ state, expected }) => {
    expect(federationRunStatus(state)).toBe(expected);
  });
});

describe("truncatePreview", () => {
  it("collapses whitespace runs and trims the edges", () => {
    expect(truncatePreview("  Refactor\n\n  the   reactor\t queue  ")).toBe(
      "Refactor the reactor queue",
    );
  });

  it("leaves text at the limit untouched", () => {
    const text = "a".repeat(FEDERATION_PREVIEW_MAX_CHARS);
    expect(truncatePreview(text)).toBe(text);
  });

  it("cuts longer text to the limit and ends it with an ellipsis", () => {
    const preview = truncatePreview("b".repeat(FEDERATION_PREVIEW_MAX_CHARS + 60));
    expect(preview).toHaveLength(FEDERATION_PREVIEW_MAX_CHARS);
    expect(preview).toBe(`${"b".repeat(FEDERATION_PREVIEW_MAX_CHARS - 1)}…`);
  });

  it("honors a custom limit", () => {
    expect(truncatePreview("abcdefgh", 5)).toBe("abcd…");
  });
});

describe("projectFederationRun", () => {
  it("reports a thread without a turn as queued, timed from its creation", () => {
    const run = projectFederationRun({
      environmentId,
      thread: makeThreadShell(),
      assistantPreview: null,
      turnCount: 0,
    });

    expect(run).toEqual({
      environmentId,
      projectId,
      threadId,
      turnId: null,
      title: "Fix flaky checkpoint test",
      status: "queued",
      runtimeMode: "full-access",
      modelSelection,
      requestedAt: createdAt,
      startedAt: null,
      completedAt: null,
      assistantPreview: null,
      turnCount: 0,
    });
  });

  it("reports a running turn with its own timestamps", () => {
    const run = projectFederationRun({
      environmentId,
      thread: makeThreadShell({ latestTurn: makeLatestTurn() }),
      assistantPreview: "Looking at the flaky test…",
      turnCount: 1,
    });

    expect(run).toMatchObject({
      turnId,
      status: "running",
      requestedAt,
      startedAt,
      completedAt: null,
      assistantPreview: "Looking at the flaky test…",
      turnCount: 1,
    });
  });

  it.each<{ readonly state: OrchestrationLatestTurnState; readonly expected: string }>([
    { state: "completed", expected: "completed" },
    { state: "interrupted", expected: "interrupted" },
    { state: "error", expected: "error" },
  ])("reports a $state turn as $expected with its completion time", ({ state, expected }) => {
    const run = projectFederationRun({
      environmentId,
      thread: makeThreadShell({
        latestTurn: makeLatestTurn({ state, completedAt }),
      }),
      assistantPreview: "Done.",
      turnCount: 3,
    });

    expect(run.status).toBe(expected);
    expect(run.completedAt).toBe(completedAt);
    expect(run.startedAt).toBe(startedAt);
  });
});

describe("isFederationRunActive", () => {
  const baseRun = projectFederationRun({
    environmentId,
    thread: makeThreadShell(),
    assistantPreview: null,
    turnCount: 0,
  });

  it("treats queued and running runs as active", () => {
    expect(isFederationRunActive({ ...baseRun, status: "queued" })).toBe(true);
    expect(isFederationRunActive({ ...baseRun, status: "running" })).toBe(true);
  });

  it("treats settled runs as inactive", () => {
    expect(isFederationRunActive({ ...baseRun, status: "completed" })).toBe(false);
    expect(isFederationRunActive({ ...baseRun, status: "interrupted" })).toBe(false);
    expect(isFederationRunActive({ ...baseRun, status: "error" })).toBe(false);
  });
});

describe("summarizeFederationRunEvent", () => {
  it("ignores events that belong to another thread", () => {
    const event = messageSentEvent({ text: "hello", aggregateId: otherThreadId });
    expect(summarizeFederationRunEvent(event, threadId)).toBeNull();
  });

  it("ignores project events even when the aggregate id matches", () => {
    const event: OrchestrationEvent = {
      ...eventBase(3, threadId, "project"),
      type: "project.created",
      payload: {
        projectId,
        title: "t3code",
        workspaceRoot: "/home/dev/t3code",
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    };
    expect(summarizeFederationRunEvent(event, threadId)).toBeNull();
  });

  it("ignores thread events that carry nothing worth relaying", () => {
    const event: OrchestrationEvent = {
      ...eventBase(4),
      type: "thread.archived",
      payload: { threadId, archivedAt: occurredAt, updatedAt: occurredAt },
    };
    expect(summarizeFederationRunEvent(event, threadId)).toBeNull();
  });

  it("relays a sent message with its role and the event position", () => {
    const summary = summarizeFederationRunEvent(
      messageSentEvent({ text: "Please  fix the\nflaky test", role: "user" }),
      threadId,
    );

    expect(summary).toEqual({
      sequence: 7,
      at: occurredAt,
      type: "thread.message-sent",
      summary: "user: Please fix the flaky test",
    });
  });

  it("truncates long message text after the role prefix", () => {
    const summary = summarizeFederationRunEvent(
      messageSentEvent({ text: "x".repeat(1_000), role: "assistant" }),
      threadId,
    );

    expect(summary?.summary.startsWith("assistant: ")).toBe(true);
    expect(summary?.summary.endsWith("…")).toBe(true);
    expect(summary?.summary).toHaveLength("assistant: ".length + FEDERATION_PREVIEW_MAX_CHARS);
  });

  it("describes turn lifecycle requests", () => {
    const started: OrchestrationEvent = {
      ...eventBase(8),
      type: "thread.turn-start-requested",
      payload: {
        threadId,
        messageId,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: occurredAt,
      },
    };
    const interrupted: OrchestrationEvent = {
      ...eventBase(10),
      type: "thread.turn-interrupt-requested",
      payload: { threadId, turnId, createdAt: occurredAt },
    };

    expect(summarizeFederationRunEvent(started, threadId)?.summary).toBe("Turn started");
    expect(summarizeFederationRunEvent(interrupted, threadId)?.summary).toBe("Interrupt requested");
  });

  it("describes session changes, including the last error when there is one", () => {
    expect(summarizeFederationRunEvent(sessionSetEvent(null), threadId)?.summary).toBe(
      "Session ready",
    );
    expect(
      summarizeFederationRunEvent(sessionSetEvent("codex exited with code 1"), threadId)?.summary,
    ).toBe("Session error: codex exited with code 1");
  });

  it("counts the files in a completed turn diff", () => {
    expect(summarizeFederationRunEvent(turnDiffCompletedEvent(1), threadId)?.summary).toBe(
      "Changes recorded (1 file)",
    );
    expect(summarizeFederationRunEvent(turnDiffCompletedEvent(3), threadId)?.summary).toBe(
      "Changes recorded (3 files)",
    );
    expect(summarizeFederationRunEvent(turnDiffCompletedEvent(0), threadId)?.summary).toBe(
      "Changes recorded (0 files)",
    );
  });

  it("relays activity summaries, truncated", () => {
    const event: OrchestrationEvent = {
      ...eventBase(12),
      type: "thread.activity-appended",
      payload: {
        threadId,
        activity: {
          id: EventId.make("activity-12"),
          tone: "tool",
          kind: "tool-call",
          summary: `Ran   vitest ${"-".repeat(FEDERATION_PREVIEW_MAX_CHARS)}`,
          payload: { command: "vitest" },
          turnId,
          createdAt: occurredAt,
        },
      },
    };

    const summary = summarizeFederationRunEvent(event, threadId);
    expect(summary?.type).toBe("thread.activity-appended");
    expect(summary?.summary.startsWith("Ran vitest ")).toBe(true);
    expect(summary?.summary).toHaveLength(FEDERATION_PREVIEW_MAX_CHARS);
  });
});

describe("projectFederationArtifacts", () => {
  it("projects ready checkpoints as turn diffs stamped with their origin", () => {
    const secondTurnId = TurnId.make("turn-2");
    const artifacts = projectFederationArtifacts({
      environmentId,
      threadId,
      checkpoints: [
        makeCheckpoint(),
        makeCheckpoint({
          turnId: secondTurnId,
          checkpointTurnCount: 2,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-fix-checkpoints/2"),
          files: [{ path: "README.md", kind: "deleted", additions: 0, deletions: 20 }],
        }),
      ],
    });

    expect(artifacts).toEqual([
      {
        environmentId,
        threadId,
        turnId,
        kind: "turn-diff",
        fromTurnCount: 0,
        toTurnCount: 1,
        files: [
          { path: "src/server.ts", status: "modified" },
          { path: "src/server.test.ts", status: "added" },
        ],
      },
      {
        environmentId,
        threadId,
        turnId: secondTurnId,
        kind: "turn-diff",
        fromTurnCount: 1,
        toTurnCount: 2,
        files: [{ path: "README.md", status: "deleted" }],
      },
    ]);
  });

  it("skips checkpoints that are not ready and the pre-turn baseline", () => {
    const artifacts = projectFederationArtifacts({
      environmentId,
      threadId,
      checkpoints: [
        makeCheckpoint({ status: "missing" }),
        makeCheckpoint({ status: "error" }),
        makeCheckpoint({ checkpointTurnCount: 0 }),
        makeCheckpoint({ turnId: TurnId.make("turn-3"), checkpointTurnCount: 3 }),
      ],
    });

    expect(artifacts.map((artifact) => artifact.turnId)).toEqual([TurnId.make("turn-3")]);
    expect(artifacts[0]).toMatchObject({ fromTurnCount: 2, toTurnCount: 3 });
  });

  it("returns nothing for a thread without checkpoints", () => {
    expect(projectFederationArtifacts({ environmentId, threadId, checkpoints: [] })).toEqual([]);
  });
});
