import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import { getUserQueuedThreadRuns } from "@t3tools/client-runtime/state/thread-workflows";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import {
  orchestrationV2RunWorkStartedAt,
  type MessageId,
  type NodeId,
  type OrchestrationV2LinkedSender,
  type OrchestrationV2RunStatus,
  type OrchestrationV2Subagent,
  type RunId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  FLEET_FIT_LEGIBLE_SCALE,
  fitFleetLayout,
  type FleetRect,
  type FleetViewTransform,
} from "../settings/environmentsMap.logic";

type Run = ThreadStructure["runs"][number];
type Item = ThreadStructure["visibleTurnItems"][number]["item"];
type UserMessageItem = Extract<Item, { readonly type: "user_message" }>;

/** Another thread that sent a message: one here, or one in a linked environment. */
export type ThreadMapSender =
  | { readonly kind: "local"; readonly threadId: ThreadId }
  | { readonly kind: "linked"; readonly sender: OrchestrationV2LinkedSender };

export type ThreadMapInput =
  | { readonly kind: "incoming"; readonly id: string; readonly sender: ThreadMapSender }
  | {
      readonly kind: "steer";
      readonly id: string;
      readonly text: string;
      readonly sender: ThreadMapSender | null;
    };

export interface ThreadMapAgent {
  readonly id: NodeId;
  readonly title: string | null;
  readonly prompt: string;
  readonly model: string | null;
  readonly driver: OrchestrationV2Subagent["driver"];
  readonly status: OrchestrationV2Subagent["status"];
  readonly progress: string | null;
  readonly result: string | null;
  readonly childThreadId: ThreadId | null;
  /** The turn its result came back into, when the client can tell which one did. */
  readonly returnRunId: RunId | null;
}

export type ThreadMapOutput =
  | { readonly kind: "agent"; readonly id: string; readonly agent: ThreadMapAgent }
  /** `threadId` is null when the call names no target this client can read. */
  | { readonly kind: "send"; readonly id: string; readonly threadId: ThreadId | null };

export interface ThreadMapTurn {
  readonly runId: RunId;
  readonly number: number;
  readonly status: OrchestrationV2RunStatus;
  readonly queued: boolean;
  /**
   * The conversation row the turn opens at: its prompt, or the notification that woke it.
   * Null when that row is older than the loaded window.
   */
  readonly rowId: string | null;
  readonly prompt: string;
  readonly sender: ThreadMapSender | null;
  /** The first commentary message, read live through its turn item. */
  readonly updateItemId: TurnItemId | null;
  readonly answerItemId: TurnItemId | null;
  readonly toolCalls: number;
  /** Work folded on the wire or older than the loaded window: `toolCalls` is a lower bound. */
  readonly moreToolCalls: boolean;
  readonly filesChanged: number | null;
  readonly durationMs: number | null;
  readonly inputs: ReadonlyArray<ThreadMapInput>;
  readonly outputs: ReadonlyArray<ThreadMapOutput>;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export const isActiveThreadMapTurn = (turn: Pick<ThreadMapTurn, "status">) =>
  ACTIVE_RUN_STATUSES.has(turn.status);

const TOOL_ITEM_TYPES: ReadonlySet<Item["type"]> = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
]);

const THREAD_SEND_TOOLS: ReadonlySet<string> = new Set([
  "t3_thread_send",
  "t3_thread_send_attachments",
]);

const STEER_INTENTS: ReadonlySet<UserMessageItem["inputIntent"]> = new Set([
  "steer",
  "promoted_queued_to_steer",
]);

function senderOf(
  message: {
    readonly senderThreadId?: ThreadId | undefined;
    readonly linkedSender?: OrchestrationV2LinkedSender | undefined;
  },
  selfId: ThreadId,
): ThreadMapSender | null {
  if (message.linkedSender !== undefined) return { kind: "linked", sender: message.linkedSender };
  // A thread can send to itself; that is not a message from another thread.
  if (message.senderThreadId !== undefined && message.senderThreadId !== selfId) {
    return { kind: "local", threadId: message.senderThreadId };
  }
  return null;
}

const presentedText = (message: Parameters<typeof resolveUserMessagePresentation>[0]) =>
  resolveUserMessagePresentation(message).text.trim();

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const isThreadId = Schema.is(ThreadId);

