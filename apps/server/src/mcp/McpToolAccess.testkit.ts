import {
  NodeId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProviderApprovalPushHooks,
  type ProviderApprovalToolAction,
  type ProviderInteractionMode,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { McpSchema } from "effect/ai";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpClientInput from "./McpClientInput.ts";

const EPOCH = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

export const liveThreadShell = (
  id: ThreadId,
  modes: {
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly activeRunId?: RunId | null;
  } = {},
): OrchestrationV2ThreadShell => {
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    id,
    projectId: ProjectId.make("project:mcp-test"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: modes.runtimeMode ?? "full-access",
    interactionMode: modes.interactionMode ?? "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: modes.activeRunId === undefined ? RunId.make("run:mcp-test") : modes.activeRunId,
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

export const liveThreadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
});

export const idleThreadProjection = (
  shell: OrchestrationV2ThreadShell,
): OrchestrationV2ThreadProjection => {
  const {
    status: _status,
    activeRunId: _activeRunId,
    latestRunId: _latestRunId,
    pendingRuntimeRequest: _pendingRuntimeRequest,
    latestVisibleMessage: _latestVisibleMessage,
    latestUserMessageAt: _latestUserMessageAt,
    hasActionableProposedPlan: _hasActionableProposedPlan,
    itemCount: _itemCount,
    visibleItemCount: _visibleItemCount,
    lastVisitedAt,
    ...thread
  } = shell;
  return {
    thread: { ...thread, lastVisitedAt: lastVisitedAt ?? null },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: shell.updatedAt,
  };
};

/** A request one of T3 Code's tools raised in a thread, as the person is shown it. */
export interface AskedInThread {
  readonly id: string;
  readonly message: string;
  readonly toolAction: ProviderApprovalToolAction;
  readonly pushHooks?: ProviderApprovalPushHooks | undefined;
}

/**
 * A thread in the middle of a turn whose client holds an elicitation open, with a person to
 * answer what its tools ask: the requests a tool raises arrive in `asked`, and `answer` is the
 * button they press. Only what `McpThreadApproval` reads of the thread is here.
 */
export const makeAskedThread = Effect.fn("McpToolAccess.testkit.makeAskedThread")(function* (
  options: {
    readonly providerInstanceId?: ProviderInstanceId;
    /** Whether the thread's adapter holds T3 Code's requests open. */
    readonly held?: boolean;
    /** Whether the client says it takes elicitations. */
    readonly elicitation?: boolean;
    /** A client with no session: it is asked by a call's answer, and calls again with its reply. */
    readonly sessionless?: boolean;
  } = {},
) {
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const providerInstanceId = options.providerInstanceId ?? ProviderInstanceId.make("codex");
  if (options.held !== false) yield* sessions.holdsApprovalRequests(providerInstanceId);
  const runId = RunId.make("run:mcp-test");
  const state = yield* Ref.make({
    runStatus: "running" as "running" | "completed" | "interrupted",
    requests: [] as ReadonlyArray<
      AskedInThread & { readonly status: string; readonly decision?: string | undefined }
    >,
  });
  const changed = yield* SubscriptionRef.make(0);
  const bump = SubscriptionRef.update(changed, (count) => count + 1);
  const asked = yield* Queue.unbounded<AskedInThread>();
  const elicited = yield* Ref.make<
    ReadonlyArray<{ readonly message: string; readonly meta: unknown }>
  >([]);
  const sent = yield* Ref.make<McpSchema.InputRequired | undefined>(undefined);
  const reply = yield* Ref.make<string | undefined>(undefined);
  /** Ends every elicitation the client holds, as a client that stops waiting does. */
  const released = yield* SubscriptionRef.make(false);

  const threads: Partial<ThreadManagement.ThreadManagementService["Service"]> = {
    getThreadRecords: ((_threadId: ThreadId) =>
      Ref.get(state).pipe(
        Effect.map(({ runStatus, requests }) => ({
          runs: [
            {
              id: runId,
              ordinal: 1,
              status: runStatus,
              rootNodeId: NodeId.make("node:mcp-test:root"),
              providerInstanceId,
            },
          ],
          runtimeRequests: requests.map((request) => ({
            id: `runtime-request:t3-tool:${request.id}`,
            status: request.status,
            decision: request.decision,
          })),
        })),
      )) as never,
    dispatch: ((command: {
      readonly type: string;
      readonly requestId: string;
      readonly prompt: string;
      readonly toolAction: ProviderApprovalToolAction;
      readonly pushHooks?: ProviderApprovalPushHooks;
      readonly decision?: string;
    }) =>
      Effect.gen(function* () {
        const id = command.requestId.replace("runtime-request:t3-tool:", "");
        if (command.type === "approval_request.record") {
          const request = {
            id,
            message: command.prompt,
            toolAction: command.toolAction,
            ...(command.pushHooks === undefined ? {} : { pushHooks: command.pushHooks }),
          };
          yield* Ref.update(state, (current) => ({
            ...current,
            requests: [...current.requests, { ...request, status: "pending" }],
          }));
          yield* Queue.offer(asked, request);
        } else if (command.type === "runtime-request.respond") {
          yield* Ref.update(state, (current) => ({
            ...current,
            requests: current.requests.map((request) =>
              request.id === id && request.status === "pending"
                ? {
                    ...request,
                    status: command.decision === "cancel" ? "cancelled" : "resolved",
                    decision: command.decision,
                  }
                : request,
            ),
          }));
        }
        yield* bump;
      })) as never,
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
    getThreadEventSequence: () => Effect.succeed(0),
    // The current count replays to each subscriber, so no change is missed.
    streamStoredEventsFrom: (() =>
      SubscriptionRef.changes(changed).pipe(Stream.map(() => ({})))) as never,
  };

  const client = McpSchema.McpServerClient.of({
    clientId: 1,
    protocolVersion: "2025-06-18",
    clientCapabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
    initializePayload: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-test", version: "1" },
    },
    getClient: Effect.succeed({
      listRoots: () => Effect.die("unused"),
      createMessage: () => Effect.die("unused"),
      elicit: (request) =>
        Ref.update(elicited, (current) => [
          ...current,
          { message: request.message, meta: request._meta },
        ]).pipe(
          Effect.andThen(
            SubscriptionRef.changes(released).pipe(
              Stream.filter((isReleased) => isReleased),
              Stream.runHead,
            ),
          ),
          Effect.as({ action: "cancel" as const }),
        ),
    } as McpSchema.McpReverseClient),
  });

  return {
    sessions,
    runId,
    threads,
    /** The next request a tool raises; waits for one. */
    asked: Queue.take(asked),
    /** Requests raised so far that nobody has answered. */
    pending: Ref.get(state).pipe(
      Effect.map(({ requests }) => requests.filter((request) => request.status === "pending")),
    ),
    raised: Ref.get(state).pipe(Effect.map(({ requests }) => requests)),
    elicited: Ref.get(elicited),
    answer: (request: AskedInThread, decision: "accept" | "decline" | "cancel") =>
      Effect.gen(function* () {
        yield* Ref.update(state, (current) => ({
          ...current,
          requests: current.requests.map((candidate) =>
            candidate.id === request.id && candidate.status === "pending"
              ? {
                  ...candidate,
                  status: decision === "cancel" ? "cancelled" : "resolved",
                  decision,
                }
              : candidate,
          ),
        }));
        yield* bump;
      }),
    endTurn: (status: "completed" | "interrupted" = "completed") =>
      Ref.update(state, (current) => ({ ...current, runStatus: status })).pipe(
        Effect.andThen(bump),
      ),
    /** What a sessionless client's last call was answered with, when that was a request. */
    answeredWith: Ref.get(sent),
    /** A sessionless client's next call brings its reply to the elicitation with this state. */
    repliesTo: (state: string | undefined) => Ref.set(reply, state),
    /** The client stops waiting on what it was sent, as on an interrupt. */
    clientStopsWaiting: SubscriptionRef.set(released, true),
    /** The services one tool call from this thread's client runs with. */
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(reply);
        yield* Ref.set(sent, undefined);
        const called = effect.pipe(
          Effect.provideService(McpClientInput.McpClientInput, {
            sessions,
            ...(options.sessionless === true ? { request: sent } : {}),
          }),
          Effect.provideService(
            McpSchema.McpRequestContext,
            McpSchema.McpRequestContext.of({
              clientId: 1,
              protocolVersion: options.sessionless === true ? "2026-07-28" : "2025-06-18",
              clientCapabilities: new McpSchema.ClientCapabilities(
                options.elicitation === false ? {} : { elicitation: {} },
              ),
              ...(state === undefined
                ? {}
                : { inputResponses: { approval: { action: "accept" } }, requestState: state }),
            }),
          ),
        );
        return yield* options.sessionless === true
          ? called
          : called.pipe(Effect.provideService(McpSchema.McpServerClient, client));
      }),
  };
});
