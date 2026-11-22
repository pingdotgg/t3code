import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveMessagesTimelineRows,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
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
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      expect(live?.thought?.id).toBe("work-998");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const working = rows.find((row) => row.kind === "working");
      expect(working?.kind === "working" ? working.activeEntry?.id : null).toBe("work-999");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? 1 : 0);
      if (expanded) {
        expect(details[0]?.groupedEntries).toEqual(live?.groupedEntries);
      }
    },
  );
});

describe("liveWorkEntryLabel for a command execution without a command", () => {
  it.each([
    {
      status: "inProgress" as const,
      active: true,
      toolTitle: "Ran command",
      expected: "Running command",
    },
    {
      status: "inProgress" as const,
      active: true,
      toolTitle: "Command",
      expected: "Running command",
    },
    {
      status: "failed" as const,
      active: false,
      toolTitle: "Ran command",
      expected: "Failed command",
    },
    {
      status: "failed" as const,
      active: false,
      toolTitle: "Run command",
      expected: "Failed command",
    },
  ])(
    "labels a $status entry titled $toolTitle as $expected",
    ({ status, active, toolTitle, expected }) => {
      const entry = {
        id: "work-empty-command",
        createdAt: "2026-10-12T00:00:00Z",
        label: "Ran command",
        toolTitle,
        tone: "tool" as const,
        itemType: "command_execution" as const,
        command: "",
        toolLifecycleStatus: status,
      };
      expect(liveWorkEntryLabel(entry, undefined, active)).toBe(expected);
      expect(workEntryDisplayLabel(entry, undefined)).toBe(expected);
    },
  );
});
