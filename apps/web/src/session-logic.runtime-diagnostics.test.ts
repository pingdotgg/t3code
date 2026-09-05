import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntriesFromVisibleTurnItems } from "./session-logic";
import {
  deriveMessagesTimelineRows,
  workEntryDisplayLabel,
} from "./components/chat/MessagesTimeline.logic";

const retainedMessage =
  "2026-03-14T16:11:12.550224Z ERROR codex_core::codex: failed to load skill /home/sebherrerabe/repos/devsuite/.agent/skills/monorepo-scaffolding/SKILL.md: invalid YAML: mapping va...";
const warningSummary =
  "2026-03-14T16:11:12.550224Z ERROR codex_core::codex: failed to load skill /home/sebherrerabe/repos/devsuite/.agent/sk...";
const now = DateTime.makeUnsafe("2026-09-05T00:00:00.000Z");
const baseItem = {
  id: TurnItemId.make("diagnostic"),
  threadId: ThreadId.make("thread-1"),
  runId: RunId.make("run-1"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: "Runtime error",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};

function workEntry(item: OrchestrationV2TurnItem) {
  const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        item,
      },
    ],
    optimisticMessages: [],
  });
  if (entry?.kind !== "work") throw new Error("Expected a work-log entry");
  return entry.entry;
}

function errorItem(
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "error" }>> = {},
): Extract<OrchestrationV2TurnItem, { type: "error" }> {
  return {
    ...baseItem,
    type: "error",
    failure: {
      class: "provider_error",
      message: retainedMessage,
      code: "runtime_error",
      retryable: false,
    },
    ...overrides,
  };
}

describe("runtime diagnostics in the v2 work log", () => {
  it("shows the retained error message in place of a generic row label", () => {
    const entry = workEntry(errorItem());

    expect(entry).toMatchObject({ label: "Runtime error", detail: retainedMessage });
    expect(workEntryDisplayLabel(entry, undefined)).toBe(retainedMessage);
  });

  it("shows the retained diagnostic message beyond its truncated title", () => {
    const entry = workEntry(errorItem({ title: warningSummary }));

    expect(entry).toMatchObject({ label: warningSummary, detail: retainedMessage });
    expect(workEntryDisplayLabel(entry, undefined)).toBe(retainedMessage);
  });

  it("uses the full system notice instead of a truncated warning title", () => {
    const entry = workEntry({
      ...baseItem,
      type: "system_notice",
      title: warningSummary,
      message: retainedMessage,
    });

    expect(entry.label).toBe(retainedMessage);
    expect(workEntryDisplayLabel(entry, undefined)).toBe(retainedMessage);
    expect(entry.detail).toBeUndefined();
  });

  it("keeps retry progress visible while retaining its diagnostic detail", () => {
    const entry = workEntry(
      errorItem({
        title: "Provider retry",
        status: "running",
        retry: { attempt: 2, maxAttempts: 5, retryDelayMs: 1_500 },
      }),
    );

    expect(workEntryDisplayLabel(entry, undefined)).toBe("Retrying provider (2/5)");
    expect(entry.detail).toBe(`${retainedMessage} Retrying in 1.5s.`);
  });

  it("keeps a diagnostic separate from adjacent tool summaries", () => {
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          ...baseItem,
          type: "command_execution" as const,
          id: TurnItemId.make("command-before"),
          input: "git status",
          output: "clean",
          exitCode: 0,
        },
        errorItem(),
        {
          ...baseItem,
          type: "command_execution" as const,
          id: TurnItemId.make("command-after"),
          input: "git diff",
          output: "",
          exitCode: 0,
        },
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        item,
      })),
      optimisticMessages: [],
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: true,
      activeTurnStartedAt: DateTime.formatIso(now),
      latestRun: {
        runId: baseItem.runId,
        status: "running",
        startedAt: DateTime.formatIso(now),
        completedAt: null,
      },
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    const diagnostic = rows.find((row) => row.id === baseItem.id);

    expect(diagnostic?.kind).toBe("work");
    if (diagnostic?.kind !== "work") throw new Error("Expected a diagnostic row");
    expect(diagnostic.isExpandedToolGroup).toBe(false);
    expect(diagnostic.groupedEntries).toHaveLength(1);
    expect(workEntryDisplayLabel(diagnostic.groupedEntries[0]!, undefined)).toBe(retainedMessage);
  });

  it("does not turn an unrelated tool payload message into a diagnostic", () => {
    const entry = workEntry({
      ...baseItem,
      type: "dynamic_tool",
      title: "Read file",
      toolName: "read_file",
      input: {},
      output: { message: retainedMessage },
    });

    expect(entry.label).toBe("Read file");
    expect(entry.detail).toBeUndefined();
  });
});
