import { EventId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as NodeCrypto from "node:crypto";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const MAX_STATE_BYTES = 32_768;
const WORK_STATE_SCHEMA_VERSION = "hyde-agent-work-state/v1";
export const HYDE_AGENT_WORK_STATE_ACTIVITY_KIND = "hyde.agent.work-state";
const COMPACTION_ACTIVITY_KIND = "context-compaction";

const Decision = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  rationale: Schema.optional(Schema.String),
});
export type Decision = typeof Decision.Type;

const WorkItem = Schema.Struct({
  id: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["completed", "ready", "blocked"]),
  dependsOn: Schema.optional(Schema.Array(Schema.String)),
  reason: Schema.optional(Schema.String),
  evidence: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkItem = typeof WorkItem.Type;

const Verification = Schema.Struct({
  command: Schema.String,
  status: Schema.Literals(["not-run", "passed", "failed", "blocked"]),
  exitCode: Schema.optional(Schema.Int),
  result: Schema.optional(Schema.String),
});
export type Verification = typeof Verification.Type;

export const HydeAgentWorkState = Schema.Struct({
  taskIdentity: Schema.optional(Schema.String),
  objective: Schema.String,
  stage: Schema.String,
  decisions: Schema.Array(Decision),
  workItems: Schema.Array(WorkItem),
  workingPaths: Schema.Array(Schema.String),
  verification: Schema.Array(Verification),
  invariants: Schema.Array(Schema.String),
  nextAction: Schema.String,
});
export type HydeAgentWorkState = typeof HydeAgentWorkState.Type;

export const HydeAgentWorkStateCheckpointInput = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: HydeAgentWorkState,
});
export type HydeAgentWorkStateCheckpointInput = typeof HydeAgentWorkStateCheckpointInput.Type;

const checkpointFileSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
});

export const HydeAgentWorkStateCheckpoint = Schema.Struct({
  checkpointRef: Schema.String,
  turnId: Schema.String,
  checkpointTurnCount: Schema.Number,
  status: Schema.String,
  completedAt: Schema.String,
  files: Schema.Array(checkpointFileSchema),
  filesTruncated: Schema.Boolean,
});
export type HydeAgentWorkStateCheckpoint = typeof HydeAgentWorkStateCheckpoint.Type;

const sourceCheckpointSchema = Schema.Struct({
  checkpointRef: Schema.String,
  checkpointTurnCount: Schema.Number,
  status: Schema.String,
  completedAt: Schema.String,
});

const lastCompactionSchema = Schema.Struct({
  createdAt: Schema.String,
  summary: Schema.String,
  beforeTokens: Schema.optional(Schema.Number),
  afterTokens: Schema.optional(Schema.Number),
});

type SourceCheckpoint = typeof sourceCheckpointSchema.Type;
const decodeSourceCheckpointEffect = Schema.decodeUnknownEffect(sourceCheckpointSchema);
const decodeWorkStateEffect = Schema.decodeUnknownEffect(HydeAgentWorkState);

export const HydeAgentWorkStateReadResult = Schema.Struct({
  present: Schema.Boolean,
  revision: Schema.Number,
  stateHash: Schema.NullOr(Schema.String),
  capturedAt: Schema.NullOr(Schema.String),
  state: Schema.NullOr(HydeAgentWorkState),
  sourceCheckpoint: Schema.NullOr(sourceCheckpointSchema),
  currentCheckpoint: Schema.NullOr(HydeAgentWorkStateCheckpoint),
  sourceCheckpointMatchesCurrent: Schema.NullOr(Schema.Boolean),
  lastCompaction: Schema.NullOr(lastCompactionSchema),
  continuityRules: Schema.Struct({
    currentSourceRequiredBeforeMutation: Schema.Literal(true),
    externalCoordinationIsAuthoritative: Schema.Literal(true),
    workingPathsAreAdvisoryOnly: Schema.Literal(true),
  }),
});
export type HydeAgentWorkStateReadResult = typeof HydeAgentWorkStateReadResult.Type;

export const HydeAgentWorkStateCheckpointResult = Schema.Struct({
  revision: Schema.Number,
  stateHash: Schema.String,
  changed: Schema.Boolean,
  capturedAt: Schema.String,
});
export type HydeAgentWorkStateCheckpointResult = typeof HydeAgentWorkStateCheckpointResult.Type;

