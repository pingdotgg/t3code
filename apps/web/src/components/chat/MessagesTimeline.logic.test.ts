import {
  CheckpointRef,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type WorkLogEntry,
} from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import type { TurnDiffSummary } from "../../types";
import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
  liveWorkEntryLabel,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveWorkGroupScrollIndex,
  shouldFollowWorkGroupAppend,
  shouldPreserveAssistantLineBreaks,
  type MessagesTimelineRow,
  resolveTimelineToolPresentation,
  summarizeToolGroup,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("expanded tool group scrolling", () => {
  const entries = [{ id: "first" }, { id: "second" }];

  it("follows appended calls only at the hard end", () => {
    const appended = [...entries, { id: "third" }];
    expect(shouldFollowWorkGroupAppend(entries, appended, 0)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, appended, 0.5)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, appended, 1)).toBe(true);
    expect(shouldFollowWorkGroupAppend(entries, appended, 1.01)).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, appended, 10)).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, appended, Infinity)).toBe(false);
  });

  it("does not follow output updates, prepends, or replacements", () => {
    expect(
      shouldFollowWorkGroupAppend(
        entries,
        entries.map((entry) => ({ ...entry })),
        0,
      ),
    ).toBe(false);
    expect(shouldFollowWorkGroupAppend(entries, [{ id: "older" }, ...entries], 0)).toBe(false);
    expect(
      shouldFollowWorkGroupAppend(
        entries,
        [{ id: "replacement" }, entries[1]!, { id: "third" }],
        0,
      ),
    ).toBe(false);
    expect(shouldFollowWorkGroupAppend([], entries, 0)).toBe(false);
  });

  it("restores the visible tool and its offset inside expanded output", () => {
    const anchor = { entryId: "second", offset: 120 };
    expect(resolveWorkGroupScrollIndex(entries, anchor)).toEqual({ index: 1, viewOffset: -120 });
    expect(resolveWorkGroupScrollIndex([{ id: "older" }, ...entries], anchor)).toEqual({
      index: 2,
      viewOffset: -120,
    });
  });

  it("starts normally when the saved tool no longer exists", () => {
    expect(resolveWorkGroupScrollIndex(entries, undefined)).toBeUndefined();
    expect(
      resolveWorkGroupScrollIndex(entries, { entryId: "removed", offset: 120 }),
    ).toBeUndefined();
  });
});

