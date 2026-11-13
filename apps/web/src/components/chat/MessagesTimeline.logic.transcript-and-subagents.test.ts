import {
  DateTime,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  deriveMessagesTimelineRows,
  deriveTimelineEntriesFromVisibleTurnItems,
  describe,
  expect,
  it,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type WorktreeSetupSnapshot,
} from "./MessagesTimeline.logic-fixtures.ts";

it.each([true, false])(
  "keeps completed responses folded across notification wakes, working=%s",
  (isWorking) => {
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const work = (id: string, run: string, second: number, notification = false) => ({
      kind: "work" as const,
      id,
      createdAt: time(second),
      entry: {
        id,
        runId: RunId.make(run),
        createdAt: time(second),
        label: id,
        tone: "info" as const,
        ...(notification ? { itemType: "notification" as const } : {}),
      },
    });
    const answer = (id: string, run: string, second: number) => ({
      kind: "message" as const,
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role: "assistant" as const,
        text: id,
        runId: RunId.make(run),
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("launch-tools", "initial", 1),
        answer("launched", "initial", 5),
        work("notification-a", "wake-a", 20, true),
        work("read-a", "wake-a", 21),
        answer("ack-a", "wake-a", 25),
        work("notification-b", "wake-b", 40, true),
        work("read-b", "wake-b", 41),
        ...(!isWorking ? [answer("ack-b", "wake-b", 45)] : []),
      ],
      latestRun: {
        runId: RunId.make("wake-b"),
        status: isWorking ? "running" : "completed",
        startedAt: time(40),
        completedAt: isWorking ? null : time(45),
      },
      isWorking,
      activeTurnStartedAt: time(40),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain("turn-fold:initial");
    expect(ids).not.toContain("launch-tools");
    expect(ids).toContain("turn-fold:wake-a");
    expect(ids.indexOf("notification-a")).toBeLessThan(ids.indexOf("turn-fold:wake-a"));
    expect(ids.indexOf("turn-fold:wake-a")).toBeLessThan(ids.indexOf("ack-a"));
    const boundary = isWorking ? "working-indicator-row" : "turn-fold:wake-b";
    expect(ids).toContain(boundary);
    expect(ids.indexOf("notification-b")).toBeLessThan(ids.indexOf(boundary));
    if (isWorking) expect(rows.find((row) => row.id === boundary)?.createdAt).toBe(time(40));
  },
);

it("keeps the working header in place across worktree setup handoff", () => {
  const snapshot: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("thread-setup"),
    phase: "running",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
    sequence: 3,
  };
  const userEntry = {
    id: "user-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: "user-1" as never,
      role: "user",
      text: "Build it",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  } as const;
  const assistantEntry = {
    id: "assistant-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:30Z",
    message: {
      id: "assistant-1" as never,
      role: "assistant",
      text: "On it",
      runId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:30Z",
      updatedAt: "2026-01-01T00:00:30Z",
      streaming: true,
    },
  } as const;
  const withoutMessages = deriveMessagesTimelineRows({
    timelineEntries: [],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: snapshot,
  });
  expect(withoutMessages).toEqual([
    { kind: "working", id: "working-indicator-row", createdAt: snapshot.startedAt },
    {
      kind: "worktree-setup",
      id: "worktree-setup-row",
      createdAt: "2026-01-01T00:00:00Z",
      snapshot,
      embedded: false,
    },
  ]);

  const withMessages = deriveMessagesTimelineRows({
    timelineEntries: [userEntry, assistantEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: { ...snapshot, phase: "failed" },
  });
  expect(withMessages.map((row) => row.kind)).toEqual([
    "message",
    "worktree-setup",
    "working",
    "message",
    "thinking",
  ]);

  const stage = (id: "agent" | "setup-script", status: "done" | "running") =>
    ({
      id,
      status,
      startedAt: "2026-01-01T00:00:10Z",
      endedAt: status === "done" ? "2026-01-01T00:00:11Z" : null,
      percent: null,
      detail: null,
      tail: [],
    }) as const;
  const asyncSnapshot: WorktreeSetupSnapshot = {
    ...snapshot,
    stages: [stage("setup-script", "running"), stage("agent", "done")],
  };
  const liveTurn = {
    runId: "turn-1" as never,
    status: "running",
    startedAt: "2026-01-01T00:00:11Z",
    completedAt: null,
  } as const;
  const asyncRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expect(asyncRows.map((row) => row.kind)).toEqual(["message", "working", "thinking"]);

  const handoffRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expect(handoffRows.map((row) => row.kind)).toEqual(["message", "working", "worktree-setup"]);
  expect(handoffRows[2]).toMatchObject({ kind: "worktree-setup", embedded: false });

  const settledRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...snapshot,
      phase: "done",
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expect(settledRows.map((row) => row.kind)).toEqual(["message", "working", "worktree-setup"]);

  const finishedRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...asyncSnapshot,
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expect(finishedRows.map((row) => row.kind)).toEqual(["message", "working", "thinking"]);
});

describe("failed turn transcript", () => {
  it.each([
    { position: "historical", failureClass: "provider_error" },
    { position: "historical", failureClass: "usage_limit" },
    { position: "latest", failureClass: "usage_limit" },
  ] as const)(
    "keeps $position $failureClass failures visible with preceding work grouped appropriately",
    ({ position, failureClass }) => {
      const isLatest = position === "latest";
      const commands = isLatest ? ["pwd", "ls", "false"] : ["pwd"];
      const runId = RunId.make("failed-run");
      const threadId = ThreadId.make("failed-thread");
      const at = DateTime.makeUnsafe("2026-09-20T12:00:00Z");
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      const items: OrchestrationV2ProjectedTurnItem[] = [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("user"),
          item: {
            ...base,
            id: TurnItemId.make("user"),
            type: "user_message",
            status: "completed",
            messageId: MessageId.make("user"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            text: "Build it",
            attachments: [],
          },
        },
        ...commands.map((input, index): OrchestrationV2ProjectedTurnItem => ({
          position: index + 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make(index === 0 ? "command" : `command-${index}`),
          item: {
            ...base,
            id: TurnItemId.make(index === 0 ? "command" : `command-${index}`),
            ordinal: index + 1,
            type: "command_execution",
            status: "completed",
            input,
            output: "",
            exitCode: 0,
          },
        })),
        {
          position: commands.length + 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("failure"),
          item: {
            ...base,
            id: TurnItemId.make("failure"),
            type: "error",
            status: "failed",
            failure: {
              class: failureClass,
              message: "The provider stopped this turn.\nRetry later.",
              code: null,
              retryable: true,
            },
          },
        },
      ];
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items,
          optimisticMessages: [],
        }).map((entry) =>
          isLatest
            ? entry
            : {
                ...entry,
                attempt: {
                  id: RunAttemptId.make("superseded-attempt"),
                  runId,
                  attemptOrdinal: 1,
                  rootNodeId: NodeId.make("superseded-root"),
                  status: "superseded" as const,
                  completedAt: null,
                },
              },
        ),
        latestRun: {
          runId: isLatest ? runId : RunId.make("newer-run"),
          status: isLatest ? "failed" : "completed",
          startedAt: DateTime.formatIso(at),
          completedAt: DateTime.formatIso(at),
        },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(rows.some((row) => row.kind === "turn-fold" || row.kind === "attempt-fold")).toBe(
        false,
      );
      const work = rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
      expect(rows.find((row) => row.kind === "work-toggle")).toEqual(
        isLatest ? expect.objectContaining({ hiddenCount: 3, expanded: false }) : undefined,
      );
      expect(work.map((entry) => entry.id)).toEqual(
        isLatest ? ["failure"] : ["command", "failure"],
      );
      expect(work.at(-1)?.detail).toBe("The provider stopped this turn.\nRetry later.");
      expect(work.at(-1)?.createdAt).toBe("2026-09-20T12:00:00.000Z");
      if (isLatest) return;
      const entriesWithoutTools = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.filter((row) => row.item.type !== "command_execution"),
        optimisticMessages: [],
      });
      entriesWithoutTools.splice(1, 0, {
        kind: "message",
        id: "assistant-before-failure",
        createdAt: DateTime.formatIso(at),
        message: {
          id: MessageId.make("assistant-before-failure"),
          role: "assistant",
          runId,
          text: "Checking the workspace.",
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
          streaming: false,
        },
      });
      const compactRows = deriveMessagesTimelineRows({
        timelineEntries: entriesWithoutTools,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(compactRows.map((row) => row.kind)).toEqual([
        "message",
        "message",
        "work",
        "assistant-meta",
      ]);
      expect(compactRows[1]).toMatchObject({ showAssistantMeta: false });
      expect(compactRows.at(-1)).toMatchObject({
        kind: "assistant-meta",
        showAssistantCopyButton: true,
        message: { id: "assistant-before-failure" },
      });
    },
  );
});

