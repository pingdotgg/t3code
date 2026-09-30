import { describe, expect, it } from "vitest";
import { EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import type { DelegationAuditEvent } from "@t3tools/contracts";
import type { TimelineEntry } from "../../session-logic";
import type { TurnDiffSummary } from "../../types";
import {
  collectReviewOutputMessageIds,
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveRevertTurnCountByUserMessageId,
  deriveDelegationOperationSummary,
  EMPTY_REVIEW_OUTPUT_MESSAGE_IDS,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveExternalActionUrl,
  shouldHandleInternalActionClick,
  stabilizeReadonlyStringSet,
  stabilizeResponseMetaByTurnId,
  stabilizeStringMap,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";

describe("delegation operation status", () => {
  const sourceThreadId = ThreadId.make("source-thread");
  const sourceTurnId = TurnId.make("source-turn");
  const auditEvent = (
    sequence: number,
    operationId: string,
    toolCallId: string,
    payload: unknown,
  ): DelegationAuditEvent => ({
    sequence,
    eventId: EventId.make(`audit-event-${sequence}`),
    operationId,
    attemptId: null,
    sourceThreadId,
    sourceTurnId,
    sourceMessageId: MessageId.make("source-message"),
    childThreadId: null,
    eventType: "operation.failed",
    occurredAt: "2026-09-01T00:00:00.000Z",
    evidenceStatus: "complete",
    redacted: false,
    context: {
      authorization: {
        sourceThreadId,
        sourceTurnId,
        initiatingMessageId: MessageId.make("source-message"),
        scope: "orchestration:operate",
      },
      toolName: "delegate_work",
      toolVersion: "1",
      toolCallId,
      providerInstanceId: null,
      model: null,
      workspaceRoot: null,
      gitRevision: null,
      buildRevision: "server-build",
    },
    payload,
  });

  it("correlates operation failures to the initiating call and keeps transport success separate", () => {
    const summary = deriveDelegationOperationSummary(
      [
        auditEvent(1, "operation-other", "other-provider-call", {
          toolTransport: "completed",
          operationStatus: "failed",
          failedAttemptCount: 5,
          unresolvedAttemptIds: [],
        }),
        auditEvent(2, "operation-selected", "selected-provider-call", {
          toolTransport: "completed",
          operationStatus: "failed",
          failedAttemptCount: 5,
          unresolvedAttemptIds: [],
        }),
      ],
      sourceTurnId,
      "selected-provider-call",
    );

    expect(summary).toEqual({
      operationId: "operation-selected",
      operationStatus: "failed",
      toolTransport: "completed",
    });
  });

  it("does not turn an unfinished operation into a definitive failure", () => {
    const summary = deriveDelegationOperationSummary(
      [
        auditEvent(1, "operation-unresolved", "mcp-call", {
          toolTransport: "completed",
          operationStatus: "unknown",
          unresolvedAttemptIds: ["attempt-1"],
        }),
      ],
      sourceTurnId,
      "mcp-call",
    );

    expect(summary).toEqual({
      operationId: "operation-unresolved",
      operationStatus: "unresolved",
      toolTransport: "completed",
    });
  });
});

describe("compaction timeline boundaries", () => {
  const work = (id: string, compact = false): TimelineEntry => ({
    kind: "work",
    id,
    createdAt: "2026-09-05T00:00:10Z",
    entry: {
      id,
      createdAt: "2026-09-05T00:00:10Z",
      label: compact ? "Compacted context 173K → 5.69K tokens" : "Read file",
      tone: "info",
      ...(compact ? { sourceActivityKind: "context-compaction" } : {}),
    },
  });
  const derive = (timelineEntries: TimelineEntry[]) =>
    deriveMessagesTimelineRows({
      timelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

  it("splits work groups around each compaction instead of folding it into a work log", () => {
    const rows = derive([work("before"), work("compact", true), work("after")]);
    expect(rows.map((row) => row.kind)).toEqual(["work", "context-compaction", "work"]);
    expect(rows[1]).toMatchObject({
      id: "compact",
      label: "Compacted context 173K → 5.69K tokens",
    });
  });

  it("does not create an empty worked-for disclosure for blank assistant placeholders", () => {
    const entries: TimelineEntry[] = [
      ["user", "user", "Inspect the code"],
      ["placeholder", "assistant", ""],
      ["response", "assistant", "Finished."],
    ].map(([id, role, text]) => ({
      kind: "message",
      id: id!,
      createdAt: "2026-09-08T10:00:00.000Z",
      message: {
        id: MessageId.make(id!),
        role: role === "user" ? "user" : "assistant",
        text: text!,
        createdAt: "2026-09-08T10:00:00.000Z",
        streaming: false,
        ...(id === "response" ? { completedAt: "2026-09-08T10:00:10.000Z" } : {}),
      },
    }));
    const rows = derive(entries);
    expect(rows.some((row) => row.kind === "reasoning")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual(["user", "response"]);
  });

  it("keeps automatic compaction visible between completed reasoning sections", () => {
    const rows = derive([
      {
        kind: "message",
        id: "user",
        createdAt: "2026-09-05T00:00:00Z",
        message: {
          id: MessageId.make("user"),
          role: "user",
          text: "Work",
          createdAt: "2026-09-05T00:00:00Z",
          streaming: false,
        },
      },
      work("before"),
      work("compact", true),
      work("after"),
      {
        kind: "message",
        id: "assistant",
        createdAt: "2026-09-05T00:00:20Z",
        message: {
          id: MessageId.make("assistant"),
          role: "assistant",
          text: "Done",
          createdAt: "2026-09-05T00:00:20Z",
          completedAt: "2026-09-05T00:00:20Z",
          streaming: false,
        },
      },
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "reasoning",
      "context-compaction",
      "reasoning",
      "message",
    ]);
    const previous = computeStableMessagesTimelineRows(rows, { byId: new Map(), result: [] });
    expect(
      computeStableMessagesTimelineRows(
        rows.map((row) => ({ ...row })),
        previous,
      ),
    ).toBe(previous);
    const changed = rows.map((row) =>
      row.kind === "context-compaction" ? { ...row, label: "Compacted context" } : row,
    );
    expect(computeStableMessagesTimelineRows(changed, previous)).not.toBe(previous);
  });
});

describe("shouldHandleInternalActionClick", () => {
  it("handles only unmodified primary clicks", () => {
    expect(
      shouldHandleInternalActionClick({
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);

    for (const input of [
      { button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
      { button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
      { button: 0, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
      { button: 0, metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
      { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: true },
    ]) {
      expect(shouldHandleInternalActionClick(input)).toBe(false);
    }
  });
});

describe("resolveExternalActionUrl", () => {
  it("accepts external HTTPS links", () => {
    expect(resolveExternalActionUrl("https://github.com/example/repo/pull/1")).toBe(
      "https://github.com/example/repo/pull/1",
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "file:///tmp/unsafe",
    "/env/thread",
    "http://[malformed",
  ])("rejects unsafe or invalid action URL %s", (url) => {
    expect(resolveExternalActionUrl(url)).toBeNull();
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous assistant completedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message without completedAt", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "a1", role: "assistant", createdAt: "2026-01-01T00:00:30Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        completedAt: "2026-01-01T00:00:55Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
      { id: "u2", role: "user", createdAt: "2026-01-01T00:01:00Z" },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        completedAt: "2026-01-01T00:01:20Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      { id: "u1", role: "user", createdAt: "2026-01-01T00:00:00Z" },
      { id: "s1", role: "system", createdAt: "2026-01-01T00:00:01Z" },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        completedAt: "2026-01-01T00:00:30Z",
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables terminal assistant affordances for the final assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: "assistant-final-entry",
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    const reasoningRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "reasoning" }> =>
        row.kind === "reasoning",
    );

    expect(assistantRows).toHaveLength(1);
    expect(reasoningRow?.workedFor).toBe("20s");
    expect(reasoningRow?.rows).toHaveLength(1);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(true);
    expect(assistantRows[0]?.showAssistantTerminalMetadata).toBe(true);
    expect(assistantRows[0]?.showCompletionDivider).toBe(true);
  });

  it("collapses reasoning before every completed terminal assistant response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "First",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-1-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            label: "Read files",
            tone: "tool",
          },
        },
        {
          id: "assistant-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done first",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:12Z",
            streaming: false,
          },
        },
        {
          id: "user-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-2" as never,
            role: "user",
            text: "Second",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "work-2-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:03Z",
          entry: {
            id: "work-2",
            createdAt: "2026-01-01T00:01:03Z",
            label: "Edited files",
            tone: "tool",
          },
        },
        {
          id: "assistant-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:20Z",
          message: {
            id: "assistant-2" as never,
            role: "assistant",
            text: "Done second",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:01:20Z",
            completedAt: "2026-01-01T00:01:24Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const reasoningRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "reasoning" }> =>
        row.kind === "reasoning",
    );

    expect(reasoningRows.map((row) => row.workedFor)).toEqual(["10s", "20s"]);
    expect(reasoningRows.flatMap((row) => row.rows)).toHaveLength(2);
  });

  it("does not collapse reasoning for the active turn while work continues", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Build it",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            label: "Read files",
            tone: "tool",
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "I'll update it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            completedAt: "2026-01-01T00:00:12Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "reasoning")).toBe(false);
    expect(rows.map((row) => row.kind)).toEqual(["message", "work", "message", "working"]);
  });

  it("keeps active trailing work groups open even when all known entries are complete", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            label: "Read files",
            tone: "tool",
            isComplete: true,
          },
        },
        {
          id: "work-entry-2",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "work-2",
            createdAt: "2026-01-01T00:00:06Z",
            label: "Ran command",
            tone: "tool",
            isComplete: true,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: true,
      activeTurnId: "turn-1" as never,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const workRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "work" }> => row.kind === "work",
    );

    expect(workRow?.shouldAutoCollapse).toBe(false);
  });

  it("keeps a non-terminal assistant response visible when the next user message arrives", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Plan this implementation",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-question-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-question" as never,
            role: "assistant",
            text: "I have a few questions first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            streaming: false,
          },
        },
        {
          id: "user-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-2" as never,
            role: "user",
            text: "Answers to your questions",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-implementation-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:10Z",
          message: {
            id: "assistant-implementation" as never,
            role: "assistant",
            text: "I'll implement that now.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:01:10Z",
            completedAt: "2026-01-01T00:01:12Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "user-1-entry",
      "assistant-question-entry",
      "user-2-entry",
      "assistant-implementation-entry",
    ]);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      files: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("refreshes a stable tool row when only its lifecycle or output changes", () => {
    const entry = {
      id: "work-1",
      createdAt: "2026-09-08T00:00:00Z",
      tone: "tool" as const,
      label: "Ran command",
      isComplete: true,
      toolLifecycleStatus: "completed" as const,
      toolCallId: "provider-call-1",
    };
    const row = {
      id: "work-1",
      kind: "work" as const,
      createdAt: entry.createdAt,
      groupedEntries: [entry],
      shouldAutoCollapse: true,
    };
    const initial = computeStableMessagesTimelineRows([row], { byId: new Map(), result: [] });
    for (const changes of [
      { toolLifecycleStatus: "failed" as const },
      { toolData: { stdout: "new output" } },
      { toolCallId: "provider-call-2" },
    ]) {
      const changed = { ...row, groupedEntries: [{ ...entry, ...changes }] };
      expect(computeStableMessagesTimelineRows([changed], initial).result[0]).toBe(changed);
    }
  });

  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });

  it("reuses equivalent work rows when grouped entry arrays are recreated", () => {
    const buildRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "work-entry-1",
            kind: "work",
            createdAt: "2026-01-01T00:00:00Z",
            entry: {
              id: "work-1",
              createdAt: "2026-01-01T00:00:00Z",
              label: "Read files",
              tone: "tool",
              isComplete: true,
            },
          },
          {
            id: "work-entry-2",
            kind: "work",
            createdAt: "2026-01-01T00:00:01Z",
            entry: {
              id: "work-2",
              createdAt: "2026-01-01T00:00:01Z",
              label: "Ran command",
              tone: "tool",
              isComplete: true,
            },
          },
        ],
        completionDividerBeforeEntryId: null,
        isWorking: true,
        activeTurnId: "turn-1" as never,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const initial = computeStableMessagesTimelineRows(buildRows(), {
      byId: new Map(),
      result: [],
    });
    const repeated = computeStableMessagesTimelineRows(buildRows(), initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("reuses equivalent reasoning rows when nested row arrays are recreated", () => {
    const userMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "Investigate",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const assistantMessage = {
      id: "assistant-1" as never,
      role: "assistant" as const,
      text: "Done",
      turnId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:20Z",
      completedAt: "2026-01-01T00:00:21Z",
      streaming: false,
    };
    const workEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:05Z",
      label: "Read files",
      tone: "tool" as const,
      isComplete: true,
    };

    const buildRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-user-1",
            kind: "message",
            createdAt: userMessage.createdAt,
            message: userMessage,
          },
          {
            id: "work-entry-1",
            kind: "work",
            createdAt: workEntry.createdAt,
            entry: { ...workEntry },
          },
          {
            id: "entry-assistant-1",
            kind: "message",
            createdAt: assistantMessage.createdAt,
            message: assistantMessage,
          },
        ],
        completionDividerBeforeEntryId: null,
        isWorking: false,
        activeTurnId: null,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = buildRows();
    const secondRows = buildRows();
    const reasoningA = firstRows.find((row) => row.kind === "reasoning");
    const reasoningB = secondRows.find((row) => row.kind === "reasoning");
    expect(reasoningA).toBeDefined();
    expect(reasoningB).toBeDefined();
    // Fresh collapse always allocates a new nested array even when content matches.
    expect(reasoningA?.rows).not.toBe(reasoningB?.rows);

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const repeated = computeStableMessagesTimelineRows(secondRows, initial);
    const stableReasoning = repeated.result.find((row) => row.kind === "reasoning");
    const initialReasoning = initial.result.find((row) => row.kind === "reasoning");

    expect(repeated).toBe(initial);
    expect(stableReasoning).toBe(initialReasoning);
  });

  it("keeps prior reasoning rows stable when a later streaming message changes", () => {
    const userMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const completedAssistant = {
      id: "assistant-1" as never,
      role: "assistant" as const,
      text: "First answer",
      turnId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:10Z",
      completedAt: "2026-01-01T00:00:11Z",
      streaming: false,
    };
    const secondUser = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Continue",
      turnId: null,
      createdAt: "2026-01-01T00:00:20Z",
      streaming: false,
    };
    const streamingAssistant = {
      id: "assistant-2" as never,
      role: "assistant" as const,
      text: "Streaming",
      turnId: "turn-2" as never,
      createdAt: "2026-01-01T00:00:30Z",
      streaming: true,
    };
    const workEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:05Z",
      label: "Read files",
      tone: "tool" as const,
      isComplete: true,
    };

    const buildRows = (assistantText: string) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-user-1",
            kind: "message",
            createdAt: userMessage.createdAt,
            message: userMessage,
          },
          {
            id: "work-entry-1",
            kind: "work",
            createdAt: workEntry.createdAt,
            entry: { ...workEntry },
          },
          {
            id: "entry-assistant-1",
            kind: "message",
            createdAt: completedAssistant.createdAt,
            message: completedAssistant,
          },
          {
            id: "entry-user-2",
            kind: "message",
            createdAt: secondUser.createdAt,
            message: secondUser,
          },
          {
            id: "entry-assistant-2",
            kind: "message",
            createdAt: streamingAssistant.createdAt,
            message: { ...streamingAssistant, text: assistantText },
          },
        ],
        completionDividerBeforeEntryId: null,
        isWorking: true,
        activeTurnId: "turn-2" as never,
        activeTurnStartedAt: streamingAssistant.createdAt,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const initial = computeStableMessagesTimelineRows(buildRows("Streaming"), {
      byId: new Map(),
      result: [],
    });
    const next = computeStableMessagesTimelineRows(buildRows("Streaming more"), initial);
    const initialReasoning = initial.result.find((row) => row.kind === "reasoning");
    const nextReasoning = next.result.find((row) => row.kind === "reasoning");

    expect(initialReasoning).toBeDefined();
    expect(nextReasoning).toBe(initialReasoning);
    expect(next).not.toBe(initial);
  });
});

