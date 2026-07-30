// @effect-diagnostics nodeBuiltinImport:off
import { statSync } from "node:fs";
import { basename } from "node:path";

import Mime from "@effect/platform-node/Mime";
import {
  ChatAttachment,
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationEvent,
  type ThreadExtensionEnqueueTurnInput,
  ThreadExtensionError,
  type ThreadExtensionQueuePauseReason,
  type ThreadExtensionQueuedTurn,
  type ThreadExtensionState,
  type ThreadForkResult,
  ThreadId,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

type NormalizedTurnStart = typeof ThreadTurnStartCommand.Type;

interface QueueRow {
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly attachmentIdsJson: string;
  readonly modelSelectionJson: string;
  readonly runtimeMode: ThreadExtensionQueuedTurn["runtimeMode"];
  readonly interactionMode: ThreadExtensionQueuedTurn["interactionMode"];
  readonly titleSeed: string | null;
  readonly sourceProposedPlanThreadId: string | null;
  readonly sourceProposedPlanId: string | null;
  readonly queuedAt: string;
  readonly enqueueSequence: number;
  readonly askOverride: number;
}

interface StateRow {
  readonly threadId: string;
  readonly askOverride: string | null;
  readonly queueStatus: ThreadExtensionState["queue"]["status"];
  readonly queuePauseReason: ThreadExtensionQueuePauseReason;
  readonly updatedAt: string;
}

function extensionError(threadId: ThreadId | undefined, message: string, cause?: unknown) {
  return new ThreadExtensionError({
    ...(threadId === undefined ? {} : { threadId }),
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function decodeJson<A>(decode: (value: unknown) => A, value: string, label: string): A {
  try {
    return decode(value);
  } catch (cause) {
    throw extensionError(undefined, `Stored ${label} is invalid.`, cause);
  }
}

const AttachmentIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const ModelSelectionJson = Schema.fromJsonString(ModelSelection);
const decodeAttachmentIdsJson = Schema.decodeUnknownSync(AttachmentIdsJson);
const decodeModelSelectionJson = Schema.decodeUnknownSync(ModelSelectionJson);

function isThreadEvent(event: OrchestrationEvent): boolean {
  return event.aggregateKind === "thread";
}

export function classifyThreadQueuePromotion(thread: {
  readonly latestTurn: { readonly turnId: string; readonly state: string } | null;
  readonly session: { readonly status: string; readonly activeTurnId: string | null } | null;
  readonly checkpoints: ReadonlyArray<{ readonly turnId: string }>;
}): "yes" | "wait" | "interrupted" | "provider-error" {
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  if (thread.latestTurn?.state === "error") return "provider-error";
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return "wait";
  }
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "wait";
  }
  if (
    thread.latestTurn?.state === "completed" &&
    !thread.checkpoints.some((checkpoint) => checkpoint.turnId === thread.latestTurn?.turnId)
  ) {
    return "wait";
  }
  return "yes";
}

export interface ThreadExtensionServiceShape {
  readonly getState: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExtensionState, ThreadExtensionError>;
  readonly subscribe: (
    threadId: ThreadId,
  ) => Stream.Stream<ThreadExtensionState, ThreadExtensionError>;
  readonly setInteractionMode: (
    threadId: ThreadId,
    mode: "default" | "ask" | "plan",
  ) => Effect.Effect<ThreadExtensionState, ThreadExtensionError>;
  readonly clearAskOverride: (threadId: ThreadId) => Effect.Effect<void, ThreadExtensionError>;
  readonly enqueueNormalizedTurn: (
    input: ThreadExtensionEnqueueTurnInput,
    command: NormalizedTurnStart,
  ) => Effect.Effect<ThreadExtensionState, ThreadExtensionError>;
  readonly removeQueuedTurn: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<ThreadExtensionState, ThreadExtensionError>;
  readonly resumeQueue: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadExtensionState, ThreadExtensionError>;
  readonly forkThread: (
    sourceThreadId: ThreadId,
  ) => Effect.Effect<ThreadForkResult, ThreadExtensionError>;
  readonly drain: Effect.Effect<void>;
}

export class ThreadExtensionService extends Context.Service<
  ThreadExtensionService,
  ThreadExtensionServiceShape
>()("t3/threadExtensions/ThreadExtensionService") {}

export const make: Effect.Effect<
  ThreadExtensionServiceShape,
  never,
  | SqlClient.SqlClient
  | Crypto.Crypto
  | ServerConfig
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | Scope.Scope
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const changes = yield* PubSub.unbounded<ThreadExtensionState>();

  const readStateRow = Effect.fn("ThreadExtensionService.readStateRow")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<StateRow>`
      SELECT
        thread_id AS "threadId",
        ask_override AS "askOverride",
        queue_status AS "queueStatus",
        queue_pause_reason AS "queuePauseReason",
        updated_at AS "updatedAt"
      FROM thread_extension_state
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(threadId, "Failed to read thread extension state.", cause),
      ),
    );
    return rows[0] ?? null;
  });

  const readQueueRows = Effect.fn("ThreadExtensionService.readQueueRows")(function* (
    threadId: ThreadId,
  ) {
    return yield* sql<QueueRow>`
      SELECT
        thread_id AS "threadId",
        message_id AS "messageId",
        text,
        attachment_ids_json AS "attachmentIdsJson",
        model_selection_json AS "modelSelectionJson",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        title_seed AS "titleSeed",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        queued_at AS "queuedAt",
        enqueue_sequence AS "enqueueSequence",
        ask_override AS "askOverride"
      FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId}
      ORDER BY enqueue_sequence ASC, queued_at ASC, message_id ASC
    `.pipe(
      Effect.mapError((cause) => extensionError(threadId, "Failed to read queued turns.", cause)),
    );
  });

  const resolveAttachments = Effect.fn("ThreadExtensionService.resolveAttachments")(function* (
    threadId: ThreadId,
    attachmentIds: ReadonlyArray<string>,
  ) {
    return yield* Effect.forEach(
      attachmentIds,
      (attachmentId) =>
        Effect.try({
          try: () => {
            const filePath = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            if (!filePath) throw new Error(`Attachment '${attachmentId}' is unavailable.`);
            const mimeType = Mime.getType(filePath) ?? "application/octet-stream";
            if (!mimeType.startsWith("image/")) {
              throw new Error(`Attachment '${attachmentId}' is not a supported image.`);
            }
            return {
              type: "image" as const,
              id: attachmentId,
              name: basename(filePath),
              mimeType,
              sizeBytes: statSync(filePath).size,
            } satisfies ChatAttachment;
          },
          catch: (cause) =>
            extensionError(
              threadId,
              `Failed to resolve queued attachment '${attachmentId}'.`,
              cause,
            ),
        }),
      { concurrency: 1 },
    );
  });

  const rowToTurn = Effect.fn("ThreadExtensionService.rowToTurn")(function* (
    row: QueueRow,
  ): Effect.fn.Return<ThreadExtensionQueuedTurn, ThreadExtensionError> {
    const threadId = ThreadId.make(row.threadId);
    const attachmentIds = decodeJson(
      decodeAttachmentIdsJson,
      row.attachmentIdsJson,
      "attachment ids",
    );
    const attachments = yield* resolveAttachments(threadId, attachmentIds);
    const modelSelection = decodeJson(
      decodeModelSelectionJson,
      row.modelSelectionJson,
      "model selection",
    );
    return {
      threadId,
      messageId: MessageId.make(row.messageId),
      text: row.text,
      attachments,
      modelSelection,
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
      askOverride: row.askOverride === 1,
      ...(row.titleSeed === null ? {} : { titleSeed: row.titleSeed }),
      ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
        ? {
            sourceProposedPlan: {
              threadId: ThreadId.make(row.sourceProposedPlanThreadId),
              planId: row.sourceProposedPlanId,
            },
          }
        : {}),
      queuedAt: row.queuedAt,
    };
  });

  const getState: ThreadExtensionServiceShape["getState"] = Effect.fn(
    "ThreadExtensionService.getState",
  )(function* (threadId) {
    const [stateRow, queueRows] = yield* Effect.all([
      readStateRow(threadId),
      readQueueRows(threadId),
    ]);
    const items = yield* Effect.forEach(queueRows, rowToTurn, { concurrency: 1 });
    const updatedAt = stateRow?.updatedAt ?? DateTime.formatIso(yield* DateTime.now);
    return {
      threadId,
      interactionModeOverride: stateRow?.askOverride === "ask" ? "ask" : null,
      queue: {
        items,
        status: items.length === 0 ? "idle" : (stateRow?.queueStatus ?? "queued"),
        pauseReason: items.length === 0 ? null : (stateRow?.queuePauseReason ?? null),
      },
      updatedAt,
    };
  });

  const publishState = Effect.fn("ThreadExtensionService.publishState")(function* (
    threadId: ThreadId,
  ) {
    const state = yield* getState(threadId);
    yield* PubSub.publish(changes, state);
    return state;
  });

  const ensureState = Effect.fn("ThreadExtensionService.ensureState")(function* (
    threadId: ThreadId,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO thread_extension_state (
        thread_id, ask_override, queue_status, queue_pause_reason, updated_at
      )
      VALUES (${threadId}, NULL, 'idle', NULL, ${now})
      ON CONFLICT(thread_id) DO NOTHING
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(threadId, "Failed to initialize thread extension state.", cause),
      ),
    );
  });

  const setQueueState = Effect.fn("ThreadExtensionService.setQueueState")(function* (
    threadId: ThreadId,
    status: ThreadExtensionState["queue"]["status"],
    pauseReason: ThreadExtensionQueuePauseReason,
  ) {
    yield* ensureState(threadId);
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE thread_extension_state
      SET queue_status = ${status},
          queue_pause_reason = ${pauseReason},
          updated_at = ${now}
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(threadId, "Failed to update thread queue state.", cause),
      ),
    );
  });

  const setInteractionMode: ThreadExtensionServiceShape["setInteractionMode"] = Effect.fn(
    "ThreadExtensionService.setInteractionMode",
  )(function* (threadId, mode) {
    yield* ensureState(threadId);
    const now = DateTime.formatIso(yield* DateTime.now);
    const askOverride = mode === "ask" ? "ask" : null;
    yield* sql`
      UPDATE thread_extension_state
      SET ask_override = ${askOverride}, updated_at = ${now}
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(threadId, "Failed to update the thread interaction mode.", cause),
      ),
    );
    return yield* publishState(threadId);
  });

  const clearAskOverride: ThreadExtensionServiceShape["clearAskOverride"] = Effect.fn(
    "ThreadExtensionService.clearAskOverride",
  )(function* (threadId) {
    const state = yield* readStateRow(threadId);
    if (state?.askOverride !== "ask") return;
    yield* setInteractionMode(threadId, "default");
  });

  const worker = yield* makeDrainableWorker(
    Effect.fn("ThreadExtensionService.promote")(function* (threadId: ThreadId) {
      const state = yield* getState(threadId);
      if (state.queue.status !== "queued" || state.queue.items.length === 0) return;
      const snapshot = yield* snapshots
        .getThreadDetailById(threadId)
        .pipe(
          Effect.mapError((cause) =>
            extensionError(threadId, "Failed to inspect the thread before queue promotion.", cause),
          ),
        );
      if (Option.isNone(snapshot)) return;
      const eligibility = classifyThreadQueuePromotion(snapshot.value);
      if (eligibility === "wait") return;
      if (eligibility === "interrupted" || eligibility === "provider-error") {
        yield* setQueueState(threadId, "paused", eligibility);
        yield* publishState(threadId);
        return;
      }

      const head = state.queue.items[0]!;
      const command: NormalizedTurnStart = {
        type: "thread.turn.start",
        commandId: CommandId.make(`server:queue-promote:${yield* crypto.randomUUIDv4}`),
        threadId,
        message: {
          messageId: head.messageId,
          role: "user",
          text: head.text,
          attachments: head.attachments,
        },
        ...(head.modelSelection === undefined ? {} : { modelSelection: head.modelSelection }),
        ...(head.titleSeed === undefined ? {} : { titleSeed: head.titleSeed }),
        runtimeMode: head.runtimeMode,
        interactionMode: head.interactionMode,
        ...(head.askOverride ? { askOverride: true } : {}),
        ...(head.sourceProposedPlan === undefined
          ? {}
          : { sourceProposedPlan: head.sourceProposedPlan }),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      const dispatched = yield* engine.dispatch(command).pipe(Effect.exit);
      if (dispatched._tag === "Failure") {
        yield* setQueueState(threadId, "paused", "start-failed");
        yield* publishState(threadId);
        return;
      }
      yield* sql`
        DELETE FROM projection_thread_turn_queue
        WHERE thread_id = ${threadId} AND message_id = ${head.messageId}
      `.pipe(
        Effect.mapError((cause) =>
          extensionError(threadId, "The promoted turn could not be removed from the queue.", cause),
        ),
      );
      const remaining = yield* readQueueRows(threadId);
      yield* setQueueState(threadId, remaining.length === 0 ? "idle" : "queued", null);
      yield* setInteractionMode(threadId, head.askOverride ? "ask" : head.interactionMode);
      yield* publishState(threadId);
    }),
  );

  const enqueueNormalizedTurn: ThreadExtensionServiceShape["enqueueNormalizedTurn"] = Effect.fn(
    "ThreadExtensionService.enqueueNormalizedTurn",
  )(function* (input, command) {
    yield* ensureState(input.threadId);
    const sequenceRows = yield* sql<{ readonly nextSequence: number }>`
      SELECT COALESCE(MAX(enqueue_sequence), 0) + 1 AS "nextSequence"
      FROM projection_thread_turn_queue
      WHERE thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(input.threadId, "Failed to allocate queue position.", cause),
      ),
    );
    const nextSequence = sequenceRows[0]?.nextSequence ?? 1;
    const attachmentIds = command.message.attachments.map((attachment) => attachment.id);
    const modelSelection =
      command.modelSelection ??
      (yield* snapshots.getThreadDetailById(input.threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (thread) => thread.modelSelection,
          }),
        ),
        Effect.mapError((cause) =>
          extensionError(input.threadId, "Failed to resolve queued model selection.", cause),
        ),
      ));
    if (modelSelection === null) {
      return yield* extensionError(input.threadId, "The queued thread no longer exists.");
    }
    const attachmentIdsJson = yield* Schema.encodeEffect(AttachmentIdsJson)(attachmentIds).pipe(
      Effect.mapError((cause) =>
        extensionError(input.threadId, "Failed to encode queued attachment ids.", cause),
      ),
    );
    const modelSelectionJson = yield* Schema.encodeEffect(ModelSelectionJson)(modelSelection).pipe(
      Effect.mapError((cause) =>
        extensionError(input.threadId, "Failed to encode queued model selection.", cause),
      ),
    );
    yield* sql`
      INSERT INTO projection_thread_turn_queue (
        thread_id,
        message_id,
        text,
        attachment_ids_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        title_seed,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        queued_at,
        enqueue_sequence,
        ask_override
      )
      VALUES (
        ${input.threadId},
        ${command.message.messageId},
        ${command.message.text},
        ${attachmentIdsJson},
        ${modelSelectionJson},
        ${command.runtimeMode},
        ${command.interactionMode},
        ${command.titleSeed ?? null},
        ${command.sourceProposedPlan?.threadId ?? null},
        ${command.sourceProposedPlan?.planId ?? null},
        ${command.createdAt},
        ${nextSequence},
        ${command.askOverride === true ? 1 : 0}
      )
      ON CONFLICT(thread_id, message_id) DO NOTHING
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(input.threadId, "Failed to persist the queued turn.", cause),
      ),
    );
    const current = yield* readStateRow(input.threadId);
    if (current?.queueStatus !== "paused") {
      yield* setQueueState(input.threadId, "queued", null);
    }
    const state = yield* publishState(input.threadId);
    if (state.queue.status === "queued") {
      yield* worker.enqueue(input.threadId);
    }
    return state;
  });

  const removeQueuedTurn: ThreadExtensionServiceShape["removeQueuedTurn"] = Effect.fn(
    "ThreadExtensionService.removeQueuedTurn",
  )(function* (threadId, messageId) {
    yield* sql`
      DELETE FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `.pipe(
      Effect.mapError((cause) =>
        extensionError(threadId, "Failed to remove the queued turn.", cause),
      ),
    );
    const remaining = yield* readQueueRows(threadId);
    if (remaining.length === 0) yield* setQueueState(threadId, "idle", null);
    return yield* publishState(threadId);
  });

  const resumeQueue: ThreadExtensionServiceShape["resumeQueue"] = Effect.fn(
    "ThreadExtensionService.resumeQueue",
  )(function* (threadId) {
    const rows = yield* readQueueRows(threadId);
    yield* setQueueState(threadId, rows.length === 0 ? "idle" : "queued", null);
    const state = yield* publishState(threadId);
    if (rows.length > 0) yield* worker.enqueue(threadId);
    return state;
  });

  const forkThread: ThreadExtensionServiceShape["forkThread"] = Effect.fn(
    "ThreadExtensionService.forkThread",
  )(function* (sourceThreadId) {
    const queue = yield* readQueueRows(sourceThreadId);
    if (queue.length > 0) {
      return yield* extensionError(sourceThreadId, "A thread with queued turns cannot be forked.");
    }
    const targetThreadId = ThreadId.make(
      yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          extensionError(sourceThreadId, "Failed to allocate a forked thread id.", cause),
        ),
      ),
    );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.fork",
        commandId: CommandId.make(
          `server:thread-fork:${yield* crypto.randomUUIDv4.pipe(
            Effect.mapError((cause) =>
              extensionError(sourceThreadId, "Failed to allocate a fork command id.", cause),
            ),
          )}`,
        ),
        threadId: targetThreadId,
        sourceThreadId,
        createdAt,
      })
      .pipe(
        Effect.mapError((cause) =>
          extensionError(sourceThreadId, "The thread could not be forked.", cause),
        ),
      );
    return { threadId: targetThreadId };
  });

  yield* Effect.forkScoped(
    engine.streamDomainEvents.pipe(
      Stream.filter(isThreadEvent),
      Stream.runForEach((event) => {
        const threadId = ThreadId.make(event.aggregateId);
        if (event.type === "thread.deleted") {
          return Effect.all(
            [
              sql`DELETE FROM projection_thread_turn_queue WHERE thread_id = ${threadId}`,
              sql`DELETE FROM thread_extension_state WHERE thread_id = ${threadId}`,
            ],
            { discard: true },
          ).pipe(
            Effect.asVoid,
            Effect.mapError((cause) =>
              extensionError(threadId, "Failed to delete thread extension state.", cause),
            ),
          );
        }
        return worker.enqueue(threadId);
      }),
    ),
    { startImmediately: true },
  );
  const queuedThreads = yield* sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId"
    FROM projection_thread_turn_queue
  `.pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(queuedThreads, (row) => worker.enqueue(ThreadId.make(row.threadId)), {
    discard: true,
  });

  return ThreadExtensionService.of({
    getState,
    subscribe: (threadId) =>
      Stream.concat(
        Stream.fromEffect(getState(threadId)),
        Stream.fromPubSub(changes).pipe(Stream.filter((state) => state.threadId === threadId)),
      ),
    setInteractionMode,
    clearAskOverride,
    enqueueNormalizedTurn,
    removeQueuedTurn,
    resumeQueue,
    forkThread,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadExtensionService, make);
