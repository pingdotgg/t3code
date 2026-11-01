import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "keeps reasoning in sequence and groups the tools between traces, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          ...(index % 500 === 0
            ? {
                tone: "thinking" as const,
                itemType: "reasoning" as const,
                detail: `Thought ${index}`,
              }
            : { tone: "tool" as const, itemType: "command_execution" as const }),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const input = {
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      };
      const groupId = "work-group:work-entry-501";
      // A lone call shares its future group's id, so opening it survives a second call joining.
      expect(
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: timelineEntries.slice(0, 502),
        }).find((row) => row.id === "work-entry-501"),
      ).toMatchObject({ kind: "work", groupId });
      const rows = deriveMessagesTimelineRows({
        ...input,
        expandedWorkGroupIds: new Set(expanded ? [groupId] : []),
      });
      expect(rows.map((row) => row.id)).toEqual([
        "working-indicator-row",
        "work-entry-0",
        "work-toggle:work-entry-1",
        "work-entry-500",
        "work-toggle:work-entry-501",
        ...(expanded ? ["work-group:work-entry-501:details"] : []),
      ]);
      const groups = rows.filter((row) => row.kind === "work-toggle");
      expect(groups[0]).toMatchObject({ hiddenCount: 499 });
      expect(groups[1]).toMatchObject({ hiddenCount: 499, activeEntry: { id: "work-999" } });
      if (expanded) {
        const details = rows
          .filter((row) => row.kind === "work")
          .find((row) => row.isExpandedToolGroup);
        expect(details?.groupedEntries.map(({ id }) => id)).toEqual(
          timelineEntries.slice(501).map(({ entry }) => entry.id),
        );
      }
    },
  );
});
