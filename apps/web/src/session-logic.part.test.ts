import {
  MessageId,
  RuntimeRequestId,
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type { ThreadRuntimeSummary } from "@t3tools/client-runtime/state/shell";
import { deriveMessagesTimelineRows } from "./components/chat/MessagesTimeline.logic";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveCanInterruptRunningThread,
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  deriveRevertTurnCountByUserMessageId,
  derivePhase,
  isLatestRunSettled,
  selectHandoffImageResources,
  selectMessageImageResources,
  createMessageAttachmentPreviewProjector,
  providerErrorPresentation,
  type TimelineEntry,
  workEntryIndicatesToolFailure,
  workEntryDisplayIndicatesToolFailure,
  workEntryIndicatesToolSuccess,
} from "./session-logic";
import { makeStreamingTimelineFixture, makeThreadProjectionFixture } from "./test-fixtures";
import type { ChatMessage } from "./types";

describe("incremental v2 timeline entries", () => {
  it("retains history and attachment previews through decoded streaming updates", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const attachment = {
      type: "image" as const,
      id: "stream-image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.type === "assistant_message"
        ? { ...row, item: { ...row.item, attachments: [attachment] } }
        : row,
    );
    const input = {
      visibleTurnItems,
      optimisticMessages: [],
      attachmentUrlById: new Map([[attachment.id, "https://server.test/image"]]),
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    Object.freeze(previous.entries);
    for (const entry of previous.entries) Object.freeze(entry);
    const last = visibleTurnItems.at(-1)!;
    if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
    const nextItem = {
      ...last,
      item: {
        ...last.item,
        text: "Next token",
        attachments: [{ ...attachment }],
        startedAt: DateTime.makeUnsafe(fixture.time(7)),
        updatedAt: DateTime.makeUnsafe(fixture.time(8)),
      },
    };
    const nextInput = {
      ...input,
      visibleTurnItems: [...visibleTurnItems.slice(0, -1), nextItem],
      attachmentUrlById: new Map(input.attachmentUrlById),
    };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.slice(0, -1).entries()) {
      expect(next.entries[index]).toBe(entry);
    }
    const beforeMessage = previous.entries.at(-1)!;
    const nextMessage = next.entries.at(-1)!;
    if (beforeMessage.kind !== "message" || nextMessage.kind !== "message") {
      throw new Error("Expected assistant entries");
    }
    expect(nextMessage.message.attachments).toBe(beforeMessage.message.attachments);
    expect(nextMessage.projectedItem).toBe(nextItem);
    expect(nextMessage.message.text).toBe("Next token");
    expect(beforeMessage.message.text).toBe("Partial");

    const renewedInput = {
      ...nextInput,
      attachmentUrlById: new Map([[attachment.id, "https://renewed.test/image"]]),
    };
    const renewed = deriveTimelineEntriesFromVisibleTurnItemsWithState(renewedInput, next);
    expect(renewed.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(renewedInput));
    expect(renewed.entries.at(-1)).toMatchObject({
      message: { attachments: [{ previewUrl: "https://renewed.test/image" }] },
    });
    expect(nextMessage.message.attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/image",
    });
    const restoredInput = { ...renewedInput, attachmentUrlById: new Map<string, string>() };
    const restored = deriveTimelineEntriesFromVisibleTurnItemsWithState(restoredInput, renewed);
    expect(restored.entries.at(-1)).toMatchObject({ message: { attachments: [attachment] } });
    const restoredMessage = restored.entries.at(-1)!;
    if (restoredMessage.kind !== "message") throw new Error("Expected assistant entry");
    expect(restoredMessage.message.attachments?.[0]).not.toHaveProperty("previewUrl");
  });

  it("appends committed items in canonical order even when their timestamps go backwards", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const last = fixture.visibleTurnItems.at(-1)!;
    const appended = {
      ...last,
      position: last.position + 1,
      sourceItemId: TurnItemId.make("late-item"),
      item: {
        ...last.item,
        id: TurnItemId.make("late-item"),
        messageId: MessageId.make("late-message"),
        startedAt: DateTime.makeUnsafe(fixture.time(0)),
      },
    };
    const nextInput = { ...input, visibleTurnItems: [...input.visibleTurnItems, appended] };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.at(-1)).toMatchObject({ id: "late-message" });
    for (const [index, entry] of previous.entries.entries())
      expect(next.entries[index]).toBe(entry);
  });

  it("re-derives only the work entry whose tool item changed", () => {
    const fixture = makeStreamingTimelineFixture("Partial");
    const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
      row.item.id === "live-work"
        ? { ...row, item: { ...row.item, status: "running" as const, completedAt: null } }
        : row,
    );
    const input = { visibleTurnItems, optimisticMessages: [] };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    for (const [index, entry] of previous.entries.entries()) {
      if (entry.id === "live-work") expect(next.entries[index]).not.toBe(entry);
      else expect(next.entries[index]).toBe(entry);
    }

    const anchoredInput = {
      ...nextInput,
      anchoredMessages: [
        {
          id: MessageId.make("feedback"),
          runId: null,
          role: "assistant" as const,
          text: "Feedback received",
          streaming: false,
          createdAt: fixture.time(6),
          updatedAt: fixture.time(6),
        },
      ],
    };
    const anchored = deriveTimelineEntriesFromVisibleTurnItemsWithState(anchoredInput);
    const movedInput = {
      ...anchoredInput,
      visibleTurnItems: anchoredInput.visibleTurnItems.map((row) =>
        row.item.id === "live-work"
          ? { ...row, item: { ...row.item, startedAt: DateTime.makeUnsafe(fixture.time(8)) } }
          : row,
      ),
    };
    expect(
      deriveTimelineEntriesFromVisibleTurnItemsWithState(movedInput, anchored).entries,
    ).toEqual(deriveTimelineEntriesFromVisibleTurnItems(movedInput));
  });

  it.each(["completion", "provenance", "ordering", "attachment", "run"] as const)(
    "rebuilds entries for a %s change instead of retaining stale v2 metadata",
    (change) => {
      const fixture = makeStreamingTimelineFixture("Partial");
      const input = { visibleTurnItems: fixture.visibleTurnItems, optimisticMessages: [] };
      const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const changed =
        change === "provenance"
          ? { ...last, sourceThreadId: ThreadId.make("inherited-thread") }
          : {
              ...last,
              item:
                change === "completion"
                  ? { ...last.item, streaming: false, status: "completed" as const }
                  : change === "ordering"
                    ? { ...last.item, startedAt: DateTime.makeUnsafe(fixture.time(0)) }
                    : change === "run"
                      ? { ...last.item, runId: fixture.historyRunId }
                      : {
                          ...last.item,
                          attachments: [
                            {
                              type: "image",
                              id: "new-image",
                              name: "new.png",
                              mimeType: "image/png",
                              sizeBytes: 42,
                            },
                          ],
                        },
            };
      const nextInput = {
        ...input,
        visibleTurnItems: [...input.visibleTurnItems.slice(0, -1), changed],
      };
      const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
      expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
      expect(next.entries.at(-1)).not.toBe(previous.entries.at(-1));
    },
  );

  it("deduplicates optimistic sends when committed items arrive and retains anchored ordering", () => {
    const fixture = makeStreamingTimelineFixture();
    const input = {
      visibleTurnItems: fixture.visibleTurnItems.slice(0, 3),
      optimisticMessages: [
        {
          id: MessageId.make("live-user"),
          runId: null,
          role: "user" as const,
          text: "Continue",
          streaming: false,
          createdAt: fixture.time(5),
          updatedAt: fixture.time(5),
        },
      ],
      anchoredMessages: [
        {
          id: MessageId.make("feedback"),
          runId: null,
          role: "assistant" as const,
          text: "Feedback received",
          streaming: false,
          createdAt: fixture.time(4),
          updatedAt: fixture.time(4),
        },
      ],
    };
    const previous = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    const nextInput = { ...input, visibleTurnItems: fixture.visibleTurnItems };
    const next = deriveTimelineEntriesFromVisibleTurnItemsWithState(nextInput, previous);
    expect(next.entries).toEqual(deriveTimelineEntriesFromVisibleTurnItems(nextInput));
    expect(next.entries.filter((entry) => entry.id === "live-user")).toHaveLength(1);
    expect(next.entries.map((entry) => entry.id)).toEqual([
      "history-user",
      "history-work",
      "history-assistant",
      "feedback",
      "live-user",
      "live-work",
      "live-assistant",
    ]);
  });
});