// The server derives a message's turn item ID from the message (IdAllocator derive.userTurnItem),
// and a wake keeps that ID when its row becomes a notification.
const messageTurnItemId = (messageId: MessageId) =>
  `turn-item:message:${encodeURIComponent(messageId)}`;

function sendTarget(
  item: Extract<Item, { readonly type: "dynamic_tool" }>,
  selfId: ThreadId,
): ThreadId | null {
  const output = compactDynamicToolOutput(item.output)?.threadId;
  if (isThreadId(output)) return output;
  const input = asRecord(item.input);
  // Historical Cursor items keep the MCP args envelope.
  const args = typeof input?.toolName === "string" ? asRecord(input.args) : input;
  if (isThreadId(args?.threadId)) return args.threadId;
  // Attachments sent without a target go to the sending thread.
  return args !== undefined && resolveT3McpToolId(item.toolName) === "t3_thread_send_attachments"
    ? selfId
    : null;
}

function isDeliveredSend(item: Extract<Item, { readonly type: "dynamic_tool" }>): boolean {
  return item.status === "completed" && compactDynamicToolOutput(item.output)?.isError !== true;
}

function durationOf(run: Run): number | null {
  if (run.completedAt === null) return null;
  return (
    DateTime.toEpochMillis(run.completedAt) -
    DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run))
  );
}

/**
 * The thread's loaded turns in order, with what flowed into each and out of it. Queued prompts
 * the user sent come last; reverted turns, queued runs a wake opened, and finished turns with
 * no loaded items are left out.
 */
