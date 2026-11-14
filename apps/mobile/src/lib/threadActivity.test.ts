import {
  MessageId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  RuntimeRequestId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import { getReviewSectionIdForCheckpoint } from "../features/review/reviewModel";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  workEntryRowLabel,
  threadFeedCompactionLabels,
  createThreadFeedCache,
  deriveThreadFeedPresentation,
  messageFoldRunId,
  type ThreadFeedCache,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "./threadActivity";
import { runId } from "./threadActivity.testkit";
import { assistantMessage, base, command, projected, sourceThreadId, threadId, userMessage } from "./threadActivity.testkit";

describe("retained v2 feed presentation", () => {
  it("retains unchanged rows while the assistant streams", () => {
    const rows = [
      projected(userMessage(), 0),
      projected(command(), 1),
      projected({ ...assistantMessage(), streaming: true }, 2),
    ];
    const latestRun = {
      runId,
      status: "running" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
    };
    const before = buildThreadFeed(rows);
    const beforePresentation = deriveThreadFeedPresentation(
      before,
      latestRun,
      new Set(),
      new Set(),
      latestRun.startedAt,
    );
    const after = buildThreadFeed([
      rows[0]!,
      rows[1]!,
      projected(
        { ...assistantMessage("2026-06-20T00:00:04.000Z"), text: "Still working", streaming: true },
        2,
      ),
    ]);
    const afterPresentation = deriveThreadFeedPresentation(
      after,
      latestRun,
      new Set(),
      new Set(),
      latestRun.startedAt,
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(afterPresentation[0]).toBe(beforePresentation[0]);
    expect(afterPresentation[1]).toBe(beforePresentation[1]);
  });

  it.each([
    { envelope: "direct", output: { taskId: "a" } },
    { envelope: "structured", output: { structuredContent: { taskId: "a" } } },
    { envelope: "text", output: { content: [{ type: "text", text: '{"taskId":"a"}' }] } },
  ])(
    "folds matched $envelope delegations without hiding pending, failed or unmatched calls",
    ({ output }) => {
      const agent = (
        id: string,
        index: number,
        origin = "app_owned" as "app_owned" | "provider_native",
      ) =>
        projected(
          {
            ...base(id, "2026-06-20T00:00:01.000Z", index),
            type: "subagent",
            subagentId: NodeId.make(id),
            origin,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            childThreadId: ThreadId.make(`child-${id}`),
            prompt: "Identical task",
            result: "Done",
          },
          index,
        );
      const delegation = (
        id: string,
        index: number,
        overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
      ) =>
        projected(
          {
            ...base(id, "2026-06-20T00:00:02.000Z", index),
            type: "dynamic_tool",
            toolName: "t3-code.delegate_task",
            input: { task: "Identical task" },
            output,
            ...overrides,
          },
          index,
        );
      const feed = buildThreadFeed([
        agent("a", 1),
        delegation("matched", 2),
        agent("b", 3),
        delegation("pending", 4, { status: "running", output: null }),
        delegation("unmatched", 5, { output: { taskId: "missing" } }),
        delegation("failed", 6, { status: "failed" }),
        delegation("error-output", 7, { output: { taskId: "a", isError: true } }),
        delegation("other-run", 8, { runId: RunId.make("other-run") }),
        agent("native", 9, "provider_native"),
        delegation("native-delegation", 10, { output: { taskId: "native" } }),
      ]);
      const groups = feed.flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      );
      expect(groups[0]).toEqual(["a", "b"]);
      expect(groups.flat()).toEqual([
        "a",
        "b",
        "pending",
        "unmatched",
        "failed",
        "error-output",
        "other-run",
        "native",
        "native-delegation",
      ]);
      const presented = deriveThreadFeedPresentation(
        feed,
        null,
        new Set([runId, RunId.make("other-run")]),
      );
      expect(
        presented.find(
          (entry) =>
            entry.type === "activity-group" && entry.activities[0]?.projectedItem.item.id === "a",
        )?.continuesWorkLog,
      ).toBeUndefined();
    },
  );

  it("groups only adjacent subagents in the same run, keeping their child links", () => {
    const agent = (id: string, index: number, agentRunId = runId) =>
      projected(
        {
          ...base(id, `2026-06-20T00:00:0${index}.000Z`, index),
          type: "subagent",
          runId: agentRunId,
          subagentId: NodeId.make(id),
          origin: "app_owned",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId: ThreadId.make(`child-${id}`),
          prompt: "Solve the puzzle",
          result: "Done",
        },
        index,
      );
    const feed = buildThreadFeed([
      agent("a", 1),
      agent("b", 2),
      projected(command("2026-06-20T00:00:03.000Z"), 3),
      agent("c", 4),
      agent("d", 5, RunId.make("other-run")),
    ]);
    expect(
      feed.flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      ),
    ).toEqual([["a", "b"], ["item-command"], ["c"], ["d"]]);
    const presented = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([runId, RunId.make("other-run")]),
    );
    const groups = presented.flatMap((entry) =>
      entry.type === "activity-group" && entry.activities[0]?.projectedItem.item.type === "subagent"
        ? [entry]
        : [],
    );
    expect(groups.map((entry) => entry.activities.length)).toEqual([2, 1, 1]);
    expect(groups[0]?.activities.map((activity) => activity.projectedItem.item)).toMatchObject([
      { childThreadId: "child-a" },
      { childThreadId: "child-b" },
    ]);
  });
});