describe("workspace handoff rows", () => {
  const handoffOrigin = (role: "marker" | "continuation") =>
    ({
      kind: "workspace-handoff",
      role,
      branch: "feature/handoff",
      worktreePath: "/tmp/handoff",
    }) as never;

  // Shared entry references: row stability is only meaningful when the inputs
  // are themselves unchanged, which is how the store feeds the timeline.
  const handoffTimelineEntries = [
    {
      id: "user-1-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:00Z",
      message: {
        id: "user-1" as never,
        role: "user",
        text: "Move this work to a new worktree",
        turnId: null,
        createdAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
    },
    {
      id: "work-a-entry",
      kind: "work",
      createdAt: "2026-01-01T00:00:03Z",
      entry: {
        id: "work-a",
        createdAt: "2026-01-01T00:00:03Z",
        label: "Create worktree",
        tone: "tool",
      },
    },
    {
      id: "marker-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:05Z",
      message: {
        id: "marker-1" as never,
        role: "system",
        text: "Moved to feature/handoff (/tmp/handoff)",
        origin: handoffOrigin("marker"),
        turnId: null,
        createdAt: "2026-01-01T00:00:05Z",
        streaming: false,
      },
    },
    {
      id: "work-b-entry",
      kind: "work",
      createdAt: "2026-01-01T00:00:06Z",
      entry: {
        id: "work-b",
        createdAt: "2026-01-01T00:00:06Z",
        label: "Record handoff",
        tone: "tool",
      },
    },
    {
      id: "assistant-1-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:10Z",
      message: {
        id: "assistant-1" as never,
        role: "assistant",
        text: "Creating the workspace.",
        turnId: "turn-1" as never,
        createdAt: "2026-01-01T00:00:10Z",
        completedAt: "2026-01-01T00:00:11Z",
        streaming: false,
      },
    },
    {
      id: "continuation-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:13Z",
      message: {
        id: "continuation-1" as never,
        role: "user",
        text: "Continue the task from the previous user request in the newly bound workspace.",
        origin: handoffOrigin("continuation"),
        turnId: null,
        createdAt: "2026-01-01T00:00:13Z",
        streaming: false,
      },
    },
    {
      id: "work-c-entry",
      kind: "work",
      createdAt: "2026-01-01T00:00:15Z",
      entry: {
        id: "work-c",
        createdAt: "2026-01-01T00:00:15Z",
        label: "Edit files",
        tone: "tool",
      },
    },
    {
      id: "assistant-2-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:20Z",
      message: {
        id: "assistant-2" as never,
        role: "assistant",
        text: "Done in the new worktree.",
        turnId: "turn-2" as never,
        createdAt: "2026-01-01T00:00:20Z",
        completedAt: "2026-01-01T00:00:21Z",
        streaming: false,
      },
    },
  ] as never;

  const deriveHandoffRows = () =>
    deriveMessagesTimelineRows({
      timelineEntries: handoffTimelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

  it("renders the marker as a transition row and hides the boilerplate continuation", () => {
    const rows = deriveHandoffRows();

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "reasoning",
      "workspace-handoff",
      "reasoning",
      "message",
      "reasoning",
      "message",
    ]);
    expect(rows.some((row) => row.id === "continuation-entry")).toBe(false);

    const markerRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "workspace-handoff" }> =>
        row.kind === "workspace-handoff",
    );
    expect(markerRow?.origin.branch).toBe("feature/handoff");
    expect(markerRow?.origin.worktreePath).toBe("/tmp/handoff");
  });

  it("places work logged after the move below the transition", () => {
    const rows = deriveHandoffRows();

    const markerIndex = rows.findIndex((row) => row.kind === "workspace-handoff");
    const postHandoffReasoning = rows.find(
      (row) =>
        row.kind === "reasoning" && row.rows.some((nestedRow) => nestedRow.id === "work-b-entry"),
    );

    expect(markerIndex).toBeGreaterThan(-1);
    expect(rows.findIndex((row) => row.kind === "reasoning")).toBeLessThan(markerIndex);
    expect(postHandoffReasoning).toBeDefined();
    expect(rows.indexOf(postHandoffReasoning!)).toBeGreaterThan(markerIndex);

    const preHandoffReasoning = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "reasoning" }> =>
        row.kind === "reasoning" && row.rows.some((nestedRow) => nestedRow.id === "work-a-entry"),
    );
    expect(preHandoffReasoning?.rows.map((row) => row.id)).toEqual(["work-a-entry"]);
  });

  it("moves the suppressed continuation revert anchor onto the marker", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: handoffTimelineEntries,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map([["continuation-1" as never, 2]]),
    });

    const markerRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "workspace-handoff" }> =>
        row.kind === "workspace-handoff",
    );
    expect(markerRow?.revertMessageId).toBe("continuation-1");
    expect(markerRow?.revertTurnCount).toBe(2);
  });

  it("gives the post-handoff assistant row the same anchor as its reasoning row", () => {
    const rows = deriveHandoffRows();

    const markerRow = rows.find((row) => row.kind === "workspace-handoff");
    const postHandoffAssistant = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.id === "assistant-2",
    );

    // The hidden continuation must not become the anchor: it is a user-role
    // message the user never sees, so measuring from it would show a duration
    // that corresponds to nothing on screen.
    expect(postHandoffAssistant?.durationStart).toBe(markerRow?.createdAt);
    expect(postHandoffAssistant?.durationStart).not.toBe("2026-01-01T00:00:13Z");
  });

  it("anchors the post-handoff elapsed time to the move, not the original request", () => {
    const rows = deriveHandoffRows();

    const reasoningRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "reasoning" }> =>
        row.kind === "reasoning",
    );
    // Measured from the marker (00:00:05) to the post-handoff response
    // (00:00:20), not from the original user message at 00:00:00.
    expect(reasoningRows.at(-1)?.workedFor).toBe("15s");
  });

  it("keeps the marker row referentially stable across recomputation", () => {
    const findMarker = (state: ReturnType<typeof computeStableMessagesTimelineRows>) =>
      state.result.find((row) => row.kind === "workspace-handoff");

    const initial = computeStableMessagesTimelineRows(deriveHandoffRows(), {
      byId: new Map(),
      result: [],
    });
    const repeated = computeStableMessagesTimelineRows(deriveHandoffRows(), initial);

    expect(findMarker(repeated)).toBe(findMarker(initial));
  });

  it("shows neither a divider nor boilerplate when a repeated handoff emits only a continuation", () => {
    // The server suppresses the marker for a handoff that re-targets the
    // worktree the thread is already bound to, but still queues the
    // continuation. A marker-less continuation must leave the transcript
    // untouched rather than surfacing as a second divider or a user bubble.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Move this work to a new worktree",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "continuation-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:13Z",
          message: {
            id: "continuation-1" as never,
            role: "user",
            text: "Continue the task from the previous user request in the newly bound workspace.",
            origin: handoffOrigin("continuation"),
            turnId: null,
            createdAt: "2026-01-01T00:00:13Z",
            streaming: false,
          },
        },
        {
          id: "assistant-2-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-2" as never,
            role: "assistant",
            text: "Done in the new worktree.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            completedAt: "2026-01-01T00:00:21Z",
            streaming: false,
          },
        },
      ] as never,
      completionDividerBeforeEntryId: null,
      isWorking: false,
      activeTurnId: null,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["message", "message"]);
    expect(rows.some((row) => row.id === "continuation-entry")).toBe(false);
    expect(
      rows.some((row) => row.kind === "message" && row.message.text.includes("Continue the task")),
    ).toBe(false);
  });
});

