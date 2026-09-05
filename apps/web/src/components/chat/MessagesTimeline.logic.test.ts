import { describe, expect, it } from "vite-plus/test";
import { CheckpointRef, MessageId, TurnId } from "@t3tools/contracts";
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
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";
import {
  createMessageAttachmentPreviewProjector,
  deriveTimelineEntries,
  deriveTimelineEntriesWithState,
  type WorkLogEntry,
} from "../../session-logic";
import { buildRevertTurnCountByUserMessageId } from "../ChatView.logic";
import { isImageAttachment, type ChatMessage, type TurnDiffSummary } from "../../types";

describe("streaming row projection", () => {
  function fixture(text = "") {
    const turnId = TurnId.make("live-turn");
    const historyTurnId = TurnId.make("history-turn");
    const time = (second: number) => new Date(Date.UTC(2026, 8, 4, 0, 0, second)).toISOString();
    const messages: ChatMessage[] = [
      {
        id: MessageId.make("history-user"),
        role: "user",
        text: "Inspect",
        turnId: null,
        createdAt: time(0),
        updatedAt: time(0),
        streaming: false,
      },
      {
        id: MessageId.make("history-assistant"),
        role: "assistant",
        text: "Done",
        turnId: historyTurnId,
        createdAt: time(3),
        updatedAt: time(4),
        streaming: false,
      },
      {
        id: MessageId.make("live-user"),
        role: "user",
        text: "Continue",
        turnId: null,
        createdAt: time(5),
        updatedAt: time(5),
        streaming: false,
      },
      {
        id: MessageId.make("live-assistant"),
        role: "assistant",
        text,
        turnId,
        createdAt: time(7),
        updatedAt: time(7),
        streaming: true,
      },
    ];
    const work: WorkLogEntry[] = [
      {
        id: "history-work",
        turnId: historyTurnId,
        createdAt: time(1),
        label: "Ran command",
        tone: "tool",
        command: "vp test",
        toolCallId: "history-tool",
        toolLifecycleStatus: "failed",
        sourceActivityKind: "tool.completed",
      },
      {
        id: "live-work",
        turnId,
        createdAt: time(6),
        label: "Read file",
        tone: "tool",
        changedFiles: ["/repo/src/index.ts"],
        toolCallId: "live-tool",
        toolLifecycleStatus: "completed",
        sourceActivityKind: "tool.completed",
      },
    ];
    const timeline = deriveTimelineEntriesWithState(messages, [], work);
    const input = {
      timelineEntries: timeline.entries,
      latestTurn: { turnId, state: "running", startedAt: time(5), completedAt: null },
      runningTurnId: turnId,
      isWorking: true,
      activeTurnStartedAt: time(5),
      turnDiffSummaryByAssistantMessageId: new Map<MessageId, TurnDiffSummary>(),
      revertTurnCountByUserMessageId: new Map<MessageId, number>(),
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { messages, work, timeline, input, time, turnId, historyTurnId };
  }

  it.each([
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ])("keeps row parity and history identity when text changes from %j to %j", (before, after) => {
    const initial = fixture(before);
    const previous = deriveMessagesTimelineRowsWithState(initial.input);
    Object.freeze(previous.rows);
    for (const row of previous.rows) Object.freeze(row);
    const last = initial.messages.at(-1)!;
    const messages = [
      ...initial.messages.slice(0, -1),
      { ...last, text: after, updatedAt: initial.time(8) },
    ];
    const timeline = deriveTimelineEntriesWithState(messages, [], initial.work, initial.timeline);
    const input = { ...initial.input, timelineEntries: timeline.entries };
    const next = deriveMessagesTimelineRowsWithState(input, previous);

    expect(next.rows).toEqual(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: deriveTimelineEntries(messages, [], initial.work),
      }),
    );
    for (const [index, row] of previous.rows.entries()) {
      if ((row.kind === "message" || row.kind === "assistant-meta") && row.message === last) {
        expect(next.rows[index]).toMatchObject({ message: { text: after } });
        expect(row.message.text).toBe(before);
      } else {
        expect(next.rows[index]).toBe(row);
      }
    }
  });

  it("keeps earlier emitted rows unchanged across two projection branches", () => {
    const initial = fixture();
    const previous = deriveMessagesTimelineRowsWithState(initial.input);
    const last = initial.messages.at(-1)!;
    const branch = (text: string) => {
      const messages = [...initial.messages.slice(0, -1), { ...last, text }];
      const timeline = deriveTimelineEntriesWithState(messages, [], initial.work, initial.timeline);
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const projection = deriveMessagesTimelineRowsWithState(input, previous);
      expect(projection.rows).toEqual(deriveMessagesTimelineRows(input));
      return projection;
    };
    const first = branch("First branch");
    const savedFirst = structuredClone(first.rows);
    branch("Second branch");
    expect(first.rows).toEqual(savedFirst);
    expect(previous.rows).toEqual(deriveMessagesTimelineRows(initial.input));
  });

  it.each(["file", "image", "handoff", "streaming-image"] as const)(
    "preserves stream reuse through the real %s preview materializer",
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
      const source = initial.messages.map((message, index) =>
        index === 0 || (kind === "streaming-image" && index === initial.messages.length - 1)
          ? { ...message, attachments: kind === "file" ? [file] : [image, file] }
          : message,
      );
      const server = createMessageAttachmentPreviewProjector();
      const handoff = createMessageAttachmentPreviewProjector();
      const materialize = (messages: ReadonlyArray<ChatMessage>, url: string) => {
        const urls = new Map(kind === "handoff" ? [] : [[image.id, url]]);
        return messages.map((message) => {
          const displayed = server(message, (attachment) => urls.get(attachment.id));
          return kind === "handoff" && message.role === "user"
            ? handoff(displayed, (attachment) =>
                isImageAttachment(attachment) ? "blob:handoff" : undefined,
              )
            : displayed;
        });
      };
      const firstMessages = materialize(source, "https://first.test/image");
      const firstTimeline = deriveTimelineEntriesWithState(firstMessages, [], initial.work);
      const input = { ...initial.input, timelineEntries: firstTimeline.entries };
      const previous = deriveMessagesTimelineRowsWithState(input);
      const saved = structuredClone(previous.rows);
      const nextSource = [...source.slice(0, -1), { ...source.at(-1)!, text: "Next token" }];
      const nextMessages = materialize(nextSource, "https://first.test/image");
      const nextTimeline = deriveTimelineEntriesWithState(
        nextMessages,
        [],
        initial.work,
        firstTimeline,
      );
      const nextInput = { ...input, timelineEntries: nextTimeline.entries };
      const next = deriveMessagesTimelineRowsWithState(nextInput, previous);

      expect(nextMessages[0]).toBe(firstMessages[0]);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(nextInput));
      for (const [index, row] of previous.rows.entries()) {
        if (
          (row.kind === "message" || row.kind === "assistant-meta") &&
          row.message.id === source.at(-1)?.id
        )
          continue;
        expect(next.rows[index]).toBe(row);
      }
      expect(previous.rows).toEqual(saved);

      if (kind === "image" || kind === "streaming-image") {
        const renewed = materialize(nextSource, "https://renewed.test/image");
        const renewedTimeline = deriveTimelineEntriesWithState(
          renewed,
          [],
          initial.work,
          nextTimeline,
        );
        const renewedInput = { ...input, timelineEntries: renewedTimeline.entries };
        const renewedRows = deriveMessagesTimelineRowsWithState(renewedInput, next);
        expect(renewedRows.rows).toEqual(deriveMessagesTimelineRows(renewedInput));
        expect(renewed[0]?.attachments?.[0]).toMatchObject({
          previewUrl: "https://renewed.test/image",
        });
        expect(firstMessages[0]?.attachments?.[0]).toMatchObject({
          previewUrl: "https://first.test/image",
        });
      }
    },
  );

  it("reuses rows when the revert map is rebuilt from the streamed entries", () => {
    const initial = fixture("Partial");
    const inferredCheckpointTurnCountByTurnId = { [initial.historyTurnId]: 1 };
    const turnDiffSummaryByAssistantMessageId = new Map<MessageId, TurnDiffSummary>([
      [
        MessageId.make("history-assistant"),
        {
          turnId: initial.historyTurnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/history-turn"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("history-assistant"),
          completedAt: initial.time(4),
        },
      ],
    ]);
    let revertMap: Map<MessageId, number> | null = null;
    // Mirrors ChatView: the map is derived from each delta's entries.
    const build = (timelineEntries: typeof initial.timeline.entries) => {
      revertMap = buildRevertTurnCountByUserMessageId(
        {
          supportsConversationRollback: true,
          timelineEntries,
          turnDiffSummaryByAssistantMessageId,
          inferredCheckpointTurnCountByTurnId,
        },
        revertMap,
      );
      return {
        ...initial.input,
        timelineEntries,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId: revertMap,
      };
    };
    const previous = deriveMessagesTimelineRowsWithState(build(initial.timeline.entries));
    expect(previous.rows.some((row) => row.kind === "message" && row.revertTurnCount === 0)).toBe(
      true,
    );
    const last = initial.messages.at(-1)!;
    const messages = [...initial.messages.slice(0, -1), { ...last, text: "Partial token" }];
    const timeline = deriveTimelineEntriesWithState(messages, [], initial.work, initial.timeline);
    const next = deriveMessagesTimelineRowsWithState(build(timeline.entries), previous);

    expect(next.rows).toEqual(deriveMessagesTimelineRows(build(timeline.entries)));
    for (const [index, row] of previous.rows.entries()) {
      if ((row.kind === "message" || row.kind === "assistant-meta") && row.message === last) {
        expect(next.rows[index]).toMatchObject({ message: { text: "Partial token" } });
      } else {
        expect(next.rows[index]).toBe(row);
      }
    }
  });

  it.each(["completion", "turn", "role", "ordering"] as const)(
    "rebuilds row structure for a %s change with otherwise unchanged controls",
    (change) => {
      const initial = fixture("Partial");
      const input = {
        ...initial.input,
        latestTurn: {
          ...initial.input.latestTurn,
          state: "completed" as const,
          completedAt: initial.time(9),
        },
        runningTurnId: null,
        isWorking: false,
      };
      const previous = deriveMessagesTimelineRowsWithState(input);
      const last = initial.messages.at(-1)!;
      const changed: ChatMessage =
        change === "completion"
          ? { ...last, streaming: false, updatedAt: initial.time(10) }
          : change === "turn"
            ? { ...last, turnId: initial.historyTurnId }
            : change === "role"
              ? { ...last, role: "user", turnId: null }
              : { ...last, createdAt: initial.time(0) };
      const messages = [...initial.messages.slice(0, -1), changed];
      const timeline = deriveTimelineEntriesWithState(messages, [], initial.work, initial.timeline);
      const nextInput = { ...input, timelineEntries: timeline.entries };
      const next = deriveMessagesTimelineRowsWithState(nextInput, previous);
      expect(next.rows).toEqual(
        deriveMessagesTimelineRows({
          ...nextInput,
          timelineEntries: deriveTimelineEntries(messages, [], initial.work),
        }),
      );
      expect(previous.rows).toEqual(deriveMessagesTimelineRows(input));
    },
  );

  it("keeps full parity through completion, trailing failure, metadata, expansion, and paging", () => {
    const initial = fixture("Partial");
    let timeline = initial.timeline;
    let input: Parameters<typeof deriveMessagesTimelineRows>[0] = initial.input;
    let projection = deriveMessagesTimelineRowsWithState(input);
    let messages = initial.messages;
    let work = initial.work;
    const check = (changes: Partial<typeof input> = {}) => {
      const oldRows = structuredClone(projection.rows);
      const previous = projection;
      timeline = deriveTimelineEntriesWithState(messages, [], work, timeline);
      input = { ...input, ...changes, timelineEntries: timeline.entries };
      projection = deriveMessagesTimelineRowsWithState(input, previous);
      expect(projection.rows).toEqual(
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: deriveTimelineEntries(messages, [], work),
        }),
      );
      expect(previous.rows).toEqual(oldRows);
    };

    messages = [
      ...messages.slice(0, -1),
      { ...messages.at(-1)!, streaming: false, text: "Complete", updatedAt: initial.time(9) },
    ];
    check({
      latestTurn: { ...initial.input.latestTurn, state: "completed", completedAt: initial.time(9) },
      runningTurnId: null,
      isWorking: false,
    });
    work = [
      ...work,
      {
        id: "late-failure",
        turnId: initial.turnId,
        createdAt: initial.time(10),
        label: "Failed command",
        command: "vp test",
        tone: "error",
        toolCallId: "failed-tool",
        toolLifecycleStatus: "failed",
        sourceActivityKind: "tool.completed",
      },
    ];
    check();
    messages = [
      ...messages.slice(0, -1),
      { ...messages.at(-1)!, text: "Updated final text", updatedAt: initial.time(11) },
    ];
    check();
    check({
      latestTurn: {
        ...initial.input.latestTurn,
        state: "interrupted",
        completedAt: initial.time(12),
      },
    });
    check({ expandedTurnIds: new Set([initial.historyTurnId, initial.turnId]) });
    const group = projection.rows.find((row) => row.kind === "work-toggle");
    check({ expandedWorkGroupIds: new Set(group ? [group.id] : []) });
    messages = [
      { ...messages[0]!, id: MessageId.make("older-user"), createdAt: "2026-09-03T23:59:00.000Z" },
      ...messages,
    ];
    check();
    messages = messages.map((message) =>
      message.id === MessageId.make("live-assistant")
        ? { ...message, role: "user", turnId: null, createdAt: initial.time(0) }
        : message,
    );
    check({ revertTurnCountByUserMessageId: new Map([[MessageId.make("live-user"), 3]]) });
  });
});

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
              itemType: "mcp_tool_call",
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
            turnId: null,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
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
            turnId: "turn-1" as never,
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
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
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
      turnId: "turn-1" as never,
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
            turnId: null,
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
            turnId: "turn-1" as never,
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
          turnId: null,
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
          turnId: "turn-1" as never,
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
          turnId: "turn-1" as never,
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
          turnId: "turn-1" as never,
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
    expect(foldRow?.turnId).toBe("turn-1");
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
      expandedTurnIds: new Set(["turn-1" as never]),
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
    const turnId = TurnId.make("turn-1");
    const timelineEntries = [
      {
        id: "work-entry-before-text",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-before-text",
          createdAt: "2026-01-01T00:00:01Z",
          turnId,
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
          turnId,
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
          turnId,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          toolLifecycleStatus: "completed" as const,
        },
      })),
    ];

    const input = {
      latestTurn: {
        turnId,
        state: "error" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const rows = deriveMessagesTimelineRows({ ...input, timelineEntries });

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
    expect(
      deriveMessagesTimelineRows({ ...input, timelineEntries: timelineEntries.slice(0, 3) }).map(
        (row) => row.id,
      ),
    ).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
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
          turnId: "turn-1" as never,
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
          turnId: "turn-1" as never,
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
          turnId: "turn-1" as never,
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
            turnId: null,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: null,
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
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
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
    expect(foldRow?.turnId).toBe("turn-1");
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
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
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
        turnId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestTurn still points at the
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
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
            turnId: null,
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
            turnId: "turn-before-restart" as never,
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
            turnId: "turn-before-restart" as never,
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
            turnId: "turn-before-restart" as never,
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
            turnId: "turn-after-restart" as never,
            label: "Running tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-after-restart" as never,
        state: "running",
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            label: "Ran tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
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

  it("renders one tool call directly after collapsing its lifecycle updates", () => {
    const turnId = TurnId.make("turn-1");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "command-started-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "command-started",
            createdAt: "2026-01-01T00:00:05Z",
            turnId,
            toolCallId: "call-1",
            label: "Running rg",
            command: "rg toolCall",
            tone: "tool" as const,
            itemType: "command_execution" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "command-completed-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "command-completed",
            createdAt: "2026-01-01T00:00:06Z",
            turnId,
            toolCallId: "call-1",
            label: "Ran rg",
            command: "rg toolCall",
            tone: "tool" as const,
            itemType: "command_execution" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      expandedTurnIds: new Set([turnId]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [{ id: "command-completed", toolCallId: "call-1" }],
      isExpandedToolGroup: false,
      displayLabel: "rg toolCall",
    });
    expect(rows.some((row) => row.kind === "work-toggle")).toBe(false);
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
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
            turnId: "turn-1" as never,
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
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: null,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            label: "Running command",
            command: "rg current",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
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
      const turnId = TurnId.make("turn-task-progress");
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "task-progress-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:05Z",
            entry: {
              id: "task-progress",
              createdAt: "2026-01-01T00:00:05Z",
              turnId,
              label: "Task progress",
              tone: "thinking",
              sourceActivityKind: "task.progress",
              ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
            },
          },
        ],
        latestTurn: {
          turnId,
          state: "running",
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
                    turnId: "turn-1" as never,
                    label: toolLifecycleStatus === "inProgress" ? "Running rg" : "Ran rg",
                    command: "rg toolCall",
                    requestKind: "command",
                    tone: "tool" as const,
                    toolLifecycleStatus,
                    ...(toolLifecycleStatus === "inProgress" ? { detail: "exit code 1" } : {}),
                  },
                },
              ],
        latestTurn: {
          turnId: "turn-1" as never,
          state: "running",
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

  it("does not fold the session's running turn when latestTurn regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
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
            turnId: null,
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
            turnId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.turnId)).toEqual([
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
            turnId: "turn-1" as never,
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
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
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
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
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
      const turnId = TurnId.make("turn-many-tools");
      const createdAt = "2026-09-01T12:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `tool-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `tool-${index}`,
          toolCallId: `call-${index}`,
          createdAt,
          turnId,
          label: "t3-code.preview_snapshot",
          tone: "tool" as const,
          toolLifecycleStatus:
            isWorking && index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const groupId = `work-group:tool:${turnId}:call-0`;
      const input = {
        timelineEntries,
        isWorking,
        expandedTurnIds: new Set([turnId]),
        runningTurnId: isWorking ? turnId : null,
        activeTurnStartedAt: isWorking ? createdAt : null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      };
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
    const turnId = TurnId.make("turn-1");
    const input = {
      runningTurnId: turnId,
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
        turnId,
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
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
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
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
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