describe("subagent continued by a later turn", () => {
  const run2 = RunId.make("run-2");
  const at = (second: number) => `2026-10-09T10:00:${String(second).padStart(2, "0")}.000Z`;
  const item = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...base(id, at(second), ordinal),
    runId: itemRunId,
  });
  const user = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "user_message" as const,
    messageId: MessageId.make(id),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: `Prompt ${id}`,
    attachments: [],
  });
  const assistant = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "assistant_message" as const,
    messageId: MessageId.make(id),
    text: `Answer ${id}`,
    streaming: false,
  });
  const reasoning = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "reasoning" as const,
    text: "Thinking",
    streaming: false,
  });
  const items: OrchestrationV2TurnItem[] = [
    user("prompt-1", runId, 1_000_001, 0),
    reasoning("reasoning-1", runId, 1_000_002, 1),
    {
      ...item("subagent", run2, 1_000_003, 2),
      type: "subagent",
      subagentId: NodeId.make("subagent"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt: "Research the bug",
      result: "Found it",
    },
    assistant("answer-1", runId, 1_000_004, 3),
    user("prompt-2", run2, 2_000_001, 30),
    reasoning("reasoning-2", run2, 2_000_002, 31),
    assistant("answer-2", run2, 2_000_003, 32),
    {
      ...item("send-message", run2, 2_000_004, 33),
      type: "dynamic_tool",
      toolName: "SendMessage",
      input: { to: "subagent" },
      output: "Sent",
    },
    assistant("closing-2", run2, 2_000_005, 41),
  ];

  it("keeps each turn's fold between its own prompt and answer", () => {
    const presented = deriveThreadFeedPresentation(
      buildThreadFeed(items.map((entry, index) => projected(entry, index))),
      { runId: run2, status: "completed", startedAt: at(30), completedAt: at(41) },
      new Set(),
    );
    expect(presented.map((entry) => entry.id)).toEqual([
      "prompt-1",
      `run-fold:${runId}`,
      "answer-1",
      "prompt-2",
      `run-fold:${run2}`,
      "closing-2",
    ]);
  });
});

it("stops stranded thinking after a steer and follows the next thought or tool", () => {
  const at = "2026-06-20T00:00:02.000Z";
  const thought = (id: string): OrchestrationV2TurnItem => ({
    ...base(id, at, 1),
    type: "reasoning",
    status: "running",
    completedAt: null,
    streaming: true,
    text: id,
  });
  const first = thought("first-thought");
  const next = thought("next-thought");
  const steer = { ...userMessage(at), inputIntent: "steer" as const };
  const tool = { ...command(at), status: "running" as const, completedAt: null };
  const rows = (items: ReadonlyArray<OrchestrationV2TurnItem>, expanded = new Set<string>()) =>
    deriveThreadFeedPresentation(
      buildThreadFeed(items.map((item, position) => projected(item, position))),
      { runId, status: "running", startedAt: at, completedAt: null },
      new Set(),
      expanded,
      at,
    );
  expect(rows([first]).find((row) => row.type === "work-toggle")).toMatchObject({
    summary: "Thinking",
    thought: "first-thought",
    live: true,
    shimmer: true,
  });
  const afterSteer = rows([first, steer]);
  expect(afterSteer.find((row) => row.type === "work-toggle")).toMatchObject({
    live: false,
    shimmer: false,
  });
  expect(afterSteer.at(-1)?.type).toBe("thinking");
  const header = afterSteer.find((row) => row.type === "work-toggle");
  if (header?.type !== "work-toggle") throw new Error("Expected thought toggle");
  const expanded = rows([first, steer], new Set([header.groupId]));
  expect(expanded.find((row) => row.type === "work-toggle")).toMatchObject({ summary: "Thought" });
  expect(expanded.find((row) => row.type === "activity-group")).toMatchObject({
    activities: [{ lifecycleStatus: "completed", workEntry: { toolLifecycleStatus: "completed" } }],
  });
  for (const items of [
    [first, steer, next],
    [first, next],
    [first, steer, next, tool],
  ]) {
    const live = rows(items).filter((row) => row.type === "work-toggle" && row.shimmer);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject(
      items.at(-1)!.type === "reasoning"
        ? { summary: "Thinking", thought: "next-thought" }
        : { summary: "Running vp" },
    );
  }
  expect(first.status).toBe("running");
});