describe("collectReviewOutputMessageIds", () => {
  const assistantRow = (id: string, text: string): MessagesTimelineRow => ({
    kind: "message",
    id,
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text,
      createdAt: "2026-01-01T00:00:00Z",
      streaming: false,
      turnId: TurnId.make("turn-1"),
    },
    durationStart: "2026-01-01T00:00:00Z",
    showCompletionDivider: false,
    showAssistantCopyButton: true,
    showAssistantTerminalMetadata: true,
  });

  it("returns the shared empty set when review results are inactive", () => {
    const rows = [assistantRow("a1", "ordinary reply")];
    const first = collectReviewOutputMessageIds(rows, false);
    const second = collectReviewOutputMessageIds(
      [assistantRow("a1", "ordinary reply that grew while streaming")],
      false,
    );

    expect(first).toBe(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS);
    expect(second).toBe(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS);
    expect(first).toBe(second);
  });

  it("returns the shared empty set when no review output rows are present", () => {
    const ids = collectReviewOutputMessageIds([assistantRow("a1", "no findings here")], true);
    expect(ids).toBe(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS);
  });

  it("collects assistant rows whose body is structured review output", () => {
    const reviewText = JSON.stringify({
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: "No issues.",
      overall_confidence_score: 0.9,
    });
    const ids = collectReviewOutputMessageIds(
      [assistantRow("review-json", reviewText), assistantRow("follow-up", "Looks good otherwise.")],
      true,
    );

    expect(ids).not.toBe(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS);
    expect([...ids]).toEqual(["review-json"]);
  });
});

