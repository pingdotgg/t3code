/** Durable event store and projection for the pure AgentRun state machine. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import {
  AgentProfileBudgets,
  AgentProfileDocument,
  AgentRunId,
  ModelSelection,
  RuntimeTaskUsage,
  type AgentRunId as AgentRunIdType,
  type ThreadId as ThreadIdType,
  type AgentProfileDocument as AgentProfileDocumentType,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  decide,
  emptyAgentRunState,
  evolveAll,
  AgentRunEvent,
  AgentRunCommandInvariantError,
  type AgentRun,
  type AgentRunCommand,
  type AgentRunState,
} from "./AgentRun.ts";

export class AgentRunRepositoryDecodeError extends Schema.TaggedErrorClass<AgentRunRepositoryDecodeError>()(
  "AgentRunRepositoryDecodeError",
  { operation: Schema.String, detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export type AgentRunRepositoryError =
  | AgentRunCommandInvariantError
  | AgentRunRepositoryDecodeError
  | PersistenceDecodeError
  | PersistenceSqlError;

export const AgentRunWaitInput = Schema.Struct({
  runIds: Schema.Array(AgentRunId),
  afterRevision: Schema.optionalKey(Schema.Record(AgentRunId, Schema.Number)),
});
export type AgentRunWaitInput = typeof AgentRunWaitInput.Type;

export class AgentRunRepository extends Context.Service<
  AgentRunRepository,
  {
    readonly putProfileSnapshot: (
      profile: AgentProfileDocumentType,
    ) => Effect.Effect<void, AgentRunRepositoryError>;
    readonly getProfileSnapshot: (
      revision: AgentProfileDocumentType["revision"],
    ) => Effect.Effect<Option.Option<AgentProfileDocumentType>, AgentRunRepositoryError>;
    readonly dispatch: (
      command: AgentRunCommand,
    ) => Effect.Effect<ReadonlyArray<AgentRunEvent>, AgentRunRepositoryError>;
    readonly get: (
      runId: AgentRunIdType,
    ) => Effect.Effect<Option.Option<AgentRun>, AgentRunRepositoryError>;
    readonly getByChildThread: (
      childThreadId: ThreadIdType,
    ) => Effect.Effect<Option.Option<AgentRun>, AgentRunRepositoryError>;
    readonly listByParentThread: (
      parentThreadId: ThreadIdType,
    ) => Effect.Effect<ReadonlyArray<AgentRun>, AgentRunRepositoryError>;
    readonly listByLineage: (
      rootRunId: AgentRunIdType,
    ) => Effect.Effect<ReadonlyArray<AgentRun>, AgentRunRepositoryError>;
    /** Active runs currently owned by this server, used for restart recovery. */
    readonly listActive: () => Effect.Effect<ReadonlyArray<AgentRun>, AgentRunRepositoryError>;
    /** In-process notification stream; durable state remains the source of truth. */
    readonly streamChanges: Stream.Stream<AgentRun>;
    /** Subscribe before taking a recovery snapshot to close the startup race. */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<AgentRun>, never, Scope.Scope>;
    /** Resolves after a requested run advances past its supplied revision. */
    readonly waitForAdvance: (
      input: AgentRunWaitInput,
    ) => Effect.Effect<ReadonlyArray<AgentRun>, AgentRunRepositoryError>;
  }
>()("t3/agents/run/AgentRunRepository") {}

const StoredEventRow = Schema.Struct({ payload: Schema.String });
type StoredEventRow = typeof StoredEventRow.Type;
const RunIdRow = Schema.Struct({ runId: AgentRunId });
const RootRunIdRow = Schema.Struct({ rootRunId: AgentRunId });
const ProfileSnapshotRow = Schema.Struct({ documentText: Schema.String });
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRunEvent));
const encodeEvent = Schema.encodeUnknownEffect(Schema.fromJsonString(AgentRunEvent));
const encodeModelSelection = Schema.encodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const encodeBudget = Schema.encodeUnknownEffect(Schema.fromJsonString(AgentProfileBudgets));
const encodeUsage = Schema.encodeUnknownEffect(Schema.fromJsonString(RuntimeTaskUsage));
const encodeProfile = Schema.encodeUnknownEffect(Schema.fromJsonString(AgentProfileDocument));
const decodeRootRunIdRow = Schema.decodeUnknownEffect(RootRunIdRow);
const decodeRunIdRow = Schema.decodeUnknownEffect(RunIdRow);
const decodeProfileSnapshotRow = Schema.decodeUnknownEffect(ProfileSnapshotRow);
const decodeProfileDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgentProfileDocument),
);
const isInvariantError = Schema.is(AgentRunCommandInvariantError);