it.each(["provider_error", "usage_limit"] as const)(
  "keeps a historical %s failure and preceding work visible without disclosures",
  (failureClass) => {
    const at = "2026-06-20T00:00:03.000Z";
    const error: OrchestrationV2TurnItem = {
      ...base("failure", at, 2),
      type: "error",
      status: "failed",
      failure: {
        class: failureClass,
        message: "The provider stopped this turn.\nRetry later.",
        code: null,
        retryable: true,
      },
    };
    const command: OrchestrationV2TurnItem = {
      ...base("command", "2026-06-20T00:00:02.000Z", 1),
      type: "command_execution",
      input: "pwd",
      output: "",
      exitCode: 0,
    };
    const sourceFeed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command, 1),
      projected(error, 2),
    ]);
    const feed = deriveThreadFeedPresentation(
      sourceFeed,
      { runId: RunId.make("newer-run"), status: "completed", startedAt: at, completedAt: at },
      new Set(),
    );
    const whileWorking = deriveThreadFeedPresentation(
      sourceFeed,
      { runId: RunId.make("newer-run"), status: "running", startedAt: at, completedAt: null },
      new Set(),
    );
    for (const entry of feed) {
      expect(whileWorking.find((row) => row.id === entry.id)).toBe(entry);
    }
    expect(feed.some((entry) => entry.type === "run-fold" || entry.type === "work-toggle")).toBe(
      false,
    );
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem.item.id)).toEqual([
      "command",
      "failure",
    ]);
    expect(activities.at(-1)).toMatchObject({
      detail: error.failure.message,
      createdAt: at,
      canExpand: false,
      prominent: true,
    });
  },
);

