import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import type { PluginId } from "@t3tools/contracts/plugin";
import type {
  AgentsAwaitTurnResult,
  AgentsCapability,
  AgentsCreateThreadInput,
  AgentsPendingRequest,
  AgentsStartTurnBootstrapInput,
} from "@t3tools/plugin-sdk";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type * as ProjectionThreadMessages from "../../persistence/Services/ProjectionThreadMessages.ts";
import type * as ProjectionTurns from "../../persistence/Services/ProjectionTurns.ts";
import type { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";

const DEFAULT_AWAIT_TURN_TIMEOUT = Duration.minutes(30);

export class AgentsThreadOwnershipError extends Schema.TaggedErrorClass<AgentsThreadOwnershipError>()(
  "AgentsThreadOwnershipError",
  {
    pluginId: Schema.String,
    threadId: Schema.String,
    expectedOwner: Schema.String,
    actualOwner: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} cannot access thread ${this.threadId}; expected owner ${this.expectedOwner}, got ${this.actualOwner ?? "none"}.`;
  }
}

export class AgentsThreadNotFoundError extends Schema.TaggedErrorClass<AgentsThreadNotFoundError>()(
  "AgentsThreadNotFoundError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class AgentsTurnAwaitTimeoutError extends Schema.TaggedErrorClass<AgentsTurnAwaitTimeoutError>()(
  "AgentsTurnAwaitTimeoutError",
  {
    threadId: Schema.String,
    turnId: Schema.String,
  },
) {
  override get message(): string {
    return `Timed out waiting for turn ${this.turnId} on thread ${this.threadId}.`;
  }
}

const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());
const nextCommandId = (tag: string) => CommandId.make(`plugin:${tag}:${NodeCrypto.randomUUID()}`);
const nextThreadId = () => ThreadId.make(NodeCrypto.randomUUID());
const nextMessageId = () => MessageId.make(`plugin-message:${NodeCrypto.randomUUID()}`);
const nextTurnId = () => TurnId.make(`plugin-turn:${NodeCrypto.randomUUID()}`);

function isThreadDetailEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

function toTimeoutDuration(input: string | number | undefined): Duration.Duration {
  if (input === undefined) return DEFAULT_AWAIT_TURN_TIMEOUT;
  if (typeof input === "number") return Duration.millis(input);
  return Duration.fromInputUnsafe(input as Duration.Input);
}

type TerminalProjectionTurn = ProjectionTurns.ProjectionTurnById & {
  readonly state: AgentsAwaitTurnResult["state"];
};

function terminalState(
  state: ProjectionTurns.ProjectionTurnById["state"],
): state is AgentsAwaitTurnResult["state"] {
  return state === "completed" || state === "error" || state === "interrupted";
}

function isTerminalTurn(
  row: ProjectionTurns.ProjectionTurnById | null,
): row is TerminalProjectionTurn {
  return row !== null && terminalState(row.state);
}

function pendingRequestFromActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): AgentsPendingRequest | null {
  if (activity.kind !== "approval.requested" && activity.kind !== "user-input.requested") {
    return null;
  }
  if (
    typeof activity.payload !== "object" ||
    activity.payload === null ||
    !("requestId" in activity.payload) ||
    typeof (activity.payload as { requestId?: unknown }).requestId !== "string"
  ) {
    return null;
  }
  return {
    kind: activity.kind,
    requestId: (activity.payload as { requestId: string }).requestId,
    activity: activity as AgentsPendingRequest["activity"],
  };
}

function normalizeBootstrapForTurnStart(
  bootstrap: AgentsStartTurnBootstrapInput | undefined,
): AgentsStartTurnBootstrapInput | undefined {
  if (!bootstrap?.createThread) return bootstrap;
  return {
    ...bootstrap,
    createThread: {
      ...bootstrap.createThread,
      createdAt: bootstrap.createThread.createdAt ?? nowIso(),
      runtimeMode: bootstrap.createThread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: bootstrap.createThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: bootstrap.createThread.branch ?? null,
      worktreePath: bootstrap.createThread.worktreePath ?? null,
    } as AgentsStartTurnBootstrapInput["createThread"],
  };
}

export function makeAgentsCapability(input: {
  readonly pluginId: PluginId;
  readonly engine: OrchestrationEngineService["Service"];
  readonly snapshots: ProjectionSnapshotQuery["Service"];
  readonly turns: ProjectionTurns.ProjectionTurnRepository["Service"];
  readonly messages: ProjectionThreadMessages.ProjectionThreadMessageRepository["Service"];
  readonly providerInstances: ProviderInstanceRegistry["Service"];
}): AgentsCapability {
  const owner = `plugin:${input.pluginId}` as `plugin:${string}`;
  const turnAliases = new Map<
    string,
    { readonly threadId: ThreadId; readonly messageId: MessageId }
  >();

  const requireOwnedThread = (threadId: ThreadId) =>
    input.snapshots.getThreadOwnerById(threadId).pipe(
      Effect.flatMap((actualOwner) => {
        if (Option.isSome(actualOwner) && actualOwner.value === owner) {
          return Effect.void;
        }
        return Effect.fail(
          new AgentsThreadOwnershipError({
            pluginId: input.pluginId,
            threadId,
            expectedOwner: owner,
            actualOwner: Option.getOrNull(actualOwner),
          }),
        );
      }),
    );

  const readTerminalTurn = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const direct = yield* input.turns.getByTurnId({ threadId, turnId });
      if (Option.isSome(direct)) {
        return direct.value;
      }
      const alias = turnAliases.get(String(turnId));
      if (!alias || alias.threadId !== threadId) {
        return null;
      }
      const rows = yield* input.turns.listByThreadId({ threadId });
      return (
        rows.find(
          (row): row is ProjectionTurns.ProjectionTurnById =>
            row.turnId !== null && row.pendingMessageId === alias.messageId,
        ) ?? null
      );
    }).pipe(
      Effect.flatMap((row) => {
        if (!isTerminalTurn(row)) return Effect.succeed(null);
        // Prune the alias once the turn is terminal so the in-memory map does
        // not grow unbounded over a long-lived plugin.
        turnAliases.delete(String(turnId));
        return Effect.succeed(row);
      }),
    );

  const readAwaitResult = (row: TerminalProjectionTurn) =>
    Effect.gen(function* () {
      const assistantMessage =
        row.assistantMessageId === null
          ? Option.none<ProjectionThreadMessages.ProjectionThreadMessage>()
          : yield* input.messages.getByMessageId({ messageId: row.assistantMessageId });
      return {
        state: row.state,
        assistantText:
          Option.isSome(assistantMessage) && !assistantMessage.value.isStreaming
            ? assistantMessage.value.text
            : null,
      } satisfies AgentsAwaitTurnResult;
    });

  const awaitTerminalTurn = (threadId: ThreadId, turnId: TurnId) =>
    Effect.gen(function* () {
      const first = yield* readTerminalTurn(threadId, turnId);
      if (first) return first;

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const terminalDeferred = yield* Deferred.make<TerminalProjectionTurn>();
          const waitForEvent = input.engine.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
            ),
            Stream.mapEffect(() =>
              readTerminalTurn(threadId, turnId).pipe(
                Effect.flatMap((row) =>
                  row ? Deferred.succeed(terminalDeferred, row).pipe(Effect.ignore) : Effect.void,
                ),
              ),
            ),
            Stream.runDrain,
          );
          yield* waitForEvent.pipe(Effect.forkScoped);
          const afterSubscribe = yield* readTerminalTurn(threadId, turnId);
          if (afterSubscribe) return afterSubscribe;
          return yield* Deferred.await(terminalDeferred);
        }),
      );
    });

  return {
    listInstances: () =>
      Effect.gen(function* () {
        const [instances, unavailable] = yield* Effect.all([
          input.providerInstances.listInstances,
          input.providerInstances.listUnavailable,
        ]);
        const available = yield* Effect.forEach(
          instances,
          (instance) => instance.snapshot.getSnapshot,
        );
        return { available, unavailable };
      }),

    createThread: (request: AgentsCreateThreadInput) =>
      Effect.gen(function* () {
        const threadId = nextThreadId();
        const createdAt = nowIso();
        yield* input.engine.dispatch({
          type: "thread.create",
          commandId: nextCommandId("thread-create"),
          threadId,
          projectId: request.projectId,
          title: request.title,
          owner,
          modelSelection: request.modelSelection,
          runtimeMode: request.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: request.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: request.branch ?? null,
          worktreePath: request.worktreePath ?? null,
          createdAt,
        });
        return { threadId };
      }),

    startTurn: (request) =>
      Effect.gen(function* () {
        const bootstrap = normalizeBootstrapForTurnStart(request.bootstrap);
        const actualOwner = yield* input.snapshots.getThreadOwnerById(request.threadId);
        if (Option.isSome(actualOwner) && actualOwner.value !== owner) {
          return yield* new AgentsThreadOwnershipError({
            pluginId: input.pluginId,
            threadId: request.threadId,
            expectedOwner: owner,
            actualOwner: actualOwner.value,
          });
        }
        // When the thread does not yet exist we create it explicitly here
        // rather than via the turn-start bootstrap: the decider's
        // thread.turn.start ignores bootstrap.createThread (that atomic path
        // lives only in the WS entrypoint), so the create must be its own
        // dispatch. If turn-start then fails, best-effort delete the thread we
        // just created so we don't orphan a plugin-owned thread.
        const createdThread = Option.isNone(actualOwner);
        if (createdThread) {
          if (!bootstrap?.createThread) {
            return yield* new AgentsThreadOwnershipError({
              pluginId: input.pluginId,
              threadId: request.threadId,
              expectedOwner: owner,
              actualOwner: null,
            });
          }
          yield* input.engine.dispatch({
            type: "thread.create",
            commandId: nextCommandId("bootstrap-thread-create"),
            threadId: request.threadId,
            projectId: bootstrap.createThread.projectId,
            title: bootstrap.createThread.title,
            owner,
            modelSelection: bootstrap.createThread.modelSelection,
            runtimeMode: bootstrap.createThread.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              bootstrap.createThread.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: bootstrap.createThread.branch ?? null,
            worktreePath: bootstrap.createThread.worktreePath ?? null,
            createdAt: bootstrap.createThread.createdAt ?? nowIso(),
          });
        }
        const messageId = request.messageId ?? nextMessageId();
        const turnId = nextTurnId();
        turnAliases.set(String(turnId), { threadId: request.threadId, messageId });
        // Do NOT forward bootstrap.createThread into turn-start: the thread now
        // exists, and the decider would ignore it anyway.
        const turnBootstrap = createdThread ? undefined : bootstrap;
        yield* input.engine
          .dispatch({
            type: "thread.turn.start",
            commandId: request.commandId ?? nextCommandId("turn-start"),
            threadId: request.threadId,
            message: {
              messageId,
              role: "user",
              text: request.text,
              attachments: [...(request.attachments ?? [])],
            },
            ...(request.modelSelection !== undefined
              ? { modelSelection: request.modelSelection }
              : {}),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            ...(turnBootstrap !== undefined ? { bootstrap: turnBootstrap as any } : {}),
            createdAt: nowIso(),
          })
          .pipe(
            Effect.tapError(() =>
              createdThread
                ? input.engine
                    .dispatch({
                      type: "thread.delete",
                      commandId: nextCommandId("thread-create-rollback"),
                      threadId: request.threadId,
                    })
                    .pipe(
                      Effect.ignore,
                      Effect.andThen(Effect.sync(() => turnAliases.delete(String(turnId)))),
                    )
                : Effect.void,
            ),
          );
        return { turnId, messageId };
      }),

    observeThread: (threadId) =>
      Stream.fromEffect(
        Effect.gen(function* () {
          yield* requireOwnedThread(threadId);
          const [threadDetail, snapshotSequence] = yield* Effect.all([
            input.snapshots.getThreadDetailById(threadId),
            input.snapshots
              .getSnapshotSequence()
              .pipe(Effect.map((snapshot) => snapshot.snapshotSequence)),
          ]);
          if (Option.isNone(threadDetail)) {
            return yield* new AgentsThreadNotFoundError({ threadId });
          }
          return {
            snapshotSequence,
            thread: threadDetail.value,
          };
        }),
      ).pipe(
        Stream.map((snapshot) => ({ kind: "snapshot" as const, snapshot })),
        Stream.concat(
          input.engine.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === threadId &&
                isThreadDetailEvent(event),
            ),
            Stream.map((event) => ({ kind: "event" as const, event })),
          ),
        ),
      ),

    awaitTurn: (request) =>
      Effect.gen(function* () {
        yield* requireOwnedThread(request.threadId);
        const timeout = toTimeoutDuration(request.timeout);
        const terminal = yield* awaitTerminalTurn(request.threadId, request.turnId).pipe(
          Effect.timeoutOption(timeout),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new AgentsTurnAwaitTimeoutError({
                    threadId: request.threadId,
                    turnId: request.turnId,
                  }),
                ),
              onSome: (row) => Effect.succeed(row),
            }),
          ),
        );
        return yield* readAwaitResult(terminal);
      }),

    listPendingRequests: (threadId) =>
      Effect.gen(function* () {
        yield* requireOwnedThread(threadId);
        const thread = yield* input.snapshots.getThreadDetailById(threadId);
        if (Option.isNone(thread)) {
          return yield* new AgentsThreadNotFoundError({ threadId });
        }
        return thread.value.activities.flatMap((activity) => {
          const pending = pendingRequestFromActivity(activity);
          return pending ? [pending] : [];
        });
      }),

    respondToApproval: (request) =>
      requireOwnedThread(request.threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.approval.respond",
            commandId: nextCommandId("approval-respond"),
            threadId: request.threadId,
            requestId: request.requestId as any,
            decision: request.decision,
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    respondToUserInput: (request) =>
      requireOwnedThread(request.threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.user-input.respond",
            commandId: nextCommandId("user-input-respond"),
            threadId: request.threadId,
            requestId: request.requestId as any,
            answers: request.answers,
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    interruptTurn: (request) =>
      requireOwnedThread(request.threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.turn.interrupt",
            commandId: nextCommandId("turn-interrupt"),
            threadId: request.threadId,
            ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    stopSession: ({ threadId }) =>
      requireOwnedThread(threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.session.stop",
            commandId: nextCommandId("session-stop"),
            threadId,
            createdAt: nowIso(),
          }),
        ),
        Effect.asVoid,
      ),

    deleteThread: ({ threadId }) =>
      requireOwnedThread(threadId).pipe(
        Effect.flatMap(() =>
          input.engine.dispatch({
            type: "thread.delete",
            commandId: nextCommandId("thread-delete"),
            threadId,
          }),
        ),
        Effect.asVoid,
      ),
  };
}
