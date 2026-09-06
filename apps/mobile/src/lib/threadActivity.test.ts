import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";
import { describe, expect, it } from "vite-plus/test";
import { codexFeedbackMessage } from "@t3tools/client-runtime/state/threads";

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
  agentSpawnSummary,
  buildPendingUserInputAnswers,
  buildThreadFeed,
  deriveThreadFeedPresentation,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  workEntryRowLabel,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
  type WorkLogEntry,
} from "./threadActivity";

describe("Codex feedback pseudo-messages", () => {
  it("keeps pending and completed feedback messages in the mobile thread body", () => {
    const pending = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:00.000Z",
      status: "uploading" as const,
    };
    const entries = [codexFeedbackMessage(pending), codexFeedbackMessage(pending, "assistant")].map(
      (message) => ({
        type: "message" as const,
        id: message.id,
        createdAt: message.createdAt,
        message,
      }),
    );

    expect(deriveThreadFeedPresentation(entries, null, new Set())).toEqual(entries);
    expect(entries[1]?.message.text).toBe("Sending feedback to OpenAI...");

    const completed = codexFeedbackMessage(
      { ...pending, status: "sent", feedbackId: "codex-thread-1" },
      "assistant",
    );
    expect(completed.text).toContain("codex-thread-1");
  });
});

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;

const nativeQuestion = {
  id: "choice",
  header: "File",
  question: "Which file should be used?",
  options: [
    { label: "Use this", description: "First file", value: " choice " },
    { label: "Use this", description: "Second file", value: "choice" },
  ],
  multiSelect: false,
  allowCustomAnswer: false,
} as const;

describe("pending user input answers", () => {
  it("accepts free-text answers to async questions without options", () => {
    const question = {
      id: "0",
      header: "Question",
      question: "What should it be named?",
      options: [],
      allowCustomAnswer: true,
      multiSelect: false,
    };
    const requested = makeActivity({
      id: EventId.make("async-question"),
      kind: "user-input.requested",
      summary: "User input requested",
      createdAt: "2026-09-03T00:00:00.000Z",
      payload: { requestId: "async-1", responseMode: "message", questions: [question] },
    });
    const questions = derivePendingRequests([requested]).userInputs[0]?.questions;
    expect(questions).toEqual([question]);
    expect(buildPendingUserInputAnswers(questions!, { "0": { customAnswer: "Example" } })).toEqual({
      "0": "Example",
    });
  });

  it("preserves native choice values and custom-answer rules from activities", () => {
    const requested = makeActivity({
      id: EventId.make("native-question"),
      kind: "user-input.requested",
      summary: "User input requested",
      createdAt: "2026-09-02T00:00:00.000Z",
      payload: {
        requestId: "interaction_1",
        questions: [nativeQuestion, singleSelectQuestion],
      },
    });

    expect(derivePendingRequests([requested]).userInputs).toEqual([
      {
        requestId: "interaction_1",
        createdAt: requested.createdAt,
        questions: [nativeQuestion, singleSelectQuestion],
      },
    ]);
  });

  it("replaces single-select options and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionValues: ["Go"] },
        "Node.js",
      ),
    ).toEqual({ customAnswer: "", selectedOptionValues: ["Node.js"] });

    const orders = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Orders");
    const ordersAndListings = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      orders,
      "Listings",
    );
    expect(ordersAndListings).toEqual({
      customAnswer: "",
      selectedOptionValues: ["Orders", "Listings"],
    });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, ordersAndListings, "Orders"),
    ).toEqual({ customAnswer: "", selectedOptionValues: ["Listings"] });

    const paddedOrders = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "  Orders  ",
    );
    expect(paddedOrders).toEqual({ customAnswer: "", selectedOptionValues: ["Orders"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, paddedOrders, "  Orders  "),
    ).toEqual({ customAnswer: "" });
  });

  it("builds array answers for multi-select questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        runtime: { selectedOptionValues: ["Go"] },
        scope: { selectedOptionValues: ["Orders", "Listings"] },
      }),
    ).toEqual({
      runtime: "Go",
      scope: ["Orders", "Listings"],
    });
  });

  it("clears selected options while a custom answer is active", () => {
    expect(
      setPendingUserInputCustomAnswer(
        multiSelectQuestion,
        { selectedOptionValues: ["Orders", "Listings"] },
        "Orders first",
      ),
    ).toEqual({ customAnswer: "Orders first" });
  });

  it("matches selected options against normalized legacy labels", () => {
    expect(
      isPendingUserInputOptionSelected(
        multiSelectQuestion,
        { selectedOptionValues: ["Orders"] },
        "  Orders  ",
      ),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        multiSelectQuestion,
        { selectedOptionValues: ["Orders"], customAnswer: "Orders first" },
        "  Orders  ",
      ),
    ).toBe(false);
  });

  it("keeps custom answers enabled for legacy questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion], {
        runtime: { selectedOptionValues: ["Go"], customAnswer: "  Use Bun  " },
      }),
    ).toEqual({ runtime: "Use Bun" });
  });

  it("keeps duplicate labels and whitespace-sensitive native values separate", () => {
    const first = togglePendingUserInputOptionSelection(nativeQuestion, undefined, " choice ");
    expect(isPendingUserInputOptionSelected(nativeQuestion, first, " choice ")).toBe(true);
    expect(isPendingUserInputOptionSelected(nativeQuestion, first, "choice")).toBe(false);
    expect(buildPendingUserInputAnswers([nativeQuestion], { choice: first })).toEqual({
      choice: " choice ",
    });

    const second = togglePendingUserInputOptionSelection(nativeQuestion, first, "choice");
    expect(isPendingUserInputOptionSelected(nativeQuestion, second, " choice ")).toBe(false);
    expect(isPendingUserInputOptionSelected(nativeQuestion, second, "choice")).toBe(true);
    expect(buildPendingUserInputAnswers([nativeQuestion], { choice: second })).toEqual({
      choice: "choice",
    });
  });

  it("keeps exact native values in multi-select answers", () => {
    const question = { ...nativeQuestion, multiSelect: true };
    const first = togglePendingUserInputOptionSelection(question, undefined, " choice ");
    const both = togglePendingUserInputOptionSelection(question, first, "choice");
    expect(buildPendingUserInputAnswers([question], { choice: both })).toEqual({
      choice: [" choice ", "choice"],
    });

    const second = togglePendingUserInputOptionSelection(question, both, " choice ");
    expect(buildPendingUserInputAnswers([question], { choice: second })).toEqual({
      choice: ["choice"],
    });
  });

  it("ignores custom answers when a question only accepts choices", () => {
    const draft = { selectedOptionValues: [" choice "], customAnswer: "Other" };
    expect(setPendingUserInputCustomAnswer(nativeQuestion, draft, "Custom text")).toBe(draft);
    expect(isPendingUserInputOptionSelected(nativeQuestion, draft, " choice ")).toBe(true);
    expect(buildPendingUserInputAnswers([nativeQuestion], { choice: draft })).toEqual({
      choice: " choice ",
    });
  });

  it.each([
    { customAnswer: "Other" },
    { selectedOptionValues: ["Use this"] },
    { selectedOptionValues: ["not offered"] },
    { selectedOptionValues: ["  choice  "] },
  ])("requires an offered value for a choice-only question: %j", (draft) => {
    expect(buildPendingUserInputAnswers([nativeQuestion], { choice: draft })).toBeNull();
  });
});

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
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

