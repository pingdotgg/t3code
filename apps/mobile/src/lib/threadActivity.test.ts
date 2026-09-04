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
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  derivePendingUserInputs,
  deriveThreadFeedPresentation,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
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
    const questions = derivePendingUserInputs([requested])[0]?.questions;
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

    expect(derivePendingUserInputs([requested])).toEqual([
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

describe("pending approvals", () => {
  it("keeps app access approvals and persistence choices from remote environments", () => {
    const options = [
      { decision: "decline", label: "Decline" },
      { decision: "acceptAlways", label: "Always allow Safari" },
      { decision: "accept", label: "Approve" },
    ];
    const activity = makeActivity({
      id: EventId.make("approval-safari"),
      kind: "approval.requested",
      summary: "App access approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: {
        requestId: "req-safari",
        requestType: "mcp_elicitation_approval",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    });

    expect(derivePendingApprovals([activity])).toEqual([
      {
        requestId: "req-safari",
        requestKind: "mcp-elicitation",
        createdAt: "2026-08-24T00:00:00.000Z",
        detail: "Allow ChatGPT to use Safari?",
        appName: "Safari",
        options,
      },
    ]);
  });

  it("removes an app access approval after a remote client rejects it", () => {
    const requested = makeActivity({
      id: EventId.make("approval-safari-open"),
      kind: "approval.requested",
      summary: "App access approval requested",
      createdAt: "2026-08-24T00:00:00.000Z",
      payload: { requestId: "req-safari", requestKind: "mcp-elicitation" },
    });
    const resolved = makeActivity({
      id: EventId.make("approval-safari-resolved"),
      kind: "approval.resolved",
      summary: "Approval resolved",
      createdAt: "2026-08-24T00:00:01.000Z",
      payload: { requestId: "req-safari", decision: "decline" },
    });

    expect(derivePendingApprovals([requested, resolved])).toEqual([]);
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
      const feed = buildThreadFeed({ ...thread, latestTurn: currentTurn });
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
          shimmer: false,
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
          { lifecycleStatus: "completed", summary: "Running pnpm", shimmer: false },
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
      expect(rows.slice(0, 3).map((entry) => [entry.id, entry.type])).toEqual([
        ["work-toggle:work-group:activity-1", "work-toggle"],
        ["activity-2", "activity-group"],
        ["work-live:work-group:activity-3", "work-toggle"],
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

      const stoppedRows = deriveThreadFeedPresentation(feed, latestTurn, new Set());
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
      expect(rows).toMatchObject([
        {
          lifecycleStatus: "inProgress",
          summary: "Reviewer",
          workEntry: { label: resumeKind === "task.progress" ? "Review resumed" : "Review" },
        },
      ]);
    },
  );

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
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        lifecycleStatus: status === "failed" ? "failed" : "stopped",
        detail,
        workEntry: { taskId: "trajectory:4", toolTitle: "Antigravity subagent batch" },
      });
      expect(rows[1]).toMatchObject({
        lifecycleStatus: "inProgress",
        workEntry: { taskId: "trajectory:5" },
      });
    },
  );

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
      { type: "activity-group", id: "nested-done" },
    ]);
  });
});