const sqlError = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, detail: `Failed to execute ${operation}`, cause });
const decodeError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new AgentRunRepositoryDecodeError({
        operation,
        detail: "Could not decode a persisted AgentRun event.",
        cause,
      });

const eventState = (events: ReadonlyArray<AgentRunEvent>): AgentRunState =>
  evolveAll(emptyAgentRunState(), events);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<AgentRun>();

  const readEvents = Effect.fn("AgentRunRepository.readEvents")(function* (where?: {
    readonly runId?: AgentRunIdType;
    readonly parentThreadId?: ThreadIdType;
    readonly rootRunId?: AgentRunIdType;
  }): Effect.fn.Return<ReadonlyArray<AgentRunEvent>, AgentRunRepositoryError> {
    const rows = yield* (
      where?.runId !== undefined
        ? sql<StoredEventRow>`
          SELECT payload_json AS payload
          FROM agent_run_events
          WHERE agent_run_id = ${where.runId}
          ORDER BY sequence ASC
        `
        : where?.parentThreadId !== undefined
          ? sql<StoredEventRow>`
            SELECT events.payload_json AS payload
            FROM agent_run_events AS events
            INNER JOIN projection_agent_runs AS runs ON runs.agent_run_id = events.agent_run_id
            WHERE runs.parent_thread_id = ${where.parentThreadId}
            ORDER BY events.sequence ASC
          `
          : where?.rootRunId !== undefined
            ? sql<StoredEventRow>`
              SELECT events.payload_json AS payload
              FROM agent_run_events AS events
              INNER JOIN projection_agent_runs AS runs ON runs.agent_run_id = events.agent_run_id
              WHERE runs.root_run_id = ${where.rootRunId}
              ORDER BY events.sequence ASC
            `
            : sql<StoredEventRow>`
              SELECT payload_json AS payload
              FROM agent_run_events
              ORDER BY sequence ASC
            `
    ).pipe(Effect.mapError(sqlError("AgentRunRepository.readEvents:query")));
    return yield* Effect.forEach(rows, (row) =>
      decodeEvent(row.payload).pipe(
        Effect.mapError(decodeError("AgentRunRepository.readEvents:decodeEvent")),
      ),
    );
  });

  const rootRunIdFor = Effect.fn("AgentRunRepository.rootRunIdFor")(function* (
    runId: AgentRunIdType,
  ): Effect.fn.Return<Option.Option<AgentRunIdType>, AgentRunRepositoryError> {
    const rows = yield* sql<{ readonly rootRunId: string }>`
      SELECT root_run_id AS rootRunId
      FROM projection_agent_runs
      WHERE agent_run_id = ${runId}
      LIMIT 1
    `.pipe(Effect.mapError(sqlError("AgentRunRepository.rootRunIdFor:query")));
    if (rows[0] === undefined) return Option.none();
    return yield* decodeRootRunIdRow(rows[0]).pipe(
      Effect.map(({ rootRunId }) => Option.some(rootRunId)),
      Effect.mapError(decodeError("AgentRunRepository.rootRunIdFor:decode")),
    );
  });

  /**
   * Rebuild only the state required by a command. A root request only needs
   * its own history for the idempotency check; commands against an existing
   * run need that run's lineage because the decider enforces lineage-wide
   * budgets and parent/child transitions.
   */
  const stateForCommand = Effect.fn("AgentRunRepository.stateForCommand")(function* (
    command: AgentRunCommand,
  ): Effect.fn.Return<AgentRunState, AgentRunRepositoryError> {
    if (command.type === "agent-run.request" && command.parentRunId === null) {
      return eventState(yield* readEvents({ runId: command.runId }));
    }

    const runId = command.type === "agent-run.request" ? command.parentRunId : command.runId;
    if (runId === null) return eventState(yield* readEvents({ runId: command.runId }));

    const rootRunId = yield* rootRunIdFor(runId);
    if (Option.isNone(rootRunId)) return eventState([]);
    return eventState(yield* readEvents({ rootRunId: rootRunId.value }));
  });

  const upsertProjection = Effect.fn("AgentRunRepository.upsertProjection")(function* (
    run: AgentRun,
  ): Effect.fn.Return<void, AgentRunRepositoryError> {
    const modelSelectionJson = yield* encodeModelSelection(run.modelSelection).pipe(
      Effect.mapError(decodeError("AgentRunRepository.upsertProjection:encodeModelSelection")),
    );
    const budgetJson = yield* encodeBudget(run.budget).pipe(
      Effect.mapError(decodeError("AgentRunRepository.upsertProjection:encodeBudget")),
    );
    const usageJson =
      run.usage === undefined
        ? null
        : yield* encodeUsage(run.usage).pipe(
            Effect.mapError(decodeError("AgentRunRepository.upsertProjection:encodeUsage")),
          );
    yield* sql`
      INSERT INTO projection_agent_runs (
        agent_run_id, parent_run_id, root_run_id, parent_thread_id, child_thread_id,
        project_id, profile_scope, profile_id, profile_revision, provider_instance_id,
        model_selection_json, depth, status, revision, workspace_mode, detached,
        budget_json, result_json, usage_json, consumed_tokens, waiting_for_children, active_turn_id,
        integration_target_thread_id, last_error, created_at, started_at, completed_at, updated_at
      ) VALUES (
        ${run.id}, ${run.parentRunId}, ${run.rootRunId}, ${run.parentThreadId}, ${run.childThreadId},
        ${run.projectId}, ${run.profile.scope}, ${run.profile.id}, ${run.profile.revision}, ${run.instanceId},
        ${modelSelectionJson}, ${run.depth}, ${run.status}, ${run.revision}, ${run.workspaceMode}, ${run.detached ? 1 : 0},
        ${budgetJson}, ${null}, ${usageJson}, ${run.consumedTokens}, ${run.waitingForChildren ? 1 : 0}, ${run.activeTurnId},
        ${run.integrationTargetThreadId}, ${run.failure ?? null}, ${run.requestedAt}, ${run.startedAt}, ${run.finishedAt}, ${run.updatedAt}
      )
      ON CONFLICT (agent_run_id) DO UPDATE SET
        parent_run_id = excluded.parent_run_id,
        root_run_id = excluded.root_run_id,
        parent_thread_id = excluded.parent_thread_id,
        child_thread_id = excluded.child_thread_id,
        project_id = excluded.project_id,
        profile_scope = excluded.profile_scope,
        profile_id = excluded.profile_id,
        profile_revision = excluded.profile_revision,
        provider_instance_id = excluded.provider_instance_id,
        model_selection_json = excluded.model_selection_json,
        depth = excluded.depth,
        status = excluded.status,
        revision = excluded.revision,
        workspace_mode = excluded.workspace_mode,
        detached = excluded.detached,
        budget_json = excluded.budget_json,
        result_json = excluded.result_json,
        usage_json = excluded.usage_json,
        consumed_tokens = excluded.consumed_tokens,
        waiting_for_children = excluded.waiting_for_children,
        active_turn_id = excluded.active_turn_id,
        integration_target_thread_id = excluded.integration_target_thread_id,
        last_error = excluded.last_error,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.asVoid, Effect.mapError(sqlError("AgentRunRepository.upsertProjection:query")));
  });

  const get: AgentRunRepository["Service"]["get"] = (runId) =>
    readEvents({ runId }).pipe(
      Effect.map(eventState),
      Effect.map((state) => Option.fromNullishOr(state.runs.get(runId))),
    );

  const putProfileSnapshot: AgentRunRepository["Service"]["putProfileSnapshot"] = (profile) =>
    encodeProfile(profile).pipe(
      Effect.mapError(decodeError("AgentRunRepository.putProfileSnapshot:encodeProfile")),
      Effect.flatMap((documentText) =>
        sql`
        INSERT INTO agent_profile_snapshots (revision, document_text, created_at)
        VALUES (${profile.revision}, ${documentText}, ${profile.updatedAt})
        ON CONFLICT (revision) DO NOTHING
      `.pipe(Effect.mapError(sqlError("AgentRunRepository.putProfileSnapshot:query"))),
      ),
      Effect.asVoid,
    );

  const getByChildThread: AgentRunRepository["Service"]["getByChildThread"] = (childThreadId) =>
    sql<{ readonly runId: string }>`
      SELECT agent_run_id AS runId
      FROM projection_agent_runs
      WHERE child_thread_id = ${childThreadId}
      LIMIT 1
    `.pipe(
      Effect.mapError(sqlError("AgentRunRepository.getByChildThread:query")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : decodeRunIdRow(rows[0]).pipe(
              Effect.mapError(decodeError("AgentRunRepository.getByChildThread:decode")),
              Effect.flatMap(({ runId }) => get(runId)),
            ),
      ),
    );

  const getProfileSnapshot: AgentRunRepository["Service"]["getProfileSnapshot"] = (revision) =>
    sql<{ readonly documentText: string }>`
      SELECT document_text AS documentText
      FROM agent_profile_snapshots
      WHERE revision = ${revision}
      LIMIT 1
    `.pipe(
      Effect.mapError(sqlError("AgentRunRepository.getProfileSnapshot:query")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : decodeProfileSnapshotRow(rows[0]).pipe(
              Effect.mapError(decodeError("AgentRunRepository.getProfileSnapshot:decodeRow")),
              Effect.flatMap(({ documentText }) =>
                decodeProfileDocument(documentText).pipe(
                  Effect.map(Option.some),
                  Effect.mapError(
                    decodeError("AgentRunRepository.getProfileSnapshot:decodeDocument"),
                  ),
                ),
              ),
            ),
      ),
    );

  const listByParentThread: AgentRunRepository["Service"]["listByParentThread"] = (
    parentThreadId,
  ) =>
    readEvents({ parentThreadId }).pipe(
      Effect.map(eventState),
      Effect.map((state) => [...state.runs.values()]),
    );

  const listByLineage: AgentRunRepository["Service"]["listByLineage"] = (rootRunId) =>
    readEvents({ rootRunId }).pipe(
      Effect.map(eventState),
      Effect.map((state) => [...state.runs.values()]),
    );

  const listActive: AgentRunRepository["Service"]["listActive"] = () =>
    sql<{ readonly runId: string }>`
      SELECT agent_run_id AS runId
      FROM projection_agent_runs
      WHERE status IN ('queued', 'running', 'waiting-for-input')
      ORDER BY updated_at ASC
    `.pipe(
      Effect.mapError(sqlError("AgentRunRepository.listActive:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeRunIdRow(row).pipe(
            Effect.mapError(decodeError("AgentRunRepository.listActive:decode")),
            Effect.flatMap(({ runId }) => get(runId)),
            Effect.map(Option.getOrUndefined),
          ),
        ),
      ),
      Effect.map((runs) => runs.filter((run): run is AgentRun => run !== undefined)),
    );

  const dispatch: AgentRunRepository["Service"]["dispatch"] = (command) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const before = yield* stateForCommand(command);
          const events = yield* decide(before, command);
          let after = before;
          for (const event of events) {
            const payload = yield* encodeEvent(event).pipe(
              Effect.mapError(decodeError("AgentRunRepository.dispatch:encodeEvent")),
            );
            yield* sql`
              INSERT INTO agent_run_events (agent_run_id, revision, event_type, occurred_at, payload_json)
              VALUES (${event.runId}, ${event.revision}, ${event.type}, ${event.occurredAt}, ${payload})
            `.pipe(Effect.asVoid);
            after = evolveAll(after, [event]);
            const run = after.runs.get(event.runId);
            if (!run)
              return yield* Effect.die(
                new Error("AgentRun event did not produce its run projection."),
              );
            yield* upsertProjection(run);
          }
          return { events, after };
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isInvariantError(cause)
            ? cause
            : sqlError("AgentRunRepository.dispatch:transaction")(cause),
        ),
        Effect.tap(({ events, after }) =>
          Effect.forEach(new Set(events.map((event) => event.runId)), (runId) => {
            const run = after.runs.get(runId);
            return run === undefined
              ? Effect.void
              : PubSub.publish(changes, run).pipe(Effect.asVoid);
          }),
        ),
        Effect.map(({ events }) => events),
      );

  const waitForAdvance: AgentRunRepository["Service"]["waitForAdvance"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const runIds = new Set(input.runIds);
        const afterRevision = input.afterRevision ?? {};
        // Subscribe before reading the durable projection. That closes the
        // commit-to-notification race without a polling loop: an earlier
        // commit is visible in `current`, a later one is retained here.
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* Effect.forEach(input.runIds, get).pipe(
          Effect.map((runs) => runs.filter(Option.isSome).map((entry) => entry.value)),
        );
        const alreadyAdvanced = current.filter(
          (run) => run.revision > (afterRevision[run.id] ?? -1),
        );
        if (alreadyAdvanced.length > 0) return alreadyAdvanced;

        const takeRelevant = (): Effect.Effect<AgentRun, never> =>
          PubSub.take(subscription).pipe(
            Effect.flatMap((run) =>
              runIds.has(run.id) && run.revision > (afterRevision[run.id] ?? -1)
                ? Effect.succeed(run)
                : takeRelevant(),
            ),
          );
        return [yield* takeRelevant()];
      }),
    );

  return AgentRunRepository.of({
    putProfileSnapshot,
    getProfileSnapshot,
    dispatch,
    get,
    getByChildThread,
    listByParentThread,
    listByLineage,
    listActive,
    streamChanges: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    waitForAdvance,
  });
});

export const layer = Layer.effect(AgentRunRepository, make);