describe("buildThreadFeed", () => {
  it("reuses unchanged feed and presentation rows during an assistant text update", () => {
    const completedTurnId = TurnId.make("completed-turn");
    const activeTurnId = TurnId.make("active-turn");
    const thread = makeThread({
      id: ThreadId.make("feed-reuse"),
      projectId: ProjectId.make("project-1"),
      title: "Feed reuse",
      messages: [
        {
          id: MessageId.make("completed-message"),
          role: "assistant",
          text: "Completed response",
          turnId: completedTurnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:01.000Z",
          updatedAt: "2026-04-01T00:00:01.000Z",
        },
        {
          id: MessageId.make("streaming-message"),
          role: "assistant",
          text: "Current response",
          turnId: activeTurnId,
          streaming: true,
          createdAt: "2026-04-01T00:00:04.000Z",
          updatedAt: "2026-04-01T00:00:04.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("completed-tool"),
          kind: "tool.completed",
          summary: "Read files",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: completedTurnId,
          payload: { itemType: "file_read", status: "completed" },
        }),
        makeActivity({
          id: EventId.make("active-tool"),
          kind: "tool.updated",
          summary: "Run checks",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: activeTurnId,
          payload: { itemType: "command_execution", command: "vp test", status: "inProgress" },
        }),
      ],
    });
    const latestTurn = {
      turnId: activeTurnId,
      state: "running" as const,
      startedAt: "2026-04-01T00:00:03.000Z",
      completedAt: null,
    };
    const expandedTurns = new Set([completedTurnId]);
    const expandedGroups = new Set(["work-group:completed-tool", "work-group:active-tool"]);
    const previousFeed = buildThreadFeed(thread);
    const previousRows = deriveThreadFeedPresentation(
      previousFeed,
      latestTurn,
      expandedTurns,
      expandedGroups,
      latestTurn.startedAt,
    );
    const updatedMessage = {
      ...thread.messages[1]!,
      text: "Current response with more text",
      updatedAt: "2026-04-01T00:00:05.000Z",
    };
    const nextFeed = buildThreadFeed({
      ...thread,
      messages: [thread.messages[0]!, updatedMessage],
    });
    const nextRows = deriveThreadFeedPresentation(
      nextFeed,
      latestTurn,
      expandedTurns,
      expandedGroups,
      latestTurn.startedAt,
    );

    expect(nextFeed).toHaveLength(previousFeed.length);
    expect(nextRows).toHaveLength(previousRows.length);
    for (const [before, after] of [
      [previousFeed, nextFeed],
      [previousRows, nextRows],
    ] as const) {
      for (const [index, row] of after.entries()) {
        if (row.id === updatedMessage.id) {
          expect(row).not.toBe(before[index]);
          expect(row).toMatchObject({ message: updatedMessage });
        } else {
          expect(row).toBe(before[index]);
        }
      }
    }
    expect(nextRows.some((row) => row.type === "turn-fold")).toBe(true);
    expect(nextRows.some((row) => row.type === "activity-group")).toBe(true);
  });

  it("regroups cached activities for message changes and pagination", () => {
    const messages = [2, 4].map((second) => ({
      id: MessageId.make(`message-${second}`),
      role: "assistant" as const,
      text: second === 2 ? "" : "Response",
      streaming: false,
      turnId: null,
      createdAt: `2026-04-01T00:00:0${second}.000Z`,
      updatedAt: `2026-04-01T00:00:0${second}.000Z`,
    }));
    const thread = makeThread({
      id: ThreadId.make("feed-regroup"),
      projectId: ProjectId.make("project-1"),
      title: "Feed grouping",
      messages,
      activities: [1, 3, 5].map((second) =>
        makeActivity({
          id: EventId.make(`work-${second}`),
          kind: "runtime.warning",
          summary: `Notice ${second}`,
          createdAt: `2026-04-01T00:00:0${second}.000Z`,
        }),
      ),
    });
    const initial = buildThreadFeed(thread);
    expect(initial.map((row) => row.id)).toEqual(["work-1", "message-4", "work-5"]);
    const split = buildThreadFeed({
      ...thread,
      messages: [{ ...messages[0]!, text: "Now visible" }, messages[1]!],
    });
    expect(split.map((row) => row.id)).toEqual([
      "work-1",
      "message-2",
      "work-3",
      "message-4",
      "work-5",
    ]);
    expect(split[0]).not.toBe(initial[0]);
    expect(split.at(-1)).toBe(initial.at(-1));
    expect(initial[0]).toMatchObject({ activities: [{ id: "work-1" }, { id: "work-3" }] });

    const reordered = buildThreadFeed({
      ...thread,
      messages: [messages[0]!, { ...messages[1]!, createdAt: "2026-04-01T00:00:06.000Z" }],
    });
    expect(reordered.map((row) => row.id)).toEqual(["work-1", "message-4"]);
    expect(reordered[0]).toMatchObject({
      activities: [{ id: "work-1" }, { id: "work-3" }, { id: "work-5" }],
    });
    const olderMessage = {
      ...messages[1]!,
      id: MessageId.make("older-message"),
      createdAt: "2026-04-01T00:00:00.000Z",
    };
    const page = buildThreadFeed(thread, {
      loadedMessages: [messages[1]!],
      localMessages: [olderMessage],
    });
    expect(page.map((row) => row.id)).toEqual(["older-message", "message-4", "work-5"]);
    const prepended = buildThreadFeed(thread, { loadedMessages: [olderMessage, ...messages] });
    expect(prepended.map((row) => row.id)).toEqual([
      "older-message",
      "work-1",
      "message-4",
      "work-5",
    ]);
    expect(prepended.at(-1)).toBe(page.at(-1));
  });

  it("keeps context compaction as a standalone timeline row", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-context-compaction"),
      projectId: ProjectId.make("project-1"),
      title: "Context compaction",
      activities: [
        makeActivity({
          id: EventId.make("context-compaction"),
          kind: "context-compaction",
          tone: "info",
          summary: "Compacted context 899K → 19K tokens",
          createdAt: "2026-09-01T00:00:00.000Z",
          turnId: TurnId.make("turn-context-compaction"),
        }),
      ],
    });

    const presented = deriveThreadFeedPresentation(buildThreadFeed(thread), null, new Set());
    expect(presented).toMatchObject([
      {
        type: "activity-group",
        id: "context-compaction",
        activities: [{ summary: "Compacted context 899K → 19K tokens" }],
      },
    ]);
  });

  it("keeps long Claude commands expandable without repeating them in full detail", () => {
    const command = `printf 'first line\nsecond line'\n&& printf done`;
    const thread = makeThread({
      id: ThreadId.make("thread-long-command"),
      projectId: ProjectId.make("project-1"),
      title: "Long command",
      activities: [
        makeActivity({
          id: EventId.make("long-command"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Command run",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            detail: `Bash: ${command}`,
            data: { toolName: "Bash", command },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(row).toMatchObject({ detail: command, canExpand: true });
    expect(row?.getFullDetail()).toBe(command);
    expect(row?.getCopyText()).toBe(`Command run\n${command}`);
  });

  it("keeps command output when it equals the displayed command", () => {
    const command = "printf hello";
    const thread = makeThread({
      id: ThreadId.make("thread-matching-command-output"),
      projectId: ProjectId.make("project-1"),
      title: "Matching output",
      activities: [
        makeActivity({
          id: EventId.make("matching-command-output"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Command run",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            detail: `Bash: ${command}`,
            data: { toolName: "Bash", command, rawOutput: { content: command } },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(row?.detail).toBe(command);
    expect(row?.getFullDetail()).toBe(`${command}\n\n${command}`);
    expect(row?.getCopyText()).toBe(`Command run\n${command}\n\n${command}`);
  });

  it("keeps OpenCode detail-only output when it equals the command", () => {
    const command = "printf hello";
    const thread = makeThread({
      id: ThreadId.make("thread-opencode-detail-output"),
      projectId: ProjectId.make("project-1"),
      title: "OpenCode detail output",
      activities: [
        makeActivity({
          id: EventId.make("opencode-detail-output"),
          kind: "tool.completed",
          tone: "tool",
          summary: "bash",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "bash",
            detail: command,
            data: { command },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(row?.workEntry.detail).toBe(command);
    expect(row?.getFullDetail()).toBe(`${command}\n\n${command}`);
    // Opening it would only repeat the command the row already shows.
    expect(row?.canExpand).toBe(false);
  });

  it.each([
    {
      name: "a task summary that is its own detail",
      activity: {
        kind: "task.completed" as const,
        tone: "info" as const,
        summary: "Task completed",
        payload: {
          taskId: "bh2p996o4",
          status: "completed",
          title: "Check CI on the new head",
          summary: "Check CI on the new head",
          detail: "Check CI on the new head",
          agentKind: "background",
          taskType: "local_bash",
        },
      },
      label: "Check CI on the new head",
      canExpand: false,
    },
    {
      name: "a runtime warning with only its message",
      activity: {
        kind: "runtime.warning" as const,
        tone: "info" as const,
        summary: "Bash is unusable in this environment",
        payload: { detail: "Bash is unusable in this environment" },
      },
      label: "Bash is unusable in this environment",
      canExpand: false,
    },
    {
      name: "a multi-line task report",
      activity: {
        kind: "task.completed" as const,
        tone: "info" as const,
        summary: "Task completed",
        payload: {
          taskId: "bpxcizf97",
          status: "completed",
          title: "Audit the PR",
          detail: "**Tooling note:** Bash is unusable.\n\n# Audit\n\nNo blockers.",
          agentKind: "background",
          taskType: "local_bash",
        },
      },
      label: "**Tooling note:** Bash is unusable. # Audit No blockers.",
      canExpand: true,
    },
    {
      name: "a command whose output differs from the command",
      activity: {
        kind: "tool.completed" as const,
        tone: "tool" as const,
        summary: "Command run",
        payload: {
          itemType: "command_execution",
          title: "Command run",
          detail: "Bash: printf hello",
          data: { toolName: "Bash", command: "printf hello", rawOutput: { content: "hello" } },
        },
      },
      label: "printf hello",
      canExpand: true,
    },
  ])("only lets $name expand when the body adds something: $canExpand", (input) => {
    const thread = makeThread({
      id: ThreadId.make("thread-expand-rule"),
      projectId: ProjectId.make("project-1"),
      title: "Expand rule",
      activities: [
        makeActivity({
          id: EventId.make("expand-rule"),
          createdAt: "2026-09-01T00:00:00.000Z",
          ...input.activity,
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(workEntryRowLabel(row!.workEntry)).toBe(input.label);
    expect(row?.canExpand).toBe(input.canExpand);
  });

  it("drops a truncated Claude echo of a long command", () => {
    const command = `git add -A && git commit -m "${"x".repeat(200)}"`;
    const thread = makeThread({
      id: ThreadId.make("thread-truncated-echo"),
      projectId: ProjectId.make("project-1"),
      title: "Truncated echo",
      activities: [
        makeActivity({
          id: EventId.make("truncated-echo"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Command run",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            detail: `Bash: ${command}`.slice(0, 177) + "...",
            data: { toolName: "Bash", command },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(row?.workEntry.detail).toBeUndefined();
    expect(row?.getFullDetail()).toBe(command);
  });

  it("drops an ACP command echo when the update omits the tool kind", () => {
    const command = "pnpm test";
    const thread = makeThread({
      id: ThreadId.make("thread-acp-no-kind"),
      projectId: ProjectId.make("project-1"),
      title: "ACP no kind",
      activities: [
        makeActivity({
          id: EventId.make("acp-no-kind"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Terminal",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "Terminal",
            detail: command,
            data: { toolCallId: "tool-1", command },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(row?.workEntry.detail).toBeUndefined();
    expect(row?.getFullDetail()).toBe(command);
  });

  it("drops ACP command metadata when detail only repeats the command", () => {
    const command = "printf hello";
    const thread = makeThread({
      id: ThreadId.make("thread-acp-command-detail"),
      projectId: ProjectId.make("project-1"),
      title: "ACP command detail",
      activities: [
        makeActivity({
          id: EventId.make("acp-command-detail"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Terminal",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "Terminal",
            detail: command,
            data: { kind: "execute", command },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    const [row] = group.activities;
    expect(row?.workEntry.detail).toBeUndefined();
    expect(row?.getFullDetail()).toBe(command);
  });

  it("does not show command output when the command input is missing", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-command-without-input"),
      projectId: ProjectId.make("project-1"),
      title: "Missing command input",
      activities: [
        makeActivity({
          id: EventId.make("command-without-input"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Command run",
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: {
            itemType: "command_execution",
            title: "Command run",
            data: { rawOutput: { content: "output without command metadata" } },
          },
        }),
      ],
    });

    const [group] = buildThreadFeed(thread);
    expect(group?.type).toBe("activity-group");
    if (group?.type !== "activity-group") return;
    expect(group.activities[0]?.detail).toBeNull();
    expect(group.activities[0]?.getFullDetail()).toBeNull();
  });

  it("keeps setup failures visible without routine setup notices before or after a turn", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-worktree-setup"),
      projectId: ProjectId.make("project-1"),
      title: "Worktree setup",
      activities: [
        makeActivity({
          id: EventId.make("setup-requested"),
          kind: "setup-script.requested",
          summary: "Starting setup script",
          createdAt: "2026-08-30T00:00:00.000Z",
        }),
        makeActivity({
          id: EventId.make("setup-started"),
          kind: "setup-script.started",
          summary: "Setup script started",
          createdAt: "2026-08-30T00:00:01.000Z",
        }),
        makeActivity({
          id: EventId.make("setup-failed"),
          kind: "setup-script.failed",
          summary: "Setup script failed to start",
          createdAt: "2026-08-30T00:00:02.000Z",
          tone: "error",
          payload: { detail: "Setup command was not found" },
        }),
      ],
    });
    const latestTurn = {
      turnId: TurnId.make("turn-after-setup"),
      state: "running" as const,
      requestedAt: "2026-08-30T00:00:03.000Z",
      startedAt: "2026-08-30T00:00:04.000Z",
      completedAt: null,
      assistantMessageId: null,
    };

    for (const currentTurn of [null, latestTurn]) {
      const currentThread = { ...thread, latestTurn: currentTurn };
      const feed = buildThreadFeed(currentThread);
      expect(feed).toMatchObject([
        {
          type: "activity-group",
          activities: [{ id: "setup-failed", status: "failure" }],
        },
      ]);
      const group = feed[0];
      if (group?.type !== "activity-group") throw new Error("Expected the setup failure group");
      expect(group.activities[0]?.getCopyText()).toContain("Setup command was not found");
    }
  });

  it.each(["setup-script.requested", "setup-script.started"])(
    "keeps error-toned %s notices visible",
    (kind) => {
      const feed = buildThreadFeed(
        makeThread({
          id: ThreadId.make("thread-setup-error"),
          projectId: ProjectId.make("project-1"),
          title: "Setup error",
          activities: [
            makeActivity({
              id: EventId.make("setup-error"),
              kind,
              summary: "Setup failed",
              createdAt: "2026-08-30T00:00:00.000Z",
              tone: "error",
            }),
          ],
        }),
      );

      expect(feed).toMatchObject([
        { type: "activity-group", activities: [{ id: "setup-error", status: "failure" }] },
      ]);
    },
  );

  it("keeps older local feedback before newer messages returned by the server", () => {
    const submission = {
      id: MessageId.make("feedback-command-ordering"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:01.000Z",
      status: "sent" as const,
      feedbackId: "codex-thread-1",
    };
    const laterMessage = {
      id: MessageId.make("later-server-message"),
      role: "assistant" as const,
      text: "Newer server response",
      turnId: null,
      createdAt: "2026-08-23T00:00:02.000Z",
      updatedAt: "2026-08-23T00:00:02.000Z",
      streaming: false,
    };
    const thread = makeThread({
      id: ThreadId.make("thread-feedback-ordering"),
      projectId: ProjectId.make("project-1"),
      title: "Feedback ordering",
      messages: [laterMessage],
    });

    const feed = buildThreadFeed(thread, {
      localMessages: [
        codexFeedbackMessage(submission),
        codexFeedbackMessage(submission, "assistant"),
      ],
    });

    expect(feed.map((entry) => entry.id)).toEqual([
      "feedback-command-ordering",
      "feedback-command-ordering:feedback",
      "later-server-message",
    ]);
  });

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

  it("drops runtime warnings with no displayable content", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-noise"),
      projectId: ProjectId.make("project-1"),
      title: "Warning noise thread",
      activities: [
        makeActivity({
          id: EventId.make("activity-noise"),
          kind: "runtime.warning",
          summary: "Claude system message 'background_tasks_changed' (no displayable text content)",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-1"),
        }),
        makeActivity({
          id: EventId.make("activity-signal"),
          kind: "runtime.warning",
          summary: "Reconnecting... 2/5",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: TurnId.make("turn-1"),
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        activities: [{ id: "activity-signal" }],
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

    expect(group.activities).toHaveLength(1);
    expect(group.activities[0]).toMatchObject({
      id: "tool-updated",
      createdAt: "2026-04-01T00:00:01.000Z",
      turnId: "turn-1",
      summary: "Run tests",
      detail: "bun run test",
      canExpand: true,
      icon: "command",
      toolLike: true,
      status: "success",
    });
    expect(group.activities[0]?.getFullDetail()).toBe("/bin/zsh -lc 'bun run test'");
    expect(group.activities[0]?.getCopyText()).toBe(
      "Run tests\nbun run test\n/bin/zsh -lc 'bun run test'",
    );
  });

  it("keeps viewed image metadata while collapsing a streamed Claude Read", () => {
    const turnId = TurnId.make("turn-image-read");
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const thread = makeThread({
      id: ThreadId.make("thread-image-read"),
      projectId: ProjectId.make("project-1"),
      title: "Image read",
      activities: [
        makeActivity({
          id: EventId.make("image-read-update"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Image view",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId,
          payload: {
            toolCallId: "tool-read-image",
            itemType: "image_view",
            status: "inProgress",
            detail: `${imagePath.slice(0, 177)}...`,
            data: { imagePath },
          },
        }),
        makeActivity({
          id: EventId.make("image-read-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Image view",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            toolCallId: "tool-read-image",
            itemType: "image_view",
            status: "completed",
            detail: `${imagePath.slice(0, 177)}...`,
            data: {},
          },
        }),
      ],
    });

    const group = buildThreadFeed(thread)[0];
    expect(group).toMatchObject({
      type: "activity-group",
      activities: [
        {
          workEntry: {
            itemType: "image_view",
            viewedImagePath: imagePath,
          },
        },
      ],
    });
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
            toolSurface: "computer",
            toolIcon: {
              _tag: "native-app",
              app: { _tag: "app-id", appId: "com.example.Editor" },
            },
            toolSource: {
              key: "native-app:com.example.editor",
              name: "Computer Use",
              kind: "computer",
              icon: {
                _tag: "native-app",
                app: { _tag: "app-id", appId: "com.example.Editor" },
              },
            },
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

    expect(group.activities[0]?.icon).toBe("computer");
    expect(group.activities[0]?.workEntry.toolSurface).toBe("computer");
    expect(group.activities[0]?.workEntry.toolIcon).toEqual({
      _tag: "native-app",
      app: { _tag: "app-id", appId: "com.example.Editor" },
    });
    expect(group.activities[0]?.workEntry.toolSource).toEqual({
      key: "native-app:com.example.editor",
      name: "Computer Use",
      kind: "computer",
      icon: {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.example.Editor" },
      },
    });
    expect(group.activities[0]?.getFullDetail()).toContain('"query": "work log"');
    expect(group.activities[0]?.getFullDetail()).toContain("repository.search");
  });

  it.each([
    {
      source: "raw MCP browser identity",
      label: "Call MCP tool",
      title: "Call MCP tool",
      item: { server: "t3-code", tool: "preview_navigate" },
      status: "inProgress",
      displayName: "Navigating the preview browser",
      icon: "browser",
    },
    {
      source: "raw MCP orchestration identity",
      label: "Call MCP tool",
      title: "Call MCP tool",
      item: { server: "t3-code", tool: "task_status" },
      status: "inProgress",
      displayName: "Getting delegated task status",
      icon: "t3-code",
    },
    {
      source: "provider-qualified title",
      label: "Call MCP tool",
      title: "mcp__t3-code__preview_snapshot",
      item: undefined,
      status: "inProgress",
      displayName: "Taking a snapshot of the preview page",
      icon: "browser",
    },
    {
      source: "provider-qualified label",
      label: "mcp__t3-code__task_status",
      title: undefined,
      item: undefined,
      status: "inProgress",
      displayName: "Getting delegated task status",
      icon: "t3-code",
    },
    {
      source: "browser identity without lifecycle status",
      label: "Call MCP tool",
      title: "Call MCP tool",
      item: { server: "t3-code", tool: "preview_click" },
      status: undefined,
      displayName: "Clicking in the preview browser",
      liveDisplayName: "Clicking in the preview browser",
      settledDisplayName: "Clicked in the preview browser",
      icon: "browser",
    },
    {
      source: "orchestration identity without lifecycle status",
      label: "Call MCP tool",
      title: "Call MCP tool",
      item: { server: "t3-code", tool: "task_status" },
      status: undefined,
      displayName: "Getting delegated task status",
      liveDisplayName: "Getting delegated task status",
      settledDisplayName: "Got delegated task status",
      icon: "t3-code",
    },
  ])(
    "uses friendly row and running labels from $source",
    ({ label, title, item, status, displayName, liveDisplayName, settledDisplayName, icon }) => {
      const turnId = TurnId.make("turn-friendly-mcp");
      const rawCommand = "node mcp-call.js";
      const rawDetail = '{"provider":"raw MCP output"}';
      const thread = makeThread({
        id: ThreadId.make("thread-friendly-mcp"),
        projectId: ProjectId.make("project-1"),
        title: "Friendly MCP labels",
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
            id: EventId.make("friendly-mcp"),
            kind: "tool.updated",
            tone: "tool",
            summary: label,
            createdAt: "2026-04-01T00:00:02.000Z",
            turnId,
            payload: {
              title,
              itemType: "mcp_tool_call",
              detail: rawDetail,
              status,
              data: { item, command: rawCommand },
            },
          }),
        ],
      });

      const feed = buildThreadFeed(thread);
      const group = feed[0];
      expect(group).toMatchObject({
        type: "activity-group",
        activities: [{ summary: displayName, detail: rawCommand }],
      });
      if (!group || group.type !== "activity-group") return;
      const activity = group.activities[0]!;
      expect(activity.getFullDetail()).toContain(rawCommand);
      expect(activity.getFullDetail()).toContain(rawDetail);
      expect(activity.getCopyText()).toContain(rawCommand);
      expect(activity.getCopyText()).toContain(rawDetail);
      expect(activity.getCopyText()).not.toContain(displayName);
      if (item) expect(activity.getFullDetail()).toContain(JSON.stringify(item, null, 2));
      expect(
        deriveThreadFeedPresentation(
          feed,
          thread.latestTurn,
          new Set(),
          new Set(),
          thread.latestTurn!.startedAt,
        ),
      ).toMatchObject([
        {
          type: "work-toggle",
          summary: liveDisplayName ?? displayName,
          summaryToolIcon: icon,
          live: true,
        },
      ]);
      if (settledDisplayName) {
        const settledRows = deriveThreadFeedPresentation(
          feed,
          {
            ...thread.latestTurn!,
            state: "completed",
            completedAt: "2026-04-01T00:00:03.000Z",
          },
          new Set([turnId]),
          new Set(),
        );
        expect(settledRows.find((entry) => entry.type === "work-toggle")).toMatchObject({
          summary: settledDisplayName,
          summaryToolIcon: icon,
          live: false,
        });
      }
    },
  );

  it("retains Claude MCP metadata behind friendly row and running labels", () => {
    const turnId = TurnId.make("turn-claude-mcp");
    const toolData = {
      toolName: "mcp__t3-code__preview_click",
      input: { locator: { role: "button", name: "Continue" } },
      result: { content: "Clicked Continue" },
    };
    const detail = "Click Continue";
    const thread = makeThread({
      id: ThreadId.make("thread-claude-mcp"),
      projectId: ProjectId.make("project-1"),
      title: "Claude MCP labels",
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
          id: EventId.make("claude-mcp-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "MCP tool call completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            title: "MCP tool call",
            itemType: "mcp_tool_call",
            status: "completed",
            detail,
            data: toolData,
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const group = feed[0];
    expect(group).toMatchObject({
      type: "activity-group",
      activities: [
        {
          summary: "Clicked in the preview browser",
          detail,
          workEntry: { label: "MCP tool call completed", toolTitle: "MCP tool call" },
        },
      ],
    });
    if (!group || group.type !== "activity-group") return;
    const activity = group.activities[0]!;
    const fullDetail = `MCP call\n${JSON.stringify(toolData, null, 2)}\n\n${detail}`;
    expect(activity.workEntry.toolData).toBe(toolData);
    expect(activity.getFullDetail()).toBe(fullDetail);
    expect(activity.getCopyText()).toBe(`MCP tool call\n${detail}\n${fullDetail}`);
    expect(
      deriveThreadFeedPresentation(
        feed,
        thread.latestTurn,
        new Set(),
        new Set(),
        thread.latestTurn!.startedAt,
      ),
    ).toMatchObject([
      {
        type: "work-toggle",
        summary: "Clicking in the preview browser",
        summaryToolIcon: "browser",
        live: true,
      },
    ]);
  });

  it.each([
    {
      status: "completed",
      displayName: "Clicked in the preview browser",
      liveDisplayName: "Clicking in the preview browser",
      detail: "Clicked Continue",
      hasFailure: false,
    },
    {
      status: "failed",
      displayName: "Failed to click in the preview browser",
      liveDisplayName: "Failed to click in the preview browser",
      detail: "Timed out waiting for Continue",
      hasFailure: true,
    },
  ])(
    "uses the browser call label once its action settles as $status",
    ({ status, displayName, liveDisplayName, detail, hasFailure }) => {
      const turnId = TurnId.make("turn-preview-lifecycle");
      const toolCallId = "preview-click";
      const groupId = `work-group:tool:${turnId}:${toolCallId}`;
      const toolData = {
        server: "t3-code",
        tool: "preview_click",
        arguments: { locator: { role: "button", name: "Continue" } },
      };
      const thread = makeThread({
        id: ThreadId.make("thread-preview-lifecycle"),
        projectId: ProjectId.make("project-1"),
        title: "Browser tool lifecycle",
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
            id: EventId.make("preview-click-started"),
            kind: "tool.updated",
            tone: "tool",
            summary: "MCP tool call",
            createdAt: "2026-04-01T00:00:02.000Z",
            turnId,
            payload: {
              title: "MCP tool call",
              itemType: "mcp_tool_call",
              status: "inProgress",
              toolCallId,
              data: { item: toolData },
            },
          }),
        ],
      });
      const present = (currentThread: OrchestrationThread) =>
        deriveThreadFeedPresentation(
          buildThreadFeed(currentThread),
          currentThread.latestTurn,
          new Set([turnId]),
          new Set([groupId]),
          currentThread.latestTurn?.state === "running" ? currentThread.latestTurn.startedAt : null,
        );

      expect(present(thread)).toMatchObject([
        {
          type: "work-toggle",
          groupId,
          hiddenCount: 1,
          expanded: true,
          summary: "Clicking in the preview browser",
          summaryToolIcon: "browser",
          live: true,
          shimmer: true,
        },
        {
          type: "activity-group",
          id: `work-details:${groupId}`,
          activities: [
            {
              id: "preview-click-started",
              summary: "Clicking in the preview browser",
              lifecycleStatus: "inProgress",
              live: true,
            },
          ],
        },
      ]);

      const terminalThread = {
        ...thread,
        activities: [
          ...thread.activities,
          makeActivity({
            id: EventId.make("preview-click-completed"),
            kind: "tool.completed",
            tone: "tool",
            summary: "MCP tool call completed",
            createdAt: "2026-04-01T00:00:03.000Z",
            turnId,
            payload: { itemType: "mcp_tool_call", toolCallId, status, detail },
          }),
        ],
      };
      const terminalRows = present(terminalThread);
      expect(terminalRows).toMatchObject([
        {
          type: "work-toggle",
          groupId,
          hiddenCount: 1,
          expanded: true,
          summary: liveDisplayName,
          summaryToolIcon: "browser",
          hasFailure,
          live: true,
          // A successful trailing call keeps shining; a failure hands off to "Thinking".
          shimmer: !hasFailure,
        },
        {
          type: "activity-group",
          id: `work-details:${groupId}`,
          activities: [
            {
              id: "preview-click-started",
              summary: displayName,
              lifecycleStatus: status,
              live: false,
            },
          ],
        },
        ...(hasFailure ? [{ type: "thinking", turnId }] : []),
      ]);
      const terminalGroup = terminalRows[1];
      if (terminalGroup?.type !== "activity-group") return;
      const activity = terminalGroup.activities[0]!;
      const fullDetail = `MCP call\n${JSON.stringify(toolData, null, 2)}\n\n${detail}`;
      expect(activity.workEntry.toolData).toBe(toolData);
      expect(activity.getFullDetail()).toBe(fullDetail);
      expect(activity.getCopyText()).toBe(`MCP tool call\n${detail}\n${fullDetail}`);

      const settledRows = present({
        ...terminalThread,
        latestTurn: {
          ...thread.latestTurn!,
          state: "completed",
          completedAt: "2026-04-01T00:00:04.000Z",
        },
      });
      expect(settledRows.find((entry) => entry.type === "work-toggle")).toMatchObject({
        groupId,
        hiddenCount: 1,
        expanded: true,
        summary: displayName,
        summaryKind: "browser",
        hasFailure,
        live: false,
      });
      expect(settledRows.find((entry) => entry.type === "activity-group")).toMatchObject({
        id: `work-details:${groupId}`,
        activities: [{ id: "preview-click-started", summary: displayName, live: false }],
      });
    },
  );

  it.each([
    [0, "Used browser 3 times", "browser"],
    [2, "Ran 2 commands and used browser 3 times", "mixed"],
  ] as const)(
    "separates browser counts from %s completed commands",
    (commandCount, summary, summaryKind) => {
      const thread = makeThread({
        id: ThreadId.make("thread-browser-counts"),
        projectId: ProjectId.make("project-1"),
        title: "Browser group counts",
        activities: Array.from({ length: commandCount + 3 }, (_, index) =>
          makeActivity({
            id: EventId.make(`browser-count-${index}`),
            createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
            kind: "tool.completed",
            tone: "tool",
            summary: index < commandCount ? "Ran command" : "MCP tool call",
            payload: {
              toolCallId: `browser-count-${index}`,
              status: "completed",
              ...(index < commandCount
                ? {
                    itemType: "command_execution",
                    data: { item: { command: "/bin/bash -lc 'vp test run'" } },
                  }
                : {
                    itemType: "mcp_tool_call",
                    data: { item: { server: "t3-code", tool: "preview_click" } },
                  }),
            },
          }),
        ),
      });
      expect(
        deriveThreadFeedPresentation(buildThreadFeed(thread), null, new Set(), new Set()),
      ).toMatchObject([{ type: "work-toggle", summary, summaryKind, live: false }]);
    },
  );

  it("defers large tool output expansion until a work row is opened or copied", () => {
    let serializedToolOutputs = 0;
    const activities = Array.from({ length: 5_000 }, (_, index) =>
      makeActivity({
        id: EventId.make(`large-tool-${index}`),
        kind: "tool.completed",
        tone: "tool",
        summary: `Tool ${index}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        payload: {
          title: `Tool ${index}`,
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              toJSON: () => {
                serializedToolOutputs += 1;
                return { output: "x".repeat(32_768) };
              },
            },
          },
        },
      }),
    );
    const thread = makeThread({
      id: ThreadId.make("thread-large-tools"),
      projectId: ProjectId.make("project-1"),
      title: "Large tools",
      activities,
    });

    const feed = buildThreadFeed(thread);
    expect(serializedToolOutputs).toBe(0);

    const group = feed[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(5_000);
    const expanded = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(["work-group:large-tool-0"]),
    );
    expect(expanded).toHaveLength(2);
    expect(expanded[1]).toMatchObject({
      type: "activity-group",
      id: "work-details:work-group:large-tool-0",
    });
    if (expanded[1]?.type === "activity-group") {
      expect(expanded[1].activities).toHaveLength(5_000);
      expect(expanded[1].activities[0]?.getFullDetail).toBe(group.activities[0]?.getFullDetail);
    }
    expect(serializedToolOutputs).toBe(0);
    expect(group.activities[0]?.getFullDetail()).toContain('"output"');
    expect(serializedToolOutputs).toBe(1);
    expect(group.activities[0]?.getCopyText()).toContain('"output"');
    expect(serializedToolOutputs).toBe(1);
  });

  it("keeps the first and terminal assistant messages visible around settled work", () => {
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
          id: MessageId.make("assistant-first"),
          role: "assistant",
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
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
    expect(collapsed.map((entry) => entry.id)).toEqual([
      "assistant-first",
      "turn-fold:turn-1",
      "assistant-final",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "turn-fold",
      label: "Worked for 17s",
      expanded: false,
    });

    const expanded = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set([turnId]));
    expect(expanded.map((entry) => entry.id)).toEqual([
      "assistant-first",
      "turn-fold:turn-1",
      "work-toggle:work-group:tool-completed",
      "assistant-final",
    ]);

    const interrupted = deriveThreadFeedPresentation(
      feed,
      { ...thread.latestTurn!, state: "interrupted", completedAt: "2026-04-01T00:00:20.000Z" },
      new Set(),
    );
    expect(interrupted[1]).toMatchObject({
      type: "turn-fold",
      label: "You stopped after 19s",
      expanded: false,
    });
    const retimed = deriveThreadFeedPresentation(
      buildThreadFeed({
        ...thread,
        messages: [
          thread.messages[0]!,
          { ...thread.messages[1]!, updatedAt: "2026-04-01T00:00:25.000Z" },
        ],
      }),
      null,
      new Set(),
    );
    expect(retimed[1]).toMatchObject({ type: "turn-fold", label: "Worked for 23s" });
    expect(collapsed[1]).toMatchObject({ type: "turn-fold", label: "Worked for 17s" });
  });

  it("folds assistant messages between the first and terminal messages", () => {
    const turnId = TurnId.make("turn-1");
    const thread = makeThread({
      id: ThreadId.make("thread-middle-message"),
      projectId: ProjectId.make("project-1"),
      title: "Bounded narration",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:06.000Z",
        assistantMessageId: MessageId.make("assistant-final"),
      },
      messages: [
        {
          id: MessageId.make("assistant-first"),
          role: "assistant",
          text: "The main result is ready.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:01.000Z",
          updatedAt: "2026-04-01T00:00:02.000Z",
        },
        {
          id: MessageId.make("assistant-middle"),
          role: "assistant",
          text: "I am checking one more detail.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:03.000Z",
          updatedAt: "2026-04-01T00:00:04.000Z",
        },
        {
          id: MessageId.make("assistant-final"),
          role: "assistant",
          text: "Verification finished.",
          turnId,
          streaming: false,
          createdAt: "2026-04-01T00:00:05.000Z",
          updatedAt: "2026-04-01T00:00:06.000Z",
        },
      ],
    });

    const feed = buildThreadFeed(thread);
    const rows = deriveThreadFeedPresentation(feed, thread.latestTurn, new Set());

    expect(rows.map((entry) => entry.id)).toEqual([
      "assistant-first",
      "turn-fold:turn-1",
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
          id: EventId.make("tool-succeeded"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run command",
          createdAt: "2026-04-01T00:00:04.000Z",
          turnId,
          payload: {
            title: "Run command",
            itemType: "command_execution",
            detail: "done",
            status: "completed",
          },
        }),
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
    expect(deriveThreadFeedPresentation(feed, thread.latestTurn, new Set())).toMatchObject([
      {
        type: "work-toggle",
        summary: "Ran 2 commands",
        hiddenCount: 2,
        hasFailure: true,
      },
    ]);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ status: "success" }, { status: "failure" }],
    });
    const expanded = deriveThreadFeedPresentation(
      feed,
      thread.latestTurn,
      new Set(),
      new Set(["work-group:tool-succeeded"]),
    );
    expect(expanded.map((entry) => entry.id)).toEqual([
      "work-toggle:work-group:tool-succeeded",
      "work-details:work-group:tool-succeeded",
    ]);
    expect(expanded[1]).toMatchObject({
      type: "activity-group",
      activities: [
        { id: "tool-succeeded", status: "success", groupedToolDetail: true },
        { id: "tool-failed", status: "failure", groupedToolDetail: true },
      ],
    });
  });

  it("keeps expanded work in one group with stable row identities", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
      toolSurface?: "browser" | "computer",
      toolIcon?: import("@t3tools/contracts").ToolActivityIcon,
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      turnId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      toolLike: true,
      status,
      workEntry: {
        id,
        createdAt,
        turnId: null,
        label: `Tool ${id}`,
        command: `command ${id}`,
        tone: "tool",
        ...(toolSurface ? { toolSurface } : {}),
        ...(toolIcon ? { toolIcon } : {}),
      },
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
          activity("activity-2", "2026-04-01T00:00:03.000Z", "success", "browser"),
          activity("activity-3", "2026-04-01T00:00:04.000Z", "success", "computer", {
            _tag: "native-app",
            app: { _tag: "app-id", appId: "com.example.Editor" },
          }),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["work-toggle:work-group:activity-1"]);
    expect(collapsed[0]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group:activity-1",
      hiddenCount: 3,
      expanded: false,
      summary: "Ran 3 commands",
      toolSurface: "computer",
      toolIcon: {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.example.Editor" },
      },
    });

    const expanded = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(["work-group:activity-1"]),
    );
    expect(expanded.map((entry) => entry.id)).toEqual([
      "work-toggle:work-group:activity-1",
      "work-details:work-group:activity-1",
    ]);
    expect(expanded[0]).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
    expect(expanded[1]).toMatchObject({
      type: "activity-group",
      activities: [
        { id: "activity-1", groupedToolDetail: true, live: false },
        { id: "activity-2", groupedToolDetail: true, live: false },
        { id: "activity-3", groupedToolDetail: true, live: false },
      ],
    });
    const unchanged = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(["work-group:activity-1", "unrelated-group"]),
    );
    expect(unchanged[0]).toBe(expanded[0]);
    expect(unchanged[1]).toBe(expanded[1]);
    expect(deriveThreadFeedPresentation(feed, null, new Set())).toEqual(collapsed);
  });

  it.each(
    [
      "sudo -u root pnpm test",
      "/bin/zsh -lc 'sudo -u root pnpm test'",
      "/bin/bash -lc 'sudo -u root pnpm test'",
    ].flatMap((command) =>
      (
        [
          { lifecycleStatus: "inProgress", summary: "Running pnpm", shimmer: true },
          { lifecycleStatus: "completed", summary: "Running pnpm", shimmer: true },
          { lifecycleStatus: "failed", summary: "Failed pnpm", shimmer: false },
          { lifecycleStatus: "declined", summary: "Declined pnpm", shimmer: false },
          { lifecycleStatus: "stopped", summary: "Stopped pnpm", shimmer: false },
        ] as const
      ).map((state) => ({ command, ...state })),
    ),
  )(
    "keeps the command summary in sync with $lifecycleStatus: $command",
    ({ command, lifecycleStatus, summary, shimmer }) => {
      const turnId = TurnId.make("turn-live-tools");
      const activity = (
        id: string,
        status: ThreadFeedActivity["status"],
        lifecycleStatus: ThreadFeedActivity["lifecycleStatus"],
        tone: "tool" | "error" = "tool",
        command?: string,
      ): ThreadFeedActivity => ({
        id,
        createdAt: `2026-04-01T00:00:0${id.at(-1)}.000Z`,
        turnId,
        summary: `Tool ${id}`,
        detail: lifecycleStatus === "stopped" ? "Exit code 130" : null,
        canExpand: false,
        getFullDetail: () => null,
        getCopyText: () => id,
        icon: "command",
        toolLike: true,
        status,
        lifecycleStatus,
        workEntry: {
          id,
          createdAt: `2026-04-01T00:00:0${id.at(-1)}.000Z`,
          turnId,
          label: `Tool ${id}`,
          tone,
          toolLifecycleStatus: lifecycleStatus,
          ...(lifecycleStatus === "stopped" ? { detail: "Exit code 130" } : {}),
          ...(command ? { command, itemType: "command_execution" as const } : {}),
        },
      });
      const feed: ThreadFeedEntry[] = [
        {
          type: "activity-group",
          id: "activity-1",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId,
          activities: [
            activity("activity-1", "success", "completed"),
            activity("activity-2", "failure", "failed", "error"),
            activity(
              "activity-3",
              lifecycleStatus === "inProgress"
                ? "neutral"
                : lifecycleStatus === "completed"
                  ? "success"
                  : "failure",
              lifecycleStatus,
              "tool",
              command,
            ),
            ...(lifecycleStatus === "inProgress"
              ? [activity("activity-4", "success", "completed", "tool", "printf done")]
              : []),
          ],
        },
      ];
      const latestTurn = {
        turnId,
        state: "running" as const,
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      };

      const rows = deriveThreadFeedPresentation(
        feed,
        latestTurn,
        new Set(),
        new Set(),
        latestTurn.startedAt,
      );
      // The shimmering row is the turn's live slot; once it stops shimmering
      // the slot belongs to "Thinking" and the group keeps its own identity.
      expect(rows.slice(0, 3).map((entry) => [entry.id, entry.type])).toEqual([
        ["work-toggle:work-group:activity-1", "work-toggle"],
        ["activity-2", "activity-group"],
        [shimmer ? "live-activity-row" : "work-live:work-group:activity-3", "work-toggle"],
      ]);
      expect(rows.slice(0, 3).map((entry) => entry.type === "work-toggle" && entry.live)).toEqual([
        false,
        false,
        true,
      ]);
      expect(rows[2]).toMatchObject({
        summary,
        summaryKind: "command",
        live: true,
        shimmer,
      });
      expect(rows[0]).toMatchObject({ live: false, shimmer: false });
      // Exactly one live activity: the shimmering call, or "Thinking" once it fails.
      expect(rows.filter((entry) => entry.type === "thinking")).toHaveLength(shimmer ? 0 : 1);
      expect(rows.at(-1)?.type).toBe(shimmer ? "work-toggle" : "thinking");

      const stoppedRows = deriveThreadFeedPresentation(feed, latestTurn, new Set());
      expect(stoppedRows.some((entry) => entry.type === "thinking")).toBe(false);
      expect(stoppedRows.filter((entry) => entry.type === "work-toggle")).toMatchObject([
        { live: false, shimmer: false },
        {
          live: false,
          shimmer: false,
          summary: lifecycleStatus === "inProgress" ? "printf done" : command,
        },
      ]);

      const completedRows = deriveThreadFeedPresentation(
        feed,
        { ...latestTurn, state: "completed", completedAt: "2026-04-01T00:00:04.000Z" },
        new Set([turnId]),
        new Set(),
        latestTurn.startedAt,
      );
      expect(completedRows.filter((entry) => entry.type === "work-toggle")).toMatchObject([
        { live: false, shimmer: false },
        { live: false, shimmer: false },
      ]);
    },
  );

  it("shows one Thinking row while a turn works without live tool activity", () => {
    const turnId = TurnId.make("turn-thinking");
    const latestTurn = {
      turnId,
      state: "running" as const,
      requestedAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    };
    const feed = buildThreadFeed(
      makeThread({
        id: ThreadId.make("thread-thinking"),
        projectId: ProjectId.make("project-1"),
        title: "Thinking",
        latestTurn,
        messages: [
          {
            id: MessageId.make("user-1"),
            role: "user",
            text: "hello",
            turnId,
            streaming: false,
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const rows = deriveThreadFeedPresentation(feed, latestTurn, new Set(), new Set(), "now");
    expect(rows.map((entry) => entry.type)).toEqual(["message", "thinking"]);
    expect(rows[1]).toMatchObject({ id: "live-activity-row", createdAt: "now", turnId });
    // The row identity is stable across re-derivations so the list can reuse it.
    expect(deriveThreadFeedPresentation(feed, latestTurn, new Set(), new Set(), "now")[1]).toBe(
      rows[1],
    );
    // Idle threads show no live activity.
    expect(
      deriveThreadFeedPresentation(feed, latestTurn, new Set(), new Set(), null).map(
        (entry) => entry.type,
      ),
    ).toEqual(["message"]);
  });

  it("keeps one live slot while calls fail and restart", () => {
    // Recorded from a Claude session whose Bash was broken: every call went
    // inProgress → failed within two seconds. Each transition used to insert
    // or remove a Thinking row under the group; now the same row id holds
    // the live call and then "Thinking", so the list updates it in place.
    const turnId = TurnId.make("turn-failing-calls");
    const latestTurn = {
      turnId,
      state: "running" as const,
      requestedAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    };
    const call = (n: number, status: "inProgress" | "failed") =>
      makeActivity({
        id: EventId.make(`call-${n}-${status}`),
        kind: status === "failed" ? "tool.completed" : "tool.updated",
        tone: "tool",
        summary: "Command run",
        createdAt: `2026-04-01T00:00:${String(n * 2 + (status === "failed" ? 1 : 0)).padStart(2, "0")}.000Z`,
        turnId,
        payload: {
          itemType: "command_execution",
          toolCallId: `call-${n}`,
          title: "Command run",
          status,
          detail: `Bash: ls ${n}`,
        },
      });
    const liveIds = (activities: ReadonlyArray<ReturnType<typeof makeActivity>>) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(
          makeThread({
            id: ThreadId.make("thread-failing-calls"),
            projectId: ProjectId.make("project-1"),
            title: "Failing calls",
            latestTurn,
            activities,
          }),
        ),
        latestTurn,
        new Set(),
        new Set(),
        latestTurn.startedAt,
      ).map((row) => `${row.type}:${row.id}`);

    expect(liveIds([call(1, "inProgress")])).toEqual(["work-toggle:live-activity-row"]);
    expect(liveIds([call(1, "inProgress"), call(1, "failed")])).toEqual([
      "work-toggle:work-live:work-group:tool:turn-failing-calls:call-1",
      "thinking:live-activity-row",
    ]);
    expect(liveIds([call(1, "inProgress"), call(1, "failed"), call(2, "inProgress")])).toEqual([
      "work-toggle:live-activity-row",
    ]);
    // A call whose end was never reported, in a run before an error row,
    // keeps its own identity: only the trailing run can hold the live slot.
    const errorRow = makeActivity({
      id: EventId.make("runtime-error"),
      kind: "runtime.error",
      tone: "error",
      summary: "Provider error",
      createdAt: "2026-04-01T00:00:02.500Z",
      turnId,
      payload: { message: "boom" },
    });
    expect(liveIds([call(1, "inProgress"), errorRow, call(2, "inProgress")])).toEqual([
      "work-toggle:work-live:work-group:tool:turn-failing-calls:call-1",
      "activity-group:runtime-error",
      "work-toggle:live-activity-row",
    ]);
  });

  it("hands a settled tool run off to Thinking once assistant text streams after it", () => {
    const turnId = TurnId.make("turn-streaming-tail");
    const latestTurn = {
      turnId,
      state: "running" as const,
      requestedAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    };
    const feed = buildThreadFeed(
      makeThread({
        id: ThreadId.make("thread-streaming-tail"),
        projectId: ProjectId.make("project-1"),
        title: "Streaming tail",
        latestTurn,
        messages: [
          {
            id: MessageId.make("assistant-1"),
            role: "assistant",
            text: "Here is what I found",
            turnId,
            streaming: true,
            createdAt: "2026-04-01T00:00:05.000Z",
            updatedAt: "2026-04-01T00:00:06.000Z",
          },
        ],
        activities: [
          makeActivity({
            id: EventId.make("read-completed"),
            kind: "tool.completed",
            tone: "tool",
            summary: "Read file",
            createdAt: "2026-04-01T00:00:02.000Z",
            turnId,
            payload: {
              itemType: "file_read",
              toolCallId: "read-1",
              title: "Read file",
              status: "completed",
              detail: "src/index.ts",
            },
          }),
        ],
      }),
    );

    const rows = deriveThreadFeedPresentation(
      feed,
      latestTurn,
      new Set(),
      new Set(),
      latestTurn.startedAt,
    );
    expect(rows.map((entry) => entry.type)).toEqual(["work-toggle", "message", "thinking"]);
    expect(rows[0]).toMatchObject({ live: false, shimmer: false });
  });

  it("preserves serialized shell wrappers with non-matching boundary quotes", () => {
    const turnId = TurnId.make("turn-serialized-shell-wrapper");
    const command =
      "/bin/zsh -lc 'git status\nsed -n '\"'1,20p' apps/web/src/components/DiffPanel.tsx\"";
    const thread = makeThread({
      id: ThreadId.make("thread-serialized-shell-wrapper"),
      projectId: ProjectId.make("project-1"),
      title: "Serialized shell wrapper",
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("serialized-shell-wrapper"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Ran command",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId,
          payload: {
            itemType: "command_execution",
            status: "inProgress",
            data: { item: { command } },
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ workEntry: { command } }],
    });
    if (feed[0]?.type === "activity-group") {
      expect(feed[0].activities[0]?.workEntry.rawCommand).toBeUndefined();
    }
  });

  it.each([
    ["inProgress", true],
    ["completed", false],
    ["failed", false],
    ["declined", false],
    ["stopped", false],
  ] as const)("respects the %s lifecycle of trailing task progress", (status, shimmer) => {
    const turnId = TurnId.make("turn-task-progress");
    const thread = makeThread({
      id: ThreadId.make("thread-task-progress"),
      projectId: ProjectId.make("project-1"),
      title: "Task lifecycle",
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
          id: EventId.make("task-progress"),
          kind: "task.progress",
          summary: "Task progress",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: { taskId: "task-1", status },
        }),
      ],
    });

    const rows = deriveThreadFeedPresentation(
      buildThreadFeed(thread),
      thread.latestTurn,
      new Set(),
      new Set(),
      thread.latestTurn!.startedAt,
    );
    expect(rows.some((entry) => entry.type === "work-toggle" && entry.shimmer)).toBe(shimmer);
  });

  it("does not revive cached in-progress tools after work stops", () => {
    const turnId = TurnId.make("turn-stale-tool");
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "stale-tool",
        createdAt: "2026-04-01T00:00:01.000Z",
        turnId,
        activities: [
          {
            id: "stale-tool",
            createdAt: "2026-04-01T00:00:01.000Z",
            turnId,
            summary: "Running tests",
            detail: null,
            canExpand: false,
            getFullDetail: () => null,
            getCopyText: () => "",
            icon: "command",
            toolLike: true,
            status: "neutral",
            lifecycleStatus: "inProgress",
            workEntry: {
              id: "stale-tool",
              createdAt: "2026-04-01T00:00:01.000Z",
              turnId,
              label: "Running tests",
              tone: "tool",
              toolLifecycleStatus: "inProgress",
            },
          },
        ],
      },
    ];
    const latestTurn = {
      turnId,
      state: "running" as const,
      requestedAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    };

    expect(deriveThreadFeedPresentation(feed, latestTurn, new Set())).toEqual([]);
    expect(
      deriveThreadFeedPresentation(feed, latestTurn, new Set(), new Set(), latestTurn.startedAt),
    ).toMatchObject([{ type: "work-toggle", live: true, shimmer: true }]);
  });

  it("collapses interleaved tool lifecycles by call identity", () => {
    const turnId = TurnId.make("turn-parallel-tools");
    const toolActivity = (
      id: string,
      toolCallId: string,
      kind: "tool.updated" | "tool.completed",
      status: "inProgress" | "completed",
      detail: string,
      nestedId = false,
    ) =>
      makeActivity({
        id: EventId.make(id),
        kind,
        tone: "tool",
        summary: `Run ${toolCallId} command`,
        createdAt: `2026-04-01T00:00:0${id.at(-1)}.000Z`,
        turnId,
        payload: {
          ...(nestedId ? { data: { toolCallId } } : { toolCallId }),
          itemType: "command_execution",
          status,
          detail,
        },
      });
    const thread = makeThread({
      id: ThreadId.make("thread-parallel-tools"),
      projectId: ProjectId.make("project-1"),
      title: "Parallel tools",
      activities: [
        toolActivity("call-a-1", "call-a", "tool.updated", "inProgress", "starting"),
        toolActivity("call-b-2", "call-b", "tool.updated", "inProgress", "starting", true),
        toolActivity("call-a-3", "call-a", "tool.completed", "completed", "first output"),
        toolActivity("call-b-4", "call-b", "tool.completed", "completed", "second output", true),
      ],
    });

    const feed = buildThreadFeed(thread);
    const activityGroup = feed.find((entry) => entry.type === "activity-group");
    expect(activityGroup).toMatchObject({
      type: "activity-group",
      activities: [
        { id: "call-a-1", lifecycleStatus: "completed", detail: "first output" },
        { id: "call-b-2", lifecycleStatus: "completed", detail: "second output" },
      ],
    });
    expect(
      deriveThreadFeedPresentation(feed, null, new Set([turnId])).find(
        (entry) => entry.type === "work-toggle",
      ),
    ).toMatchObject({
      type: "work-toggle",
      hiddenCount: 2,
      summary: "Ran 2 commands",
      live: false,
    });

    const groupId = `work-group:tool:${turnId}:call-a`;
    const startedAt = "2026-04-01T00:00:00.000Z";
    const runningRows = deriveThreadFeedPresentation(
      buildThreadFeed({ ...thread, activities: thread.activities.slice(0, 2) }),
      { turnId, state: "running", startedAt, completedAt: null },
      new Set(),
      new Set([groupId]),
      startedAt,
    );
    expect(runningRows.find((entry) => entry.type === "activity-group")).toMatchObject({
      id: `work-details:${groupId}`,
      activities: [
        { id: "call-a-1", lifecycleStatus: "inProgress", groupedToolDetail: true, live: false },
        { id: "call-b-2", lifecycleStatus: "inProgress", groupedToolDetail: true, live: true },
      ],
    });

    const completedRows = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([turnId]),
      new Set([groupId]),
    );
    expect(completedRows.find((entry) => entry.type === "activity-group")).toMatchObject({
      id: `work-details:${groupId}`,
      activities: [
        { id: "call-a-1", lifecycleStatus: "completed", groupedToolDetail: true, live: false },
        { id: "call-b-2", lifecycleStatus: "completed", groupedToolDetail: true, live: false },
      ],
    });

    const correctedFeed = buildThreadFeed({
      ...thread,
      activities: thread.activities.map((activity) =>
        activity.id === "call-a-3"
          ? {
              ...activity,
              tone: "error",
              payload: {
                toolCallId: "call-a",
                itemType: "command_execution",
                status: "failed",
                detail: "Corrected failure output",
              },
            }
          : activity,
      ),
    });
    const correctedGroup = correctedFeed.find((entry) => entry.type === "activity-group");
    expect(correctedGroup).toMatchObject({
      activities: [
        { id: "call-a-1", lifecycleStatus: "failed", detail: "Corrected failure output" },
        { id: "call-b-2", lifecycleStatus: "completed", detail: "second output" },
      ],
    });
    expect(correctedGroup?.activities[0]?.getCopyText()).toContain("Corrected failure output");
    expect(activityGroup?.activities[0]?.getCopyText()).toContain("first output");
    const correctedRows = deriveThreadFeedPresentation(
      correctedFeed,
      null,
      new Set([turnId]),
      new Set([groupId]),
    );
    expect(correctedRows.find((entry) => entry.type === "activity-group")).toMatchObject({
      id: "call-a-1",
      activities: [{ status: "failure", workEntry: { tone: "error" } }],
    });
  });
});

describe("quiet timeline: nested agents", () => {
  it.each(["task.updated", "task.progress"] as const)(
    "does not mark an ordinary task complete when it resumes through %s",
    (resumeKind) => {
      const thread = makeThread({
        id: ThreadId.make("resumed-agent"),
        projectId: ProjectId.make("project-1"),
        title: "Resumed agent",
        activities: (
          [
            ["task.progress", "running", "Review"],
            ["task.updated", "idle", "Task idle"],
            [resumeKind, "running", "Review resumed"],
          ] as const
        ).map(([kind, status, summary], index) =>
          makeActivity({
            id: EventId.make(`resumed-${index}`),
            kind,
            summary,
            createdAt: `2026-04-01T00:00:0${index + 1}.000Z`,
            payload: {
              taskId: "agent-1",
              agentKind: "agent",
              title: "Reviewer",
              status,
              detail: summary,
            },
          }),
        ),
      });
      const rows = buildThreadFeed(thread).flatMap((entry) =>
        entry.type === "activity-group" ? entry.activities : [],
      );
      // The agent folds into its spawn batch, which stays live after a resume.
      expect(rows).toMatchObject([
        {
          lifecycleStatus: "inProgress",
          summary: "Kicked off 1 subagent · 1 working",
          workEntry: { agentSpawn: { workflowId: null, agentTaskIds: ["agent-1"] } },
        },
      ]);
    },
  );

  it("folds a turn's direct spawns into one batch row that tracks their states", () => {
    const turnId = TurnId.make("turn-spawn");
    const agent = (
      id: string,
      kind: "task.started" | "task.progress" | "task.completed" | "task.updated",
      taskId: string,
      status: string,
      seconds: number,
      extra: Record<string, unknown> = {},
    ) =>
      makeActivity({
        id: EventId.make(id),
        kind,
        summary: `${taskId} ${status}`,
        createdAt: `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`,
        turnId,
        payload: {
          taskId,
          agentKind: "agent",
          taskType: "local_agent",
          title: `Agent ${taskId}`,
          status,
          ...extra,
        },
      });
    const shell = makeActivity({
      id: EventId.make("shell-1"),
      kind: "task.completed",
      summary: "Task completed",
      createdAt: "2026-04-01T00:00:05.000Z",
      turnId,
      payload: {
        taskId: "sh-1",
        agentKind: "background",
        taskType: "local_bash",
        status: "completed",
        title: "Run tests",
        detail: "Run tests",
      },
    });
    const activities = [
      agent("a-start", "task.started", "a", "running", 1),
      agent("b-start", "task.started", "b", "running", 2),
      agent("a-progress", "task.progress", "a", "running", 3, { detail: "Reading files" }),
      shell,
      agent("b-progress", "task.progress", "b", "running", 6, { detail: "Grepping" }),
    ];
    const rowsFor = (extraActivities: ReadonlyArray<ReturnType<typeof makeActivity>>) =>
      buildThreadFeed(
        makeThread({
          id: ThreadId.make("thread-spawn"),
          projectId: ProjectId.make("project-1"),
          title: "Spawns",
          activities: [...activities, ...extraActivities],
        }),
      ).flatMap((entry) => (entry.type === "activity-group" ? entry.activities : []));

    // The batch anchors on the first task.started: a fixed id and timestamp,
    // unlike progress ticks (which the server rewrites in place).
    const running = rowsFor([]);
    expect(running.map((row) => [row.id, row.summary])).toEqual([
      ["a-start", "Kicked off 2 subagents · 2 working"],
      ["shell-1", "Run tests"],
    ]);
    expect(running[0]).toMatchObject({
      createdAt: "2026-04-01T00:00:01.000Z",
      lifecycleStatus: "inProgress",
      workEntry: { agentSpawn: { agentTaskIds: ["a", "b"] } },
    });

    const oneDone = rowsFor([agent("a-done", "task.completed", "a", "completed", 7)]);
    expect(oneDone[0]).toMatchObject({
      id: "a-start",
      summary: "Kicked off 2 subagents · 1 working",
      lifecycleStatus: "inProgress",
    });

    const allDone = rowsFor([
      agent("a-done", "task.completed", "a", "completed", 7),
      agent("b-failed", "task.updated", "b", "failed", 8, { error: "boom" }),
    ]);
    expect(allDone[0]).toMatchObject({
      id: "a-start",
      summary: "Ran 2 subagents · 1 failed",
      lifecycleStatus: "failed",
      status: "failure",
    });
    expect(allDone).toHaveLength(2);
  });

  it("folds the tool call that launched an agent into its spawn card", () => {
    const turnId = TurnId.make("turn-agent-tool");
    const at = (seconds: number) => `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
    const feed = buildThreadFeed(
      makeThread({
        id: ThreadId.make("thread-agent-tool"),
        projectId: ProjectId.make("project-1"),
        title: "Agent tool",
        activities: [
          makeActivity({
            id: EventId.make("agent-call-updated"),
            kind: "tool.updated",
            tone: "tool",
            summary: "Subagent task",
            createdAt: at(1),
            turnId,
            payload: {
              itemType: "collab_agent_tool_call",
              toolCallId: "toolu_agent",
              status: "inProgress",
              title: "Subagent task",
              detail: "Locate code",
              data: { toolName: "Agent" },
            },
          }),
          makeActivity({
            id: EventId.make("agent-started"),
            kind: "task.started",
            summary: "Locate code",
            createdAt: at(2),
            turnId,
            payload: {
              taskId: "a1",
              agentKind: "agent",
              taskType: "local_agent",
              title: "Locate code",
              toolUseId: "toolu_agent",
            },
          }),
          makeActivity({
            id: EventId.make("agent-done"),
            kind: "task.completed",
            summary: "Locate code",
            createdAt: at(3),
            turnId,
            payload: {
              taskId: "a1",
              agentKind: "agent",
              taskType: "local_agent",
              title: "Locate code",
              toolUseId: "toolu_agent",
              status: "completed",
            },
          }),
          makeActivity({
            id: EventId.make("agent-call-completed"),
            kind: "tool.completed",
            tone: "tool",
            summary: "Subagent task",
            createdAt: at(4),
            turnId,
            payload: {
              itemType: "collab_agent_tool_call",
              toolCallId: "toolu_agent",
              status: "completed",
              title: "Subagent task",
              detail: "Locate code",
              data: { toolName: "Agent" },
            },
          }),
        ],
      }),
    );
    const rows = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities.map((row) => row.id) : [],
    );
    expect(rows).toEqual(["agent-started"]);
    expect(
      deriveThreadFeedPresentation(feed, null, new Set([turnId])).map((row) => row.type),
    ).toEqual(["turn-fold", "agent-spawn"]);
  });

  it("presents a spawn batch as one card whose status line follows the newest member activity", () => {
    const turnId = TurnId.make("turn-spawn-card");
    const latestTurn = {
      turnId,
      state: "running" as const,
      requestedAt: "2026-04-01T00:00:00.000Z",
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    };
    const agent = (
      id: string,
      kind: "task.started" | "task.progress" | "task.completed",
      taskId: string,
      seconds: number,
      extra: Record<string, unknown> = {},
    ) =>
      makeActivity({
        id: EventId.make(id),
        kind,
        summary: `Agent ${taskId}`,
        createdAt: `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`,
        turnId,
        payload: {
          taskId,
          agentKind: "agent",
          taskType: "local_agent",
          title: `Agent ${taskId}`,
          ...extra,
        },
      });
    const presentFor = (activities: ReadonlyArray<ReturnType<typeof makeActivity>>) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(
          makeThread({
            id: ThreadId.make("thread-spawn-card"),
            projectId: ProjectId.make("project-1"),
            title: "Spawn card",
            latestTurn,
            activities,
          }),
        ),
        latestTurn,
        new Set(),
        new Set(),
        latestTurn.startedAt,
      );

    // A working card is the live activity; no Thinking row sits under it.
    const single = presentFor([agent("a-start", "task.started", "a", 1)]);
    expect(single.map((row) => row.type)).toEqual(["agent-spawn"]);
    expect(single[0]).toMatchObject({
      id: `agent-spawn:${turnId}`,
      summary: { title: "Agent a", status: "Working", tone: "working" },
    });

    // The server upserts the progress row with a new createdAt each tick;
    // the card keeps its identity and only the status line changes.
    const tick = (seconds: number, detail: string) =>
      presentFor([
        agent("a-start", "task.started", "a", 1),
        agent("task-progress:a", "task.progress", "a", seconds, { detail }),
      ]);
    expect(tick(2, "Reading a.ts")[0]).toMatchObject({
      id: `agent-spawn:${turnId}`,
      createdAt: "2026-04-01T00:00:01.000Z",
      summary: { title: "Agent a", status: "Reading a.ts", tone: "working" },
    });
    expect(tick(3, "Reading b.ts")[0]).toMatchObject({
      id: `agent-spawn:${turnId}`,
      createdAt: "2026-04-01T00:00:01.000Z",
      summary: { status: "Reading b.ts" },
    });

    const batch = presentFor([
      agent("a-start", "task.started", "a", 1),
      agent("b-start", "task.started", "b", 2),
      agent("task-progress:b", "task.progress", "b", 3, { detail: "Grepping" }),
      agent("a-done", "task.completed", "a", 4, { status: "completed" }),
    ]);
    expect(batch[0]).toMatchObject({
      id: `agent-spawn:${turnId}`,
      summary: {
        title: "2 subagents",
        status: "Grepping",
        tone: "working",
        members: [
          { title: "Agent a", status: "completed", tone: "completed" },
          { title: "Agent b", status: "working", tone: "working", detail: "Grepping" },
        ],
      },
    });

    const settled = presentFor([
      agent("a-start", "task.started", "a", 1),
      agent("b-start", "task.started", "b", 2),
      agent("a-done", "task.completed", "a", 4, { status: "completed" }),
      agent("b-done", "task.completed", "b", 5, { status: "failed", error: "boom" }),
    ]);
    expect(settled[0]).toMatchObject({
      type: "agent-spawn",
      summary: { title: "2 subagents", status: "1 failed", tone: "failed" },
    });
    expect(settled.map((row) => row.type)).toEqual(["agent-spawn", "thinking"]);
  });

  it.each(["cancelled", "failed", "interrupted", "idle"] as const)(
    "replaces Antigravity batch progress with %s",
    (status) => {
      const detail =
        status === "idle"
          ? "Turn ended. Individual agent status is unavailable."
          : "Antigravity process stopped.";
      const thread = makeThread({
        id: ThreadId.make("antigravity-agents"),
        projectId: ProjectId.make("project-1"),
        title: "Antigravity subagents",
        activities: [
          ...["trajectory:4", "trajectory:5"].map((taskId, index) =>
            makeActivity({
              id: EventId.make(`progress-${index}`),
              kind: "task.progress",
              summary: "Antigravity subagent batch",
              createdAt: `2026-04-01T00:00:0${index + 1}.000Z`,
              payload: {
                taskId,
                taskType: "subagent_batch",
                agentKind: "agent",
                title: "Antigravity subagent batch",
                detail: "Antigravity subagent batch",
                status: "running",
              },
            }),
          ),
          makeActivity({
            id: EventId.make("agent-stopped"),
            kind: "task.updated",
            summary: `Task ${status}`,
            createdAt: "2026-04-01T00:00:03.000Z",
            payload: {
              taskId: "trajectory:4",
              taskType: "subagent_batch",
              agentKind: "agent",
              title: "Antigravity subagent batch",
              status,
              ...(status === "idle" ? { detail, timelineBypass: true } : { error: detail }),
            },
          }),
        ],
      });
      const rows = buildThreadFeed(thread).flatMap((entry) =>
        entry.type === "activity-group" ? entry.activities : [],
      );
      // Turn-less batches never share a spawn group, so each keeps its own row.
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        lifecycleStatus: status === "failed" ? "failed" : "stopped",
        summary: `Ran 1 subagent · ${status === "failed" ? "1 failed" : "1 stopped"}`,
        workEntry: {
          taskId: "trajectory:4",
          toolTitle: "Antigravity subagent batch",
          agentSpawn: { agents: [{ detail }] },
        },
      });
      expect(rows[0]?.getFullDetail()).toContain(detail);
      expect(rows[1]).toMatchObject({
        lifecycleStatus: "inProgress",
        summary: "Kicked off 1 subagent · 1 working",
        workEntry: { taskId: "trajectory:5" },
      });
    },
  );

  it("folds bypassed Claude workflow members into the coordinator's batch and settles them with it", () => {
    const turnId = TurnId.make("turn-workflow");
    const at = (seconds: number) => `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
    const thread = makeThread({
      id: ThreadId.make("thread-workflow"),
      projectId: ProjectId.make("project-1"),
      title: "Workflow",
      activities: [
        makeActivity({
          id: EventId.make("wf-progress"),
          kind: "task.progress",
          summary: "Workflow running",
          createdAt: at(1),
          turnId,
          payload: {
            taskId: "wf-1",
            taskType: "local_workflow",
            workflowName: "review",
            agentKind: "agent",
            title: "review",
            status: "running",
          },
        }),
        // Members are synthesized with timelineBypass and never render alone.
        ...[0, 1].map((index) =>
          makeActivity({
            id: EventId.make(`member-${index}`),
            kind: "task.progress",
            summary: `Agent ${index}`,
            createdAt: at(2 + index),
            turnId,
            payload: {
              taskId: `wf-1:wf:${index}`,
              agentKind: "agent",
              title: `Reviewer ${index}`,
              description: `Reviewer ${index}`,
              status: index === 0 ? "completed" : "running",
              parentAgentId: "wf-1",
              timelineBypass: true,
            },
          }),
        ),
        makeActivity({
          id: EventId.make("wf-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: at(10),
          turnId,
          payload: {
            taskId: "wf-1",
            taskType: "local_workflow",
            workflowName: "review",
            agentKind: "agent",
            status: "completed",
            title: "review",
          },
        }),
      ],
    });
    const rows = buildThreadFeed(thread).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(rows).toHaveLength(1);
    // The member that never reported its own end settles with the coordinator.
    expect(rows[0]).toMatchObject({
      id: "wf-progress",
      summary: "Ran 2 subagents · completed",
      lifecycleStatus: "completed",
      workEntry: {
        agentSpawn: {
          workflowId: "wf-1",
          agentTaskIds: ["wf-1", "wf-1:wf:0", "wf-1:wf:1"],
        },
      },
    });
    expect(rows[0]?.getFullDetail()).toBe("Reviewer 0 · completed\nReviewer 1 · completed");
  });

  it("summarizes a spawn card from the newest member report and the batch outcome", () => {
    type Member = NonNullable<WorkLogEntry["agentSpawn"]>["agents"][number];
    const member = (title: string, status: Member["status"], detail: string, seconds: number) =>
      ({
        title,
        status,
        detail,
        updatedAt: `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`,
      }) satisfies Member;
    const direct = (agents: ReadonlyArray<Member>) => ({
      workflowId: null,
      agentTaskIds: agents.map((_, index) => `a${index}`),
      agents,
    });

    // The newest report wins regardless of member order.
    expect(
      agentSpawnSummary(
        direct([
          member("Agent 0", "inProgress", "Reading b.ts", 5),
          member("Agent 1", "inProgress", "Reading a.ts", 2),
        ]),
        "inProgress",
      ),
    ).toMatchObject({ title: "2 subagents", status: "Reading b.ts", tone: "working" });

    // A declined request is a failed batch, not a completed one.
    expect(
      agentSpawnSummary(direct([member("Agent 0", "declined", "", 1)]), "declined"),
    ).toMatchObject({ status: "failed", tone: "failed" });

    // A coordinator that failed on its own reports the failure even when every
    // member succeeded; before any member reports, the card has a neutral title.
    const workflow = (agents: ReadonlyArray<Member>) => ({
      workflowId: "wf",
      agentTaskIds: ["wf", ...agents.map((_, index) => `wf:wf:${index}`)],
      agents: [member("review", "failed", "", 9), ...agents],
    });
    expect(
      agentSpawnSummary(workflow([member("Reviewer", "completed", "", 3)]), "failed"),
    ).toMatchObject({ title: "Reviewer", status: "failed", tone: "failed" });
    expect(
      agentSpawnSummary(
        { workflowId: "wf", agentTaskIds: ["wf"], agents: [member("review", undefined, "", 1)] },
        "inProgress",
      ),
    ).toMatchObject({ title: "Subagents", status: "Working", tone: "working", members: [] });
  });

  it("treats a Codex child's idle turn end as a finished batch member", () => {
    const turnId = TurnId.make("turn-codex");
    const child = (
      id: string,
      kind: "task.started" | "task.updated",
      status: string,
      seconds: number,
    ) =>
      makeActivity({
        id: EventId.make(id),
        kind,
        summary: `${status}`,
        createdAt: `2026-04-01T00:00:${String(seconds).padStart(2, "0")}.000Z`,
        turnId,
        payload: {
          taskId: "child-1",
          agentKind: "agent",
          title: "math_one",
          status,
          timelineBypass: true,
        },
      });
    const thread = makeThread({
      id: ThreadId.make("thread-codex"),
      projectId: ProjectId.make("project-1"),
      title: "Codex children",
      activities: [
        child("c-start", "task.started", "running", 1),
        child("c-running", "task.updated", "running", 2),
        child("c-idle", "task.updated", "idle", 5),
      ],
    });
    const rows = buildThreadFeed(thread).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      summary: "Ran 1 subagent · completed",
      lifecycleStatus: "completed",
    });
  });

  it("keeps a nested agent's terminal row but hides its background work", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-nested"),
      projectId: ProjectId.make("project-1"),
      title: "Nested agents",
      activities: [
        // A subagent's own shell: internal, covered by the owner's liveness.
        makeActivity({
          id: EventId.make("shell-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          payload: { taskId: "sh-1", agentId: "owner", agentKind: "background" },
        }),
        // A nested AGENT's completion: mobile has no Agents sheet, so this
        // terminal row is the only signal it ever finished.
        makeActivity({
          id: EventId.make("nested-done"),
          kind: "task.completed",
          summary: "Task completed",
          createdAt: "2026-04-01T00:00:03.000Z",
          payload: { taskId: "n-1", agentId: "owner", agentKind: "agent" },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const ids = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities.map((row) => row.id) : [],
    );
    expect(ids).toContain("nested-done");
    expect(ids).not.toContain("shell-done");
    expect(deriveThreadFeedPresentation(feed, null, new Set())).toMatchObject([
      {
        type: "agent-spawn",
        id: "agent-spawn:n-1",
        activity: { id: "nested-done" },
        summary: { title: "Task completed", status: "completed", tone: "completed" },
      },
    ]);
  });
});