export function deriveThreadMap(projection: ThreadStructure): ReadonlyArray<ThreadMapTurn> {
  const queuedRuns = getUserQueuedThreadRuns(projection).toSorted(
    (left, right) =>
      (left.queuePosition ?? Number.MAX_SAFE_INTEGER) -
        (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.ordinal - right.ordinal,
  );
  const itemsByRun = new Map<RunId, Item[]>();
  const userItemByMessageId = new Map<MessageId, UserMessageItem>();
  const subagentItemRun = new Map<NodeId, RunId>();
  // The wake that delivered a task's result names the task; its run received it. Clients get
  // the wake as a notification row, and only sometimes its message.
  const deliveryRunByTask = new Map<NodeId, RunId>();
  for (const { item } of projection.visibleTurnItems) {
    if (item.type === "user_message") userItemByMessageId.set(item.messageId, item);
    if (item.runId === null) continue;
    if (item.type === "subagent") subagentItemRun.set(item.subagentId, item.runId);
    if (item.type === "notification" && item.source.kind === "delegated_task") {
      for (const taskId of item.source.taskIds) deliveryRunByTask.set(taskId, item.runId);
    }
    const items = itemsByRun.get(item.runId);
    if (items === undefined) itemsByRun.set(item.runId, [item]);
    else items.push(item);
  }
  const startedRuns = projection.runs
    .filter(
      (run) =>
        run.status !== "queued" &&
        run.status !== "rolled_back" &&
        // A queued prompt cancelled before it started never became a turn.
        !(run.status === "cancelled" && run.startedAt === null) &&
        // A finished turn with nothing loaded is older than the history window; drawn, it
        // would claim it did nothing.
        (ACTIVE_RUN_STATUSES.has(run.status) || itemsByRun.has(run.id)),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const startedRunIds = new Set(startedRuns.map((run) => run.id));

  const messageById = new Map(projection.messages.map((message) => [message.id, message]));

  for (const message of projection.messages) {
    if (message.delegatedCompletion === undefined || message.runId === null) continue;
    for (const taskId of message.delegatedCompletion.taskIds) {
      deliveryRunByTask.set(taskId, message.runId);
    }
  }
  const returnRunOf = (subagent: OrchestrationV2Subagent): RunId | null => {
    const runId =
      subagent.completionDelivery?.observedByRunId ?? deliveryRunByTask.get(subagent.id) ?? null;
    return runId !== null && startedRunIds.has(runId) ? runId : null;
  };
  const agentsByRun = new Map<RunId, ThreadMapOutput[]>();
  for (const subagent of projection.subagents) {
    const runId = subagent.runId ?? subagentItemRun.get(subagent.id);
    if (runId === undefined || !startedRunIds.has(runId)) continue;
    const title = subagent.title?.trim();
    const output: ThreadMapOutput = {
      kind: "agent",
      id: `agent:${subagent.id}`,
      agent: {
        id: subagent.id,
        title: title ? formatSubagentDisplayTitle(title) : null,
        prompt: subagent.prompt,
        model: subagent.executedModel ?? subagent.model ?? subagent.modelSelection?.model ?? null,
        driver: subagent.driver,
        status: subagent.status,
        progress: subagent.progress?.trim() || null,
        result: subagent.result?.trim() || null,
        childThreadId: subagent.childThreadId,
        returnRunId: returnRunOf(subagent),
      },
    };
    const outputs = agentsByRun.get(runId);
    if (outputs === undefined) agentsByRun.set(runId, [output]);
    else outputs.push(output);
  }

  // One checkpoint per repository; a capture that is missing or failed says nothing about files.
  const filesChangedByRun = new Map<RunId, number>();
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.runId === null || checkpoint.status !== "ready") continue;
    filesChangedByRun.set(
      checkpoint.runId,
      (filesChangedByRun.get(checkpoint.runId) ?? 0) +
        (checkpoint.filesTotal?.count ?? checkpoint.files.length),
    );
  }

  const toTurn = (run: Run, queued: boolean): ThreadMapTurn => {
    const items = queued ? [] : (itemsByRun.get(run.id) ?? []);
    const openingItem = userItemByMessageId.get(run.userMessageId);
    const openingMessage = messageById.get(run.userMessageId);
    const opening = openingItem ?? openingMessage;
    // A wake's message becomes a notification row, which has no message ID but keeps its ID.
    const openingItemId = messageTurnItemId(run.userMessageId);
    const openingNotification =
      openingItem === undefined
        ? items.find(
            (item): item is Extract<Item, { readonly type: "notification" }> =>
              item.type === "notification" && item.id === openingItemId,
          )
        : undefined;
    const prompt =
      openingNotification?.summary ??
      (opening === undefined
        ? ""
        : (openingMessage?.notification?.summary ??
          presentedText({ ...opening, id: run.userMessageId, role: "user" })));
    const sender = opening === undefined ? null : senderOf(opening, projection.thread.id);

    const inputs: ThreadMapInput[] =
      sender === null ? [] : [{ kind: "incoming", id: `from:${run.id}`, sender }];
    const outputs: ThreadMapOutput[] = [...(agentsByRun.get(run.id) ?? [])];
    let toolCalls = 0;
    // Without its opening message, the turn's start is older than the loaded window.
    let moreToolCalls = !queued && openingItem === undefined && openingNotification === undefined;
    let firstCommentary: TurnItemId | null = null;
    let firstAssistant: TurnItemId | null = null;
    let lastAssistant: TurnItemId | null = null;
    let finalAnswer: TurnItemId | null = null;
    for (const item of items) {
      if (item.deferredWork !== undefined) moreToolCalls = true;
      if (TOOL_ITEM_TYPES.has(item.type)) toolCalls += 1;
      if (
        item.type === "user_message" &&
        item.messageId !== run.userMessageId &&
        STEER_INTENTS.has(item.inputIntent)
      ) {
        inputs.push({
          kind: "steer",
          id: `steer:${item.messageId}`,
          text: presentedText({ ...item, id: item.messageId, role: "user" }),
          sender: senderOf(item, projection.thread.id),
        });
      } else if (item.type === "assistant_message") {
        firstAssistant ??= item.id;
        if (item.phase === "commentary") firstCommentary ??= item.id;
        // An async alert is sent apart from the answer, even when marked as one.
        // Commentary is never the answer, even in a turn that ended before giving one.
        if (item.delivery !== "async" && item.phase !== "commentary") {
          lastAssistant = item.id;
          if (item.phase === "final_answer") finalAnswer = item.id;
        }
      } else if (
        item.type === "dynamic_tool" &&
        THREAD_SEND_TOOLS.has(resolveT3McpToolId(item.toolName) ?? "") &&
        isDeliveredSend(item)
      ) {
        const threadId = sendTarget(item, projection.thread.id);
        if (threadId !== projection.thread.id)
          outputs.push({ kind: "send", id: `send:${item.id}`, threadId });
      }
    }
    // Many providers never mark a phase: a finished turn's last message is its answer.
    const answerItemId =
      finalAnswer ?? (ACTIVE_RUN_STATUSES.has(run.status) ? null : lastAssistant);
    const updateItemId =
      firstCommentary ?? (firstAssistant !== answerItemId ? firstAssistant : null);
    return {
      runId: run.id,
      number: run.ordinal,
      status: run.status,
      queued,
      rowId:
        openingItem !== undefined || queued ? run.userMessageId : (openingNotification?.id ?? null),
      prompt,
      sender,
      updateItemId,
      answerItemId,
      toolCalls,
      moreToolCalls,
      filesChanged: filesChangedByRun.get(run.id) ?? null,
      durationMs: durationOf(run),
      inputs,
      outputs,
    };
  };

  return [
    ...startedRuns.map((run) => toTurn(run, false)),
    ...queuedRuns.map((run) => toTurn(run, true)),
  ];
}