describe("streamed feed updates", () => {
  const runs = [RunId.make("run-1"), RunId.make("run-2"), RunId.make("run-3")] as const;
  const at = (second: number) => `2026-06-20T00:00:${String(second).padStart(2, "0")}.000Z`;
  const item = (id: string, second: number, run: RunId) => ({
    ...base(id, at(second), second),
    runId: run,
  });
  const user = (
    id: string,
    second: number,
    run: RunId,
  ): Extract<OrchestrationV2TurnItem, { type: "user_message" }> => ({
    ...item(id, second, run),
    type: "user_message",
    messageId: MessageId.make(`message-${id}`),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent: "turn_start",
    text: `Prompt ${id}`,
    attachments: [],
  });
  const reply = (id: string, second: number, run: RunId, text = "Done", streaming = false) =>
    ({
      ...item(id, second, run),
      ...(streaming ? { status: "running" as const, completedAt: null } : {}),
      type: "assistant_message",
      messageId: MessageId.make(`message-${id}`),
      text,
      streaming,
    }) satisfies OrchestrationV2TurnItem;
  const shell = (id: string, second: number, run: RunId): OrchestrationV2TurnItem => ({
    ...item(id, second, run),
    type: "command_execution",
    input: `echo ${id}`,
    output: id,
    exitCode: 0,
  });
  const requestId = RuntimeRequestId.make("request-color");
  const question = (answered: boolean): OrchestrationV2TurnItem => ({
    ...item("question", 12, runs[1]),
    type: "user_input_request",
    requestId,
    questions: [],
    ...(answered
      ? { questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} } }
      : {}),
  });
  const answer: OrchestrationV2TurnItem = {
    ...user("answer", 40, runs[1]),
    messageId: MessageId.make(`async-answer:${requestId}`),
  };
  const delegation: OrchestrationV2TurnItem = {
    ...item("delegation", 3, runs[0]),
    type: "dynamic_tool",
    toolName: "t3-code.delegate_task",
    input: { task: "Check" },
    output: { taskId: "child" },
  };
  const lateChild: OrchestrationV2TurnItem = {
    ...item("late-child", 30, runs[0]),
    type: "subagent",
    subagentId: NodeId.make("child"),
    origin: "app_owned",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: sourceThreadId,
    prompt: "Check",
    result: "Fine",
  };
  const resumed: OrchestrationV2TurnItem = {
    ...lateChild,
    ...item("resumed", 3, runs[2]),
    subagentId: NodeId.make("resumed"),
    origin: "provider_native",
    childThreadId: null,
  };
  const history: OrchestrationV2TurnItem[] = [
    user("u1", 1, runs[0]),
    shell("s1", 2, runs[0]),
    delegation,
    reply("a1", 4, runs[0]),
    user("u2", 10, runs[1]),
    shell("s2", 11, runs[1]),
    question(false),
    reply("a2", 13, runs[1]),
    user("u3", 20, runs[2]),
    shell("s3", 21, runs[2]),
  ];
  const running = {
    runId: runs[2],
    status: "running" as const,
    startedAt: at(20),
    completedAt: null,
  };
  const settled = { ...running, status: "completed" as const, completedAt: at(50) };
  // Each step is what one streamed event leaves behind, including the edits
  // that reach back into earlier runs.
  const steps: ReadonlyArray<{
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly latestRun: ThreadFeedLatestRun;
  }> = [
    { items: [...history, reply("a3", 22, runs[2], "W", true)], latestRun: running },
    { items: [...history, reply("a3", 22, runs[2], "Wor", true)], latestRun: running },
    {
      items: [...history, reply("a3", 22, runs[2], "Working", true), shell("s4", 23, runs[2])],
      latestRun: running,
    },
    {
      items: [
        ...history,
        reply("a3", 22, runs[2], "Working", true),
        shell("s4", 23, runs[2]),
        lateChild,
      ],
      latestRun: running,
    },
    {
      items: [
        ...history.map((entry) => (entry.id === "question" ? question(true) : entry)),
        reply("a3", 22, runs[2], "Working", true),
        shell("s4", 23, runs[2]),
        lateChild,
        answer,
      ],
      latestRun: running,
    },
    {
      items: [
        ...history.slice(0, 9),
        shell("inserted", 20, runs[2]),
        ...history.slice(9),
        reply("a3", 22, runs[2], "Working", true),
        shell("s4", 23, runs[2]),
      ],
      latestRun: running,
    },
    {
      items: [...history, reply("a3", 22, runs[2], "Working on it"), shell("s4", 23, runs[2])],
      latestRun: running,
    },
    {
      items: [...history, reply("a3", 22, runs[2], "Working on it"), shell("s4", 23, runs[2])],
      latestRun: settled,
    },
    {
      items: [
        ...history,
        reply("a3", 22, runs[2], "Working on it"),
        shell("s4", 23, runs[2]),
        shell("late-s1", 45, runs[0]),
      ],
      latestRun: settled,
    },
    // The first run's fold above was timed to the late item; dropping it must reach back too.
    {
      items: [...history, reply("a3", 22, runs[2], "Working on it"), shell("s4", 23, runs[2])],
      latestRun: settled,
    },
    // The latest run resumes a subagent from the first run: the item moves to
    // the latest run but keeps its place, so it folds with the first run.
    {
      items: [
        ...history.slice(0, 3),
        resumed,
        ...history.slice(3),
        reply("a3", 22, runs[2], "Working on it"),
        shell("s4", 23, runs[2]),
      ],
      latestRun: running,
    },
    {
      items: [
        ...history.slice(0, 3),
        resumed,
        ...history.slice(3),
        reply("a3", 22, runs[2], "Working on it"),
        shell("s4", 23, runs[2]),
        reply("a4", 24, runs[2], "Still", true),
      ],
      latestRun: running,
    },
  ];
  // Like the projection reducer, an unchanged item at an unchanged position keeps its row.
  const rowsByItem = new Map<
    OrchestrationV2TurnItem,
    Map<number, OrchestrationV2ProjectedTurnItem>
  >();
  const row = (entry: OrchestrationV2TurnItem, position: number) => {
    const byPosition = rowsByItem.get(entry) ?? new Map<number, OrchestrationV2ProjectedTurnItem>();
    rowsByItem.set(entry, byPosition);
    const cached = byPosition.get(position) ?? projected(entry, position);
    byPosition.set(position, cached);
    return cached;
  };
  const present = (
    step: (typeof steps)[number],
    expandedRunIds: ReadonlySet<RunId>,
    cache?: ThreadFeedCache,
  ) =>
    deriveThreadFeedPresentation(
      buildThreadFeed(step.items.map(row), { cache }),
      step.latestRun,
      expandedRunIds,
      new Set(),
      step.latestRun.status === "running" ? at(20) : null,
      false,
      cache,
    );

  it.each([
    { folds: "collapsed", expandedRunIds: new Set<RunId>() },
    { folds: "expanded", expandedRunIds: new Set<RunId>(runs) },
  ])("matches a fresh build after every update with $folds runs", ({ expandedRunIds }) => {
    const cache = createThreadFeedCache();
    const streamed = steps.map((step) => present(step, expandedRunIds, cache));
    const fresh = steps.map((step) => present(step, expandedRunIds));
    // Closures on activities are not part of what a row shows.
    const values = (rows: ReadonlyArray<ThreadFeedEntry>) => JSON.parse(JSON.stringify(rows));
    for (const [index, rows] of streamed.entries()) {
      expect(values(rows), `step ${index}`).toEqual(values(fresh[index]!));
    }
  });

  it("hides a delegation once its child reaches back into the earlier run", () => {
    const showsDelegation = (step: (typeof steps)[number]) =>
      buildThreadFeed(step.items.map(row)).some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.id === "delegation"),
      );
    expect(showsDelegation(steps[2]!)).toBe(true);
    expect(showsDelegation(steps[3]!)).toBe(false);
  });
});