describe("image asset requests", () => {
  const image = {
    type: "image" as const,
    id: "image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 42,
  };
  const message = {
    id: MessageId.make("image-message"),
    role: "user" as const,
    text: "Inspect these images",
    runId: null,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    streaming: false,
    attachments: [image],
  };

  it("requests the whole row's gallery and crops without signing local preview IDs", () => {
    const attachments = Object.freeze([
      image,
      { ...image, id: "second" },
      { ...image, id: "crop", name: "preview-annotation-1.png" },
      { ...image, id: "local", previewUrl: "blob:local" },
      { ...image, id: "inline", previewUrl: "data:image/png;base64,AA==" },
      { ...image, id: "provided", previewUrl: "https://preview.test/image" },
      { ...image, type: "file" as const, id: "file", mimeType: "application/pdf" },
      { ...image, type: "future", id: "unknown" },
      image,
    ]);

    expect(selectMessageImageResources(attachments)).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "second" },
      { _tag: "attachment", attachmentId: "crop" },
      { _tag: "attachment", attachmentId: "provided" },
    ]);
  });

  it("requests offscreen handoffs without signing the rest of the loaded history", () => {
    const history = {
      ...message,
      id: MessageId.make("history"),
      attachments: [{ ...image, id: "history-image" }],
    };
    const offscreen = {
      ...message,
      id: MessageId.make("offscreen"),
      attachments: [image, { ...image, id: "crop", name: "preview-annotation-1.png" }],
    };
    const empty = {
      ...message,
      id: MessageId.make("empty"),
      attachments: [{ ...image, id: "empty" }],
    };
    const assistant = {
      ...message,
      id: MessageId.make("assistant"),
      role: "assistant" as const,
      attachments: [{ ...image, id: "assistant-image" }],
    };
    expect(
      selectHandoffImageResources([history, message, offscreen, empty, assistant], {
        [message.id]: ["blob:message"],
        [offscreen.id]: ["blob:offscreen", "blob:crop"],
        [empty.id]: [],
        [assistant.id]: ["blob:unused"],
      }),
    ).toEqual([
      { _tag: "attachment", attachmentId: "image" },
      { _tag: "attachment", attachmentId: "crop" },
    ]);
  });

  it("hands signed URLs to a mounted row only after the local preview is released", () => {
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const row = createMessageAttachmentPreviewProjector();
    const pending = handoff(
      server(message, () => undefined),
      () => "blob:pending",
    );
    expect(selectMessageImageResources(pending.attachments)).toEqual([]);
    expect(selectHandoffImageResources([message], { [message.id]: ["blob:pending"] })).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);

    const ready = server(message, () => "https://server.test/image");
    expect(selectMessageImageResources(handoff(ready, () => "blob:pending").attachments)).toEqual(
      [],
    );
    const released = server(message, () => undefined);
    expect(selectMessageImageResources(released.attachments)).toEqual([
      { _tag: "attachment", attachmentId: image.id },
    ]);
    const displayed = row(released, () => "https://server.test/image");
    expect(displayed).toEqual(ready);
    expect(pending.attachments?.[0]).toMatchObject({ previewUrl: "blob:pending" });
    expect(row(released, () => "https://server.test/renewed").attachments?.[0]).toMatchObject({
      previewUrl: "https://server.test/renewed",
    });
    expect(displayed.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(row(released, () => undefined)).toBe(message);
  });
});

