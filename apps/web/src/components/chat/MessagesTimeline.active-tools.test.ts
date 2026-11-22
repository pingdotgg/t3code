import { MessageId, RunId } from "@t3tools/contracts";
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

describe("running background command visibility", () => {
  it("prefers a non-generic command title over the raw command and ignores generic titles", () => {
    const titled = {
      id: "work-titled-command",
      createdAt: "2026-10-12T00:00:00Z",
      label: "Check outer moons sky level and capture 60 frames if clean",
      toolTitle: "Check outer moons sky level and capture 60 frames if clean",
      tone: "tool" as const,
      itemType: "command_execution" as const,
      command: "mkdir -p /tmp/out && python3 capture.py",
      toolLifecycleStatus: "inProgress" as const,
    };
    expect(liveWorkEntryLabel(titled, undefined, true)).toBe(
      "Check outer moons sky level and capture 60 frames if clean",
    );
    expect(workEntryDisplayLabel(titled, undefined)).toBe(
      "Check outer moons sky level and capture 60 frames if clean",
    );

    const generic = {
      ...titled,
      label: "Run command",
      toolTitle: "bash",
    };
    expect(liveWorkEntryLabel(generic, undefined, true)).toBe("Running mkdir");
    expect(workEntryDisplayLabel(generic, undefined)).toBe(
      "mkdir -p /tmp/out && python3 capture.py",
    );

    const { toolTitle: _omit, ...withoutTitle } = titled;
    const executableTitled = {
      ...withoutTitle,
      label: "git",
      command: "git status",
    };
    expect(liveWorkEntryLabel(executableTitled, undefined, true)).toBe("Running git");
    expect(workEntryDisplayLabel(executableTitled, undefined)).toBe("git status");
  });

  it("surfaces a running command below an interim assistant message and settles it back when done", () => {
    const runId = RunId.make("bg-cmd-run");
    const createdAt = "2026-10-12T00:00:00Z";
    const makeEntries = (status: "inProgress" | "completed") => [
      {
        id: "user-1",
        kind: "message" as const,
        createdAt,
        message: {
          id: MessageId.make("user-1"),
          role: "user" as const,
          text: "Capture 60 frames",
          createdAt,
          updatedAt: createdAt,
          streaming: false,
          runId,
        },
      },
      {
        id: "cmd-1",
        kind: "work" as const,
        createdAt,
        entry: {
          id: "cmd-1",
          createdAt,
          runId,
          label: "Check outer moons sky level and capture 60 frames if clean",
          toolTitle: "Check outer moons sky level and capture 60 frames if clean",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          command: "python3 capture.py",
          toolLifecycleStatus: status,
        },
      },
      {
        id: "assistant-1",
        kind: "message" as const,
        createdAt,
        message: {
          id: MessageId.make("assistant-1"),
          role: "assistant" as const,
          text: "Checking 1 frame right now.",
          createdAt,
          updatedAt: createdAt,
          streaming: false,
          runId,
        },
      },
    ];

    const runningRows = deriveMessagesTimelineRows({
      timelineEntries: makeEntries("inProgress"),
      isWorking: true,
      runningRunId: runId,
      activeTurnStartedAt: createdAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const assistantIdx = runningRows.findIndex(
      (row) => row.kind === "message" && row.id === "assistant-1",
    );
    const liveIdx = runningRows.findIndex((row) => row.kind === "work-live");
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(liveIdx).toBeGreaterThan(assistantIdx);
    const liveRow = runningRows[liveIdx];
    expect(liveRow?.kind).toBe("work-live");
    expect(liveRow?.id).toBe("live-activity-row");
    expect(
      liveRow?.kind === "work-live" && liveWorkEntryLabel(liveRow.entry, undefined, liveRow.active),
    ).toBe("Check outer moons sky level and capture 60 frames if clean");
    // Not duplicated above the interim message, and no generic Thinking row underneath.
    expect(runningRows.filter((row) => row.kind === "work-live")).toHaveLength(1);
    expect(runningRows.some((row) => row.kind === "thinking")).toBe(false);

    // Even when a completed tool lands after the interim reply, keep the running command pinned.
    const withTailTool = deriveMessagesTimelineRows({
      timelineEntries: [
        ...makeEntries("inProgress"),
        {
          id: "search-1",
          kind: "work" as const,
          createdAt,
          entry: {
            id: "search-1",
            createdAt,
            runId,
            label: "Searched files",
            toolTitle: "grep_search",
            tone: "tool" as const,
            itemType: "dynamic_tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      isWorking: true,
      runningRunId: runId,
      activeTurnStartedAt: createdAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const tailLiveRow = withTailTool.find((row) => row.kind === "work-live");
    expect(tailLiveRow?.kind).toBe("work-live");
    if (tailLiveRow?.kind === "work-live") {
      expect(tailLiveRow.id).toBe("live-activity-row");
      expect(tailLiveRow.active).toBe(true);
      expect(tailLiveRow.entry.id).toBe("cmd-1");
      expect(tailLiveRow.groupedEntries.map((entry) => entry.id)).toEqual(["search-1", "cmd-1"]);
    }
    expect(
      withTailTool.filter(
        (row) => row.kind === "work" && row.groupedEntries.some((entry) => entry.id === "cmd-1"),
      ),
    ).toHaveLength(0);

    const completedRows = deriveMessagesTimelineRows({
      timelineEntries: makeEntries("completed"),
      isWorking: false,
      runningRunId: null,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      expandedRunIds: new Set([runId]),
    });
    const settledCmdIdx = completedRows.findIndex((row) => row.id === "cmd-1");
    const settledAssistantIdx = completedRows.findIndex(
      (row) => row.kind === "message" && row.id === "assistant-1",
    );
    expect(settledCmdIdx).toBeGreaterThan(-1);
    expect(settledCmdIdx).toBeLessThan(settledAssistantIdx);
  });
});