describe("stabilizeReadonlyStringSet", () => {
  it("reuses the previous set when membership is unchanged", () => {
    const previous = new Set(["a", "b"]);
    const next = new Set(["b", "a"]);

    expect(stabilizeReadonlyStringSet(next, previous)).toBe(previous);
  });

  it("returns the next set when membership changes", () => {
    const previous = new Set(["a"]);
    const next = new Set(["a", "b"]);

    expect(stabilizeReadonlyStringSet(next, previous)).toBe(next);
  });

  it("keeps the shared empty set stable across repeated empty collections", () => {
    const first = stabilizeReadonlyStringSet(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS, undefined);
    const second = stabilizeReadonlyStringSet(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS, first);
    expect(second).toBe(first);
    expect(second).toBe(EMPTY_REVIEW_OUTPUT_MESSAGE_IDS);
  });
});

describe("stabilizeStringMap", () => {
  it("reuses the previous map when entries are unchanged", () => {
    const previous = new Map([
      ["#1", "https://example.com/1"],
      ["#2", "https://example.com/2"],
    ]);
    const next = new Map([
      ["#1", "https://example.com/1"],
      ["#2", "https://example.com/2"],
    ]);

    expect(stabilizeStringMap(next, previous)).toBe(previous);
  });

  it("returns the next map when an entry value changes", () => {
    const previous = new Map([["#1", "https://example.com/1"]]);
    const next = new Map([["#1", "https://example.com/other"]]);

    expect(stabilizeStringMap(next, previous)).toBe(next);
  });
});