describe("live subagents after their parent turn settles", () => {
  const runId = RunId.make("parent-run");
  const threadId = ThreadId.make("parent-thread");
  const providerTurnId = ProviderTurnId.make("parent-provider-turn");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-10-06T10:00:${String(second).padStart(2, "0")}Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const projected = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  });
  const child = (
    id: string,
    second: number,
    status: OrchestrationV2TurnItem["status"],
    origin: "app_owned" | "provider_native" = "app_owned",
  ): OrchestrationV2TurnItem => ({
    ...base(id, second),
    status,
    completedAt: status === "running" ? null : at(second),
    type: "subagent",
    subagentId: NodeId.make(id),
    origin,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: origin === "app_owned" ? ThreadId.make(`${id}-thread`) : null,
    prompt: `Inspect ${id}`,
    result: null,
  });
  const rowsFor = (children: ReadonlyArray<OrchestrationV2TurnItem>) =>
    deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: (
          [
            {
              ...base("user", 0),
              status: "completed",
              type: "user_message",
              messageId: MessageId.make("user"),
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              text: "Delegate the review",
              attachments: [],
            },
            {
              ...base("reasoning", 1),
              status: "completed",
              type: "reasoning",
              text: "Two children can split this.",
              streaming: false,
            },
            {
              ...base("command", 2),
              status: "completed",
              type: "command_execution",
              input: "pwd",
              output: "/repo",
              exitCode: 0,
            },
            ...children,
            {
              ...base("assistant", 8),
              status: "completed",
              type: "assistant_message",
              messageId: MessageId.make("assistant"),
              text: "Both children are running.",
              streaming: false,
            },
          ] satisfies OrchestrationV2TurnItem[]
        ).map(projected),
        optimisticMessages: [],
      }),
      latestRun: {
        runId,
        status: "completed",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: DateTime.formatIso(at(8)),
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

  it.each(["app_owned", "provider_native"] as const)(
    "keeps a running %s child visible while the rest of the settled turn folds",
    (origin) => {
      const rows = rowsFor([child("child", 3, "running", origin)]);
      expect(rows.map((row) => row.id)).toEqual([
        "user",
        `turn-fold:${runId}`,
        "child",
        "assistant",
      ]);
    },
  );

  it("keeps a launch batch visible while any member is still running", () => {
    const rows = rowsFor([child("done", 3, "completed"), child("live", 4, "running")]);
    expect(rows.map((row) => row.id)).toEqual(["user", `turn-fold:${runId}`, "done", "assistant"]);
    expect(rows.find((row) => row.id === "done")).toMatchObject({
      subagents: [{ item: { id: "done" } }, { item: { id: "live" } }],
    });
  });

  it("keeps a running child visible when a steer supersedes its attempt", () => {
    const attempt = {
      id: RunAttemptId.make("superseded-attempt"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("superseded-root"),
      status: "superseded" as const,
      completedAt: null,
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: (
        [
          {
            ...base("command", 2),
            status: "completed",
            type: "command_execution",
            input: "pwd",
            output: "/repo",
            exitCode: 0,
          },
          child("child", 3, "running"),
        ] satisfies OrchestrationV2TurnItem[]
      ).map(projected),
      optimisticMessages: [],
    }).map((entry) => ({ ...entry, attempt }));
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId,
        status: "running",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([`attempt-fold:${attempt.id}`, "child"]);
  });
});