describe("work entry labels", () => {
  const entry = {
    id: "tool-1",
    createdAt: "2026-09-01T12:00:00Z",
    label: "Tool call",
    tone: "tool" as const,
  };

  it.each([
    ["inProgress", "Clicking in the preview browser"],
    ["completed", "Clicked in the preview browser"],
    ["failed", "Failed to click in the preview browser"],
    ["declined", "Declined to click in the preview browser"],
    ["stopped", "Stopped clicking in the preview browser"],
  ] as const)("uses the same friendly %s label in both views", (toolLifecycleStatus, label) => {
    const browserEntry = {
      ...entry,
      toolTitle: "T3-code.preview_click",
      detail: '{"ok":true}',
      toolLifecycleStatus,
    };
    expect(liveWorkEntryLabel(browserEntry, undefined, toolLifecycleStatus === "inProgress")).toBe(
      label,
    );
    expect(workEntryDisplayLabel(browserEntry, undefined)).toBe(label);
  });

  it("uses the active summary state for legacy tools without a lifecycle status", () => {
    const browserEntry = { ...entry, toolTitle: "T3-code.preview_click" };
    expect(liveWorkEntryLabel(browserEntry, undefined, true)).toBe(
      "Clicking in the preview browser",
    );
    expect(liveWorkEntryLabel(browserEntry, undefined, false)).toBe(
      "Clicked in the preview browser",
    );
  });

  it("keeps the latest live activity in the present tense after the call completes", () => {
    const browserEntry = {
      ...entry,
      toolTitle: "T3-code.preview_click",
      toolLifecycleStatus: "completed" as const,
    };
    expect(liveWorkEntryLabel(browserEntry, undefined, true)).toBe(
      "Clicking in the preview browser",
    );
    expect(liveWorkEntryLabel(browserEntry, undefined, false)).toBe(
      "Clicked in the preview browser",
    );
  });

  it("keeps custom titles and output for unrecognized tools", () => {
    const unknownEntry = { ...entry, toolTitle: "mcp__github__search_issues" };
    expect(liveWorkEntryLabel(unknownEntry, undefined, true)).toBe("Mcp__github__search_issues");
    expect(workEntryDisplayLabel({ ...unknownEntry, detail: "Found 3 issues" }, undefined)).toBe(
      "Found 3 issues",
    );
  });

  it("keeps command summaries compact without replacing the full command in expanded rows", () => {
    const commandEntry = { ...entry, command: "vp test run", detail: "All tests passed" };
    expect(liveWorkEntryLabel(commandEntry, undefined, true)).toBe("Running vp");
    expect(liveWorkEntryLabel(commandEntry, undefined, false)).toBe("Ran vp");
    expect(workEntryDisplayLabel(commandEntry, undefined)).toBe("vp test run");
  });

  it("summarizes the program inside a shell wrapper while preserving the expanded command", () => {
    const command = "/bin/zsh -lc 'vp test run apps/web/src/session-logic.test.ts'";
    const commandEntry = { ...entry, command };
    expect(liveWorkEntryLabel(commandEntry, undefined, true)).toBe("Running vp");
    expect(liveWorkEntryLabel(commandEntry, undefined, false)).toBe("Ran vp");
    expect(workEntryDisplayLabel(commandEntry, undefined)).toBe(command);
  });

  it.each([
    ["inProgress", "Running vp", "Running vp"],
    ["completed", "Running vp", "Ran vp"],
    ["failed", "Failed vp", "Failed vp"],
    ["declined", "Declined vp", "Declined vp"],
    ["stopped", "Stopped vp", "Stopped vp"],
  ] as const)(
    "uses present tense for a live %s command and the outcome once it is no longer live",
    (toolLifecycleStatus, liveLabel, settledLabel) => {
      const commandEntry = {
        ...entry,
        command: "/bin/bash -lc 'vp test run'",
        toolLifecycleStatus,
      };
      expect(liveWorkEntryLabel(commandEntry, undefined, true)).toBe(liveLabel);
      expect(liveWorkEntryLabel(commandEntry, undefined, false)).toBe(settledLabel);
    },
  );

  it.each([
    ["preview_click", "Clicked in the preview browser"],
    ["task_status", "Got delegated task status"],
  ] as const)(
    "renders a settled legacy %s call directly with its completed presentation",
    (tool, label) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "browser-entry",
            kind: "work",
            createdAt: entry.createdAt,
            entry: {
              ...entry,
              itemType: "dynamic_tool",
              toolData: { server: "t3-code", tool },
            },
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
      const directRow = rows.find((row) => row.kind === "work");
      expect(directRow).toMatchObject({
        groupedEntries: [expect.objectContaining({ id: "tool-1" })],
        isExpandedToolGroup: false,
        displayLabel: label,
      });
    },
  );
});

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
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

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
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
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
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
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
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

  it("copies the rendered representation of Codex directives", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: [
          'Created :codex-file-citation{path="outputs/report.xlsx" purpose="output"}.',
          "",
          '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
        ].join("\n"),
        streaming: false,
      }),
    ).toEqual({
      text: "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
      visible: true,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("keeps context compaction visible outside folded work", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "compaction-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "compaction",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Compacted context 899K → 19K tokens",
            tone: "info",
            sourceActivityKind: "context-compaction",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      {
        kind: "context-compaction",
        id: "compaction-entry",
        createdAt: "2026-01-01T00:00:00Z",
        label: "Compacted context 899K → 19K tokens",
      },
    ]);
  });

  it("only enables assistant copy for the terminal assistant message in a turn", () => {
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
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
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
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
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
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      runId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
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
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
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
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
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

  it("folds the first assistant message and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("keeps a tool group after the terminal response visible when the turn is folded", () => {
    const runId = RunId.make("turn-1");
    const timelineEntries = [
      {
        id: "work-entry-before-text",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-before-text",
          createdAt: "2026-01-01T00:00:01Z",
          runId,
          label: "Status updated",
          tone: "info" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "I could not finish the task.",
          runId,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `work-entry-after-text-${index}`,
        kind: "work" as const,
        createdAt: `2026-01-01T00:00:0${index + 7}Z`,
        entry: {
          id: `work-after-text-${index}`,
          createdAt: `2026-01-01T00:00:0${index + 7}Z`,
          runId,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          toolLifecycleStatus: "completed" as const,
        },
      })),
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      latestRun: {
        runId,
        status: "failed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "work-toggle:work-entry-after-text-0",
      "assistant-meta:assistant-final",
    ]);
    expect(rows.at(-2)).toMatchObject({
      kind: "work-toggle",
      hiddenCount: 3,
      summary: "Ran 3 commands",
    });
    expect(rows.at(-1)).toMatchObject({
      kind: "assistant-meta",
      message: { id: "assistant-final" },
      showAssistantCopyButton: true,
    });
    expect(rows.at(-3)).toMatchObject({
      kind: "message",
      showAssistantMeta: false,
      showAssistantCopyButton: false,
    });
  });

  it("folds all assistant messages before the terminal message", () => {
    const timelineEntries = [
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:01Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "The main result is ready.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:01Z",
          updatedAt: "2026-01-01T00:00:02Z",
          streaming: false,
        },
      },
      {
        id: "assistant-middle-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:03Z",
        message: {
          id: "assistant-middle" as never,
          role: "assistant" as const,
          text: "I am checking one more detail.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:03Z",
          updatedAt: "2026-01-01T00:00:04Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Verification finished.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-before-message",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "work-before-message",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Status updated",
            tone: "info" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            runId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        runId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestRun still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
      "live-activity-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: "thinking" });
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "assistant-thought-entry",
      "live-activity-row",
    ]);
  });

  it("keeps a promptless restart in one active visual response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "keep going",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "old-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "old-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-before-restart" as never,
            label: "Searched files",
            command: "rg restart",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "old-stale-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "old-stale-work",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-before-restart" as never,
            label: "Running stale command",
            command: "rg stale",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "old-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:08Z",
          message: {
            id: "old-commentary" as never,
            role: "assistant",
            text: "the server restarted, continuing here.",
            runId: "turn-before-restart" as never,
            createdAt: "2026-01-01T00:00:08Z",
            updatedAt: "2026-01-01T00:00:08Z",
            streaming: false,
          },
        },
        {
          id: "new-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "new-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-after-restart" as never,
            label: "Running tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-after-restart" as never,
        status: "running",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.filter((row) => row.id === "working-indicator-row")).toHaveLength(1);
    expect(rows.findIndex((row) => row.id === "working-indicator-row")).toBeLessThan(
      rows.findIndex((row) => row.id === "old-work-entry"),
    );
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(rows.find((row) => row.id === "old-commentary-entry")).toMatchObject({
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: true,
    });
    expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: "new-work" }) }),
    ]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("keeps an actually running tool in the shared activity row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Ran tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      active: true,
      groupedEntries: [
        { id: "running-command" },
        { id: "completed-edit" },
        { id: "completed-command" },
      ],
    });
  });

  it("renders a single completed tool call directly", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Checking another thing.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work", "message", "work-live"]);
    expect(rows.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [{ id: "completed-command", command: "rg toolCall" }],
      isExpandedToolGroup: false,
      displayLabel: "rg toolCall",
    });
  });

  it("keeps separated in-progress tool runs visible", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "first-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "first-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running first command",
            command: "rg first",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "second-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "second-running",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live", "message", "work-live"]);
    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "first-running",
      "second-running",
    ]);
  });

  it("does not revive stale in-progress tools before a fresh send has a turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running stale command",
            command: "rg stale",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
  });

  it("does not revive separated historical task progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-progress-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-progress",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Old progress",
            tone: "thinking" as const,
            sourceActivityKind: "task.progress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running command",
            command: "rg current",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "running-command",
    ]);
  });

  it.each([
    [undefined, true],
    ["inProgress", true],
    ["completed", false],
    ["failed", null],
    ["declined", false],
    ["stopped", false],
  ] as const)(
    "respects the %s lifecycle of trailing task progress",
    (toolLifecycleStatus, active) => {
      const runId = RunId.make("turn-task-progress");
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "task-progress-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:05Z",
            entry: {
              id: "task-progress",
              createdAt: "2026-01-01T00:00:05Z",
              runId,
              label: "Task progress",
              tone: "thinking",
              sourceActivityKind: "task.progress",
              ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
            },
          },
        ],
        latestRun: {
          runId,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

      const workLiveRow = rows.find((row) => row.kind === "work-live");
      if (active === null) {
        expect(workLiveRow).toBeUndefined();
        expect(rows.at(-1)).toMatchObject({ kind: "thinking", id: "live-activity-row" });
      } else {
        expect(workLiveRow).toMatchObject({ active });
      }
    },
  );

  it("reuses one activity row for initial thinking and the latest tool", () => {
    const deriveRows = (
      toolLifecycleStatus: "inProgress" | "completed" | "failed" | "declined" | null,
    ) =>
      deriveMessagesTimelineRows({
        timelineEntries:
          toolLifecycleStatus === null
            ? []
            : [
                {
                  id: "latest-command-entry",
                  kind: "work",
                  createdAt: "2026-01-01T00:00:05Z",
                  entry: {
                    id: "latest-command",
                    createdAt: "2026-01-01T00:00:05Z",
                    runId: "turn-1" as never,
                    label: toolLifecycleStatus === "inProgress" ? "Running rg" : "Ran rg",
                    command: "rg toolCall",
                    requestKind: "command",
                    tone: "tool" as const,
                    toolLifecycleStatus,
                    ...(toolLifecycleStatus === "inProgress" ? { detail: "exit code 1" } : {}),
                  },
                },
              ],
        latestRun: {
          runId: "turn-1" as never,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const initialRows = deriveRows(null);
    const runningRows = deriveRows("inProgress");
    const completedRows = deriveRows("completed");
    const failedRows = deriveRows("failed");
    const declinedRows = deriveRows("declined");
    const initialActivityRow = initialRows.find((row) => row.id === "live-activity-row");
    const runningActivityRow = runningRows.find((row) => row.id === "live-activity-row");
    const completedActivityRow = completedRows.find((row) => row.id === "live-activity-row");

    expect(initialActivityRow).toMatchObject({ kind: "thinking" });
    expect(runningActivityRow).toMatchObject({ kind: "work-live", active: true });
    expect(completedActivityRow).toMatchObject({ kind: "work-live", active: true });
    expect(failedRows.some((row) => row.kind === "work-live")).toBe(false);
    expect(failedRows.at(-1)).toMatchObject({ kind: "thinking", id: "live-activity-row" });
    expect(declinedRows.find((row) => row.kind === "work-live")).toMatchObject({ active: false });
    expect(declinedRows.at(-1)).toMatchObject({ kind: "thinking", id: "live-activity-row" });
    expect(initialRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(runningRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(completedRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(failedRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(declinedRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
  });

  it("does not fold the session's running turn when latestRun regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningRunId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.runId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("live-activity-row");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
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
            text: "Done.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
    expect(rows.at(-1)).toMatchObject({ kind: "thinking" });
  });

  it.each([
    ["tools", "tool", "Used 3 tools"],
    ["tools and status updates", "info", "Used 2 tools and received 1 update"],
  ] as const)("expands %s through the same activity group", (_, middleTone, summary) => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "Status updated",
          detail: "Editing MessagesTimeline.tsx",
          tone: middleTone,
          toolSurface: "computer" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
          toolSurface: "browser" as const,
          toolIcon: { _tag: "website" as const, pageUrl: "https://example.com/checkout" },
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 3,
      expanded: false,
      summary,
      toolSurface: "browser",
      toolIcon: { _tag: "website", pageUrl: "https://example.com/checkout" },
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-toggle:work-entry-1",
      "work-group:work-entry-1:details",
    ]);
    expect(expandedRows.find((row) => row.kind === "work")).toMatchObject({
      isExpandedToolGroup: true,
      groupedEntries: timelineEntries.map(({ entry }) => entry),
    });
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });

  it("deduplicates integration sources and uses the first source icon for the group", () => {
    const chromeSource = {
      key: "browser-use:chrome",
      name: "Chrome",
      kind: "integration" as const,
      icon: {
        _tag: "native-app" as const,
        app: { _tag: "display-name" as const, displayName: "Google Chrome" },
      },
    };
    const timelineEntries = [
      {
        id: "browser-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "browser-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "Open MATLAB",
          tone: "tool" as const,
          toolSurface: "browser" as const,
          toolSource: chromeSource,
          toolIcon: {
            _tag: "website" as const,
            pageUrl: "https://www.mathworks.com/help/matlab/",
          },
        },
      },
      {
        id: "browser-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "browser-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "Show summary",
          tone: "tool" as const,
          toolSurface: "browser" as const,
          toolSource: chromeSource,
          toolIcon: {
            _tag: "website" as const,
            pageUrl: "https://www.mathworks.com/help/matlab/summary.html",
          },
        },
      },
      {
        id: "command-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "command-1",
          createdAt: "2026-01-01T00:00:03Z",
          label: "Ran command",
          command: "git status",
          itemType: "command_execution" as const,
          tone: "tool" as const,
        },
      },
    ];
    const [row] = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(row).toMatchObject({
      kind: "work-toggle",
      summary: "Used Chrome integration and ran 1 command",
      toolSurface: "browser",
      toolIcon: {
        _tag: "website",
        pageUrl: "https://www.mathworks.com/help/matlab/",
      },
    });
  });

  it.each([true, false])(
    "keeps a large expanded tool run inside one timeline item, live=%s",
    (isWorking) => {
      const runId = RunId.make("turn-many-tools");
      const createdAt = "2026-09-01T12:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `tool-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `tool-${index}`,
          toolCallId: `call-${index}`,
          createdAt,
          runId,
          label: "t3-code.preview_snapshot",
          tone: "tool" as const,
          toolLifecycleStatus:
            isWorking && index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const input = {
        timelineEntries,
        isWorking,
        expandedRunIds: new Set([runId]),
        runningRunId: isWorking ? runId : null,
        activeTurnStartedAt: isWorking ? createdAt : null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      };
      const collapsedRows = deriveMessagesTimelineRows(input);
      const collapsedGroup = collapsedRows.find(
        (row) => row.kind === "work-toggle" || row.kind === "work-live",
      );
      expect(collapsedGroup).toBeDefined();
      const groupId = collapsedGroup!.groupId;
      const expandedRows = deriveMessagesTimelineRows({
        ...input,
        expandedWorkGroupIds: new Set([groupId]),
      });
      const groupRows = expandedRows.filter((row) => row.kind === "work");
      expect(groupRows).toHaveLength(1);
      expect(groupRows[0]?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(groupRows[0]?.id).toBe(`${groupId}:details`);
      expect(deriveMessagesTimelineRows(input).some((row) => row.kind === "work")).toBe(false);
    },
  );

  it.each([
    ["recovered", ["failed", "completed"], false],
    ["ending in failure", ["completed", "failed"], true],
    ["failed", ["failed", "failed"], true],
  ] as const)("uses the final call for %s tool groups", (_, statuses, hasFailure) => {
    const timelineEntries = statuses.map((status, index) => ({
      id: `work-entry-${index}`,
      kind: "work" as const,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      entry: {
        id: `work-${index}`,
        createdAt: `2026-01-01T00:00:0${index}Z`,
        label: "Ran command",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        toolLifecycleStatus: status,
      },
    }));

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      hasFailure,
    });
  });

  it.each([
    ["the later success is hidden", ["failed", "completed", "info"], false],
    ["the later success is visible", ["failed", "info", "completed"], false],
    ["an error-toned entry recovers", ["error", "info", "completed"], false],
    ["the final failure is hidden", ["completed", "failed", "info"], true],
    ["the final failure is visible", ["failed", "info", "failed"], true],
    ["the only failure is visible", ["completed", "info", "failed"], true],
  ] as const)(
    "uses the final tool call for mixed work groups when %s",
    (_, statuses, hasFailure) => {
      const timelineEntries = statuses.map((status, index) => {
        const id = `work-${index}`;
        const createdAt = `2026-01-01T00:00:0${index}Z`;

        return {
          id: `work-entry-${index}`,
          kind: "work" as const,
          createdAt,
          entry:
            status === "info"
              ? { id, createdAt, label: "Status updated", tone: "info" as const }
              : status === "error"
                ? { id, createdAt, label: "Command failed", tone: "error" as const }
                : {
                    id,
                    createdAt,
                    label: "Ran command",
                    tone: "tool" as const,
                    toolLifecycleStatus: status,
                  },
        };
      });

      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

      expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
        hiddenCount: statuses.some((status) => status === "error") ? 2 : 3,
        summary: statuses.some((status) => status === "error")
          ? "Received 1 update and used 1 tool"
          : "Used 2 tools and received 1 update",
        hasFailure,
      });
      if (statuses.some((status) => status === "error")) {
        expect(rows[0]).toMatchObject({
          kind: "work",
          groupedEntries: [{ tone: "error", label: "Command failed" }],
        });
      }
    },
  );
});