const THREAD_MAP_COLUMNS = ["inputs", "turns", "outputs"] as const;
export type ThreadMapColumn = (typeof THREAD_MAP_COLUMNS)[number];

const HEADER = 28;
const LANE_WIDTH = 208;
const TURN_WIDTH = 288;
const GAP = 72;
const TURN_HEIGHT = 96;
const QUEUED_HEIGHT = 56;
const ITEM_HEIGHT = 44;
const ITEM_GAP = 8;
const ROW_GAP = 28;
const BOTTOM_PADDING = 8;
/** Where a lane wire meets a card: kept clear of its rounded corners. */
const PORT_INSET = 14;

export interface ThreadMapArrow {
  readonly x: number;
  readonly y: number;
  /** 1 points right, -1 left. */
  readonly dir: 1 | -1;
}

export interface ThreadMapEdge {
  readonly id: string;
  readonly kind: "spine" | "input" | "output" | "return";
  readonly d: string;
  readonly arrow: ThreadMapArrow | null;
}

export interface ThreadMapLayout {
  readonly width: number;
  readonly height: number;
  readonly columns: ReadonlyArray<{ readonly id: ThreadMapColumn; readonly x: number }>;
  readonly turns: ReadonlyMap<RunId, FleetRect>;
  /** Lane items by their `id`. */
  readonly items: ReadonlyMap<string, FleetRect>;
  readonly edges: ReadonlyArray<ThreadMapEdge>;
}

const laneHeight = (count: number) =>
  count === 0 ? 0 : count * ITEM_HEIGHT + (count - 1) * ITEM_GAP;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const pull = (x2 - x1) / 2;
  return `M${x1} ${y1}C${x1 + pull} ${y1} ${x2 - pull} ${y2} ${x2} ${y2}`;
};

/** A right-angled path through the gap beside the turns, with rounded corners. */
function elbow(from: { x: number; y: number }, gapX: number, to: { x: number; y: number }) {
  const dy = to.y - from.y;
  const radius = Math.min(8, Math.abs(dy) / 2, Math.abs(from.x - gapX), Math.abs(gapX - to.x));
  const down = Math.sign(dy);
  return [
    `M${from.x} ${from.y}`,
    `H${gapX + radius}`,
    `Q${gapX} ${from.y} ${gapX} ${from.y + down * radius}`,
    `V${to.y - down * radius}`,
    `Q${gapX} ${to.y} ${gapX - radius} ${to.y}`,
    `H${to.x}`,
  ].join("");
}

/**
 * Places the turns top to bottom in the middle column, what flowed into each on its left and
 * what went out of it on its right. A row is as tall as its tallest column. Most threads have
 * no steers or incoming messages, and then the left column is left out.
 */
