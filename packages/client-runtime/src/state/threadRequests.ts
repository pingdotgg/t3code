import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderApprovalDecision,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { AtomCommandResult } from "./runtime.ts";
import type { ThreadStructure, ThreadStructureVisibleTurnItem } from "./models.ts";

export type ApprovalResponder = (
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
  feedback?: string,
) => Promise<AtomCommandResult<unknown, unknown> | undefined>;

/** Feedback belongs to the displayed request, which may be a native child's tool call. */
export async function sendApprovalFeedback(
  approval: ThreadPendingApproval,
  feedback: string,
  respond: ApprovalResponder,
): Promise<boolean> {
  if (!approval.supportsFeedback || approval.responseCapability !== "live" || !feedback.trim())
    return false;
  return (await respond(approval.requestId, "decline", feedback.trim()))?._tag === "Success";
}

/** Declines every approval a redirect replaces; any one still pending would block the agent. */
export async function declinePendingApprovals(
  approvals: ReadonlyArray<ThreadPendingApproval>,
  respond: ApprovalResponder,
): Promise<boolean> {
  for (const approval of approvals) {
    // A request the provider can no longer answer has nothing to decline.
    if (approval.responseCapability !== "live") continue;
    if ((await respond(approval.requestId, "decline"))?._tag !== "Success") return false;
  }
  return true;
}

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly fullAccessOverride?: ProviderApprovalFullAccessOverride;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
  readonly supportsFeedback?: boolean;
}

export const FULL_ACCESS_OVERRIDE_QUESTION = "Why am I being asked this?";

export function fullAccessOverrideExplanation(
  override: ProviderApprovalFullAccessOverride,
): string {
  return override === "ask_rule"
    ? "Full access skips approvals, but an ask rule in the agent's own settings matches this action, so it still asks. Remove or narrow that rule to stop these prompts."
    : "Full access skips approvals, but the agent still stops for a few safety checks of its own that no setting can skip, such as a delete whose path it can't verify. T3 Code can't turn these off, so check the request and approve it if it's what you expect.";
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
  /** Questions asked before this prompt among requests whose pending intervals overlap it. */
  readonly queueQuestionIndex?: number;
  readonly queueQuestionTotal?: number;
}

// Adapters fall back to "Question" or "Question N" when the provider sends no title.
export function isGenericUserInputQuestionHeader(header: string) {
  return /^question(?:\s+\d+)?$/i.test(header.trim());
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  let seeded: Record<string, Draft | { customAnswer: string }> = drafts;
  for (const question of questions) {
    if (
      question.initialAnswer === undefined ||
      question.allowCustomAnswer === false ||
      seeded[question.id] !== undefined
    )
      continue;
    if (seeded === drafts) seeded = { ...drafts };
    seeded[question.id] = { customAnswer: question.initialAnswer };
  }
  return seeded;
}

export function derivePendingThreadRequests(
  projection: Pick<ThreadStructure, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];
  const hasPendingUserInput = projection.runtimeRequests.some(
    (request) => request.kind === "user_input" && request.status === "pending",
  );
  const userInputItems = hasPendingUserInput
    ? userInputItemsByRequestId(projection.turnItems)
    : undefined;
  const queuePositions = userInputItems
    ? userInputQueuePositions(projection.runtimeRequests, userInputItems)
    : undefined;

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = userInputItems?.get(request.id);
      if (item === undefined) continue;
      const position = queuePositions?.get(request.id);
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
        ...(position
          ? { queueQuestionIndex: position.index, queueQuestionTotal: position.total }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.reason ? { reason: item.reason } : {}),
      ...(item?.type === "approval_request" && item.fullAccessOverride
        ? { fullAccessOverride: item.fullAccessOverride }
        : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
      ...(request.responseCapability.type === "live" && request.responseCapability.supportsFeedback
        ? { supportsFeedback: true }
        : {}),
    });
  }

  // Consumers activate the first entry; queue positions count in creation order.
  userInputs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { approvals, userInputs };
}