describe("computeStableMessagesTimelineRows", () => {
  it("replaces a cached work toggle when its icon presentation changes", () => {
    const initialRow: MessagesTimelineRow = {
      kind: "work-toggle",
      id: "work-toggle:1",
      createdAt: "2026-01-01T00:00:00Z",
      groupId: "work-group:1",
      hiddenCount: 1,
      expanded: false,
      summary: "Used Browser",
      summaryKind: "other",
      toolSurface: "browser",
      hasFailure: false,
    };
    const initial = computeStableMessagesTimelineRows([initialRow], {
      byId: new Map(),
      result: [],
    });
    const enrichedRow: MessagesTimelineRow = {
      ...initialRow,
      toolIcon: { _tag: "website", pageUrl: "https://example.com" },
    };

    const updated = computeStableMessagesTimelineRows([enrichedRow], initial);

    expect(updated).not.toBe(initial);
    expect(updated.result[0]).toBe(enrichedRow);
  });

  it.each(["", " \n"])("keeps Thinking after assistant content grows from %j", (text) => {
    const startedAt = "2026-01-01T00:00:00Z";
    const runId = RunId.make("turn-1");
    const input = {
      runningRunId: runId,
      isWorking: true,
      activeTurnStartedAt: startedAt,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const assistantEntry = {
      id: "assistant-entry",
      kind: "message" as const,
      createdAt: startedAt,
      message: {
        id: MessageId.make("assistant-1"),
        role: "assistant" as const,
        text,
        runId,
        createdAt: startedAt,
        updatedAt: startedAt,
        streaming: true,
      },
    };
    const initial = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({ ...input, timelineEntries: [assistantEntry] }),
      { byId: new Map(), result: [] },
    );
    const updated = computeStableMessagesTimelineRows(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: [
          {
            ...assistantEntry,
            message: { ...assistantEntry.message, text: "I will inspect the repository." },
          },
        ],
      }),
      initial,
    );

    const initialThinking = initial.byId.get("live-activity-row");
    const updatedThinking = updated.byId.get("live-activity-row");
    expect(initialThinking).toMatchObject({ kind: "thinking" });
    expect(updatedThinking).toBe(initialThinking);
    expect(updated.result.at(-1)).toBe(updatedThinking);
  });

  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      runId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
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
      isWorking: false,
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

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      runId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
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
      isWorking: false,
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
});

