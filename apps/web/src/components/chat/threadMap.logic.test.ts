import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  ContextHandoffId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { derive } from "@t3tools/provider-core/server/IdAllocator";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { deriveThreadMap, layoutThreadMap, threadMapInitialView } from "./threadMap.logic";

const base = makeThreadProjectionFixture();
const threadId = base.thread.id;
const providerInstanceId = ProviderInstanceId.make("codex");
const at = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, 0, second));

function run(
  id: string,
  ordinal: number,
  overrides: Partial<OrchestrationV2Run> = {},
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    providerThreadId: null,
    userMessageId: MessageId.make(`${id}-prompt`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at(ordinal * 10),
    startedAt: at(ordinal * 10),
    completedAt: at(ordinal * 10 + 5),
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function message(
  id: string,
  runId: string | null,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(id),
    threadId,
    runId: runId === null ? null : RunId.make(runId),
    nodeId: null,
    role: "user",
    text: id,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

let ordinal = 0;
const itemBase = (id: string, runId: string) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: ordinal++,
  status: "completed" as const,
  title: null,
  startedAt: at(0),
  completedAt: at(0),
  updatedAt: at(0),
});

const prompt = (
  runId: string,
  text: string,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "user_message" }>> = {},
): OrchestrationV2TurnItem => ({
  ...itemBase(`${runId}-prompt-item`, runId),
  type: "user_message",
  messageId: MessageId.make(`${runId}-prompt`),
  inputIntent: "turn_start",
  text,
  attachments: [],
  createdBy: "user",
  creationSource: "web",
  ...overrides,
});

const steer = (
  id: string,
  runId: string,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "user_message" }>> = {},
): OrchestrationV2TurnItem => ({
  ...itemBase(`${id}-item`, runId),
  type: "user_message",
  messageId: MessageId.make(id),
  inputIntent: "steer",
  text: id,
  attachments: [],
  createdBy: "user",
  creationSource: "web",
  ...overrides,
});

const reply = (
  id: string,
  runId: string,
  phase?: "commentary" | "partial_answer" | "final_answer",
  delivery?: "async",
): OrchestrationV2TurnItem => ({
  ...itemBase(id, runId),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text: id,
  streaming: false,
  ...(phase === undefined ? {} : { phase }),
  ...(delivery === undefined ? {} : { delivery }),
});

const tool = (
  id: string,
  runId: string,
  overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
): OrchestrationV2TurnItem => ({
  ...itemBase(id, runId),
  type: "dynamic_tool",
  toolName: "read_file",
  input: {},
  ...overrides,
});

function subagent(
  id: string,
  runId: string | null,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId,
    runId: runId === null ? null : RunId.make(runId),
    parentNodeId: NodeId.make(`${id}-parent`),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId,
    providerThreadId: null,
    childThreadId: ThreadId.make(`${id}-thread`),
    nativeTaskRef: null,
    prompt: `${id} prompt`,
    title: null,
    model: null,
    status: "completed",
    result: null,
    startedAt: null,
    completedAt: null,
    updatedAt: at(0),
    ...overrides,
  };
}