it.each([false, true])(
  "caps live approval headers while preserving the prompt (grouped: %s)",
  (grouped) => {
    const at = "2026-06-20T00:00:02.000Z";
    const prompt = `python3 - <<'PY'\n${"print('approval')\n".repeat(400)}PY`;
    const approval: OrchestrationV2TurnItem = {
      ...base("long-approval", at, 2),
      type: "approval_request",
      status: "waiting",
      completedAt: null,
      requestId: RuntimeRequestId.make("long-approval"),
      requestKind: "command",
      prompt,
    };
    const presented = deriveThreadFeedPresentation(
      buildThreadFeed([
        projected(userMessage(), 0),
        ...(grouped ? [projected(command(), 1)] : []),
        projected(approval, 2),
      ]),
      { runId, status: "running", startedAt: at, completedAt: null },
      new Set(),
      new Set(),
      at,
    );
    const header = presented.find((row) =>
      grouped ? row.type === "work-toggle" : row.type === "activity-group",
    );
    const label =
      header?.type === "work-toggle"
        ? header.summary
        : header?.type === "activity-group"
          ? header.activities[0]?.groupStandIn?.label
          : undefined;
    expect(label).toBeDefined();
    expect(label!.length).toBeLessThanOrEqual(203);
    expect(label).toMatch(/^python3 - <<'PY' print/);
    expect(label).not.toContain("\n");
    const feed = buildThreadFeed([projected(approval, 0)]);
    const activity = feed.flatMap((row) =>
      row.type === "activity-group" ? row.activities : [],
    )[0]!;
    expect(activity.detail).toBe(prompt);
    expect(JSON.parse(activity.getFullDetail()!).item).toMatchObject({ prompt });
    expect(activity.getCopyText()).toContain(prompt);
  },
);

it("caps live thought previews while preserving reasoning detail", () => {
  const at = "2026-06-20T00:00:02.000Z";
  const text = "Considering the pending approval\n".repeat(100);
  const thought: OrchestrationV2TurnItem = {
    ...base("long-thought", at, 1),
    type: "reasoning",
    status: "running",
    completedAt: null,
    text,
    streaming: true,
  };
  const feed = buildThreadFeed([projected(userMessage(), 0), projected(thought, 1)]);
  const rows = deriveThreadFeedPresentation(
    feed,
    { runId, status: "running", startedAt: at, completedAt: null },
    new Set(),
    new Set(),
    at,
  );
  const header = rows.find((row) => row.type === "work-toggle");
  expect(header).toMatchObject({ summary: "Thinking", live: true });
  expect(header?.thought).toMatch(/^Considering the pending approval/);
  expect(header?.thought).not.toContain("\n");
  expect(header!.thought!.length).toBeLessThanOrEqual(203);
  const activity = feed.flatMap((row) => (row.type === "activity-group" ? row.activities : []))[0]!;
  expect(activity.detail).toBe(text);
  expect(JSON.parse(activity.getFullDetail()!).item).toMatchObject({ text });
  expect(activity.getCopyText()).toContain(text);
});