describe("subagent continued by a later turn", () => {
  const threadId = ThreadId.make("parent-thread");
  const run1 = RunId.make("run-1");
  const run2 = RunId.make("run-2");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-10-09T10:00:${String(second).padStart(2, "0")}Z`);
  const base = (id: string, runId: RunId, ordinal: number, second: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const user = (id: string, runId: RunId, ordinal: number, second: number) => ({
    ...base(id, runId, ordinal, second),
    type: "user_message" as const,
    messageId: MessageId.make(id),
    createdBy: "user" as const,
    creationSource: "web" as const,
    inputIntent: "turn_start" as const,
    text: `Prompt ${id}`,
    attachments: [],
  });
  const assistant = (id: string, runId: RunId, ordinal: number, second: number) => ({
    ...base(id, runId, ordinal, second),
    type: "assistant_message" as const,
    messageId: MessageId.make(id),
    text: `Answer ${id}`,
    streaming: false,
  });
  const reasoning = (id: string, runId: RunId, ordinal: number, second: number) => ({
    ...base(id, runId, ordinal, second),
    type: "reasoning" as const,
    text: "Thinking",
    streaming: false,
  });
  const items: OrchestrationV2TurnItem[] = [
    user("prompt-1", run1, 1_000_001, 0),
    reasoning("reasoning-1", run1, 1_000_002, 1),
    {
      ...base("subagent", run2, 1_000_003, 2),
      completedAt: at(40),
      updatedAt: at(40),
      type: "subagent",
      subagentId: NodeId.make("subagent"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt: "Research the bug",
      result: "Found it",
    },
    assistant("answer-1", run1, 1_000_004, 3),
    user("prompt-2", run2, 2_000_001, 30),
    reasoning("reasoning-2", run2, 2_000_002, 31),
    assistant("answer-2", run2, 2_000_003, 32),
    {
      ...base("send-message", run2, 2_000_004, 33),
      type: "dynamic_tool",
      toolName: "SendMessage",
      input: { to: "subagent" },
      output: "Sent",
    },
    assistant("closing-2", run2, 2_000_005, 41),
  ];

  it("keeps each turn's fold between its own prompt and answer", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.map((item) => ({
          position: item.ordinal,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
        optimisticMessages: [],
      }),
      latestRun: {
        runId: run2,
        status: "completed",
        startedAt: DateTime.formatIso(at(30)),
        completedAt: DateTime.formatIso(at(41)),
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "prompt-1",
      `turn-fold:${run1}`,
      "answer-1",
      "prompt-2",
      `turn-fold:${run2}`,
      "closing-2",
    ]);
  });
});