function projection(input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
  readonly checkpoints?: OrchestrationV2ThreadProjection["checkpoints"];
}): OrchestrationV2ThreadProjection {
  const items = input.items ?? [];
  return {
    ...base,
    runs: [...input.runs],
    messages: [...(input.messages ?? [])],
    subagents: [...(input.subagents ?? [])],
    checkpoints: [...(input.checkpoints ?? [])],
    turnItems: [...items],
    visibleTurnItems: items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

describe("deriveThreadMap", () => {
  it("lists started turns in order, then the user's queued prompts", () => {
    const turns = deriveThreadMap(
      projection({
        runs: [
          run("second", 2),
          run("first", 1),
          run("reverted", 3, { status: "rolled_back" }),
          run("dropped", 4, { status: "cancelled", startedAt: null }),
          run("queued-later", 6, { status: "queued", queuePosition: 2, startedAt: null }),
          run("queued-next", 5, { status: "queued", queuePosition: 1, startedAt: null }),
          // A wake queued to deliver task results is not a prompt the user sent.
          run("wake", 7, { status: "queued", startedAt: null }),
          // Finished, with its items older than the loaded window.
          run("unloaded", 8),
        ],
        items: [prompt("first", "Fix the build\nIt fails on CI"), prompt("second", "Ship it")],
        messages: [
          message("queued-later-prompt", "queued-later"),
          message("queued-next-prompt", "queued-next"),
          message("wake-prompt", "wake", {
            delegatedCompletion: {
              parentRunId: RunId.make("second"),
              generation: 1,
              taskIds: [],
            },
          }),
        ],
      }),
    );

    expect(turns.map((turn) => [turn.runId, turn.queued])).toEqual([
      ["first", false],
      ["second", false],
      ["queued-next", true],
      ["queued-later", true],
    ]);
    expect(turns[0]?.prompt).toBe("Fix the build\nIt fails on CI");
    expect(turns[2]?.prompt).toBe("queued-next-prompt");
  });

  it("puts steers and messages from other threads into the turn they reached", () => {
    const linkedSender = {
      environmentId: EnvironmentId.make("remote"),
      threadId: ThreadId.make("remote-thread"),
      title: "Remote planner",
    };
    const [fromAgent, fromLinked] = deriveThreadMap(
      projection({
        runs: [run("a", 1), run("b", 2)],
        items: [
          prompt("a", "Review this", { senderThreadId: ThreadId.make("coordinator") }),
          steer("plain-steer", "a"),
          steer("promoted", "a", { inputIntent: "promoted_queued_to_steer" }),
          steer("agent-steer", "a", { senderThreadId: ThreadId.make("helper") }),
          steer("self-steer", "a", { senderThreadId: threadId }),
          // Queued into the run but never a steer, so not an input.
          steer("queued", "a", { inputIntent: "queued_turn" }),
          prompt("b", "From afar", { linkedSender }),
        ],
      }),
    );

    expect(fromAgent?.sender).toEqual({ kind: "local", threadId: "coordinator" });
    expect(fromAgent?.inputs).toEqual([
      { kind: "incoming", id: "from:a", sender: { kind: "local", threadId: "coordinator" } },
      { kind: "steer", id: "steer:plain-steer", text: "plain-steer", sender: null },
      { kind: "steer", id: "steer:promoted", text: "promoted", sender: null },
      {
        kind: "steer",
        id: "steer:agent-steer",
        text: "agent-steer",
        sender: { kind: "local", threadId: "helper" },
      },
      { kind: "steer", id: "steer:self-steer", text: "self-steer", sender: null },
    ]);
    expect(fromLinked?.sender).toEqual({ kind: "linked", sender: linkedSender });
  });

  it("draws a return only into a loaded turn the client can tell received the result", () => {
    const turns = deriveThreadMap(
      projection({
        runs: [run("launch", 1), run("receive", 2), run("later", 3), run("woken", 4)],
        items: [
          prompt("launch", "Delegate"),
          { ...itemBase("orphan-item", "launch"), ...subagentItem("orphan") },
          prompt("receive", "Delegated task delivered reached a terminal state."),
          prompt("later", "Anything back?"),
          // Clients usually get a wake as its notification row, without the message behind it.
          {
            ...itemBase(
              derive.userTurnItem({ messageId: MessageId.make("woken-prompt") }),
              "woken",
            ),
            type: "notification",
            source: { kind: "delegated_task", taskIds: [NodeId.make("notified")] },
            outcome: "completed",
            summary: 'Delegated task "Notified" finished',
          },
        ],
        messages: [
          message("receive-prompt", "receive", {
            createdBy: "agent",
            delegatedCompletion: {
              parentRunId: RunId.make("launch"),
              generation: 1,
              taskIds: [NodeId.make("delivered")],
            },
          }),
        ],
        subagents: [
          subagent("observed", "launch", {
            completionDelivery: { state: "acknowledged", observedByRunId: RunId.make("later") },
          }),
          subagent("delivered", "launch", { title: "Subagent: Reviewer", model: "gpt-5.4" }),
          subagent("native", "launch", { origin: "provider_native", childThreadId: null }),
          subagent("unloaded", "launch", {
            completionDelivery: { state: "acknowledged", observedByRunId: RunId.make("gone") },
          }),
          // Recorded without its run: the parent-side item names it.
          subagent("orphan", null),
          subagent("notified", "launch"),
          subagent("elsewhere", "not-loaded"),
        ],
      }),
    );

    const agents = turns[0]?.outputs.flatMap((output) =>
      output.kind === "agent" ? [output.agent] : [],
    );
    expect(agents?.map((agent) => [agent.id, agent.returnRunId])).toEqual([
      ["observed", "later"],
      ["delivered", "receive"],
      ["native", null],
      ["unloaded", null],
      ["orphan", null],
      ["notified", "woken"],
    ]);
    expect(agents?.[1]).toMatchObject({ title: "Reviewer", model: "gpt-5.4" });
  });

  it("lists the messages a turn sent to other threads, with the target when it can be read", () => {
    const [turn] = deriveThreadMap(
      projection({
        runs: [run("a", 1)],
        items: [
          prompt("a", "Coordinate"),
          tool("from-output", "a", {
            toolName: "t3_thread_send",
            output: { structuredContent: { threadId: "target-a", messageId: "m" } },
          }),
          tool("from-input", "a", {
            toolName: "mcp__t3-code__t3_thread_send_attachments",
            input: { threadId: "target-b", attachments: [] },
          }),
          tool("from-envelope", "a", {
            toolName: "t3-code.t3_thread_send",
            input: { toolName: "t3_thread_send", args: { threadId: "target-c" } },
          }),
          tool("unresolved", "a", { toolName: "t3_thread_send", input: { message: "hi" } }),
          tool("failed", "a", { toolName: "t3_thread_send", status: "failed" }),
          tool("in-flight", "a", {
            toolName: "t3_thread_send",
            status: "running",
            input: { threadId: "target-d" },
          }),
          tool("errored", "a", {
            toolName: "t3_thread_send",
            output: { isError: true, content: [{ type: "text", text: "No such thread" }] },
          }),
          tool("not-a-send", "a", { toolName: "t3_thread_read", input: { threadId: "x" } }),
          // Sent to this thread itself, by name or by default.
          tool("to-self", "a", {
            toolName: "t3_thread_send_attachments",
            output: { structuredContent: { threadId, messageId: "m" } },
          }),
          tool("to-self-by-default", "a", {
            toolName: "t3_thread_send_attachments",
            input: { attachments: [] },
          }),
        ],
      }),
    );

    expect(turn?.outputs).toEqual([
      { kind: "send", id: "send:from-output", threadId: "target-a" },
      { kind: "send", id: "send:from-input", threadId: "target-b" },
      { kind: "send", id: "send:from-envelope", threadId: "target-c" },
      { kind: "send", id: "send:unresolved", threadId: null },
    ]);
  });

  it("opens a turn a notification started at the notification's row", () => {
    const [turn] = deriveThreadMap(
      projection({
        runs: [run("woken", 1)],
        items: [
          // A provider change hands context over just before the wake's notification.
          {
            ...itemBase("woken-handoff", "woken"),
            ordinal: 56,
            type: "handoff",
            contextHandoffId: ContextHandoffId.make("handoff"),
            fromProviderThreadIds: [],
            toProviderThreadId: ProviderThreadId.make("provider-thread"),
            fromProviderInstanceIds: [],
            toProviderInstanceId: providerInstanceId,
            strategy: "full_thread_summary",
          },
          {
            // A restart opens the turn at the next free ordinal, under its message's item ID.
            ...itemBase(
              derive.userTurnItem({ messageId: MessageId.make("woken-prompt") }),
              "woken",
            ),
            ordinal: 57,
            type: "notification",
            source: { kind: "delegated_task", taskIds: [] },
            outcome: "completed",
            summary: "1 delegated task finished",
          },
          { ...tool("woken-tool", "woken"), ordinal: 58 },
        ],
      }),
    );

    expect(turn).toMatchObject({
      rowId: derive.userTurnItem({ messageId: MessageId.make("woken-prompt") }),
      prompt: "1 delegated task finished",
      toolCalls: 1,
      moreToolCalls: false,
    });
  });

  it("never takes a notification from inside a turn for the prompt that opened it", () => {
    const notice = (id: string, runId: string, at: number): OrchestrationV2TurnItem => ({
      ...itemBase(id, runId),
      ordinal: at,
      type: "notification",
      source: { kind: "delegated_task", taskIds: [] },
      outcome: "completed",
      summary: `${id} summary`,
    });
    const [afterWork, atBoundary, retained] = deriveThreadMap(
      projection({
        runs: [run("after-work", 1), run("at-boundary", 2), run("retained", 3)],
        // Each window starts inside the turn, after its prompt.
        items: [
          tool("after-work-tool", "after-work"),
          notice("after-work-notice", "after-work", 105),
          // The window starts right at a report that arrived mid-turn, in the turn's first slot.
          notice("at-boundary-notice", "at-boundary", 200),
          tool("at-boundary-tool", "at-boundary"),
          notice("retained-notice", "retained", 305),
        ],
        // The latest turn's prompt is kept even when its row is not.
        messages: [message("retained-prompt", "retained", { text: "Ship it" })],
      }),
    );

    expect(afterWork).toMatchObject({ rowId: null, prompt: "", moreToolCalls: true });
    expect(atBoundary).toMatchObject({ rowId: null, prompt: "", moreToolCalls: true });
    expect(retained).toMatchObject({ rowId: null, prompt: "Ship it", moreToolCalls: true });
  });

  it("counts a turn's changed files across its repositories, only from captured changes", () => {
    const checkpoint = (
      id: string,
      runId: string,
      overrides: Partial<OrchestrationV2ThreadProjection["checkpoints"][number]>,
    ): OrchestrationV2ThreadProjection["checkpoints"][number] => ({
      id: CheckpointId.make(id),
      threadId,
      scopeId: CheckpointScopeId.make(`${id}-scope`),
      runId: RunId.make(runId),
      nodeId: NodeId.make("node"),
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      ref: CheckpointRef.make(id),
      status: "ready",
      files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
      capturedAt: at(15),
      ...overrides,
    });
    const [repos, missing] = deriveThreadMap(
      projection({
        runs: [run("repos", 1), run("missing", 2)],
        items: [prompt("repos", "One"), prompt("missing", "Two")],
        checkpoints: [
          checkpoint("root", "repos", {}),
          // A tracked repository's checkpoint carries no app ordinal.
          checkpoint("tracked", "repos", {
            appRunOrdinal: null,
            filesTotal: { count: 3, additions: 3, deletions: 0 },
          }),
          checkpoint("not-captured", "missing", { status: "missing", files: [] }),
        ],
      }),
    );

    expect(repos?.filesChanged).toBe(4);
    expect(missing?.filesChanged).toBeNull();
  });

  it("summarizes what a turn did and picks its update and answer", () => {
    const [phased, unphased, live, partial, failed] = deriveThreadMap(
      projection({
        runs: [
          run("phased", 1),
          run("unphased", 2),
          run("live", 3, { status: "running", completedAt: null }),
          run("partial", 4),
          run("failed", 5, { status: "failed" }),
        ],
        items: [
          prompt("phased", "One"),
          reply("phased-note", "phased", "commentary"),
          tool("phased-tool", "phased"),
          {
            ...itemBase("phased-command", "phased"),
            type: "command_execution",
            input: "vp test",
            deferredWork: { cursor: "c", itemCount: 12, lastOrdinal: 3 },
          },
          reply("phased-answer", "phased", "final_answer"),
          reply("phased-after", "phased", "commentary"),
          prompt("unphased", "Two"),
          reply("unphased-first", "unphased"),
          reply("unphased-last", "unphased"),
          // Sent mid-turn apart from the answer, so it never becomes the answer.
          reply("unphased-async", "unphased", undefined, "async"),
          // Codex marks an async alert as a final answer too.
          reply("unphased-alert", "unphased", "final_answer", "async"),
          prompt("live", "Three"),
          reply("live-first", "live"),
          reply("live-alert", "live", "final_answer", "async"),
          // The window starts inside this turn: its prompt and earlier work are not loaded.
          tool("partial-tool", "partial"),
          // It failed before its answer, so its commentary is only an update.
          prompt("failed", "Five"),
          reply("failed-note", "failed", "commentary"),
          reply("failed-later-note", "failed", "commentary"),
        ],
        checkpoints: [
          {
            id: CheckpointId.make("checkpoint"),
            threadId,
            scopeId: CheckpointScopeId.make("scope"),
            runId: RunId.make("phased"),
            nodeId: NodeId.make("node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref: CheckpointRef.make("ref"),
            status: "ready",
            files: [{ path: "a.ts", kind: "modified", additions: 1, deletions: 0 }],
            filesTotal: { count: 7, additions: 10, deletions: 2 },
            capturedAt: at(15),
          },
        ],
      }),
    );

    expect(phased).toMatchObject({
      updateItemId: "phased-note",
      answerItemId: "phased-answer",
      toolCalls: 2,
      moreToolCalls: true,
      filesChanged: 7,
      durationMs: 5_000,
    });
    expect(unphased).toMatchObject({
      updateItemId: "unphased-first",
      answerItemId: "unphased-last",
      filesChanged: null,
      moreToolCalls: false,
    });
    // Without phases, a running turn's message may be an update, not its answer.
    expect(live).toMatchObject({
      updateItemId: "live-first",
      answerItemId: null,
      durationMs: null,
    });
    expect(partial).toMatchObject({ toolCalls: 1, moreToolCalls: true, rowId: null });
    expect(failed).toMatchObject({ updateItemId: "failed-note", answerItemId: null });
  });
});

function subagentItem(id: string) {
  return {
    type: "subagent" as const,
    subagentId: NodeId.make(id),
    origin: "app_owned" as const,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId,
    childThreadId: null,
    prompt: "",
    result: null,
  };
}

describe("layoutThreadMap", () => {
  const turns = deriveThreadMap(
    projection({
      runs: [
        run("a", 1),
        run("b", 2),
        run("q", 3, { status: "queued", queuePosition: 1, startedAt: null }),
      ],
      items: [
        prompt("a", "A", { senderThreadId: ThreadId.make("other") }),
        tool("send-1", "a", { toolName: "t3_thread_send", input: { threadId: "x" } }),
        tool("send-2", "a", { toolName: "t3_thread_send", input: { threadId: "y" } }),
        tool("send-3", "a", { toolName: "t3_thread_send", input: { threadId: "z" } }),
        prompt("b", "B"),
      ],
      messages: [message("q-prompt", "q")],
      subagents: [
        subagent("helper", "a", {
          completionDelivery: { state: "acknowledged", observedByRunId: RunId.make("b") },
        }),
      ],
    }),
  );
  const layout = layoutThreadMap(turns);

  it("makes each row as tall as its tallest column and links the turns in order", () => {
    const a = layout.turns.get(RunId.make("a"))!;
    const b = layout.turns.get(RunId.make("b"))!;
    const queued = layout.turns.get(RunId.make("q"))!;
    // Four outputs (an agent and three sends) outgrow the card.
    expect(b.y - a.y).toBe(4 * 44 + 3 * 8 + 28);
    expect(queued.height).toBeLessThan(b.height);
    expect(layout.items.get("send:send-3")!.x).toBeGreaterThan(a.x + a.width);
    expect(layout.items.get("from:a")!.x + layout.items.get("from:a")!.width).toBeLessThan(a.x);
    expect(layout.edges.map((edge) => edge.kind).toSorted()).toEqual([
      "input",
      "output",
      "output",
      "output",
      "output",
      "return",
      "spine",
      "spine",
    ]);
    expect(layout.height).toBe(queued.y + queued.height + 8);
  });

  it("brings a result back into the right edge of the turn that received it", () => {
    const b = layout.turns.get(RunId.make("b"))!;
    const back = layout.edges.find((edge) => edge.kind === "return");
    expect(back?.arrow).toEqual({ x: b.x + b.width, y: b.y + b.height - 14, dir: -1 });
    expect(back?.d.endsWith(`H${b.x + b.width}`)).toBe(true);
  });

  it("leaves out the left column when no turn received anything", () => {
    const plain = layoutThreadMap(
      deriveThreadMap(
        projection({
          runs: [run("a", 1)],
          items: [
            prompt("a", "A"),
            tool("send", "a", { toolName: "t3_thread_send", input: { threadId: "x" } }),
          ],
        }),
      ),
    );
    const card = plain.turns.get(RunId.make("a"))!;
    expect(plain.columns.map((column) => column.id)).toEqual(["turns", "outputs"]);
    expect(card.x).toBe(0);
    expect(plain.items.get("send:send")!.x).toBe(card.width + 72);
    expect(plain.width).toBe(card.width + 72 + 208);
    expect(layout.columns.map((column) => column.id)).toEqual(["inputs", "turns", "outputs"]);
  });

  it("is empty but for its header when there are no turns", () => {
    expect(layoutThreadMap([])).toMatchObject({ height: 28, edges: [] });
  });
});

describe("threadMapInitialView", () => {
  it("fits a short map and shows the newest turns of a long one at a legible size", () => {
    const viewport = { width: 1000, height: 600 };
    expect(threadMapInitialView({ width: 776, height: 300 }, viewport).scale).toBeGreaterThan(0.85);

    const tall = threadMapInitialView({ width: 776, height: 4000 }, viewport);
    expect(tall.scale).toBe(1);
    expect(tall.y + 4000 * tall.scale).toBe(600 - 16);

    const narrow = threadMapInitialView({ width: 776, height: 4000 }, { width: 400, height: 600 });
    expect(narrow.scale).toBeCloseTo((400 - 32) / 776);
  });
});
