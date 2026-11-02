import {
  MessageId,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { splitBufferedAssistantText } from "@t3tools/shared/assistantStreaming";
import { projectTurnItemForWire } from "@t3tools/shared/wireProjection";
import * as DateTime from "effect/DateTime";

import type { TimelineLatestRun } from "../../chat/MessagesTimeline.logic";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  derivePendingApprovals,
  derivePendingUserInputs,
  findLatestProposedPlan,
} from "../../../session-logic";

/**
 * Playback applies server buffering and wire projection before client timeline derivation.
 * Runtime requests and plan artifacts feed the composer separately from timeline items.
 */

export const PLAYBACK_THREAD_ID = ThreadId.make("playback-thread");
// Local time, so the first turn's rows read 2:14 PM like the board.
const PLAYBACK_START = new Date(2026, 8, 28, 14, 14, 0).getTime();

export type RunEnding = "completed" | "failed" | "interrupted";

type ItemBase = Omit<
  Extract<OrchestrationV2TurnItem, { type: "reasoning" }>,
  "type" | "text" | "streaming"
>;
/** An item's type-specific fields; the player owns ids, run, status and times. */
export type ItemBody = DistributiveOmit<OrchestrationV2TurnItem, keyof ItemBase>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Step =
  | { readonly kind: "turn"; readonly prompt: string }
  /**
   * A message sent while the turn runs. It joins the running run as a
   * `steer` user message; no new run or provider turn starts. A queued
   * message promoted mid-turn is the same, marked `promoted_queued_to_steer`.
   */
  | {
      readonly kind: "steer";
      readonly key: string;
      readonly text: string;
      readonly promoted?: boolean;
    }
  | {
      readonly kind: "start";
      readonly key: string;
      readonly body: ItemBody;
      readonly seconds?: number;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly patch: Partial<ItemBody>;
      readonly seconds?: number;
    }
  | {
      readonly kind: "finish";
      readonly key: string;
      readonly status?: "completed" | "failed";
      readonly patch?: Partial<ItemBody>;
      readonly seconds?: number;
    }
  | { readonly kind: "end"; readonly ending: RunEnding; readonly seconds?: number }
  | {
      readonly kind: "request";
      readonly key: string;
      readonly request:
        | {
            readonly kind: "approval";
            readonly requestKind: ProviderRequestKind;
            readonly prompt: string;
            readonly cwd?: string;
            /** The provider item the approval gates, such as a patch; it shares the approval's native ref. */
            readonly gates?: ItemBody;
          }
        | {
            readonly kind: "question";
            readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
          };
    }
  | {
      readonly kind: "resolve";
      readonly key: string;
      readonly decision?: ProviderApprovalDecision;
      readonly answers?: ProviderUserInputAnswers;
    }
  | { readonly kind: "plan"; readonly key: string; readonly markdown: string };

export interface PlaybackRun {
  readonly runId: RunId;
  readonly status: "running" | RunEnding;
  readonly startedAt: number;
  readonly completedAt: number | null;
}

export interface PlaybackState {
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runs: ReadonlyArray<PlaybackRun>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly plans: ReadonlyArray<OrchestrationV2PlanArtifact>;
  /** Scene time in ms since the thread started; each step advances it. */
  readonly clock: number;
}

const EMPTY_PLAYBACK: PlaybackState = {
  items: [],
  runs: [],
  runtimeRequests: [],
  plans: [],
  clock: 0,
};

const PLAYBACK_SESSION_ID = ProviderSessionId.make("playback-session");

const iso = (clock: number) => DateTime.makeUnsafe(PLAYBACK_START + clock);

function itemId(runIndex: number, key: string) {
  return TurnItemId.make(`run-${runIndex}:${key}`);
}

function gatedItemId(runIndex: number, key: string) {
  return TurnItemId.make(`run-${runIndex}:${key}:gated`);
}