export const HydeAgentWorkStateUnavailableReason = Schema.Literals([
  "capability_unavailable",
  "thread_not_found",
  "read_failed",
  "write_failed",
  "state_invalid",
]);
export type HydeAgentWorkStateUnavailableReason = typeof HydeAgentWorkStateUnavailableReason.Type;

export class HydeAgentWorkStateUnavailableError extends Schema.TaggedError<HydeAgentWorkStateUnavailableError>()(
  "HydeAgentWorkStateUnavailableError",
  { reason: HydeAgentWorkStateUnavailableReason },
) {
  override get message(): string {
    return `HYDE durable work state is unavailable (${this.reason}).`;
  }
}

export class HydeAgentWorkStateRevisionConflictError extends Schema.TaggedError<HydeAgentWorkStateRevisionConflictError>()(
  "HydeAgentWorkStateRevisionConflictError",
  {
    expectedRevision: Schema.Number,
    currentRevision: Schema.Number,
    currentStateHash: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return "HYDE durable work state changed; read it again before checkpointing.";
  }
}

const isHydeAgentWorkStateUnavailableError = Schema.is(HydeAgentWorkStateUnavailableError);
const isHydeAgentWorkStateRevisionConflictError = Schema.is(
  HydeAgentWorkStateRevisionConflictError,
);
export const HydeAgentWorkStateError = Schema.Union([
  HydeAgentWorkStateUnavailableError,
  HydeAgentWorkStateRevisionConflictError,
]);
export type HydeAgentWorkStateError =
  | HydeAgentWorkStateUnavailableError
  | HydeAgentWorkStateRevisionConflictError;

const failInvalid = (): never => {
  throw new HydeAgentWorkStateUnavailableError({ reason: "state_invalid" });
};

const decodeSourceCheckpointForWorkState = (value: unknown) =>
  decodeSourceCheckpointEffect(value).pipe(
    Effect.mapError(() => new HydeAgentWorkStateUnavailableError({ reason: "state_invalid" })),
  );

function bounded(value: string, max: number, required = true): string {
  const normalized = value.trim();
  if ((required && normalized.length === 0) || normalized.length > max) failInvalid();
  return normalized;
}

function boundedOptional(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : bounded(value, max, false) || undefined;
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalStateJson(state: HydeAgentWorkState): string {
  return JSON.stringify(canonicalize(state));
}

export function hashWorkState(state: HydeAgentWorkState): string {
  return NodeCrypto.createHash("sha256").update(canonicalStateJson(state), "utf8").digest("hex");
}

const normalizeDecodedWorkState = (decoded: HydeAgentWorkState): HydeAgentWorkState => {
  if (decoded.decisions.length > 24 || decoded.workItems.length > 64) failInvalid();
  if (decoded.workingPaths.length > 100 || decoded.verification.length > 40) failInvalid();
  if (decoded.invariants.length > 24) failInvalid();

  const decisions = decoded.decisions.map((decision) => {
    const rationale = boundedOptional(decision.rationale, 2_000);
    return {
      id: bounded(decision.id, 128),
      summary: bounded(decision.summary, 1_000),
      ...(rationale ? { rationale } : {}),
    };
  });
  const decisionIds = decisions.map(({ id }) => id);
  if (unique(decisionIds).length !== decisionIds.length) failInvalid();

  const workItems = decoded.workItems.map((item) => {
    if (item.dependsOn && item.dependsOn.length > 16) failInvalid();
    if (item.evidence && item.evidence.length > 8) failInvalid();
    const dependsOn = item.dependsOn?.map((id) => bounded(id, 128));
    const reason = boundedOptional(item.reason, 2_000);
    return {
      id: bounded(item.id, 128),
      summary: bounded(item.summary, 1_000),
      status: item.status,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn: unique(dependsOn) } : {}),
      ...(reason ? { reason } : {}),
      ...(item.evidence && item.evidence.length > 0
        ? { evidence: item.evidence.map((entry) => bounded(entry, 1_500)) }
        : {}),
    };
  });
  const workItemIds = workItems.map(({ id }) => id);
  if (unique(workItemIds).length !== workItemIds.length) failInvalid();
  const workItemIdSet = new Set(workItemIds);
  const graph = new Map(workItems.map((item) => [item.id, item.dependsOn ?? []]));
  for (const item of workItems) {
    if (item.status === "blocked" && !(item.dependsOn?.length || item.reason)) failInvalid();
    for (const dependency of item.dependsOn ?? []) {
      if (!workItemIdSet.has(dependency) || dependency === item.id) failInvalid();
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) failInvalid();
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of workItemIds) visit(id);

  const verification = decoded.verification.map((entry) => {
    const result = boundedOptional(entry.result, 2_000);
    return {
      command: bounded(entry.command, 4_000),
      status: entry.status,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(result ? { result } : {}),
    };
  });
  const taskIdentity = boundedOptional(decoded.taskIdentity, 512);
  const state: HydeAgentWorkState = {
    ...(taskIdentity ? { taskIdentity } : {}),
    objective: bounded(decoded.objective, 4_000),
    stage: bounded(decoded.stage, 512),
    decisions,
    workItems,
    workingPaths: unique(decoded.workingPaths.map((path) => bounded(path, 512))),
    verification,
    invariants: unique(decoded.invariants.map((invariant) => bounded(invariant, 2_000))),
    nextAction: bounded(decoded.nextAction, 4_000),
  };
  if (Buffer.byteLength(canonicalStateJson(state), "utf8") > MAX_STATE_BYTES) failInvalid();
  return state;
};