describe("stabilizeResponseMetaByTurnId", () => {
  const settled = TurnId.make("turn-settled");
  const active = TurnId.make("turn-active");

  it("reuses settled entry objects when only the active turn changes", () => {
    const settledEntry = { model: "mock-model", usedTokens: 100 };
    const previous = new Map([
      [settled, settledEntry],
      [active, { model: "mock-model", usedTokens: 1 }],
    ]);
    // Fresh objects with equal settled values, as rebuilt from threadActivities.
    const next = new Map([
      [settled, { model: "mock-model", usedTokens: 100 }],
      [active, { model: "mock-model", usedTokens: 2 }],
    ]);

    const stabilized = stabilizeResponseMetaByTurnId(next, previous);
    expect(stabilized).not.toBe(next);
    expect(stabilized.get(settled)).toBe(settledEntry);
    expect(stabilized.get(active)).toEqual({ model: "mock-model", usedTokens: 2 });
  });

  it("returns the previous map when every entry is identical", () => {
    const previous = new Map([[settled, { model: "mock-model" }]]);
    const next = new Map(previous);

    expect(stabilizeResponseMetaByTurnId(next, previous)).toBe(previous);
  });

  it("uses the new value when a settled entry value changes", () => {
    const previous = new Map([[settled, { model: "mock-model", usedTokens: 100 }]]);
    const next = new Map([[settled, { model: "mock-model", usedTokens: 101 }]]);

    const stabilized = stabilizeResponseMetaByTurnId(next, previous);
    expect(stabilized.get(settled)).toBe(next.get(settled));
  });
});