type UserInputRequestItem = Extract<
  ThreadStructure["turnItems"][number],
  { type: "user_input_request" }
>;

function userInputItemsByRequestId(turnItems: ThreadStructure["turnItems"]) {
  const items = new Map<RuntimeRequestId, UserInputRequestItem>();
  // Later items win, matching the previous findLast lookup.
  for (const item of turnItems) {
    if (item.type === "user_input_request") items.set(item.requestId, item);
  }
  return items;
}

// Agents like Pi ask several one-question requests at once. Requests whose pending intervals
// overlap form one queue, so the composer can count across them; a question asked after the
// previous one resolved starts a fresh queue.
function userInputQueuePositions(
  requests: ThreadStructure["runtimeRequests"],
  items: ReadonlyMap<RuntimeRequestId, UserInputRequestItem>,
) {
  const intervals = requests.flatMap((request, order) => {
    if (request.kind !== "user_input") return [];
    const start = DateTime.toEpochMillis(request.createdAt);
    const end =
      request.resolvedAt !== null
        ? DateTime.toEpochMillis(request.resolvedAt)
        : request.status === "pending"
          ? Number.POSITIVE_INFINITY
          : // A settled request without a resolution time must not hold its queue open forever.
            start;
    // A request without its question item contributes nothing countable.
    const questionCount = items.get(request.id)?.questions.length ?? 0;
    return [
      { id: request.id, pending: request.status === "pending", start, end, order, questionCount },
    ];
  });
  intervals.sort((left, right) => left.start - right.start || left.order - right.order);

  const positions = new Map<RuntimeRequestId, { index: number; total: number }>();
  let batchStart = 0;
  let batchEnd = Number.NEGATIVE_INFINITY;
  const flush = (batchStop: number) => {
    const batch = intervals.slice(batchStart, batchStop);
    if (!batch.some((interval) => interval.pending)) return;
    const total = batch.reduce((sum, interval) => sum + interval.questionCount, 0);
    let index = 0;
    for (const interval of batch) {
      if (interval.pending) positions.set(interval.id, { index, total });
      index += interval.questionCount;
    }
  };
  for (const [position, interval] of intervals.entries()) {
    if (position > batchStart && interval.start > batchEnd) {
      flush(position);
      batchStart = position;
      batchEnd = Number.NEGATIVE_INFINITY;
    }
    batchEnd = Math.max(batchEnd, interval.end);
  }
  flush(intervals.length);
  return positions;
}

export function createQuestionHistoryProjector<
  Row extends ThreadStructureVisibleTurnItem =
    OrchestrationV2ThreadProjection["visibleTurnItems"][number],
>() {
  type Rows = ReadonlyArray<Row>;
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  const cache = new WeakMap<Row, { request: Requests[number]; row: Row }>();
  return (projection: {
    readonly visibleTurnItems: Rows;
    readonly runtimeRequests: Requests;
  }): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    if (rows === previousRows && requests === previousRequests && previousResult)
      return previousResult;
    const byId = new Map(requests.map((request) => [request.id, request]));
    let result: Row[] | undefined;
    for (const [index, row] of rows.entries()) {
      const item = row.item;
      const request =
        item.type === "user_input_request" && !item.questionAnswer
          ? byId.get(item.requestId)
          : undefined;
      let next = row;
      if (
        item.type === "user_input_request" &&
        request?.status === "resolved" &&
        request.answers !== undefined
      ) {
        const cached = cache.get(row);
        next =
          cached?.request === request
            ? cached.row
            : {
                ...row,
                item: {
                  ...item,
                  questionAnswer: {
                    requestId: request.id,
                    answers: request.answers,
                    attachmentsByQuestionId: {},
                    questionTextById: Object.fromEntries(
                      item.questions.map((question) => [question.id, question.question]),
                    ),
                  },
                },
              };
        cache.set(row, { request, row: next });
      }
      if (next !== row) result ??= rows.slice(0, index);
      result?.push(next);
    }
    previousRows = rows;
    previousRequests = requests;
    previousResult = result ?? rows;
    return previousResult;
  };
}
