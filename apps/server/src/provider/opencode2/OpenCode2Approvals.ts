/**
 * OpenCode2Approvals — permission rules per runtime mode, reply mappers,
 * form-answer coercion, and the pending approval maps for the standalone
 * `opencode2` adapter.
 *
 * `trackOpenCode2Permission` / `trackOpenCode2Question` register incoming
 * approval requests (called by the event translator). `respond` /
 * `respondToUserInput` claim the pending entry, reply through the session
 * client, and mark the request terminal. The terminal `request.resolved` /
 * `user-input.resolved` events themselves come from the SSE translator's
 * provider echo (`permission.replied` / `form.replied`) — the respond path
 * never emits them, so each resolution surfaces exactly once. Unknown ids
 * fail typed (`ProviderAdapterRequestError`); already-resolved ids are
 * idempotent no-ops.
 *
 * @module provider/opencode2/OpenCode2Approvals
 */
import type {
  ApprovalRequestId,
  EventId,
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";

import {
  openCode2RequestError,
  toOpenCode2FormAnswers,
  toOpenCode2PermissionReply,
  toOpenCode2QuestionAnswers,
  type OpenCode2AdapterError,
} from "./OpenCode2Protocol.ts";
import {
  ensureOpenCode2Context,
  evictOldestOpenCode2PendingRequest,
  OPENCODE2_MAX_PENDING_REQUESTS,
  OPENCODE2_SUBMISSION_TIMEOUT_MS,
  runOpenCode2SdkWithTimeout,
  type OpenCode2PendingPermission,
  type OpenCode2PendingQuestion,
  type OpenCode2SessionClient,
  type OpenCode2SessionContext,
  type OpenCode2SessionStore,
} from "./OpenCode2SessionStore.ts";

export type {
  OpenCode2PendingPermission,
  OpenCode2PendingQuestion,
} from "./OpenCode2SessionStore.ts";

/**
 * Reply budget (10s per reply op — submit 10s / wait 10min / interrupt 10s /
 * reply 10s budgets from the sweep). The inner `runOpenCode2SdkWithTimeout`
 * already bounds the network call; this outer budget stays as the typed
 * reply-level timeout matching v1 (`permission.reply did not complete
 * within 10 seconds`).
 */
const REPLY_TIMEOUT_MS = OPENCODE2_SUBMISSION_TIMEOUT_MS;

const withReplyTimeout =
  <A, E, R>(
    method: string,
  ): ((effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | OpenCode2AdapterError, R>) =>
  (effect) =>
    Effect.timeoutOrElse(effect, {
      duration: `${REPLY_TIMEOUT_MS} millis`,
      orElse: () =>
        Effect.fail(
          openCode2RequestError(method, `OpenCode 2 ${method} did not complete within 10 seconds.`),
        ),
    });

export interface OpenCode2ApprovalEventDeps {
  readonly randomEventId: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

const emitApprovalEvent = (
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  input: {
    readonly threadId: ThreadId;
    readonly type:
      | "request.opened"
      | "request.resolved"
      | "user-input.requested"
      | "user-input.resolved";
    readonly requestId: RuntimeRequestId;
    readonly payload: Record<string, unknown>;
    readonly eventId: EventId;
    readonly createdAt: string;
  },
): Effect.Effect<void> =>
  Queue.offer(events, {
    eventId: input.eventId,
    provider: "opencode2" as ProviderRuntimeEvent["provider"],
    threadId: input.threadId,
    createdAt: input.createdAt,
    requestId: input.requestId,
    type: input.type,
    payload: input.payload,
  } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);

/**
 * Register an incoming permission request and emit `request.opened`.
 * Re-registering an id refreshes the entry (upstream re-emit).
 */
export const trackOpenCode2Permission = Effect.fn("trackOpenCode2Permission")(function* (
  store: OpenCode2SessionStore,
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  threadId: ThreadId,
  request: OpenCode2PendingPermission,
  detail: {
    readonly requestType:
      | "command_execution_approval"
      | "file_change_approval"
      | "file_read_approval"
      | "permission_approval";
    readonly eventDeps: OpenCode2ApprovalEventDeps;
  },
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  if (
    !context.pendingPermissions.has(request.requestId) &&
    context.pendingPermissions.size + context.pendingQuestions.size >=
      OPENCODE2_MAX_PENDING_REQUESTS
  ) {
    evictOldestOpenCode2PendingRequest(context);
  }
  context.pendingPermissions.set(request.requestId, request);
  yield* emitApprovalEvent(events, {
    threadId,
    type: "request.opened",
    requestId: request.requestId as unknown as RuntimeRequestId,
    payload: { requestType: detail.requestType },
    eventId: (yield* detail.eventDeps.randomEventId) as EventId,
    createdAt: yield* detail.eventDeps.nowIso,
  });
});

/**
 * Register an incoming user-input (question) request and emit
 * `user-input.requested` with normalized questions.
 */
export const trackOpenCode2Question = Effect.fn("trackOpenCode2Question")(function* (
  store: OpenCode2SessionStore,
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  threadId: ThreadId,
  request: OpenCode2PendingQuestion,
  eventDeps: OpenCode2ApprovalEventDeps,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  if (
    !context.pendingQuestions.has(request.requestId) &&
    context.pendingPermissions.size + context.pendingQuestions.size >=
      OPENCODE2_MAX_PENDING_REQUESTS
  ) {
    evictOldestOpenCode2PendingRequest(context);
  }
  context.pendingQuestions.set(request.requestId, request);
  yield* emitApprovalEvent(events, {
    threadId,
    type: "user-input.requested",
    requestId: request.requestId as unknown as RuntimeRequestId,
    payload: {
      questions: request.questions.map((question, index) => ({
        id: `question-${index}`,
        header: question.header,
        question: question.question,
        options: (question.options ?? []).map((option) => ({
          label: option.label,
          description: "",
        })),
      })),
    },
    eventId: (yield* eventDeps.randomEventId) as EventId,
    createdAt: yield* eventDeps.nowIso,
  });
});

/**
 * Claim one pending entry for a reply: remove it from both pending maps
 * before the SDK await so a concurrent reply for the same id finds no entry
 * (and becomes an idempotent no-op / typed unknown-id instead of a second
 * submit). No async boundary sits between the lookup and this delete, so the
 * claim is atomic under Effect's cooperative scheduling. On transport
 * failure the caller restores the claimed entry (guarded by `has`, so a
 * re-tracked entry from another fiber is never clobbered) so a retry can
 * resubmit instead of stalling on unknown-id; the terminal event itself
 * arrives via the provider SSE echo, recorded by
 * `handleOpenCode2TranslatedEvent`.
 */
const claimPendingForReply = (context: OpenCode2SessionContext, key: string): void => {
  context.pendingPermissions.delete(key);
  context.pendingQuestions.delete(key);
};

/**
 * Restore a claimed entry after a failed reply, unless another fiber
 * re-registered the same id meanwhile (upstream re-emit / re-track). The
 * guard preserves the race property: the loser already failed unknown-id
 * before the winner's failure path runs, so a restore can never resurrect
 * a second submit — it only re-arms a retry.
 */
const restorePendingForRetry = (
  map: Map<string, OpenCode2PendingPermission> | Map<string, OpenCode2PendingQuestion>,
  key: string,
  request: OpenCode2PendingPermission | OpenCode2PendingQuestion,
): void => {
  if (!map.has(key)) {
    (map as Map<string, typeof request>).set(key, request);
  }
};

/**
 * Respond to an interactive approval request. Already-resolved ids are
 * idempotent no-ops; unknown ids fail with `ProviderAdapterRequestError`.
 * The requested session id travels with the reply (v2 is session-scoped).
 * The pending entry is claimed before the SDK await so concurrent replies
 * for the same id cannot both submit; on failure the entry is restored
 * (unless re-registered meanwhile) so a transient failure is retryable
 * instead of stalling on unknown-id. The terminal
 * `request.resolved` event arrives via the provider SSE echo
 * (`permission.replied`); this path only records the id so late frames
 * settle state without re-emitting.
 */
export const respondToOpenCode2Request = Effect.fn("respondToOpenCode2Request")(function* (
  store: OpenCode2SessionStore,
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  _eventDeps: OpenCode2ApprovalEventDeps,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  const key = String(requestId);
  const request = context.pendingPermissions.get(key);
  if (request === undefined) {
    if (context.emittedTerminalRequestIds.has(key)) {
      return;
    }
    return yield* openCode2RequestError(
      "permission.reply",
      `Unknown pending permission request: ${key}`,
    );
  }
  const reply = toOpenCode2PermissionReply(decision);
  claimPendingForReply(context, key);
  const outcome = yield* runOpenCode2SdkWithTimeout("permission.reply", (signal) =>
    context.client.permission.reply(
      { requestID: key, reply, sessionID: request.sessionID },
      { signal },
    ),
  ).pipe(withReplyTimeout("permission.reply"), Effect.exit);
  if (Exit.isFailure(outcome)) {
    restorePendingForRetry(context.pendingPermissions, key, request);
    return yield* Effect.failCause(outcome.cause);
  }
  // No synthetic terminal emit: the provider SSE echo (`permission.replied`)
  // is the sole `request.resolved` source. Recording the id here lets a late
  // echo settle pending state without re-emitting, and keeps a re-reply of
  // the same id an idempotent no-op.
  context.emittedTerminalRequestIds.add(key);
});

/**
 * Walk the `parentID` ancestry from a root session id down through every
 * subagent descendant (`session.list({parentID})`, paginated). Cycle-safe:
 * ids already visited are never re-enqueued, so a server that echoes an
 * ancestor as its own child terminates. Best-effort per branch: one bad
 * page returns what the walk collected so far instead of failing the
 * caller (abort/interrupt paths must never wedge on a listing error).
 *
 * The concrete binding maps `session.children` to `session.list`; fakes
 * may omit it (then only the root is returned). Each page follows the
 * SDK `SessionsResponse` cursor shape (`{data, cursor: {next?}}`) as well
 * as bare arrays so fakes keep compiling.
 */
export const listOpenCode2Descendants = Effect.fn("listOpenCode2Descendants")(function* (
  client: Pick<OpenCode2SessionClient, "session">,
  rootSessionId: string,
  options?: { readonly maxDepth?: number | undefined } | undefined,
): Effect.fn.Return<ReadonlyArray<string>, OpenCode2AdapterError> {
  const maxDepth = options?.maxDepth ?? 32;
  const visited = new Set<string>([rootSessionId]);
  const descendants: Array<string> = [];
  const listChildren = (
    sessionId: string,
    cursor?: string | undefined,
  ): Effect.Effect<{ readonly ids: ReadonlyArray<string>; readonly next?: string | undefined }> => {
    const childrenOf = client.session.children;
    if (childrenOf === undefined) {
      return Effect.succeed({ ids: [] as ReadonlyArray<string> });
    }
    // The structural `children` input carries only `sessionID` today; the
    // SDK `session.list` page behind the concrete binding takes an optional
    // `cursor`, so thread it through structurally and let the binding
    // forward it (fakes that ignore extras keep compiling).
    const input = (
      cursor !== undefined ? { sessionID: sessionId, cursor } : { sessionID: sessionId }
    ) as { readonly sessionID: string };
    // Best-effort per branch: a throwing child listing resolves to no
    // children for that branch instead of failing the whole walk (abort and
    // interrupt paths must never wedge on a listing error). Each page runs
    // under the 10s submission budget so a hanging child listing cannot
    // wedge the abort/interrupt path that called the walk.
    return runOpenCode2SdkWithTimeout("session.children", (signal) =>
      childrenOf(input, { signal }).then(
        (response) => ({ status: "ok" as const, response }),
        () => ({ status: "failed" as const }),
      ),
    ).pipe(
      Effect.orElseSucceed(() => ({ status: "failed" as const })),
      Effect.map((outcome) => {
        if (outcome.status === "failed") {
          return { ids: [] as ReadonlyArray<string> };
        }
        const response = outcome.response as {
          readonly data?: ReadonlyArray<{ readonly id: string }> | undefined;
          readonly cursor?: { readonly next?: string | undefined } | undefined;
        };
        const data = response.data ?? [];
        const ids = data
          .map((child) => child.id)
          .filter((id) => typeof id === "string" && id.length > 0);
        const next = response.cursor?.next;
        return { ids, ...(next !== undefined ? { next } : {}) };
      }),
    );
  };
  const collectChildren = (sessionId: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      const ids: Array<string> = [];
      let cursor: string | undefined;
      // Guard against a server that endlessly pages: a repeated cursor ends
      // the walk for this branch (visited-set still protects the BFS below).
      const seenCursors = new Set<string>();
      for (;;) {
        const page = yield* listChildren(sessionId, cursor);
        ids.push(...page.ids);
        if (page.next === undefined || seenCursors.has(page.next)) {
          break;
        }
        seenCursors.add(page.next);
        cursor = page.next;
      }
      return ids as ReadonlyArray<string>;
    });
  let frontier: Array<{ readonly id: string; readonly depth: number }> = [
    { id: rootSessionId, depth: 0 },
  ];
  while (frontier.length > 0) {
    const next: Array<{ readonly id: string; readonly depth: number }> = [];
    for (const node of frontier) {
      if (node.depth >= maxDepth) {
        continue;
      }
      const childIds = yield* collectChildren(node.id);
      for (const childId of childIds) {
        if (visited.has(childId)) {
          continue;
        }
        visited.add(childId);
        descendants.push(childId);
        next.push({ id: childId, depth: node.depth + 1 });
      }
    }
    frontier = next;
  }
  return descendants as ReadonlyArray<string>;
});

/**
 * Respond to a structured user-input request. Already-resolved ids are
 * idempotent no-ops; unknown ids fail typed. Prefers the v2-native
 * session-scoped form reply (`sessionForm.reply`, `Form.Answer` record);
 * falls back to the legacy question reply only when the binding predates
 * forms. The pending entry is claimed before the SDK await so concurrent
 * replies for the same id cannot both submit; on failure the entry is
 * restored (unless re-registered meanwhile) so a transient failure is
 * retryable instead of stalling on unknown-id. The terminal
 * `user-input.resolved` event arrives via the provider SSE echo
 * (`form.replied` / `form.cancelled`); this path only records the id.
 */
export const respondToOpenCode2UserInput = Effect.fn("respondToOpenCode2UserInput")(function* (
  store: OpenCode2SessionStore,
  events: Queue.Enqueue<ProviderRuntimeEvent>,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  _eventDeps: OpenCode2ApprovalEventDeps,
): Effect.fn.Return<void, OpenCode2AdapterError> {
  const context = yield* ensureOpenCode2Context(store, threadId);
  const key = String(requestId);
  const request = context.pendingQuestions.get(key);
  if (request === undefined) {
    if (context.emittedTerminalRequestIds.has(key)) {
      return;
    }
    return yield* openCode2RequestError(
      "question.reply",
      `Unknown pending user-input request: ${key}`,
    );
  }
  claimPendingForReply(context, key);
  const outcome =
    context.client.sessionForm !== undefined
      ? yield* runOpenCode2SdkWithTimeout("session.form.reply", (signal) =>
          context.client.sessionForm!.reply(
            {
              sessionID: request.sessionID,
              formID: key,
              answers: toOpenCode2FormAnswers(answers as Record<string, unknown>),
            },
            { signal },
          ),
        ).pipe(withReplyTimeout("session.form.reply"), Effect.exit)
      : yield* Effect.gen(function* () {
          const coerced = toOpenCode2QuestionAnswers(request, answers);
          yield* runOpenCode2SdkWithTimeout("question.reply", (signal) =>
            context.client.question.reply({ requestID: key, answers: coerced }, { signal }),
          ).pipe(withReplyTimeout("question.reply"), Effect.asVoid);
        }).pipe(Effect.exit);
  if (Exit.isFailure(outcome)) {
    restorePendingForRetry(context.pendingQuestions, key, request);
    return yield* Effect.failCause(outcome.cause);
  }
  // No synthetic terminal emit: the provider SSE echo (`form.replied` /
  // `form.cancelled`) is the sole `user-input.resolved` source. Recording
  // the id here lets a late echo settle pending state without re-emitting.
  context.emittedTerminalRequestIds.add(key);
});