/** Applies one step. Steps that no longer fit (an update for a missing item) are ignored. */
function applyStep(state: PlaybackState, step: Step): PlaybackState {
  const clock =
    state.clock + ("seconds" in step ? (step.seconds ?? 1) : step.kind === "turn" ? 2 : 1) * 1000;
  const run = state.runs.at(-1);
  const runIndex = state.runs.length - 1;

  if (step.kind === "turn") {
    const runId = RunId.make(`playback-run-${state.runs.length}`);
    const at = iso(state.clock);
    const prompt: OrchestrationV2TurnItem = {
      ...base(TurnItemId.make(`run-${state.runs.length}:prompt`), runId, state.items.length, at),
      status: "completed",
      completedAt: at,
      type: "user_message",
      messageId: MessageId.make(`run-${state.runs.length}:prompt`),
      text: step.prompt,
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    };
    return {
      ...state,
      items: [...state.items, prompt],
      runs: [
        ...state.runs,
        { runId, status: "running", startedAt: state.clock, completedAt: null },
      ],
      clock,
    };
  }

  if (!run || run.status !== "running") return state;

  if (step.kind === "steer") {
    const at = iso(state.clock);
    const steer: OrchestrationV2TurnItem = {
      ...base(itemId(runIndex, step.key), run.runId, state.items.length, at),
      status: "completed",
      completedAt: at,
      type: "user_message",
      messageId: MessageId.make(`run-${runIndex}:${step.key}`),
      text: step.text,
      attachments: [],
      inputIntent: step.promoted ? "promoted_queued_to_steer" : "steer",
      createdBy: "user",
      creationSource: "web",
    };
    return { ...state, items: [...state.items, steer], clock };
  }

  if (step.kind === "end") {
    const at = iso(clock);
    // A stop leaves the interrupt result the server records, a failure its
    // terminal error, and both settle what was still running.
    const settled = state.items.map((item) =>
      item.runId === run.runId && (item.status === "running" || item.status === "pending")
        ? settle(item, step.ending === "completed" ? "completed" : "interrupted", at)
        : item,
    );
    const interrupt: OrchestrationV2TurnItem[] =
      step.ending === "interrupted"
        ? [
            {
              ...base(itemId(runIndex, "interrupt"), run.runId, settled.length, at),
              status: "completed",
              completedAt: at,
              type: "run_interrupt_result",
              message: "Run interrupted by user",
            },
          ]
        : step.ending === "failed"
          ? [
              {
                ...base(itemId(runIndex, "failure"), run.runId, settled.length, at),
                status: "failed",
                title: "Provider error",
                completedAt: at,
                type: "error",
                failure: {
                  class: "provider_error",
                  message: "The provider closed the connection. Changes so far are kept.",
                  code: null,
                  retryable: true,
                },
              },
            ]
          : [];
    return {
      ...state,
      items: [...settled, ...interrupt],
      runs: state.runs.map((entry) =>
        entry === run ? { ...entry, status: step.ending, completedAt: clock } : entry,
      ),
      // A request the run no longer waits on is cancelled, not left pending.
      runtimeRequests: state.runtimeRequests.map((request) =>
        request.status === "pending"
          ? { ...request, status: "cancelled", resolvedAt: at }
          : request,
      ),
      clock,
    };
  }

  if (step.kind === "request") return openRequest(state, step, run, runIndex, clock);
  if (step.kind === "resolve") return resolveRequest(state, step, runIndex, clock);
  if (step.kind === "plan") return proposePlan(state, step, run, runIndex, clock);

  const id = itemId(runIndex, step.key);
  if (step.kind === "start") {
    const item = {
      ...base(id, run.runId, state.items.length, iso(state.clock)),
      ...step.body,
      ...("streaming" in step.body ? { streaming: true } : {}),
    } as OrchestrationV2TurnItem;
    return { ...state, items: [...state.items, item], clock };
  }

  const at = iso(clock);
  const items = state.items.map((item) => {
    if (item.id !== id) return item;
    if (step.kind === "update") {
      return { ...item, ...step.patch, updatedAt: at } as OrchestrationV2TurnItem;
    }
    return settle(
      { ...item, ...step.patch } as OrchestrationV2TurnItem,
      step.status ?? "completed",
      at,
    );
  });
  return { ...state, items, clock };
}

/**
 * An approval or question as the Claude adapter opens one: a pending runtime
 * request and a waiting turn item carrying its prompt or questions.
 */