describe("summarizeToolGroup", () => {
  const now = DateTime.makeUnsafe("2026-08-29T00:00:00Z");
  function work(overrides: Partial<WorkLogEntry> = {}): WorkLogEntry {
    return {
      id: "tool",
      createdAt: "2026-08-29T00:00:00Z",
      label: "Tool call",
      tone: "tool",
      toolLifecycleStatus: "completed",
      ...overrides,
    };
  }
  function t3(toolName: string, input: unknown = {}, output: unknown = {}): WorkLogEntry {
    return work({
      itemType: "dynamic_tool",
      toolTitle: "Friendly display name",
      structuredPayload: {
        id: TurnItemId.make("tool"),
        threadId: ThreadId.make("parent"),
        runId: RunId.make("run"),
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: "Friendly display name",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "dynamic_tool",
        toolName,
        input,
        output,
      },
    });
  }

  it("summarizes commands and thread messages using canonical names despite humanized titles", () => {
    const entries = [
      work({ command: "git diff" }),
      ...["mcp__t3-code__t3_thread_send", "t3_code.t3_thread_send", "t3_thread_send"].map(
        (toolName, i) =>
          t3(
            toolName,
            { threadId: `thread-${i}` },
            { messageId: `message-${i}`, threadId: `thread-${i}` },
          ),
      ),
      work({ command: "git status" }),
    ];
    expect(summarizeToolGroup(entries)).toEqual({
      summary: "Ran 2 commands and sent messages to 3 threads",
      hasFailure: false,
    });
  });

  it("prioritizes actions over polling, caps the clauses, and retains an omitted failure", () => {
    const status = t3("task_status", { taskId: "task-1" }, { taskId: "task-1", status: "running" });
    expect(
      summarizeToolGroup([
        status,
        status,
        status,
        work({ command: "git diff" }),
        t3(
          "t3_thread_send",
          { threadId: "thread-1" },
          { threadId: "thread-1", messageId: "message-1" },
        ),
        t3(
          "schedule_task",
          {},
          { isError: true, content: [{ type: "text", text: "Schedule rejected" }] },
        ),
        status,
      ]),
    ).toEqual({
      summary: "Ran 1 command, sent 1 message to 1 thread, and performed 5 other actions",
      hasFailure: true,
    });
  });

  it("counts status checks without treating the reported child failure as a failed tool", () => {
    const status = {
      ...t3("task_status", { taskId: "task-1" }, { taskId: "task-1", status: "failed" }),
      detail: "Child failed: command not found",
    };
    expect(
      summarizeToolGroup([
        t3("delegate_task", {}, { taskId: "task-1" }),
        t3("delegate_task", {}, { taskId: "task-2" }),
        status,
        status,
        status,
        status,
      ]),
    ).toEqual({
      summary: "Delegated 2 tasks and checked task status 4 times",
      hasFailure: false,
    });
  });

  it("leaves foreign, unknown, and preview tools generic instead of guessing from display titles", () => {
    expect(
      summarizeToolGroup([
        { ...t3("mcp__github__t3_thread_send"), toolTitle: "t3-code.t3_thread_send" },
        t3("t3-code.future_tool"),
        t3("t3-code.preview_snapshot"),
      ]),
    ).toEqual({ summary: "Used 3 tools", hasFailure: false });
  });
});