export function normalizeWorkState(input: unknown): HydeAgentWorkState {
  let decoded: HydeAgentWorkState;
  try {
    decoded = Schema.decodeUnknownSync(HydeAgentWorkState)(input);
  } catch {
    return failInvalid();
  }
  return normalizeDecodedWorkState(decoded);
}

const normalizeWorkStateEffect = (input: unknown) =>
  decodeWorkStateEffect(input).pipe(
    Effect.mapError(() => new HydeAgentWorkStateUnavailableError({ reason: "state_invalid" })),
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => normalizeDecodedWorkState(decoded),
        catch: (error) =>
          isHydeAgentWorkStateUnavailableError(error)
            ? error
            : new HydeAgentWorkStateUnavailableError({ reason: "state_invalid" }),
      }),
    ),
  );

export interface HydeAgentWorkStateShape {
  readonly read: (
    threadId: ThreadId,
  ) => Effect.Effect<HydeAgentWorkStateReadResult, HydeAgentWorkStateUnavailableError>;
  readonly checkpoint: (
    threadId: ThreadId,
    providerSessionId: string,
    providerInstanceId: string,
    input: HydeAgentWorkStateCheckpointInput,
  ) => Effect.Effect<HydeAgentWorkStateCheckpointResult, HydeAgentWorkStateError>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const continuityRules = {
  currentSourceRequiredBeforeMutation: true as const,
  externalCoordinationIsAuthoritative: true as const,
  workingPathsAreAdvisoryOnly: true as const,
};

type LatestActivityEffect = ReturnType<
  NonNullable<ProjectionSnapshotQuery.ProjectionSnapshotQueryShape["getLatestThreadActivityByKind"]>
>;
export const makeHydeAgentWorkState = (
  engine: OrchestrationEngine.OrchestrationEngineShape,
  snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
): HydeAgentWorkStateShape => {
  const threadLocks = SynchronizedRef.makeUnsafe(new Map<ThreadId, Semaphore.Semaphore>());
  const getThreadSemaphore = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(threadLocks, (current) => {
      const existing = Option.fromNullishOr(current.get(threadId));
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });
  const withThreadLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const latestActivity = (threadId: ThreadId, kind: string): LatestActivityEffect => {
    if (snapshots.getLatestThreadActivityByKind)
      return snapshots.getLatestThreadActivityByKind({ threadId, kind });
    return snapshots
      .getThreadDetailById(threadId, { activityKinds: [kind] })
      .pipe(
        Effect.map((detail) =>
          Option.isNone(detail)
            ? Option.none()
            : Option.fromNullishOr(
                detail.value.activities.filter((activity) => activity.kind === kind).at(-1),
              ),
        ),
      );
  };

  const load = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const context = yield* snapshots.getThreadCheckpointContext(threadId);
      if (Option.isNone(context))
        return yield* new HydeAgentWorkStateUnavailableError({
          reason: "thread_not_found",
        });
      const activity = yield* latestActivity(threadId, HYDE_AGENT_WORK_STATE_ACTIVITY_KIND);
      const compaction = yield* latestActivity(threadId, COMPACTION_ACTIVITY_KIND);
      let persisted:
        | {
            readonly revision: number;
            readonly stateHash: string;
            readonly capturedAt: string;
            readonly state: HydeAgentWorkState;
            readonly sourceCheckpoint: HydeAgentWorkStateReadResult["sourceCheckpoint"];
          }
        | undefined;
      if (Option.isSome(activity)) {
        const payload = asRecord(activity.value.payload);
        if (
          !payload ||
          payload.schemaVersion !== WORK_STATE_SCHEMA_VERSION ||
          typeof payload.revision !== "number" ||
          !Number.isSafeInteger(payload.revision) ||
          payload.revision < 1 ||
          typeof payload.stateHash !== "string" ||
          !/^[0-9a-f]{64}$/u.test(payload.stateHash) ||
          typeof payload.capturedAt !== "string" ||
          payload.capturedAt.trim().length === 0 ||
          payload.capturedAt.length > 128 ||
          typeof payload.writerProviderSessionId !== "string" ||
          payload.writerProviderSessionId.trim().length === 0 ||
          payload.writerProviderSessionId.length > 256 ||
          typeof payload.writerProviderInstanceId !== "string" ||
          payload.writerProviderInstanceId.trim().length === 0 ||
          payload.writerProviderInstanceId.length > 256 ||
          payload.timelineBypass !== true
        )
          return yield* new HydeAgentWorkStateUnavailableError({
            reason: "state_invalid",
          });
        const { state, sourceCheckpoint } = yield* Effect.gen(function* () {
          const state = yield* normalizeWorkStateEffect(payload.state);
          if (hashWorkState(state) !== payload.stateHash)
            return yield* new HydeAgentWorkStateUnavailableError({
              reason: "state_invalid",
            });
          const hasSourceCheckpoint = Object.hasOwn(payload, "sourceCheckpoint");
          const rawSource = asRecord(payload.sourceCheckpoint);
          if (hasSourceCheckpoint && !rawSource)
            return yield* new HydeAgentWorkStateUnavailableError({
              reason: "state_invalid",
            });
          const sourceCheckpoint = rawSource
            ? yield* decodeSourceCheckpointForWorkState(rawSource)
            : null;
          if (
            sourceCheckpoint &&
            (!Number.isSafeInteger(sourceCheckpoint.checkpointTurnCount) ||
              sourceCheckpoint.checkpointTurnCount < 0 ||
              sourceCheckpoint.checkpointRef.trim().length === 0 ||
              sourceCheckpoint.checkpointRef.length > 512 ||
              sourceCheckpoint.status.trim().length === 0 ||
              sourceCheckpoint.status.length > 128 ||
              sourceCheckpoint.completedAt.trim().length === 0 ||
              sourceCheckpoint.completedAt.length > 128)
          )
            return yield* new HydeAgentWorkStateUnavailableError({
              reason: "state_invalid",
            });
          return { state, sourceCheckpoint };
        }).pipe(
          Effect.mapError(
            () => new HydeAgentWorkStateUnavailableError({ reason: "state_invalid" }),
          ),
        );
        persisted = {
          revision: payload.revision,
          stateHash: payload.stateHash,
          capturedAt: payload.capturedAt,
          state,
          sourceCheckpoint,
        };
      }
      const checkpoint = context.value.checkpoints.reduce<HydeAgentWorkStateCheckpoint | null>(
        (latest, candidate) =>
          latest === null || candidate.checkpointTurnCount > latest.checkpointTurnCount
            ? {
                checkpointRef: candidate.checkpointRef,
                turnId: candidate.turnId,
                checkpointTurnCount: candidate.checkpointTurnCount,
                status: candidate.status,
                completedAt: candidate.completedAt,
                files: candidate.files.slice(0, 100),
                filesTruncated: candidate.files.length > 100,
              }
            : latest,
        null,
      );
      const sourceCheckpointMatchesCurrent = persisted?.sourceCheckpoint
        ? checkpoint === null
          ? false
          : persisted.sourceCheckpoint.checkpointRef === checkpoint.checkpointRef &&
            persisted.sourceCheckpoint.checkpointTurnCount === checkpoint.checkpointTurnCount
        : null;
      const compactionPayload = Option.isSome(compaction)
        ? asRecord(compaction.value.payload)
        : null;
      const lastCompaction =
        Option.isSome(compaction) && compactionPayload
          ? {
              createdAt: compaction.value.createdAt,
              summary:
                typeof compactionPayload.summary === "string"
                  ? compactionPayload.summary.slice(0, 2_000)
                  : compaction.value.summary.slice(0, 2_000),
              ...(typeof compactionPayload.beforeTokens === "number"
                ? { beforeTokens: compactionPayload.beforeTokens }
                : {}),
              ...(typeof compactionPayload.afterTokens === "number"
                ? { afterTokens: compactionPayload.afterTokens }
                : {}),
            }
          : Option.isSome(compaction)
            ? {
                createdAt: compaction.value.createdAt,
                summary: compaction.value.summary.slice(0, 2_000),
              }
            : null;
      return { persisted, checkpoint, lastCompaction, sourceCheckpointMatchesCurrent };
    }).pipe(
      Effect.mapError((error) =>
        isHydeAgentWorkStateUnavailableError(error)
          ? error
          : new HydeAgentWorkStateUnavailableError({ reason: "read_failed" }),
      ),
    );

  const read: HydeAgentWorkStateShape["read"] = (threadId) =>
    load(threadId).pipe(
      Effect.map(({ persisted, checkpoint, lastCompaction, sourceCheckpointMatchesCurrent }) => ({
        present: persisted !== undefined,
        revision: persisted?.revision ?? 0,
        stateHash: persisted?.stateHash ?? null,
        capturedAt: persisted?.capturedAt ?? null,
        state: persisted?.state ?? null,
        sourceCheckpoint: persisted?.sourceCheckpoint ?? null,
        currentCheckpoint: checkpoint,
        sourceCheckpointMatchesCurrent,
        lastCompaction,
        continuityRules,
      })),
    );

  const checkpointState: HydeAgentWorkStateShape["checkpoint"] = (
    threadId,
    providerSessionId,
    providerInstanceId,
    input,
  ) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const current = yield* load(threadId);
        const state = yield* normalizeWorkStateEffect(input.state);
        const stateHash = hashWorkState(state);
        if (current.persisted?.stateHash === stateHash)
          return {
            revision: current.persisted.revision,
            stateHash,
            changed: false,
            capturedAt: current.persisted.capturedAt,
          };
        const currentRevision = current.persisted?.revision ?? 0;
        if (input.expectedRevision !== currentRevision)
          return yield* new HydeAgentWorkStateRevisionConflictError({
            expectedRevision: input.expectedRevision,
            currentRevision,
            currentStateHash: current.persisted?.stateHash ?? null,
          });
        const revision = currentRevision + 1;
        const capturedAt = DateTime.formatIso(yield* DateTime.now);
        const sourceCheckpoint = current.checkpoint
          ? {
              checkpointRef: current.checkpoint.checkpointRef,
              checkpointTurnCount: current.checkpoint.checkpointTurnCount,
              status: current.checkpoint.status,
              completedAt: current.checkpoint.completedAt,
            }
          : undefined;
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: `hyde-work-state:${threadId}:${revision}:${stateHash}`,
            threadId,
            activity: {
              id: EventId.make(NodeCrypto.randomUUID()),
              tone: "info",
              kind: HYDE_AGENT_WORK_STATE_ACTIVITY_KIND,
              summary: "HYDE durable work state checkpoint",
              payload: {
                schemaVersion: WORK_STATE_SCHEMA_VERSION,
                revision,
                stateHash,
                writerProviderSessionId: providerSessionId,
                writerProviderInstanceId: providerInstanceId,
                capturedAt,
                ...(sourceCheckpoint ? { sourceCheckpoint } : {}),
                state,
                timelineBypass: true,
              },
              turnId: null,
              createdAt: capturedAt,
            },
            createdAt: capturedAt,
          } as never)
          .pipe(
            Effect.mapError(
              () => new HydeAgentWorkStateUnavailableError({ reason: "write_failed" }),
            ),
          );
        return { revision, stateHash, changed: true, capturedAt };
      }).pipe(
        Effect.catch((error) =>
          isHydeAgentWorkStateRevisionConflictError(error) ||
          isHydeAgentWorkStateUnavailableError(error)
            ? Effect.fail(error)
            : Effect.fail(new HydeAgentWorkStateUnavailableError({ reason: "write_failed" })),
        ),
      ),
    );

  return { read, checkpoint: checkpointState };
};

export class HydeAgentWorkStateService extends Context.Service<
  HydeAgentWorkStateService,
  HydeAgentWorkStateShape
>()("t3/roy/autonomy/HydeAgentWorkState/HydeAgentWorkStateService") {}

const makeLive = Effect.gen(function* () {
  return HydeAgentWorkStateService.of(
    makeHydeAgentWorkState(
      yield* OrchestrationEngine.OrchestrationEngineService,
      yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery,
    ),
  );
});

export const HydeAgentWorkStateLive = Layer.effect(HydeAgentWorkStateService, makeLive);