export function layoutThreadMap(turns: ReadonlyArray<ThreadMapTurn>): ThreadMapLayout {
  const columns = THREAD_MAP_COLUMNS.filter(
    (column) => column !== "inputs" || turns.some((turn) => turn.inputs.length > 0),
  );
  const turnsX = columns.includes("inputs") ? LANE_WIDTH + GAP : 0;
  const columnX: Record<ThreadMapColumn, number> = {
    inputs: 0,
    turns: turnsX,
    outputs: turnsX + TURN_WIDTH + GAP,
  };
  const turnRects = new Map<RunId, FleetRect>();
  const items = new Map<string, FleetRect>();
  const edges: ThreadMapEdge[] = [];
  let y = HEADER;
  let previous: FleetRect | null = null;
  for (const turn of turns) {
    const card = {
      x: columnX.turns,
      y,
      width: TURN_WIDTH,
      height: turn.queued ? QUEUED_HEIGHT : TURN_HEIGHT,
    };
    turnRects.set(turn.runId, card);
    if (previous !== null) {
      const x = card.x + card.width / 2;
      edges.push({
        id: `spine:${turn.runId}`,
        kind: "spine",
        d: `M${x} ${previous.y + previous.height}V${card.y}`,
        arrow: null,
      });
    }
    const lane = (column: "inputs" | "outputs", ids: ReadonlyArray<string>) =>
      ids.forEach((id, index) => {
        const rect = {
          x: columnX[column],
          y: y + index * (ITEM_HEIGHT + ITEM_GAP),
          width: LANE_WIDTH,
          height: ITEM_HEIGHT,
        };
        items.set(id, rect);
        const portY = clamp(
          rect.y + ITEM_HEIGHT / 2,
          card.y + PORT_INSET,
          card.y + card.height - PORT_INSET,
        );
        edges.push(
          column === "inputs"
            ? {
                id: `input:${id}`,
                kind: "input",
                d: curve(rect.x + rect.width, rect.y + ITEM_HEIGHT / 2, card.x, portY),
                arrow: { x: card.x, y: portY, dir: 1 },
              }
            : {
                id: `output:${id}`,
                kind: "output",
                d: curve(card.x + card.width, portY, rect.x, rect.y + ITEM_HEIGHT / 2),
                arrow: { x: rect.x, y: rect.y + ITEM_HEIGHT / 2, dir: 1 },
              },
        );
      });
    lane(
      "inputs",
      turn.inputs.map((input) => input.id),
    );
    lane(
      "outputs",
      turn.outputs.map((output) => output.id),
    );
    y +=
      Math.max(card.height, laneHeight(turn.inputs.length), laneHeight(turn.outputs.length)) +
      ROW_GAP;
    previous = card;
  }

  let returns = 0;
  for (const turn of turns) {
    for (const output of turn.outputs) {
      if (output.kind !== "agent" || output.agent.returnRunId === null) continue;
      const from = items.get(output.id);
      const into = turnRects.get(output.agent.returnRunId);
      if (from === undefined || into === undefined) continue;
      // Each return takes its own track in the gap, so several stay apart.
      const gapX = columnX.turns + TURN_WIDTH + 14 + (returns % 4) * 9;
      returns += 1;
      const to = { x: into.x + into.width, y: into.y + into.height - PORT_INSET };
      edges.push({
        id: `return:${output.id}`,
        kind: "return",
        d: elbow({ x: from.x, y: from.y + from.height - PORT_INSET }, gapX, to),
        arrow: { ...to, dir: -1 },
      });
    }
  }

  return {
    width: columnX.outputs + LANE_WIDTH,
    height: turns.length === 0 ? HEADER : y - ROW_GAP + BOTTOM_PADDING,
    columns: columns.map((id) => ({ id, x: columnX[id] })),
    turns: turnRects,
    items,
    edges,
  };
}

/**
 * The view the map opens on: all of it when that stays legible, else its full width at up to
 * actual size with the newest turns in view, since a long thread fitted whole is unreadable.
 */
export function threadMapInitialView(
  layout: Pick<ThreadMapLayout, "width" | "height">,
  viewport: { readonly width: number; readonly height: number },
): FleetViewTransform {
  const fit = fitFleetLayout(layout, viewport);
  if (fit.scale >= FLEET_FIT_LEGIBLE_SCALE) return fit;
  const padding = 16;
  const scale = Math.max(0.01, Math.min(1, (viewport.width - padding * 2) / layout.width));
  return {
    scale,
    x: (viewport.width - layout.width * scale) / 2,
    y: viewport.height - padding - layout.height * scale,
  };
}