describe("deriveRevertTurnCountByUserMessageId", () => {
  const userEntry = (id: string): TimelineEntry => ({
    kind: "message",
    id: `entry-${id}`,
    createdAt: "2026-09-08T10:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role: "user",
      text: id,
      createdAt: "2026-09-08T10:00:00.000Z",
      streaming: false,
    },
  });
  const assistantEntry = (id: string, turnId: string): TimelineEntry => ({
    kind: "message",
    id: `entry-${id}`,
    createdAt: "2026-09-08T10:00:01.000Z",
    message: {
      id: MessageId.make(id),
      role: "assistant",
      text: id,
      turnId: TurnId.make(turnId),
      createdAt: "2026-09-08T10:00:01.000Z",
      streaming: false,
    },
  });
  const summaryFor = (
    messageId: string,
    turnId: string,
    checkpointTurnCount?: number,
  ): [string, TurnDiffSummary] => [
    messageId,
    {
      turnId: TurnId.make(turnId),
      completedAt: "2026-09-08T10:00:02.000Z",
      files: [],
      ...(checkpointTurnCount === undefined ? {} : { checkpointTurnCount }),
    },
  ];
  const derive = (
    timelineEntries: TimelineEntry[],
    summaries: Array<ReturnType<typeof summaryFor>>,
    inferred: Record<string, number> = {},
  ) =>
    deriveRevertTurnCountByUserMessageId({
      timelineEntries,
      turnDiffSummaryByAssistantMessageId: new Map(
        summaries.map(([messageId, summary]) => [MessageId.make(messageId), summary] as const),
      ),
      inferredCheckpointTurnCountByTurnId: inferred as Record<
        ReturnType<typeof TurnId.make>,
        number
      >,
    });

  it("resolves each user message against the first summarized assistant reply", () => {
    const result = derive(
      [userEntry("user-1"), assistantEntry("assistant-1", "turn-1")],
      [summaryFor("assistant-1", "turn-1", 3)],
    );
    expect([...result]).toEqual([[MessageId.make("user-1"), 2]]);
  });

  it("skips summary-less assistant messages and keeps scanning", () => {
    const result = derive(
      [
        userEntry("user-1"),
        assistantEntry("assistant-1", "turn-1"),
        assistantEntry("assistant-2", "turn-1"),
      ],
      [summaryFor("assistant-2", "turn-1", 2)],
    );
    expect([...result]).toEqual([[MessageId.make("user-1"), 1]]);
  });

  it("discards the pending user on a non-numeric summary", () => {
    const result = derive(
      [
        userEntry("user-1"),
        assistantEntry("assistant-1", "turn-1"),
        userEntry("user-2"),
        assistantEntry("assistant-2", "turn-2"),
      ],
      [summaryFor("assistant-1", "turn-1"), summaryFor("assistant-2", "turn-2", 4)],
    );
    // assistant-1's summary carries no count and no inferred count exists, so
    // user-1 is discarded while user-2 resolves normally.
    expect([...result]).toEqual([[MessageId.make("user-2"), 3]]);
  });

  it("discards the pending user when another user message follows", () => {
    const result = derive(
      [userEntry("user-1"), userEntry("user-2"), assistantEntry("assistant-2", "turn-2")],
      [summaryFor("assistant-2", "turn-2", 1)],
    );
    expect([...result]).toEqual([[MessageId.make("user-2"), 0]]);
  });

  it("falls back to inferred checkpoint counts and clamps at zero", () => {
    const result = derive(
      [userEntry("user-1"), assistantEntry("assistant-1", "turn-1")],
      [summaryFor("assistant-1", "turn-1")],
      { "turn-1": 1 },
    );
    expect([...result]).toEqual([[MessageId.make("user-1"), 0]]);
  });
});