describe("resolveTimelineToolPresentation", () => {
  it("pretty prints Claude and Cursor T3 MCP tool names", () => {
    expect(resolveTimelineToolPresentation("mcp__t3-code__t3_thread_read")).toEqual({
      displayName: "Read a T3 thread",
      logo: "t3-code",
    });
  });

  it("pretty prints Codex T3 MCP tool names", () => {
    expect(resolveTimelineToolPresentation("t3-code.create_threads")).toEqual({
      displayName: "Create T3 threads",
      logo: "t3-code",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveTimelineToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "t3-code",
    });
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveTimelineToolPresentation("mcp__github__search_issues")).toBeNull();
  });
});

describe("v2 run and attempt history", () => {
  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    // Expanding the activity preserves tool output and provider recovery details.
    const expandedWork = openedActivity.find((row) => row.kind === "work");
    expect(expandedWork?.kind === "work" ? expandedWork.groupedEntries : []).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });
  it("keeps persistent cards after the Worked-for row when they arrive before commentary", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Spawn a subagent",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "subagent-card-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:03Z",
        projectedItem: {
          item: {
            type: "subagent",
            runId: "turn-1",
          },
        } as never,
      },
      {
        id: "assistant-commentary-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-commentary" as never,
          role: "assistant" as const,
          text: "I spawned the subagent.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Subagent says: Hello.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "subagent-card-entry",
      "assistant-final-entry",
    ]);
  });
  it("collapses only output from a superseded V2 attempt within the active logical run", () => {
    const runId = "run-steered" as never;
    const supersededAttemptId = "attempt-1" as never;
    const activeAttemptId = "attempt-2" as never;
    const supersededAttempt = {
      id: supersededAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
    };
    const activeAttempt = {
      id: activeAttemptId,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
    };
    const timelineEntries = [
      {
        id: "initial-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        message: {
          id: "initial-user" as never,
          role: "user" as const,
          text: "Build it",
          runId,
          inputIntent: "turn_start" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:02Z",
        attempt: supersededAttempt,
        message: {
          id: "superseded-assistant" as never,
          role: "assistant" as const,
          text: "Partial old response",
          runId,
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:03Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        attempt: supersededAttempt,
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:04Z",
          runId,
          label: "Old command",
          tone: "tool" as const,
        },
      },
      {
        id: "superseded-thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:04.500Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "steer-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        attempt: activeAttempt,
        message: {
          id: "steer-user" as never,
          role: "user" as const,
          text: "Change direction",
          runId,
          inputIntent: "steer" as const,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
      },
      {
        id: "active-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:06Z",
        attempt: activeAttempt,
        message: {
          id: "active-assistant" as never,
          role: "assistant" as const,
          text: "Current response",
          runId,
          createdAt: "2026-01-01T00:00:06Z",
          updatedAt: "2026-01-01T00:00:07Z",
          streaming: true,
        },
      },
    ];
    const common = {
      timelineEntries,
      latestRun: {
        runId,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };

    const collapsedRows = deriveMessagesTimelineRows(common);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    expect(collapsedRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      attemptId: supersededAttemptId,
      runId,
      label: "Superseded attempt",
      expanded: false,
    });

    const expandedRows = deriveMessagesTimelineRows({
      ...common,
      expandedAttemptIds: new Set([supersededAttemptId]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-assistant-entry",
      "superseded-work-entry",
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
  });
  it("hides the interruption request while keeping intervening work and the result", () => {
    const runId = "turn-1" as never;
    const interruptEvent = (type: "run_interrupt_request" | "run_interrupt_result") => ({
      position: type === "run_interrupt_request" ? 0 : 2,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-${type}` as never,
      item: {
        id: `item-${type}`,
        threadId: "thread-1",
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: type === "run_interrupt_request" ? 0 : 2,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type,
        message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: interruptEvent("run_interrupt_request") as never,
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:02Z",
            runId,
            label: "Finishing tool output",
            tone: "tool",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual(["work-entry", "interrupt-result"]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
  });
});

describe("streaming v2 row projection", () => {
  function fixture(text = "") {
    const source = makeStreamingTimelineFixture(text);
    const timelineInput = { visibleTurnItems: source.visibleTurnItems, optimisticMessages: [] };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
    const input = {
      timelineEntries: timeline.entries,
      latestRun: {
        runId: source.runId,
        status: "running" as const,
        startedAt: source.time(5),
        completedAt: null,
      },
      runningRunId: source.runId,
      isWorking: true,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaryByAssistantMessageId: new Map<MessageId, TurnDiffSummary>([
        [
          MessageId.make("history-assistant"),
          {
            runId: source.historyRunId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/checkpoints/history"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("history-assistant"),
            completedAt: source.time(4),
          },
        ],
      ]),
      revertTurnCountByUserMessageId: new Map([[MessageId.make("history-user"), 0]]),
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { ...source, timelineInput, timeline, input };
  }

  function updateText(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, text: string) {
    return items.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? {
            ...row,
            item: { ...row.item, text, updatedAt: DateTime.makeUnsafe("2026-09-04T00:00:08.000Z") },
          }
        : row,
    );
  }

  it.each([
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ])("keeps row parity and history identity from %j to %j", (before, after) => {
    const initial = fixture(before);
    const previous = deriveMessagesTimelineRowsWithState(initial.input);
    Object.freeze(previous.rows);
    for (const row of previous.rows) Object.freeze(row);
    const timelineInput = {
      ...initial.timelineInput,
      visibleTurnItems: updateText(initial.visibleTurnItems, after),
    };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      timelineInput,
      initial.timeline,
    );
    // The actual v2 selectors recreate shell/checkpoint summaries and maps on
    // every projection event, even when their contents did not change.
    const input = {
      ...initial.input,
      timelineEntries: timeline.entries,
      latestRun: { ...initial.input.latestRun },
      turnDiffSummaryByAssistantMessageId: new Map(
        [...initial.input.turnDiffSummaryByAssistantMessageId].map(([key, value]) => [
          key,
          { ...value },
        ]),
      ),
      revertTurnCountByUserMessageId: new Map(initial.input.revertTurnCountByUserMessageId),
    };
    const next = deriveMessagesTimelineRowsWithState(input, previous);
    expect(next.rows).toEqual(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
      }),
    );
    for (const [index, row] of previous.rows.entries()) {
      if (
        (row.kind === "message" || row.kind === "assistant-meta") &&
        row.message.id === "live-assistant"
      ) {
        expect(next.rows[index]).toMatchObject({ message: { text: after } });
        expect(next.rows[index]).toHaveProperty(
          "projectedItem",
          timelineInput.visibleTurnItems.at(-1),
        );
        expect(row.message.text).toBe(before);
      } else {
        expect(next.rows[index]).toBe(row);
      }
    }
  });

  it.each(["file", "image", "handoff", "streaming-image"] as const)(
    "keeps history references with %s previews through the v2 materializer",
    (kind) => {
      const initial = fixture("Partial");
      const image = {
        type: "image" as const,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 42,
      };
      const file = {
        type: "file" as const,
        id: "file",
        name: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
      };
      const timelineInput = {
        ...initial.timelineInput,
        visibleTurnItems: initial.visibleTurnItems.map((row, index) =>
          (row.item.type === "user_message" && index === 0) ||
          (row.item.type === "assistant_message" &&
            row.item.streaming &&
            kind === "streaming-image")
            ? {
                ...row,
                item: { ...row.item, attachments: kind === "file" ? [file] : [image, file] },
              }
            : row,
        ),
        attachmentUrlById: new Map([
          [image.id, kind === "handoff" ? "blob:handoff" : "https://server.test/image"],
        ]),
      };
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const previous = deriveMessagesTimelineRowsWithState(input);
      const nextTimelineInput = {
        ...timelineInput,
        visibleTurnItems: updateText(timelineInput.visibleTurnItems, "Next token"),
        attachmentUrlById: new Map(timelineInput.attachmentUrlById),
      };
      const nextTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        nextTimelineInput,
        timeline,
      );
      const nextInput = { ...input, timelineEntries: nextTimeline.entries };
      const next = deriveMessagesTimelineRowsWithState(nextInput, previous);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(nextInput));
      for (const [index, row] of previous.rows.entries()) {
        if (
          (row.kind === "message" || row.kind === "assistant-meta") &&
          row.message.id === "live-assistant"
        )
          continue;
        expect(next.rows[index]).toBe(row);
      }
      const renewedInput = {
        ...nextTimelineInput,
        attachmentUrlById: new Map([[image.id, "https://renewed.test/image"]]),
      };
      const renewedTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        renewedInput,
        nextTimeline,
      );
      const renewedRowsInput = { ...input, timelineEntries: renewedTimeline.entries };
      const renewed = deriveMessagesTimelineRowsWithState(renewedRowsInput, next);
      expect(renewed.rows).toEqual(deriveMessagesTimelineRows(renewedRowsInput));
      if (kind !== "file") {
        expect(renewed.rows.find((row) => row.id === "history-user")).toMatchObject({
          message: { attachments: [{ previewUrl: "https://renewed.test/image" }, file] },
        });
      }
    },
  );

  it("leaves emitted rows immutable when a projection branches", () => {
    const initial = fixture("Initial");
    const previous = deriveMessagesTimelineRowsWithState(initial.input);
    const branch = (text: string) => {
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        { ...initial.timelineInput, visibleTurnItems: updateText(initial.visibleTurnItems, text) },
        initial.timeline,
      );
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const next = deriveMessagesTimelineRowsWithState(input, previous);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(input));
      return next;
    };
    const first = branch("First");
    branch("Second");
    expect(first.rows.find((row) => row.id === "live-assistant")).toMatchObject({
      message: { text: "First" },
    });
    expect(previous.rows.find((row) => row.id === "live-assistant")).toMatchObject({
      message: { text: "Initial" },
    });
  });

  it("rebuilds for completion, late failure, metadata, expansion, and older history", () => {
    const initial = fixture("Partial");
    let timeline = initial.timeline;
    let timelineInput = initial.timelineInput;
    let input: Parameters<typeof deriveMessagesTimelineRows>[0] = initial.input;
    let projection = deriveMessagesTimelineRowsWithState(input);
    const check = (changes: Partial<typeof input> = {}) => {
      const previous = projection;
      timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
      input = { ...input, ...changes, timelineEntries: timeline.entries };
      projection = deriveMessagesTimelineRowsWithState(input, previous);
      expect(projection.rows).toEqual(
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
        }),
      );
      expect(previous.rows).toEqual(deriveMessagesTimelineRows(previous.input));
    };
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? {
              ...row,
              item: {
                ...row.item,
                streaming: false,
                status: "completed",
                text: "Complete",
                updatedAt: DateTime.makeUnsafe(initial.time(9)),
              },
            }
          : row,
      ),
    };
    check({
      latestRun: { ...initial.input.latestRun, status: "completed", completedAt: initial.time(9) },
      runningRunId: null,
      isWorking: false,
    });
    const lateFailure = initial.visibleTurnItems[1]!;
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        ...timelineInput.visibleTurnItems,
        {
          ...lateFailure,
          position: 6,
          sourceItemId: TurnItemId.make("late-failure"),
          item: {
            ...lateFailure.item,
            id: TurnItemId.make("late-failure"),
            runId: initial.runId,
            ordinal: 10,
            startedAt: DateTime.makeUnsafe(initial.time(10)),
          },
        },
      ],
    };
    check();
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.messageId === "live-assistant"
          ? {
              ...row,
              item: {
                ...row.item,
                text: "Corrected final text",
                updatedAt: DateTime.makeUnsafe(initial.time(11)),
              },
            }
          : row,
      ),
    };
    check();
    check({
      latestRun: {
        ...initial.input.latestRun,
        status: "interrupted",
        completedAt: initial.time(12),
      },
    });
    check({ expandedRunIds: new Set([initial.historyRunId, initial.runId]) });
    const group = projection.rows.find((row) => row.kind === "work-toggle");
    check({ expandedWorkGroupIds: new Set(group ? [group.groupId] : []) });
    const first = initial.visibleTurnItems[0]!;
    if (first.item.type !== "user_message") throw new Error("Expected user fixture");
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        {
          ...first,
          sourceItemId: TurnItemId.make("older-user-item"),
          item: {
            ...first.item,
            id: TurnItemId.make("older-user-item"),
            messageId: MessageId.make("older-user"),
            startedAt: DateTime.makeUnsafe(initial.time(-60)),
          },
        },
        ...timelineInput.visibleTurnItems,
      ].map((row, position) => ({ ...row, position })),
    };
    check();
    check({ revertTurnCountByUserMessageId: new Map([[MessageId.make("live-user"), 3]]) });
    check({
      turnDiffSummaryByAssistantMessageId: new Map(
        [...initial.input.turnDiffSummaryByAssistantMessageId].map(([key, value]) => [
          key,
          { ...value, status: "stale" },
        ]),
      ),
    });
  });
});