function openRequest(
  state: PlaybackState,
  step: Extract<Step, { kind: "request" }>,
  run: PlaybackRun,
  runIndex: number,
  clock: number,
): PlaybackState {
  const at = iso(state.clock);
  const requestId = requestIdFor(runIndex, step.key);
  const request: OrchestrationV2RuntimeRequest = {
    id: requestId,
    nodeId: NodeId.make(`run-${runIndex}:${step.key}:node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: step.request.kind === "approval" ? step.request.requestKind : "user_input",
    status: "pending",
    responseCapability: { type: "live", providerSessionId: PLAYBACK_SESSION_ID },
    createdAt: at,
    resolvedAt: null,
  };
  const itemBase = {
    ...base(itemId(runIndex, step.key), run.runId, state.items.length, at),
    status: "waiting" as const,
  };
  const gated = step.request.kind === "approval" ? step.request.gates : undefined;
  const nativeItemRef = gated
    ? { driver: ProviderDriverKind.make("codex"), nativeId: step.key, strength: "strong" as const }
    : null;
  const gatedItem = gated
    ? ({
        ...base(gatedItemId(runIndex, step.key), run.runId, state.items.length + 1, at),
        ...gated,
        status: "waiting",
        nativeItemRef,
      } as OrchestrationV2TurnItem)
    : null;
  const item: OrchestrationV2TurnItem =
    step.request.kind === "approval"
      ? {
          ...itemBase,
          nativeItemRef,
          type: "approval_request",
          requestId,
          requestKind: step.request.requestKind,
          prompt: step.request.prompt,
          ...(step.request.cwd === undefined ? {} : { cwd: step.request.cwd }),
        }
      : {
          ...itemBase,
          type: "user_input_request",
          requestId,
          questions: [...step.request.questions],
        };
  return {
    ...state,
    items: gatedItem ? [...state.items, item, gatedItem] : [...state.items, item],
    runtimeRequests: [...state.runtimeRequests, request],
    clock,
  };
}

/**
 * Answers a request the way the orchestrator does: the request resolves with
 * the decision or answers, and its turn item settles (a question keeps the
 * answers it was given).
 */
function resolveRequest(
  state: PlaybackState,
  step: Extract<Step, { kind: "resolve" }>,
  runIndex: number,
  clock: number,
): PlaybackState {
  const requestId = requestIdFor(runIndex, step.key);
  const request = state.runtimeRequests.find((entry) => entry.id === requestId);
  if (!request || request.status !== "pending") return state;
  const at = iso(clock);
  const declined = step.decision === "decline" || step.decision === "cancel";
  return {
    ...state,
    runtimeRequests: state.runtimeRequests.map((entry) =>
      entry.id === requestId
        ? {
            ...entry,
            status: "resolved",
            resolvedAt: at,
            ...(step.decision === undefined ? {} : { decision: step.decision }),
            ...(step.answers === undefined ? {} : { answers: step.answers }),
          }
        : entry,
    ),
    items: state.items.map((item) => {
      // The gated patch lands when allowed and is dropped when declined.
      if (item.id === gatedItemId(runIndex, step.key)) {
        return {
          ...item,
          status: declined ? "cancelled" : "completed",
          completedAt: at,
          updatedAt: at,
        } as OrchestrationV2TurnItem;
      }
      if (item.id !== itemId(runIndex, step.key)) return item;
      const answered =
        item.type === "user_input_request" && step.answers !== undefined
          ? {
              questionAnswer: {
                requestId,
                answers: step.answers,
                attachmentsByQuestionId: {},
                questionTextById: Object.fromEntries(
                  item.questions.map((question) => [question.id, question.question]),
                ),
              },
            }
          : {};
      return {
        ...item,
        ...answered,
        status: declined ? "cancelled" : "completed",
        completedAt: at,
        updatedAt: at,
      } as OrchestrationV2TurnItem;
    }),
    clock,
  };
}

/** A proposed plan: the plan item in the timeline and the active artifact the composer offers to build. */
function proposePlan(
  state: PlaybackState,
  step: Extract<Step, { kind: "plan" }>,
  run: PlaybackRun,
  runIndex: number,
  clock: number,
): PlaybackState {
  const at = iso(state.clock);
  const planId = PlanId.make(`run-${runIndex}:${step.key}`);
  return {
    ...state,
    items: [
      ...state.items,
      {
        ...base(itemId(runIndex, step.key), run.runId, state.items.length, at),
        status: "completed",
        completedAt: at,
        type: "proposed_plan",
        planId,
        markdown: step.markdown,
        streaming: false,
      },
    ],
    plans: [
      // A new plan supersedes the run's earlier ones.
      ...state.plans.map((plan) =>
        plan.kind === "proposed_plan" && plan.status === "active"
          ? { ...plan, status: "superseded" as const }
          : plan,
      ),
      {
        id: planId,
        threadId: PLAYBACK_THREAD_ID,
        runId: run.runId,
        nodeId: NodeId.make(`run-${runIndex}:${step.key}:node`),
        status: "active",
        kind: "proposed_plan",
        markdown: step.markdown,
      },
    ],
    clock,
  };
}

function requestIdFor(runIndex: number, key: string) {
  return RuntimeRequestId.make(`run-${runIndex}:${key}`);
}

/** The step key that opened a request, for answering it as a `resolve` step. */
export function requestStepKey(requestId: string): string {
  return requestId.slice(requestId.indexOf(":") + 1);
}

export function playSteps(steps: ReadonlyArray<Step>, count = steps.length): PlaybackState {
  return steps.slice(0, count).reduce(applyStep, EMPTY_PLAYBACK);
}

function base(id: TurnItemId, runId: RunId, ordinal: number, at: DateTime.Utc): ItemBase {
  return {
    id,
    threadId: PLAYBACK_THREAD_ID,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "running",
    title: null,
    startedAt: at,
    completedAt: null,
    updatedAt: at,
  };
}

function settle(
  item: OrchestrationV2TurnItem,
  status: "completed" | "failed" | "interrupted",
  at: DateTime.Utc,
): OrchestrationV2TurnItem {
  return {
    ...item,
    status,
    completedAt: at,
    updatedAt: at,
    ...("streaming" in item ? { streaming: false } : {}),
  } as OrchestrationV2TurnItem;
}

/**
 * What paragraph streaming stores for an item still streaming: its text up to
 * the last markdown boundary, or nothing at all before the first boundary. The
 * server holds the rest until the next boundary or completion. It also
 * coalesces updates within 400ms; the player steps are further apart than that.
 */
function storedStreamingItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem | null {
  if ((item.type !== "assistant_message" && item.type !== "reasoning") || !item.streaming) {
    return item;
  }
  const { ready } = splitBufferedAssistantText(item.text);
  return ready ? { ...item, text: ready } : null;
}

/** The timeline's inputs at this moment, derived the way a connected client derives them. */
export function playbackTimeline(state: PlaybackState) {
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = state.items
    .flatMap((raw) => {
      const stored = storedStreamingItem(raw);
      return stored ? [projectTurnItemForWire(stored)] : [];
    })
    .map((wire, position) => ({
      position,
      visibility: "local",
      sourceThreadId: wire.threadId,
      sourceItemId: wire.id,
      item: wire,
    }));
  const run = state.runs.at(-1);
  const latestRun: TimelineLatestRun | null = run
    ? {
        runId: run.runId,
        status: run.status,
        startedAt: new Date(PLAYBACK_START + run.startedAt).toISOString(),
        completedAt:
          run.completedAt === null
            ? null
            : new Date(PLAYBACK_START + run.completedAt).toISOString(),
      }
    : null;
  return {
    entries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems,
      optimisticMessages: [],
    }),
    latestRun,
    running: run?.status === "running",
    /** A sent `/compact` until its compaction settles, as ChatView reports it. */
    compacting:
      run?.status === "running" &&
      state.items.some(
        (item) =>
          item.runId === run.runId && item.type === "user_message" && item.text === "/compact",
      ) &&
      !state.items.some(
        (item) =>
          item.runId === run.runId && item.type === "compaction" && item.status === "completed",
      ),
    /** How long the open turn has run in scene time; the live timer counts on from here. */
    runningForMs: run?.status === "running" ? state.clock - run.startedAt : 0,
  };
}

/**
 * What the composer reads at this moment, derived the way ChatView derives it
 * from the thread projection: pending approvals and questions, and the plan
 * the settled turn offers to build.
 */
export function playbackComposerRequests(state: PlaybackState) {
  const { approvals, userInputs } = derivePendingThreadRequests({
    runtimeRequests: state.runtimeRequests,
    turnItems: state.items,
  });
  const run = state.runs.at(-1);
  const settled = run !== undefined && run.status !== "running";
  const plan = settled
    ? findLatestProposedPlan(
        {
          plans: state.plans,
          turnItems: state.items,
          thread: { createdAt: iso(0) },
          runs: state.runs.map((entry) => ({
            id: entry.runId,
            requestedAt: iso(entry.startedAt),
            startedAt: iso(entry.startedAt),
            completedAt: entry.completedAt === null ? null : iso(entry.completedAt),
          })),
        },
        run.runId,
      )
    : null;
  return {
    approvals: derivePendingApprovals(approvals),
    userInputs: derivePendingUserInputs(userInputs),
    proposedPlan: plan?.status === "active" ? plan : null,
  };
}