it("renders automatic completion as a work entry instead of a user bubble", () => {
  const now = DateTime.makeUnsafe("2026-09-09T00:00:00Z");
  const item = {
    id: TurnItemId.make("wake-item"),
    threadId: ThreadId.make("parent"),
    runId: RunId.make("wake-run"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "notification" as const,
    source: { kind: "delegated_task" as const, taskIds: [NodeId.make("task-1")] },
    outcome: "unknown" as const,
    summary: "Delegated task finished",
  };
  const row = {
    item,
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
  };
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    optimisticMessages: [],
    visibleTurnItems: [row],
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    kind: "work",
    entry: { label: "Delegated task finished", tone: "info", projectedItem: row },
  });
  expect(
    deriveTimelineEntriesFromVisibleTurnItems({
      optimisticMessages: [],
      visibleTurnItems: [
        {
          ...row,
          item: {
            ...item,
            type: "user_message",
            messageId: MessageId.make("wake-message"),
            createdBy: "agent" as const,
            creationSource: "server" as const,
            inputIntent: "turn_start" as const,
            attachments: [],
            text: "Delegated task node:task-1 reached a terminal state. Use task_status with taskId node:task-1 to read the result.",
          },
        },
      ],
    })[0]?.kind,
  ).toBe("message");
});
