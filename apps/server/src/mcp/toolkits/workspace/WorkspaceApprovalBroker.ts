/**
 * WorkspaceApprovalBroker — routes workspace-bridge mutations through the
 * product's normal approval flow.
 *
 * The problem it solves is a layering gap: mutations originate in the MCP
 * toolkit (an HTTP request from OpenAI), but approvals live in the provider
 * pipeline — a `request.opened` runtime event flows through ingestion to the
 * approval card in the timeline, and the user's decision comes back through
 * `thread.approval.respond` → `ProviderService.respondToRequest` → the
 * adapter that owns the thread. The toolkit and the adapter are built in
 * different layer graphs and cannot see each other's services.
 *
 * The broker bridges them with module-level state, following the precedent of
 * `McpProviderSession.ts` in this same subsystem:
 *
 *   - The ChatGPT browser adapter registers a per-thread channel at session
 *     start (it owns the runtime-event PubSub, so only it can emit
 *     `request.opened` / `request.resolved` with the right identity fields).
 *   - The workspace coordinator asks the broker for a decision; the broker
 *     emits through the registered channel and parks a Deferred.
 *   - The adapter's `respondToRequest` resolves the Deferred.
 *
 * Nothing here decides *whether* an operation needs approval — that is the
 * coordinator's runtime-mode policy. The broker only carries the question and
 * the answer.
 *
 * `acceptForSession` is honoured per thread and per request type: once the
 * user picks it for, say, a command approval, later commands in that thread
 * skip the card until the session ends. The memory dies with the channel
 * registration, so a new session always starts asking again.
 *
 * @module mcp/toolkits/workspace/WorkspaceApprovalBroker
 */
import * as NodeCrypto from "node:crypto";

import type { CanonicalRequestType, ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export interface WorkspaceApprovalChannel {
  /** Emit `request.opened` into the thread's runtime event stream. */
  readonly emitOpened: (input: {
    readonly requestId: string;
    readonly requestType: CanonicalRequestType;
    readonly detail: string;
  }) => Effect.Effect<void>;
  /** Emit `request.resolved` after a decision (or a forced cancellation). */
  readonly emitResolved: (input: {
    readonly requestId: string;
    readonly requestType: CanonicalRequestType;
    readonly decision: ProviderApprovalDecision;
  }) => Effect.Effect<void>;
}

interface PendingApproval {
  readonly threadId: ThreadId;
  readonly requestType: CanonicalRequestType;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

const channels = new Map<ThreadId, WorkspaceApprovalChannel>();
const pendingByRequestId = new Map<string, PendingApproval>();
const sessionAccepts = new Map<ThreadId, Set<CanonicalRequestType>>();

/** Called by the adapter when a ChatGPT session starts. */
export function registerWorkspaceApprovalChannel(
  threadId: ThreadId,
  channel: WorkspaceApprovalChannel,
): void {
  channels.set(threadId, channel);
}

/**
 * Called by the adapter when the session stops. Cancels every in-flight
 * approval for the thread first, so a coordinator fiber parked on a Deferred
 * is released as "cancel" rather than waiting forever on a session that will
 * never answer.
 */
export const unregisterWorkspaceApprovalChannel = (threadId: ThreadId): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const [requestId, pending] of pendingByRequestId) {
      if (pending.threadId !== threadId) continue;
      pendingByRequestId.delete(requestId);
      yield* Deferred.succeed(pending.decision, "cancel" as ProviderApprovalDecision);
    }
    channels.delete(threadId);
    sessionAccepts.delete(threadId);
  });

export interface WorkspaceApprovalTicket {
  readonly requestId: string;
  /**
   * Resolves when the user decides (or the session dies). Deliberately
   * unbounded — the *caller* decides how long to block an MCP response and
   * parks the rest behind `workspace_wait`.
   */
  readonly decision: Effect.Effect<ProviderApprovalDecision>;
}

/**
 * Opens an approval request in the thread's timeline, or answers immediately
 * from session-scoped memory when the user previously chose "accept for
 * session" for this request type.
 *
 * Returns `undefined` when the thread has no registered channel — the ChatGPT
 * session is not running, so there is no timeline to ask in. Callers surface
 * that as `approval-unavailable` rather than silently proceeding.
 */
export const openWorkspaceApproval = (input: {
  readonly threadId: ThreadId;
  readonly requestType: CanonicalRequestType;
  readonly detail: string;
}): Effect.Effect<WorkspaceApprovalTicket | "auto-accepted" | undefined> =>
  Effect.gen(function* () {
    const channel = channels.get(input.threadId);
    if (!channel) return undefined;

    if (sessionAccepts.get(input.threadId)?.has(input.requestType)) {
      return "auto-accepted" as const;
    }

    const requestId = `chatgpt-workspace:${NodeCrypto.randomUUID()}`;
    const decision = yield* Deferred.make<ProviderApprovalDecision>();
    pendingByRequestId.set(requestId, {
      threadId: input.threadId,
      requestType: input.requestType,
      decision,
    });
    yield* channel.emitOpened({
      requestId,
      requestType: input.requestType,
      detail: input.detail,
    });
    return { requestId, decision: Deferred.await(decision) };
  });

/**
 * Called by the adapter's `respondToRequest`. Returns false when the request
 * id is unknown (already resolved, or belongs to a different mechanism), so
 * the adapter can fall through to its own error path.
 */
export const resolveWorkspaceApproval = (
  threadId: ThreadId,
  requestId: string,
  decision: ProviderApprovalDecision,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const pending = pendingByRequestId.get(requestId);
    if (!pending || pending.threadId !== threadId) return false;
    pendingByRequestId.delete(requestId);

    if (decision === "acceptForSession") {
      const accepted = sessionAccepts.get(threadId) ?? new Set<CanonicalRequestType>();
      accepted.add(pending.requestType);
      sessionAccepts.set(threadId, accepted);
    }

    const channel = channels.get(threadId);
    if (channel) {
      yield* channel.emitResolved({
        requestId,
        requestType: pending.requestType,
        decision,
      });
    }
    yield* Deferred.succeed(pending.decision, decision);
    return true;
  });

/** True when the thread currently has a registered approval channel. */
export function hasWorkspaceApprovalChannel(threadId: ThreadId): boolean {
  return channels.has(threadId);
}

/** Exposed for tests: wipe all module-level state between cases. */
export const __testing = {
  reset(): void {
    channels.clear();
    pendingByRequestId.clear();
    sessionAccepts.clear();
  },
  pendingCount(): number {
    return pendingByRequestId.size;
  },
};
