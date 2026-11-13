import {
  RunId,
  deriveMessagesTimelineRows,
  describe,
  expect,
  it,
  timelineTurnFoldRunIdsByEntryId,
} from "./MessagesTimeline.logic-fixtures.ts";

describe("deriveMessagesTimelineRows", () => {
  it("keeps imported V1 turns folded once the thread's first V2 run starts", () => {
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      second: number,
      runId: string | null = null,
    ) => ({
      id,
      kind: "message" as const,
      createdAt: at(second),
      message: {
        id: id as never,
        role,
        text: id,
        runId: runId as never,
        createdAt: at(second),
        updatedAt: at(second),
        streaming: false,
      },
    });
    const rows = (tail: ReadonlyArray<ReturnType<typeof message>>) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          message("imported-prompt", "user", 0),
          message("imported-update", "assistant", 4),
          {
            id: "imported-command",
            kind: "work",
            createdAt: at(5),
            entry: {
              id: "imported-command",
              createdAt: at(5),
              runId: null,
              label: "Ran git",
              command: "git status",
              requestKind: "command",
              tone: "tool" as const,
              toolLifecycleStatus: "completed" as const,
            },
          },
          message("imported-answer", "assistant", 8),
          ...tail,
        ],
        latestRun: {
          runId: "run-1" as never,
          status: "running",
          startedAt: at(20),
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: at(20),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }).map((row) =>
        row.kind === "message" ? `${row.message.role}:${row.message.id}` : row.kind,
      );

    expect(rows([message("new-prompt", "user", 20, "run-1")]).slice(0, 4)).toEqual([
      "user:imported-prompt",
      "turn-fold",
      "assistant:imported-answer",
      "user:new-prompt",
    ]);
    const withoutPrompt = rows([]);
    expect(withoutPrompt).toContain("turn-fold");
    expect(withoutPrompt).not.toContain("assistant:imported-update");

    const timelineEntries = [
      message("imported-prompt", "user", 0),
      message("imported-update", "assistant", 4),
      message("imported-answer", "assistant", 8),
    ];
    const foldInput = { timelineEntries, latestRun: null, isWorking: false };
    const foldRunIds = timelineTurnFoldRunIdsByEntryId(foldInput);
    const foldRunId = foldRunIds.get("imported-update") ?? null;
    expect(foldRunId).not.toBeNull();
    const foldRow = deriveMessagesTimelineRows({
      ...foldInput,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    }).find((row) => row.kind === "turn-fold");
    expect(foldRow?.kind === "turn-fold" ? foldRow.runId : null).toBe(foldRunId);
    expect(foldRunIds.get("imported-answer") ?? null).toBeNull();
    const expanded = deriveMessagesTimelineRows({
      ...foldInput,
      expandedRunIds: new Set([foldRunId!]),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(
      expanded.some((row) => row.kind === "message" && row.message.id === "imported-update"),
    ).toBe(true);
  });

  it("does not treat runless entries as live work on a thread with runs", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "runless-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "runless-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: null,
            label: "Running git",
            command: "git status",
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
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
    expect(rows.at(-1)?.kind).toBe("thinking");
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
      turnDiffSummaries: [],
      supportsConversationRollback: false,
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
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
  });

  it.each([
    ["inProgress", true],
    ["completed", false],
    ["failed", null],
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
        turnDiffSummaries: [],
        supportsConversationRollback: false,
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
      expandedWorkGroupIds?: ReadonlySet<string>,
    ) =>
      deriveMessagesTimelineRows({
        ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
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
        turnDiffSummaries: [],
        supportsConversationRollback: false,
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
    const failedThinkingRow = failedRows.at(-1);
    const failedGroupId =
      failedThinkingRow?.kind === "thinking" ? failedThinkingRow.groupId : undefined;
    expect(failedGroupId).toBeDefined();
    const expandedFailedRows = deriveRows("failed", new Set([failedGroupId!]));
    expect(expandedFailedRows.slice(-2)).toMatchObject([
      { kind: "thinking", id: "live-activity-row", expanded: true },
      {
        kind: "work",
        isExpandedToolGroup: true,
        groupedEntries: [{ id: "latest-command" }],
      },
    ]);
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
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.runId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("live-activity-row");
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
        turnDiffSummaries: [],
        supportsConversationRollback: false,
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
