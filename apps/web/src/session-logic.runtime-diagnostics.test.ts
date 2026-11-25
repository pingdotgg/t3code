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
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const diagnostic = rows.find((row) => row.id === baseItem.id);

    expect(diagnostic?.kind).toBe("work");
    if (diagnostic?.kind !== "work") throw new Error("Expected a diagnostic row");
    expect(diagnostic.isExpandedToolGroup).toBe(false);
    expect(diagnostic.groupedEntries).toHaveLength(1);
    expect(workEntryDisplayLabel(diagnostic.groupedEntries[0]!, undefined)).toBe(retainedMessage);
  });

  // regression: #42561 one Claude api_retry showed as two "Retrying provider (1/1)" rows
  it("shows a single running provider retry once when its group is expanded", () => {
    const retry = errorItem({
      title: "Provider retry",
      status: "running",
      completedAt: null,
      failure: {
        class: "provider_error",
        message: "Claude API unknown.",
        code: "unknown",
        retryable: true,
      },
      retry: { attempt: 1, maxAttempts: 1, retryDelayMs: 0 },
    });
    const timelineEntries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: retry.threadId,
          sourceItemId: retry.id,
          item: retry,
        },
      ],
      optimisticMessages: [],
    });
    const deriveRows = (expandedWorkGroupIds?: ReadonlySet<string>) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        activeTurnStartedAt: DateTime.formatIso(now),
        latestRun: {
          runId: baseItem.runId,
          status: "running",
          startedAt: DateTime.formatIso(now),
          completedAt: null,
        },
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
      });
    const groupIds = new Set(
      deriveRows().flatMap((row) => ("groupId" in row && row.groupId ? [row.groupId] : [])),
    );
    const rows = deriveRows(groupIds);
    const rowsShowingRetry = rows.flatMap((row) => {
      if (row.kind === "work-live") return row.entry.id === retry.id ? [row.kind] : [];
      if (row.kind === "work") {
        return row.groupedEntries.some((entry) => entry.id === retry.id) ? [row.kind] : [];
      }
      return [];
    });

    expect(rowsShowingRetry).toHaveLength(1);
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
