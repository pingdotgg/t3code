import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalFullAccessOverride,
  ProviderApprovalOption,
  ProviderApprovalDecision,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { parseThreadKey, threadKey } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";
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

/** Keys a user-input draft by thread so a thread's resolved requests can be pruned together. */
export function userInputDraftKey(
  environmentId: string,
  threadId: string | null,
  requestId: string | undefined,
): string {
  return JSON.stringify([environmentId, threadId, requestId]);
}

/**
 * Drops the thread's drafts for requests outside `pendingRequestIds`, leaving
 * other threads alone. Returns the input itself when nothing is dropped.
 */
export function pruneResolvedUserInputDrafts<T>(
  draftsByRequestKey: Record<string, T>,
  environmentId: string,
  threadId: string,
  pendingRequestIds: ReadonlyArray<string>,
): Record<string, T> {
  const threadPrefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  const pendingKeys = new Set(
    pendingRequestIds.map((requestId) => userInputDraftKey(environmentId, threadId, requestId)),
  );
  const retained = Object.entries(draftsByRequestKey).filter(
    ([key]) => !key.startsWith(threadPrefix) || pendingKeys.has(key),
  );
  return retained.length === Object.keys(draftsByRequestKey).length
    ? draftsByRequestKey
    : Object.fromEntries(retained);
}

/**
 * Question attachment drafts are keyed `<thread prefix><encoded [requestId, questionId]>`.
 * Returns the keys under `threadPrefix` whose request is outside `pendingRequestIds`.
 */
export function resolvedQuestionDraftKeys(
  keys: Iterable<string>,
  threadPrefix: string,
  pendingRequestIds: ReadonlyArray<string>,
): string[] {
  // encodeURIComponent is per character, so an encoded JSON prefix prefixes the encoded key.
  const pendingPrefixes = pendingRequestIds.map(
    (requestId) =>
      `${threadPrefix}${encodeURIComponent(`${JSON.stringify([requestId]).slice(0, -1)},`)}`,
  );
  const resolved: string[] = [];
  for (const key of keys) {
    if (key.startsWith(threadPrefix) && !pendingPrefixes.some((prefix) => key.startsWith(prefix)))
      resolved.push(key);
  }
  return resolved;
}

export interface ThreadRequestsResolved {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Every request the thread still waits on; drafts for any other request are stale. */
  readonly pendingRequestIds: ReadonlyArray<RuntimeRequestId>;
}

const threadRequestsResolvedListeners = new Set<(event: ThreadRequestsResolved) => void>();

/**
 * Clients register draft pruners once at module level. Thread state announces
 * when its synchronized projection first lands and whenever a request leaves
 * pending, wherever the resolution came from (another device, interrupt, turn end).
 */
export function onThreadRequestsResolved(
  listener: (event: ThreadRequestsResolved) => void,
): () => void {
  threadRequestsResolvedListeners.add(listener);
  return () => threadRequestsResolvedListeners.delete(listener);
}

function notifyThreadRequestsResolved(event: ThreadRequestsResolved): void {
  for (const listener of threadRequestsResolvedListeners) {
    try {
      listener(event);
    } catch (error) {
      // A failing pruner must neither stop the others nor break thread sync.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/**
 * Tracks one thread's announced pending requests. Feed it the pending ids of
 * each authoritative projection; it notifies on the first one and whenever an
 * announced request is no longer pending. New requests alone stay quiet.
 */
export function makeThreadRequestsResolvedAnnouncer(
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  let announced: ReadonlySet<RuntimeRequestId> | null = null;
  return (pendingRequestIds: ReadonlyArray<RuntimeRequestId>) => {
    const pending = new Set(pendingRequestIds);
    const resolvedSome = announced === null || [...announced].some((id) => !pending.has(id));
    announced = pending;
    if (resolvedSome) notifyThreadRequestsResolved({ environmentId, threadId, pendingRequestIds });
  };
}

export function pendingRuntimeRequestIds(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests">,
): RuntimeRequestId[] {
  return projection.runtimeRequests.flatMap((request) =>
    request.status === "pending" ? [request.id] : [],
  );
}

export function derivePendingThreadRequests(
  projection: Pick<ThreadStructure, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
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

  return { approvals, userInputs };
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

export interface ChildThreadApproval {
  readonly thread: ScopedThreadRef;
  readonly title: string;
  readonly approval: ThreadPendingApproval;
}

export function createChildThreadApprovalsAtom(input: {
  readonly childThreadInputsAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly pendingRequestsAtom: (ref: ScopedThreadRef) => Atom.Atom<PendingThreadRequests | null>;
}) {
  const family = Atom.family((key: string) => {
    let previous: ReadonlyArray<ChildThreadApproval> = [];
    return Atom.make((get) => {
      const next = get(input.childThreadInputsAtom(parseThreadKey(key))).flatMap((child) => {
        if (!child.hasPendingApprovals) return [];
        const thread = { environmentId: child.environmentId, threadId: child.id };
        // Only children asking for approval need a detail subscription.
        return (get(input.pendingRequestsAtom(thread))?.approvals ?? []).map((approval) => ({
          thread,
          title: child.title,
          approval,
        }));
      });
      if (
        next.length === previous.length &&
        next.every((entry, index) => {
          const old = previous[index]!;
          return (
            old.approval === entry.approval &&
            old.title === entry.title &&
            threadKey(old.thread) === threadKey(entry.thread)
          );
        })
      )
        return previous;
      previous = next;
      return next;
    });
  });
  const empty = Atom.make<ReadonlyArray<ChildThreadApproval>>([]);
  return (ref: ScopedThreadRef | null) => (ref === null ? empty : family(threadKey(ref)));
}
