import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
} from "./threadActivity";

function makeActivity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "id" | "kind" | "summary" | "createdAt">,
): OrchestrationThreadActivity {
  return {
    tone: "info",
    payload: {},
    turnId: null,
    ...input,
  };
}

function makeThread(
  input: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id" | "projectId" | "title">,
): OrchestrationThread {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...input,
  };
}

describe("buildThreadFeed", () => {
  it("keeps historic work entries attributed to their turns", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Runtime warning thread",
      latestTurn: {
        turnId: TurnId.make("turn-latest"),
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("activity-old"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-old"),
          payload: {
            message: "Old warning",
          },
        }),
        makeActivity({
          id: EventId.make("activity-latest"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: TurnId.make("turn-latest"),
          payload: {
            message: "Latest warning",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        turnId: "turn-old",
        activities: [{ id: "activity-old", turnId: "turn-old" }],
      },
      {
        type: "activity-group",
        turnId: "turn-latest",
        activities: [{ id: "activity-latest", turnId: "turn-latest" }],
      },
    ]);
  });

  it("collapses matching tool lifecycle rows like desktop", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-1"),
      title: "Collapsed tools",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-updated"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Run tests",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run tests completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const group = feed[0];

    expect(group).toMatchObject({
      type: "activity-group",
    });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toEqual([
      {
        id: "tool-completed",
        createdAt: "2026-04-01T00:00:02.000Z",
        turnId: "turn-1",
        summary: "Run tests",
        detail: "bun run test",
        fullDetail: "/bin/zsh -lc 'bun run test'",
        copyText: "Run tests\nbun run test\n/bin/zsh -lc 'bun run test'",
        icon: "command",
        toolLike: true,
        status: "success",
      },
    ]);
  });

  it("keeps MCP inputs available to expanded mobile work rows", () => {
    const turnId = TurnId.make("turn-mcp");
    const thread = makeThread({
      id: ThreadId.make("thread-mcp"),
      projectId: ProjectId.make("project-1"),
      title: "Expandable MCP call",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("mcp-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Call repository tool",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            title: "Call repository tool",
            itemType: "mcp_tool_call",
            detail: "repository.search",
            status: "completed",
            data: {
              item: {
                server: "repository",
                tool: "search",
                arguments: { query: "work log" },
              },
            },
          },
        }),
      ],
    });

    const group = buildThreadFeed(thread)[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities[0]?.icon).toBe("wrench");
    expect(group.activities[0]?.fullDetail).toContain('"query": "work log"');
    expect(group.activities[0]?.fullDetail).toContain("repository.search");
  });

  it("renders subagent task lifecycle activities as dedicated rows, not generic work-log entries", () => {
    const turnId = TurnId.make("turn-subagent");
    const thread = makeThread({
      id: ThreadId.make("thread-subagent"),
      projectId: ProjectId.make("project-1"),
      title: "Subagent task row",
      activities: [
        makeActivity({
          id: EventId.make("task-started"),
          kind: "task.started",
          summary: "Task started",
          createdAt: "2026-04-01T00:00:00.000Z",
          turnId,
          payload: {
            taskId: "task-row-1",
            description: "Investigate the bug",
            subagentType: "Explore",
          },
        }),
        makeActivity({
          id: EventId.make("task-progress"),
          kind: "task.progress",
          summary: "Task progress",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: { taskId: "task-row-1", lastToolName: "Grep", summary: "Searching" },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const subagentEntries = feed.filter((entry) => entry.type === "subagent-task");
    expect(subagentEntries).toHaveLength(1);
    expect(subagentEntries[0]).toMatchObject({
      type: "subagent-task",
      turnId: "turn-subagent",
      task: { taskId: "task-row-1", state: "running" },
    });

    // task.started/task.progress must not also leak into the generic work log.
    const activityGroups = feed.filter((entry) => entry.type === "activity-group");
    expect(activityGroups).toHaveLength(0);
  });

  it("keeps session health out of the generic work log", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-health"),
      projectId: ProjectId.make("project-1"),
      title: "Health projection",
      activities: [
        makeActivity({
          id: EventId.make("health-stalled"),
          kind: "session.health",
          tone: "error",
          summary: "Session stalled",
          createdAt: "2026-04-01T00:03:00.000Z",
          payload: {
            state: "stalled",
            lastActivityAt: "2026-04-01T00:00:00.000Z",
          },
        }),
      ],
    });

    expect(buildThreadFeed(thread)).toEqual([]);
  });

  it("renders explicit command tasks as tool activity under their parent turn", () => {
    const turnId = TurnId.make("turn-command-task");
    const thread = makeThread({
      id: ThreadId.make("thread-command-task"),
      projectId: ProjectId.make("project-1"),
      title: "Local command task",
      activities: [
        makeActivity({
          id: EventId.make("command-started"),
          kind: "task.started",
          summary: "Task started",
          createdAt: "2026-04-01T00:00:00.000Z",
          turnId,
          payload: {
            taskId: "command-task-1",
            entityType: "command",
            description: "Run tests",
          },
        }),
        makeActivity({
          id: EventId.make("command-completed"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId,
          payload: {
            taskId: "command-task-1",
            status: "completed",
            summary: "pnpm test",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed.some((entry) => entry.type === "subagent-task")).toBe(false);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        turnId: "turn-command-task",
        activities: [
          { icon: "command", turnId: "turn-command-task" },
          { icon: "command", turnId: "turn-command-task" },
        ],
      },
    ]);
  });

  it("does not promote explicit command legacy task events to subagent rows", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-legacy-task"),
      projectId: ProjectId.make("project-1"),
      title: "Legacy task",
      activities: [
        makeActivity({
          id: EventId.make("legacy-task"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:00.000Z",
          payload: {
            taskId: "legacy-task-1",
            itemType: "command_execution",
            status: "completed",
            summary: "Bash finished",
          },
        }),
      ],
    });

    expect(buildThreadFeed(thread).some((entry) => entry.type === "subagent-task")).toBe(false);
  });

  it("drops session exits whose stderr tail is empty after trimming", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-quiet-exit"),
      projectId: ProjectId.make("project-1"),
      title: "Quiet provider exit",
      activities: [
        makeActivity({
          id: EventId.make("session-exited-empty"),
          kind: "session.exited",
          tone: "error",
          summary: "Provider process exited",
          createdAt: "2026-04-01T00:04:00.000Z",
          payload: {
            reason: "Provider process exited",
            stderrTail: " \n\t ",
          },
        }),
      ],
    });

    expect(buildThreadFeed(thread)).toEqual([]);
  });

  it("maps a session exit with stderr into its dedicated disclosure row", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-provider-exit"),
      projectId: ProjectId.make("project-1"),
      title: "Provider exit",
      activities: [
        makeActivity({
          id: EventId.make("session-exited-with-stderr"),
          kind: "session.exited",
          tone: "error",
          summary: "Provider process exited",
          createdAt: "2026-04-01T00:04:00.000Z",
          payload: {
            reason: "  Provider crashed  ",
            stderrTail: "\nFatal provider error\n",
          },
        }),
      ],
    });

    expect(buildThreadFeed(thread)).toEqual([
      {
        type: "session-exit",
        id: "session-exited-with-stderr",
        createdAt: "2026-04-01T00:04:00.000Z",
        turnId: null,
        sessionExit: {
          id: "session-exited-with-stderr",
          createdAt: "2026-04-01T00:04:00.000Z",
          turnId: null,
          summary: "Provider crashed",
          stderrTail: "\nFatal provider error\n",
        },
      },
    ]);
  });

  it("uses the provider-exit fallback when the session exit has no reason", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-provider-exit-fallback"),
      projectId: ProjectId.make("project-1"),
      title: "Provider exit fallback",
      activities: [
        makeActivity({
          id: EventId.make("session-exited-fallback"),
          kind: "session.exited",
          tone: "error",
          summary: "Runtime session ended",
          createdAt: "2026-04-01T00:04:00.000Z",
          payload: { stderrTail: "Fatal provider error" },
        }),
      ],
    });

    expect(buildThreadFeed(thread)[0]).toMatchObject({
      type: "session-exit",
      sessionExit: { summary: "Provider process exited" },
    });
  });

  it("folds settled turn work while leaving the terminal answer visible", () => {
    const turnId = TurnId.make("turn-1");
    const thread = makeThread({
      id: ThreadId.make("thread-3"),
      projectId: ProjectId.make("project-1"),
      title: "Folded work",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:18.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "I am checking.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:02.000Z",
          updatedAt: "2026-04-01T00:00:03.000Z",
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "Done.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:18.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Read files",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Read files",
            itemType: "file_read",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["turn-fold:turn-1", "assistant-final"]);
    expect(collapsed[0]).toMatchObject({
      type: "turn-fold",
      label: "Worked for 17s",
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([turnId]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-commentary",
      "tool-completed",
      "assistant-final",
    ]);
  });

  it("measures a steer-superseded turn from its user boundary through trailing work", () => {
    const firstTurnId = TurnId.make("turn-1");
    const secondTurnId = TurnId.make("turn-2");
    const thread = makeThread({
      id: ThreadId.make("thread-steered"),
      projectId: ProjectId.make("project-1"),
      title: "Steered work",
      latestTurn: {
        turnId: secondTurnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:14.000Z",
        startedAt: "2026-04-01T00:00:14.000Z",
        completedAt: null,
        assistantMessageId: MessageId.make("assistant-next"),
      },
      messages: [
        {
          id: MessageId.make("user-1"),
          role: "user",
          text: "Do it once more.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-commentary"),
          role: "assistant",
          text: "Kicking off call 1.",
          turnId: firstTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:09.000Z",
          updatedAt: "2026-04-01T00:00:09.000Z",
        },
        {
          id: MessageId.make("user-2"),
          role: "user",
          text: "Actually do 15.",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-01T00:00:14.000Z",
          updatedAt: "2026-04-01T00:00:14.000Z",
        },
        {
          id: MessageId.make("assistant-next"),
          role: "assistant",
          text: "One down - adjusting.",
          turnId: secondTurnId,
          streaming: true,
          createdAt: "2026-04-01T00:00:17.000Z",
          updatedAt: "2026-04-01T00:00:17.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("work-1"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Ran command",
          createdAt: "2026-04-01T00:00:12.000Z",
          turnId: firstTurnId,
          payload: {
            title: "Ran command",
            itemType: "command_execution",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const collapsed = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());
    expect(collapsed.find((entry) => entry.type === "turn-fold")).toMatchObject({
      turnId: firstTurnId,
      label: "Worked for 12s",
    });
  });

  it("keeps an active turn expanded and classifies error-shaped tool output", () => {
    const turnId = TurnId.make("turn-running");
    const thread = makeThread({
      id: ThreadId.make("thread-4"),
      projectId: ProjectId.make("project-1"),
      title: "Running work",
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-failed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run command",
          createdAt: "2026-04-01T00:00:05.000Z",
          turnId,
          payload: {
            title: "Run command",
            itemType: "command_execution",
            detail: "zsh: command not found: nope",
            status: "completed",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())).toEqual(feed);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ status: "failure" }],
    });
  });

  it("models work-log overflow as list rows", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      fullDetail: null,
      copyText: id,
      icon: "command",
      toolLike: true,
      status,
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId: null,
        activities: [
          activity("activity-1", "2026-04-01T00:00:01.000Z"),
          activity("activity-neutral", "2026-04-01T00:00:02.000Z", "neutral"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["activity-3", "work-toggle:work-group-1"]);
    expect(collapsed[1]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group-1",
      hiddenCount: 2,
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, null, new Set(), new Set(["work-group-1"]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "work-toggle:work-group-1",
    ]);
    expect(expanded.at(-1)).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
  });
});
