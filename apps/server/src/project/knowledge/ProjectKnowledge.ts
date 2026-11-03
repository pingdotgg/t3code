import {
  ActiveProjectFact,
  type AssistedLearningRun,
  type KnowledgeConflictHint,
  type KnowledgeFactSource,
  KnowledgeOrigin,
  KnowledgeScore,
  type KnowledgeSourceUnavailableReason,
  ProjectKnowledgeError,
  type ProjectFact,
  type ProjectId,
  type ProjectKnowledgeContext,
  type ProjectKnowledgeDeliveries,
  type ProjectKnowledgeDelivery,
  type ProjectKnowledgeReadDeliveriesInput,
  type ProjectKnowledgeListInput,
  type ProjectKnowledgeListResult,
  ProjectKnowledgeMutation,
  ProjectKnowledgeSearchInput,
  ProjectFactId,
  type ProjectKnowledgePreparedContext,
  type ProjectKnowledgeReadSourceInput,
  type ProjectKnowledgeSearchResult,
  type ProjectKnowledgeSource,
  type ProjectKnowledgeFactDetail,
  type ProjectKnowledgeMutationResult,
  type ProjectKnowledgeReadFactInput,
  type ProjectKnowledgeStatus,
  type ProjectKnowledgeStatusInput,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
  projectKnowledgeContextRecord,
} from "@t3tools/shared/composerContextReferences";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadSearch from "../../orchestration-v2/ThreadSearch.ts";
import {
  makeStore,
  type DeliveryState,
  type DeliveryStateInput,
  type NativeDeliveryEstimateInput,
  type HistoryRecord,
  type SearchReceipt,
} from "./persistence.ts";
import * as HolographicMemory from "./HolographicMemory.ts";
import { projectMemorySearchTokens } from "./holographicScoring.ts";
import { conflictHints } from "./knowledgeConflicts.ts";
import { DeliveryScrubRunner } from "./deliveryScrubSchedule.ts";

export class ProjectKnowledge extends Context.Service<
  ProjectKnowledge,
  {
    readonly list: (
      input: ProjectKnowledgeListInput,
    ) => Effect.Effect<ProjectKnowledgeListResult, ProjectKnowledgeError>;
    readonly mutate: (
      input: ProjectKnowledgeMutation,
      actor: KnowledgeOrigin,
    ) => Effect.Effect<ProjectFact, ProjectKnowledgeError>;
    /** mutate, plus duplicate and conflict hints for content it wrote. */
    readonly mutateWithHints: (
      input: ProjectKnowledgeMutation,
      actor: KnowledgeOrigin,
    ) => Effect.Effect<ProjectKnowledgeMutationResult, ProjectKnowledgeError>;
    readonly readFact: (
      input: ProjectKnowledgeReadFactInput,
    ) => Effect.Effect<ProjectKnowledgeFactDetail, ProjectKnowledgeError>;
    readonly status: (
      input: ProjectKnowledgeStatusInput,
    ) => Effect.Effect<ProjectKnowledgeStatus, ProjectKnowledgeError>;
    readonly readSource: (
      input: ProjectKnowledgeReadSourceInput,
    ) => Effect.Effect<ProjectKnowledgeSource, ProjectKnowledgeError>;
    /** readSource for several messages of one thread in one projection read, in input order. */
    readonly readSources: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ProjectKnowledgeReadSourceInput["threadId"];
      readonly sources: ReadonlyArray<
        Pick<ProjectKnowledgeReadSourceInput, "messageId" | "digest">
      >;
      readonly includeArchived?: boolean;
    }) => Effect.Effect<ReadonlyArray<ProjectKnowledgeSource>, ProjectKnowledgeError>;
    readonly search: (
      input: ProjectKnowledgeSearchInput,
    ) => Effect.Effect<ProjectKnowledgeSearchResult, ProjectKnowledgeError>;
    readonly prepareContext: (
      input: ProjectKnowledgeContext,
    ) => Effect.Effect<ProjectKnowledgePreparedContext, ProjectKnowledgeError>;
    readonly resolveForTurn: (
      input: ProjectKnowledgeContext,
    ) => Effect.Effect<ProjectKnowledgePreparedContext, ProjectKnowledgeError>;
    readonly recordDelivery: (
      delivery: ProjectKnowledgeDelivery,
    ) => Effect.Effect<void, ProjectKnowledgeError>;
    readonly readDeliveries: (
      input: ProjectKnowledgeReadDeliveriesInput,
    ) => Effect.Effect<ProjectKnowledgeDeliveries, ProjectKnowledgeError>;
    /** Original delivery outcomes, independent of source availability and inspector pagination. */
    readonly readDeliveryState: (
      input: DeliveryStateInput,
    ) => Effect.Effect<DeliveryState, ProjectKnowledgeError>;
    /** Accepted attachment occupancy in one native conversation, independent of retained bodies. */
    readonly nativeDeliveryEstimate: (
      input: NativeDeliveryEstimateInput,
    ) => Effect.Effect<number, ProjectKnowledgeError>;
    readonly markDeliveryUncertain: (
      input: DeliveryStateInput,
    ) => Effect.Effect<void, ProjectKnowledgeError>;
    readonly scrubDeliveryPage: (input: {
      readonly projectId: ProjectId;
      readonly afterId?: string | undefined;
    }) => Effect.Effect<string | null, ProjectKnowledgeError>;
    /**
     * Creates an assisted proposal through the normal create path. An exact duplicate of an
     * active fact creates nothing; a near duplicate or possible conflict is created as a pending
     * replacement of that fact, which only takes effect when a user confirms it.
     */
    readonly proposeAssisted: (
      input: Extract<ProjectKnowledgeMutation, { readonly action: "create" }>,
      actor: Extract<KnowledgeOrigin, { readonly kind: "assisted" }>,
    ) => Effect.Effect<
      { readonly outcome: "proposed" | "suggested" | "duplicate" | "existing" },
      ProjectKnowledgeError
    >;
    readonly hasAssistedRun: (
      projectId: ProjectId,
      runId: ProjectKnowledgeDelivery["runId"],
    ) => Effect.Effect<boolean, ProjectKnowledgeError>;
    readonly recordAssistedRun: (
      projectId: ProjectId,
      run: AssistedLearningRun,
    ) => Effect.Effect<void, ProjectKnowledgeError>;
    /** Sent records only, for replaying earlier messages into a fresh provider conversation. */
    readonly readSentDeliveries: (input: {
      readonly projectId: ProjectId;
      readonly threadIds: ReadonlyArray<ProjectKnowledgeDelivery["threadId"]>;
      readonly runIds: ReadonlyArray<ProjectKnowledgeDelivery["runId"]>;
    }) => Effect.Effect<ReadonlyArray<ProjectKnowledgeDelivery>, ProjectKnowledgeError>;
  }
>()("t3/project/knowledge/ProjectKnowledge") {}

const encodeText = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeMutation = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ actor: KnowledgeOrigin, input: ProjectKnowledgeMutation })),
);
const encodeSearch = Schema.encodeSync(Schema.fromJsonString(ProjectKnowledgeSearchInput));
const encodeQuery = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      projectId: ProjectKnowledgeSearchInput.fields.projectId,
      query: Schema.String,
      entities: Schema.Array(Schema.String),
      entityMatch: Schema.String,
      includeArchived: Schema.Boolean,
      minTrust: Schema.Number,
      includeSuperseded: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
// Matches the default search minTrust, so the health strip counts what recall would skip.
const RECALL_THRESHOLD = 0.3;
const HISTORY_LIMIT = 50;
// Whole-project source checks read every cited fact; beyond this the count is partial.
const SOURCE_CHECK_LIMIT = 2000;
// Smallest batch of ranked facts whose citations recall checks at once.
const RESOLVE_BATCH = 20;
// How long a search ranking stays pageable and replayable.
const SEARCH_RECEIPT_TTL_MILLIS = 60 * 60 * 1000;
const excerpt = (content: string | null) => (content === null ? null : content.slice(0, 320));
const isKnowledgeError = Schema.is(ProjectKnowledgeError);
// One rule for both the single-source read and the batched list check, so a
// list badge never disagrees with what opening the citation shows.
const sourceUnavailableReason = (
  projectId: ProjectId,
  includeArchived: boolean,
  thread: {
    readonly projectId: string;
    readonly deletedAt: unknown;
    readonly archivedAt: unknown;
  } | null,
  message: { readonly role: string; readonly streaming: boolean } | undefined,
): KnowledgeSourceUnavailableReason | null => {
  if (thread === null) return "missing";
  if (thread.projectId !== projectId) return "wrong_project";
  if (thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null && !includeArchived) return "archived";
  if (!message || (message.role !== "user" && message.role !== "assistant")) return "missing";
  if (message.streaming) return "streaming";
  return null;
};
const storageError = (projectId: ProjectId) => (cause: unknown) =>
  isKnowledgeError(cause)
    ? cause
    : new ProjectKnowledgeError({ reason: "storage", projectId, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Digest.Digest;
  const digest = Effect.fn("ProjectKnowledge.digest")((text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode)),
  );
  const store = yield* makeStore;
  const holographic = yield* HolographicMemory.HolographicMemory;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadSearch.ThreadSearch;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const requireProject = Effect.fn("ProjectKnowledge.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects.get(projectId).pipe(Effect.mapError(storageError(projectId)));
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new ProjectKnowledgeError({ reason: "missing_project", projectId });
  });
  const readSources: ProjectKnowledge["Service"]["readSources"] = Effect.fn(
    "ProjectKnowledge.readSources",
  )(function* (input) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError(storageError(input.projectId)));
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return input.sources.map(() => ({
        state: "unavailable" as const,
        reason: "deleted" as const,
      }));
    if (input.sources.length === 0) return [];
    const projection = yield* projections
      .getThreadRecords(input.threadId, ["messages"], {
        messageIds: input.sources.map((source) => source.messageId),
      })
      .pipe(
        Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        Effect.mapError(storageError(input.projectId)),
      );
    const rolledBack = yield* sql<{ messageId: string }>`
      SELECT message.message_id AS "messageId"
      FROM orchestration_v2_projection_messages AS message
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = message.run_id
      WHERE message.thread_id = ${input.threadId} AND run.status = 'rolled_back'
        AND ${sql.in(
          "message.message_id",
          input.sources.map((source) => source.messageId),
        )}
    `.pipe(Effect.mapError(storageError(input.projectId)));
    const excluded = new Set(rolledBack.map((row) => row.messageId));
    const messages = new Map(
      projection?.messages
        .filter((message) => !excluded.has(message.id))
        .map((message) => [message.id, message]),
    );
    return yield* Effect.forEach(
      input.sources,
      // Per source inside the batch, which already has its span.
      Effect.fnUntraced(function* (source): Effect.fn.Return<
        ProjectKnowledgeSource,
        ProjectKnowledgeError
      > {
        const message = messages.get(source.messageId);
        const reason = sourceUnavailableReason(
          input.projectId,
          input.includeArchived ?? false,
          projection?.thread ?? null,
          message,
        );
        if (reason !== null) return { state: "unavailable", reason };
        if (!projection || !message || (message.role !== "user" && message.role !== "assistant"))
          return { state: "unavailable", reason: "missing" };
        const contentDigest = yield* digest(message.text).pipe(
          Effect.mapError(storageError(input.projectId)),
        );
        if (source.digest !== undefined && source.digest !== contentDigest)
          return { state: "unavailable", reason: "changed" };
        return {
          state: "available",
          source: {
            kind: "message",
            threadId: input.threadId,
            messageId: source.messageId,
            digest: contentDigest,
          },
          text: message.text,
          title: projection.thread.title,
          role: message.role,
          createdAt: DateTime.formatIso(message.createdAt),
          archived: projection.thread.archivedAt !== null,
        };
      }),
    );
  });
  const readSource: ProjectKnowledge["Service"]["readSource"] = Effect.fn(
    "ProjectKnowledge.readSource",
  )(function* (input) {
    const [source] = yield* readSources({ ...input, sources: [input] });
    return source ?? { state: "unavailable", reason: "missing" };
  });
  const sourcesAvailable = Effect.fn("ProjectKnowledge.sourcesAvailable")(function* (
    fact: Pick<ProjectFact, "projectId" | "sources">,
    includeArchived: boolean,
  ) {
    for (const source of fact.sources) {
      if (source.kind === "user") continue;
      const result = yield* readSource({ projectId: fact.projectId, ...source, includeArchived });
      if (result.state !== "available") return false;
    }
    return true;
  });
  // Two set-based reads per page instead of a projection read per citation.
  const unavailableSources = Effect.fn("ProjectKnowledge.unavailableSources")(function* <
    K extends string,
  >(
    projectId: ProjectId,
    facts: ReadonlyArray<{ readonly id: K; readonly sources: ReadonlyArray<KnowledgeFactSource> }>,
    includeArchived = false,
  ) {
    const refs = facts.flatMap((fact) =>
      fact.sources.flatMap((source) =>
        source.kind === "message" ? [{ factId: fact.id, source }] : [],
      ),
    );
    if (refs.length === 0) return [];
    const project = yield* projects.get(projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return [...new Set(refs.map((ref) => ref.factId))].map((factId) => ({
        factId,
        reason: "deleted" as const,
      }));
    const threadRows = yield* sql<{
      readonly threadId: string;
      readonly projectId: string;
      readonly archivedAt: string | null;
      readonly deletedAt: string | null;
    }>`SELECT thread_id AS "threadId", project_id AS "projectId", archived_at AS "archivedAt",
        deleted_at AS "deletedAt"
      FROM orchestration_v2_projection_threads
      WHERE ${sql.in("thread_id", [...new Set(refs.map((ref) => ref.source.threadId))])}`;
    const messageRows = yield* sql<{
      readonly messageId: string;
      readonly threadId: string;
      readonly role: string;
      readonly streaming: number;
      readonly text: string | null;
    }>`SELECT message_id AS "messageId", thread_id AS "threadId", role, streaming,
        json_extract(payload_json, '$.text') AS text
      FROM orchestration_v2_projection_messages
      WHERE ${sql.in("message_id", [...new Set(refs.map((ref) => ref.source.messageId))])}
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
          WHERE run.run_id = orchestration_v2_projection_messages.run_id
            AND run.status = 'rolled_back')`;
    const threadsById = new Map(threadRows.map((row) => [row.threadId, row]));
    const messagesById = new Map(messageRows.map((row) => [row.messageId, row]));
    const digests = new Map<string, string>();
    const reasons = new Map<K, KnowledgeSourceUnavailableReason>();
    for (const { factId, source } of refs) {
      if (reasons.has(factId)) continue;
      const row = messagesById.get(source.messageId);
      const message = row?.threadId === source.threadId ? row : undefined;
      let reason = sourceUnavailableReason(
        projectId,
        includeArchived,
        threadsById.get(source.threadId) ?? null,
        message && { role: message.role, streaming: message.streaming !== 0 },
      );
      if (reason === null && message) {
        let contentDigest = digests.get(message.messageId);
        if (contentDigest === undefined) {
          contentDigest = yield* digest(message.text ?? "");
          digests.set(message.messageId, contentDigest);
        }
        if (contentDigest !== source.digest) reason = "changed";
      }
      if (reason !== null) reasons.set(factId, reason);
    }
    return [...reasons].map(([factId, reason]) => ({ factId, reason }));
  });
  const list: ProjectKnowledge["Service"]["list"] = Effect.fn("ProjectKnowledge.list")(
    function* (input) {
      yield* requireProject(input.projectId);
      const limit = input.limit ?? 50;
      // The lost-source filter matches the health count, which spans both active statuses.
      const status = input.status ?? (input.sourceState === "unavailable" ? null : "confirmed");
      const includeSuperseded = input.includeSuperseded ?? false;
      const onlyIds =
        input.sourceState === "unavailable"
          ? yield* store
              .citedFacts(input.projectId, status, includeSuperseded, SOURCE_CHECK_LIMIT)
              .pipe(
                Effect.flatMap((cited) => unavailableSources(input.projectId, cited)),
                Effect.map((items) => items.map((item) => item.factId)),
                Effect.mapError(storageError(input.projectId)),
              )
          : null;
      const rows = yield* store
        .list(
          input.projectId,
          status,
          input.afterId ?? null,
          limit + 1,
          includeSuperseded,
          onlyIds,
          input.origin ?? null,
        )
        .pipe(Effect.mapError(storageError(input.projectId)));
      const facts = rows.slice(0, limit);
      return {
        facts,
        nextCursor: rows.length > limit ? (facts.at(-1)?.id ?? null) : null,
        unavailableSources: yield* unavailableSources(input.projectId, facts).pipe(
          Effect.mapError(storageError(input.projectId)),
        ),
      };
    },
  );
  const mutate: ProjectKnowledge["Service"]["mutate"] = Effect.fn("ProjectKnowledge.mutate")(
    function* (input, actor) {
      const { projectId, factId } = input;
      const requestDigest = yield* digest(encodeMutation({ actor, input })).pipe(
        Effect.mapError(storageError(projectId)),
      );
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireProject(projectId);
            const prior = yield* store.receipt(input.commandId);
            const existing = yield* store.find(projectId, factId);
            if (prior !== null) {
              if (
                prior.projectId !== projectId ||
                prior.factId !== factId ||
                prior.digest !== requestDigest
              ) {
                return yield* new ProjectKnowledgeError({
                  reason: "command_reused",
                  projectId,
                  factId,
                });
              }
              const replayed =
                input.action === "supersede"
                  ? yield* store.find(projectId, input.replacementFactId)
                  : existing;
              if (replayed === null)
                return yield* new ProjectKnowledgeError({
                  reason: "missing_fact",
                  projectId,
                  factId,
                });
              return replayed;
            }
            if (input.action === "confirm" && actor.kind !== "user") {
              return yield* new ProjectKnowledgeError({
                reason: "user_confirmation_required",
                projectId,
                factId,
              });
            }
            if (
              input.action === "create" ||
              input.action === "edit" ||
              input.action === "supersede"
            ) {
              if (
                Buffer.byteLength(input.content) +
                  input.entities.reduce((size, entity) => size + Buffer.byteLength(entity), 0) >
                  16384 ||
                input.tags.some((tag) => Buffer.byteLength(tag) > 256)
              ) {
                return yield* new ProjectKnowledgeError({ reason: "fact_size", projectId, factId });
              }
              if (actor.kind !== "user" && input.sources.some((source) => source.kind === "user")) {
                return yield* new ProjectKnowledgeError({
                  reason: "invalid_source",
                  projectId,
                  factId,
                });
              }
              if (
                (actor.kind === "user" && input.sources.length === 0) ||
                !(yield* sourcesAvailable(input, true))
              ) {
                return yield* new ProjectKnowledgeError({
                  reason: "invalid_source",
                  projectId,
                  factId,
                });
              }
            }
            const now = DateTime.formatIso(yield* DateTime.now);
            const history = Effect.fn("ProjectKnowledge.recordHistory")(function* (
              fact: ProjectFact,
              event: HistoryRecord["event"],
              extra: Partial<HistoryRecord> = {},
            ) {
              const content = event === "created" || event === "edited" ? fact.content : null;
              yield* store.recordHistory({
                projectId,
                factId: fact.id,
                revision: fact.revision,
                event,
                actor,
                at: now,
                contentDigest: content === null ? null : yield* digest(content),
                content,
                sources: content === null ? [] : fact.sources,
                trustBefore: null,
                trustAfter: fact.trust,
                helpful: null,
                relatedFactId: null,
                ...extra,
              });
            });
            let fact: ProjectFact;
            if (input.action === "supersede") {
              if (existing === null)
                return yield* new ProjectKnowledgeError({
                  reason: "missing_fact",
                  projectId,
                  factId,
                });
              if (existing.status === "forgotten")
                return yield* new ProjectKnowledgeError({ reason: "forgotten", projectId, factId });
              if (existing.supersededBy != null)
                return yield* new ProjectKnowledgeError({
                  reason: "superseded",
                  projectId,
                  factId,
                });
              if (existing.revision !== input.expectedRevision)
                return yield* new ProjectKnowledgeError({
                  reason: "conflict",
                  projectId,
                  factId,
                  currentRevision: existing.revision,
                });
              const taken = yield* store.find(projectId, input.replacementFactId);
              if (taken !== null || input.replacementFactId === factId)
                return yield* new ProjectKnowledgeError({
                  reason: "conflict",
                  projectId,
                  factId: input.replacementFactId,
                });
              fact = {
                id: input.replacementFactId,
                projectId,
                content: input.content,
                entities: input.entities,
                tags: input.tags,
                kind: input.kind,
                sources: input.sources,
                origin: actor,
                status: actor.kind === "user" ? "confirmed" : "proposed",
                revision: 1,
                trust: 0.5,
                retrievalCount: 0,
                createdAt: now,
                updatedAt: now,
                forgottenAt: null,
                supersedes: factId,
                supersededBy: null,
              };
              const replaced: ProjectFact = {
                ...existing,
                revision: existing.revision + 1,
                updatedAt: now,
                supersededBy: fact.id,
              };
              yield* store.insert(fact);
              if (!(yield* store.update(replaced, input.expectedRevision)))
                return yield* new ProjectKnowledgeError({ reason: "conflict", projectId, factId });
              yield* history(replaced, "superseded", { relatedFactId: fact.id });
              yield* history(fact, "created", { relatedFactId: factId });
              yield* store.record(input.commandId, projectId, factId, requestDigest);
              return fact;
            }
            if (input.action === "create") {
              if (existing !== null)
                return yield* new ProjectKnowledgeError({
                  reason: existing.status === "forgotten" ? "forgotten" : "conflict",
                  projectId,
                  factId,
                  currentRevision: existing.revision,
                });
              fact = {
                id: factId,
                projectId,
                content: input.content,
                entities: input.entities,
                tags: input.tags,
                kind: input.kind,
                sources: input.sources,
                origin: actor,
                status: actor.kind === "user" ? "confirmed" : "proposed",
                revision: 1,
                trust: 0.5,
                retrievalCount: 0,
                createdAt: now,
                updatedAt: now,
                forgottenAt: null,
                supersedes: null,
                supersededBy: null,
              };
              yield* store.insert(fact);
              yield* history(fact, "created");
            } else {
              if (existing === null)
                return yield* new ProjectKnowledgeError({
                  reason: "missing_fact",
                  projectId,
                  factId,
                });
              if (existing.status === "forgotten")
                return yield* new ProjectKnowledgeError({ reason: "forgotten", projectId, factId });
              if (
                existing.supersededBy != null &&
                (input.action === "edit" || input.action === "confirm")
              )
                return yield* new ProjectKnowledgeError({
                  reason: "superseded",
                  projectId,
                  factId,
                });
              if (existing.revision !== input.expectedRevision)
                return yield* new ProjectKnowledgeError({
                  reason: "conflict",
                  projectId,
                  factId,
                  currentRevision: existing.revision,
                });
              fact = { ...existing, revision: existing.revision + 1, updatedAt: now };
              switch (input.action) {
                case "edit":
                  fact = {
                    ...fact,
                    content: input.content,
                    entities: input.entities,
                    tags: input.tags,
                    kind: input.kind,
                    sources: input.sources,
                    origin: actor,
                    status: actor.kind !== "user" ? "proposed" : existing.status,
                  };
                  break;
                case "confirm": {
                  if (!(yield* sourcesAvailable(existing, true)))
                    return yield* new ProjectKnowledgeError({
                      reason: "invalid_source",
                      projectId,
                      factId,
                    });
                  fact = { ...fact, status: "confirmed" };
                  // An assisted suggestion names the fact it would replace without touching it;
                  // confirming completes that replacement, or drops the link once the target is
                  // gone or already replaced.
                  const target =
                    existing.supersedes == null
                      ? null
                      : yield* store.find(projectId, existing.supersedes);
                  if (target !== null && target.supersededBy !== existing.id) {
                    if (target.status === "forgotten" || target.supersededBy != null) {
                      fact = { ...fact, supersedes: null };
                    } else {
                      const replaced: ProjectFact = {
                        ...target,
                        revision: target.revision + 1,
                        updatedAt: now,
                        supersededBy: existing.id,
                      };
                      if (!(yield* store.update(replaced, target.revision)))
                        return yield* new ProjectKnowledgeError({
                          reason: "conflict",
                          projectId,
                          factId: target.id,
                        });
                      yield* history(replaced, "superseded", { relatedFactId: existing.id });
                    }
                  }
                  break;
                }
                case "forget":
                  fact = {
                    ...fact,
                    status: "forgotten",
                    content: null,
                    entities: [],
                    tags: [],
                    sources: [],
                    forgottenAt: now,
                  };
                  break;
                case "feedback":
                  fact = {
                    ...fact,
                    trust: Math.max(0, Math.min(1, fact.trust + (input.helpful ? 0.05 : -0.1))),
                  };
                  break;
              }
              if (!(yield* store.update(fact, input.expectedRevision)))
                return yield* new ProjectKnowledgeError({ reason: "conflict", projectId, factId });
              switch (input.action) {
                case "edit":
                  yield* history(fact, "edited");
                  break;
                case "confirm":
                  yield* history(fact, "confirmed");
                  break;
                case "forget":
                  yield* store.eraseHistory(projectId, factId);
                  yield* store.scrubDeliveries(projectId, factId);
                  yield* history(fact, "forgotten");
                  break;
                case "feedback":
                  yield* history(fact, "feedback", {
                    trustBefore: existing.trust,
                    helpful: input.helpful,
                  });
                  break;
              }
            }
            yield* store.record(input.commandId, projectId, factId, requestDigest);
            return fact;
          }),
        )
        .pipe(Effect.mapError(storageError(projectId)));
    },
  );

  const resolveForTurn: ProjectKnowledge["Service"]["resolveForTurn"] = Effect.fn(
    "ProjectKnowledge.resolveForTurn",
  )(
    function* (input) {
      if (input.environmentId !== (yield* environment.getEnvironmentId))
        return yield* new ProjectKnowledgeError({
          reason: "wrong_environment",
          projectId: input.projectId,
        });
      yield* requireProject(input.projectId);
      const parts: string[] = [];
      const items: { label: string; text: string }[] = [];
      for (const selection of input.selections) {
        if (selection.kind === "message") {
          const source = yield* readSource({
            projectId: input.projectId,
            ...selection,
            includeArchived: input.includeArchived ?? false,
          });
          if (source.state !== "available")
            return yield* new ProjectKnowledgeError({
              reason: "stale_context",
              projectId: input.projectId,
            });
          parts.push(
            `[Message ${selection.threadId}/${selection.messageId} sha256:${selection.digest}]\n${source.text}`,
          );
          items.push({ label: `Message ${selection.messageId}`, text: source.text });
        } else {
          const fact = yield* store
            .find(input.projectId, selection.factId)
            .pipe(Effect.mapError(storageError(input.projectId)));
          if (
            fact === null ||
            fact.status === "forgotten" ||
            fact.revision !== selection.revision ||
            fact.content === null ||
            !(yield* sourcesAvailable(fact, input.includeArchived ?? false))
          ) {
            return yield* new ProjectKnowledgeError({
              reason: "stale_context",
              projectId: input.projectId,
              factId: selection.factId,
            });
          }
          const citations = fact.sources
            .flatMap((source) => (source.kind === "message" ? [source] : []))
            .map(
              (source) => `Message ${source.threadId}/${source.messageId} sha256:${source.digest}`,
            )
            .join("; ");
          items.push({ label: `Fact ${fact.id.slice(0, 8)}`, text: fact.content });
          const origin =
            fact.origin.kind === "user"
              ? "User assertion"
              : fact.origin.kind === "agent-thread"
                ? `Agent observation in thread ${fact.origin.threadId}`
                : fact.origin.kind === "assisted"
                  ? `Extracted from run ${fact.origin.runId} in thread ${fact.origin.threadId} (${fact.origin.runOutcome})`
                  : fact.origin.kind === "agent-client"
                    ? `Agent observation from ${fact.origin.label}`
                    : `Origin ${fact.origin.originKind}`;
          parts.push(
            `[Fact ${fact.id} revision:${fact.revision} status:${fact.status} trust:${fact.trust}; ${origin}${citations ? `; ${citations}` : ""}]\n${fact.content}`,
          );
        }
      }
      const text = `Selected project knowledge (quoted source material):\n\n${parts.join("\n\n")}`;
      const byteLength = Buffer.byteLength(text, "utf8");
      if (byteLength > input.maxBytes)
        return yield* new ProjectKnowledgeError({
          reason: "context_budget",
          projectId: input.projectId,
          byteLength,
        });
      return { context: input, text, byteLength, items };
    },
    (effect, input) =>
      sql.withTransaction(effect).pipe(Effect.mapError(storageError(input.projectId))),
  );
  const prepareContext: ProjectKnowledge["Service"]["prepareContext"] = Effect.fn(
    "ProjectKnowledge.prepareContext",
  )(function* (input) {
    const resolved = yield* resolveForTurn(input);
    const record = projectKnowledgeContextRecord(input);
    const text = projectComposerContextForProvider({
      text: formatComposerContextReference(record),
      records: [record],
      resolvedKnowledge: new Map([[record.contextId, resolved.text]]),
    });
    const byteLength = Buffer.byteLength(encodeText(text)) - Buffer.byteLength(encodeText(""));
    if (byteLength > input.maxBytes)
      return yield* new ProjectKnowledgeError({
        reason: "context_budget",
        projectId: input.projectId,
        byteLength,
      });
    return {
      context: input,
      text,
      byteLength,
      ...(resolved.items ? { items: resolved.items } : {}),
    };
  });
  const search: ProjectKnowledge["Service"]["search"] = Effect.fn("ProjectKnowledge.search")(
    function* (input) {
      yield* requireProject(input.projectId);
      const messages = yield* threads
        .search({
          ...input,
          ...(input.messageLimit === undefined ? {} : { limit: input.messageLimit }),
        })
        .pipe(Effect.mapError(storageError(input.projectId)));
      const entities = [
        ...new Set((input.entities ?? []).map((entity) => entity.toLowerCase())),
      ].sort();
      const minTrust = input.minTrust ?? 0.3;
      const queryDigest = yield* digest(
        encodeQuery({
          projectId: input.projectId,
          query: input.query,
          entities,
          entityMatch: input.entityMatch ?? "any",
          includeArchived: input.includeArchived ?? false,
          minTrust,
          ...(input.includeSuperseded ? { includeSuperseded: true } : {}),
        }),
      ).pipe(Effect.mapError(storageError(input.projectId)));
      const { cursor: _messageCursor, ...factInput } = input;
      const requestDigest = yield* digest(encodeSearch(factInput)).pipe(
        Effect.mapError(storageError(input.projectId)),
      );
      const searchedAt = yield* DateTime.now;
      const receiptsNotBefore = DateTime.formatIso(
        DateTime.subtract(searchedAt, { milliseconds: SEARCH_RECEIPT_TTL_MILLIS }),
      );
      const prior = yield* store
        .receipt(input.requestId, receiptsNotBefore)
        .pipe(Effect.mapError(storageError(input.projectId)));
      if (
        prior !== null &&
        (prior.projectId !== input.projectId ||
          prior.factId !== null ||
          prior.digest !== requestDigest ||
          prior.search === null)
      ) {
        return yield* new ProjectKnowledgeError({
          reason: "command_reused",
          projectId: input.projectId,
        });
      }
      const rootRequestId =
        prior?.search?.rootRequestId ?? input.factCursor?.requestId ?? input.requestId;
      const rootReceipt =
        rootRequestId === input.requestId
          ? prior
          : yield* store
              .receipt(rootRequestId, receiptsNotBefore)
              .pipe(Effect.mapError(storageError(input.projectId)));
      if (
        (input.factCursor !== undefined || prior !== null) &&
        (rootReceipt === null ||
          rootReceipt.projectId !== input.projectId ||
          rootReceipt.search?.ranking == null ||
          rootReceipt.search.queryDigest !== queryDigest ||
          (input.factCursor?.offset ?? 0) > rootReceipt.search.ranking.matches.length)
      ) {
        return yield* new ProjectKnowledgeError({
          reason: "invalid_cursor",
          projectId: input.projectId,
        });
      }
      let ranking = rootReceipt?.search?.ranking ?? null;
      if (ranking === null) {
        const candidates = yield* store
          .candidates(
            input.projectId,
            projectMemorySearchTokens(input.query),
            entities,
            minTrust,
            input.includeSuperseded ?? false,
          )
          .pipe(Effect.mapError(storageError(input.projectId)));
        const eligible = candidates.facts.filter(
          (fact): fact is typeof ActiveProjectFact.Type =>
            fact.status !== "forgotten" &&
            fact.content !== null &&
            // Model-extracted text reaches agents only after a user confirms it.
            !(fact.status === "proposed" && fact.origin.kind === "assisted") &&
            (entities.length === 0 ||
              (input.entityMatch === "all"
                ? entities.every((entity) =>
                    fact.entities.some((value) => value.toLowerCase() === entity),
                  )
                : entities.some((entity) =>
                    fact.entities.some((value) => value.toLowerCase() === entity),
                  ))),
        );
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const scored = yield* holographic
          .scoreCandidates({
            query: input.query,
            now,
            candidates: eligible.map((fact) => ({
              id: fact.id,
              content: fact.content,
              entities: fact.entities,
              tags: fact.tags,
              trust: fact.trust,
              updatedAt: Date.parse(fact.updatedAt),
              retrievalCount: fact.retrievalCount,
              ...(candidates.ranks.has(fact.id) ? { ftsRank: candidates.ranks.get(fact.id)! } : {}),
            })),
          })
          .pipe(
            Effect.map((scores) => ({ state: "available" as const, scores })),
            Effect.catchTags({
              HolographicMemoryError: (cause) =>
                cause.reason === "unavailable"
                  ? Effect.succeed({ state: "unavailable" as const })
                  : Effect.fail(
                      new ProjectKnowledgeError({
                        reason: "scoring",
                        projectId: input.projectId,
                        cause,
                      }),
                    ),
            }),
          );
        if (scored.state === "unavailable")
          return { messages, facts: { state: "unavailable", reason: "kernel_unavailable" } };
        const snapshots = new Map(eligible.map((fact) => [fact.id, fact]));
        const matches = scored.scores.flatMap((score) => {
          const fact = snapshots.get(ProjectFactId.make(score.id));
          if (!fact) return [];
          return [
            {
              factId: fact.id,
              revision: fact.revision,
              updatedAt: fact.updatedAt,
              scoreMillionths: score.scoreMillionths,
              score: {
                holographic: score.holographic,
                lexical: score.fts,
                tokenOverlap: score.tokenOverlap,
                temporalDecay: score.decay,
                reinforcement: score.reinforcement,
                trust: fact.trust,
                combined: score.score,
              },
            },
          ];
        });
        matches.sort(
          (left, right) =>
            right.scoreMillionths - left.scoreMillionths ||
            (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0) ||
            (left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0),
        );
        ranking = {
          matches: matches.map(({ factId, revision, score }) => ({ factId, revision, score })),
          coverage: candidates.partial ? "partial" : "complete",
        };
      }
      const initialRanking = ranking;
      const limit = input.limit ?? 20;
      const recallable = (
        fact: ProjectFact | undefined,
        revision: number,
      ): fact is typeof ActiveProjectFact.Type =>
        fact !== undefined &&
        fact.revision === revision &&
        fact.status !== "forgotten" &&
        fact.content !== null &&
        (fact.supersededBy == null || input.includeSuperseded === true);
      // Walks ranked positions in order and checks citations a batch at a time, so a page reads
      // sources for about as many facts as it returns instead of for the whole ranking.
      const resolveMatches = Effect.fn("ProjectKnowledge.resolveMatches")(function* (
        searchReceipt: SearchReceipt | null,
      ) {
        const ranked = searchReceipt?.ranking ?? initialRanking;
        const positions =
          searchReceipt?.positions ??
          ranked.matches.map((_, position) => position).slice(input.factCursor?.offset ?? 0);
        // A fresh page looks one past the limit to know whether a continuation exists.
        const take = searchReceipt === null ? limit + 1 : positions.length;
        const resolved: Array<{
          readonly fact: typeof ActiveProjectFact.Type;
          readonly score: typeof KnowledgeScore.Type;
          readonly position: number;
        }> = [];
        let next = 0;
        while (resolved.length < take && next < positions.length) {
          const batch = positions.slice(
            next,
            next + Math.max(take - resolved.length, RESOLVE_BATCH),
          );
          next += batch.length;
          const current = new Map(
            (yield* store.findMany(
              input.projectId,
              batch.map((position) => ranked.matches[position]!.factId),
            )).map((fact) => [fact.id, fact]),
          );
          const candidates = batch.flatMap((position) => {
            const match = ranked.matches[position]!;
            const fact = current.get(match.factId);
            return recallable(fact, match.revision) ? [{ fact, score: match.score, position }] : [];
          });
          const lost = new Set(
            (yield* unavailableSources(
              input.projectId,
              candidates.map((candidate) => candidate.fact),
              input.includeArchived ?? false,
            )).map((item) => item.factId),
          );
          for (const candidate of candidates)
            if (!lost.has(candidate.fact.id) && resolved.length < take) resolved.push(candidate);
        }
        return { ranked, resolved };
      });
      // Citation checks are reads; they run before the write transaction, which only re-reads
      // the rows of the facts it returns.
      const early = yield* resolveMatches(prior?.search ?? null).pipe(
        Effect.mapError(storageError(input.projectId)),
      );
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireProject(input.projectId);
            const receipt = yield* store.receipt(input.requestId, receiptsNotBefore);
            if (
              receipt !== null &&
              (receipt.projectId !== input.projectId ||
                receipt.factId !== null ||
                receipt.digest !== requestDigest)
            ) {
              return yield* new ProjectKnowledgeError({
                reason: "command_reused",
                projectId: input.projectId,
              });
            }
            const searchReceipt = receipt?.search ?? null;
            // A duplicate request can commit its receipt after the early read; follow it.
            const { ranked, resolved } =
              (searchReceipt === null) === (prior?.search == null)
                ? early
                : yield* resolveMatches(searchReceipt);
            const page = searchReceipt === null ? resolved.slice(0, limit) : resolved;
            const current = new Map(
              (yield* store.findMany(
                input.projectId,
                page.map((match) => match.fact.id),
              )).map((fact) => [fact.id, fact]),
            );
            const selected = page.flatMap((match) => {
              const fact = current.get(match.fact.id);
              return recallable(fact, match.fact.revision) ? [{ ...match, fact }] : [];
            });
            const last = page.at(-1);
            const nextOffset =
              searchReceipt === null
                ? resolved.length > page.length && last !== undefined
                  ? last.position + 1
                  : null
                : searchReceipt.nextOffset;
            const reinforce = receipt === null && input.recordRetrieval !== false;
            if (reinforce)
              yield* store.recordRetrieval(
                input.projectId,
                selected.map((match) => match.fact.id),
              );
            if (receipt === null) {
              yield* store.recordSearch(
                input.requestId,
                input.projectId,
                requestDigest,
                {
                  rootRequestId,
                  queryDigest,
                  ranking: input.factCursor === undefined ? ranked : null,
                  positions: selected.map((match) => match.position),
                  nextOffset,
                },
                DateTime.formatIso(searchedAt),
                receiptsNotBefore,
              );
            }
            return {
              messages,
              facts: {
                state: "available" as const,
                matches: selected.map(({ fact, score }) => ({
                  fact: reinforce ? { ...fact, retrievalCount: fact.retrievalCount + 1 } : fact,
                  score,
                })),
                coverage: ranked.coverage,
                nextCursor:
                  nextOffset === null ? null : { requestId: rootRequestId, offset: nextOffset },
              },
            };
          }),
        )
        .pipe(Effect.mapError(storageError(input.projectId)));
    },
  );
  const recordDelivery: ProjectKnowledge["Service"]["recordDelivery"] = Effect.fn(
    "ProjectKnowledge.recordDelivery",
  )(function* (delivery) {
    const checked = yield* revalidateDelivery(delivery).pipe(
      Effect.mapError(storageError(delivery.projectId)),
    );
    yield* store.recordDelivery(checked).pipe(Effect.mapError(storageError(delivery.projectId)));
  });
  // A fact edit is not a source edit: check the citations of the revision actually sent.
  // Scrubbing is monotone, so restoring a thread cannot restore retained excerpts.
  const revalidateDelivery = Effect.fn("ProjectKnowledge.revalidateDelivery")(function* (
    delivery: ProjectKnowledgeDelivery,
  ) {
    const project = yield* projects.get(delivery.projectId);
    const projectUnavailable = Option.isNone(project) || project.value.deletedAt !== null;
    const items = [];
    const omissions = [...delivery.omissions];
    for (const item of delivery.items) {
      let unavailable = projectUnavailable;
      for (const selection of item.context.selections) {
        if (selection.kind === "message") {
          const source = yield* readSource({
            projectId: delivery.projectId,
            ...selection,
            includeArchived: true,
          });
          unavailable ||= source.state !== "available";
        } else {
          const fact = yield* store.find(delivery.projectId, selection.factId);
          const sources =
            fact === null || fact.status === "forgotten" || fact.revision < selection.revision
              ? null
              : fact.revision === selection.revision
                ? fact.sources
                : yield* store.sourcesAtRevision(
                    delivery.projectId,
                    selection.factId,
                    selection.revision,
                  );
          unavailable ||= sources === null;
          if (sources !== null) {
            const lost = yield* unavailableSources(
              delivery.projectId,
              [{ id: selection.factId, sources }],
              true,
            );
            unavailable ||= lost.length > 0;
          }
        }
      }
      if (
        unavailable &&
        !omissions.some(
          (omission) =>
            omission.contextId === item.contextId && omission.reason === "source_unavailable",
        )
      )
        omissions.push({
          contextId: item.contextId,
          label: item.label,
          reason: "source_unavailable",
        });
      items.push(
        unavailable &&
          !item.contentRemoved &&
          item.text !== "[Source unavailable: removed or changed.]"
          ? { ...item, text: "[Source unavailable: removed or changed.]" }
          : item,
      );
    }
    const checked = { ...delivery, items, omissions };
    if (
      omissions.length !== delivery.omissions.length ||
      items.some((item, index) => item !== delivery.items[index])
    )
      yield* store
        .replaceDeliveryItems(checked, delivery)
        .pipe(Effect.mapError(storageError(delivery.projectId)));
    return checked;
  });
  const scrubDeliveryPage: ProjectKnowledge["Service"]["scrubDeliveryPage"] = Effect.fn(
    "ProjectKnowledge.scrubDeliveryPage",
  )(function* (input) {
    // Each continuation releases the maintenance worker instead of walking a whole project.
    const limit = 50;
    const page = yield* store
      .deliveryPage(input.projectId, input.afterId, limit)
      .pipe(Effect.mapError(storageError(input.projectId)));
    yield* Effect.forEach(page.deliveries, revalidateDelivery, { discard: true }).pipe(
      Effect.mapError(storageError(input.projectId)),
    );
    return page.afterId;
  });
  const readSentDeliveries: ProjectKnowledge["Service"]["readSentDeliveries"] = Effect.fn(
    "ProjectKnowledge.readSentDeliveries",
  )(function* (input) {
    const rows = yield* store
      .sentDeliveries(input.projectId, input.threadIds, input.runIds)
      .pipe(Effect.mapError(storageError(input.projectId)));
    return yield* Effect.forEach(rows, revalidateDelivery).pipe(
      Effect.mapError(storageError(input.projectId)),
    );
  });
  const readDeliveryState: ProjectKnowledge["Service"]["readDeliveryState"] = Effect.fn(
    "ProjectKnowledge.readDeliveryState",
  )((input) => store.readDeliveryState(input).pipe(Effect.mapError(storageError(input.projectId))));
  const nativeDeliveryEstimate: ProjectKnowledge["Service"]["nativeDeliveryEstimate"] = Effect.fn(
    "ProjectKnowledge.nativeDeliveryEstimate",
  )((input) =>
    store.nativeDeliveryEstimate(input).pipe(Effect.mapError(storageError(input.projectId))),
  );
  const markDeliveryUncertain: ProjectKnowledge["Service"]["markDeliveryUncertain"] = Effect.fn(
    "ProjectKnowledge.markDeliveryUncertain",
  )(function* (input) {
    yield* store
      .markDeliveryUncertain(input, DateTime.formatIso(yield* DateTime.now))
      .pipe(Effect.mapError(storageError(input.projectId)));
  });
  const readDeliveries: ProjectKnowledge["Service"]["readDeliveries"] = Effect.fn(
    "ProjectKnowledge.readDeliveries",
  )(function* (input) {
    yield* requireProject(input.projectId);
    const rows = yield* store
      .deliveries(input.projectId, input.threadId, input.messageId)
      .pipe(Effect.mapError(storageError(input.projectId)));
    const facts = new Map<ProjectFactId, ProjectFact | null>();
    const selectionState = Effect.fn("ProjectKnowledge.deliveredSelectionState")(function* (
      context: ProjectKnowledgeContext,
    ) {
      const states = new Set<"changed" | "forgotten" | "unavailable">();
      for (const selection of context.selections) {
        if (selection.kind === "message") {
          const source = yield* readSource({
            projectId: input.projectId,
            ...selection,
            includeArchived: context.includeArchived ?? false,
          });
          if (source.state === "unavailable")
            states.add(source.reason === "changed" ? "changed" : "unavailable");
          continue;
        }
        if (!facts.has(selection.factId))
          facts.set(
            selection.factId,
            yield* store
              .find(input.projectId, selection.factId)
              .pipe(Effect.mapError(storageError(input.projectId))),
          );
        const fact = facts.get(selection.factId);
        if (!fact) states.add("unavailable");
        else if (fact.status === "forgotten") states.add("forgotten");
        else if (fact.revision !== selection.revision) states.add("changed");
        else {
          // A fact's revision does not move when the message it cites is edited or removed.
          const [lost] = yield* unavailableSources(
            input.projectId,
            [fact],
            context.includeArchived ?? false,
          ).pipe(Effect.mapError(storageError(input.projectId)));
          if (lost) states.add(lost.reason === "changed" ? "changed" : "unavailable");
        }
      }
      return states.has("forgotten")
        ? ("forgotten" as const)
        : states.has("unavailable")
          ? ("unavailable" as const)
          : states.has("changed")
            ? ("changed" as const)
            : ("current" as const);
    });
    const deliveries = [];
    for (const original of rows) {
      const row = yield* revalidateDelivery(original).pipe(
        Effect.mapError(storageError(input.projectId)),
      );
      const items = [];
      for (const item of row.items)
        items.push({ ...item, current: yield* selectionState(item.context) });
      deliveries.push({ ...row, items });
    }
    return { deliveries };
  });
  const hintsForContent = Effect.fn("ProjectKnowledge.hintsForContent")(function* (
    projectId: ProjectId,
    content: string,
    excludeIds: ReadonlyArray<ProjectFactId>,
  ) {
    // The longest tokens are the most selective; a fact can tokenize into hundreds of terms.
    const terms = projectMemorySearchTokens(content)
      .toSorted((left, right) => right.length - left.length || (left < right ? -1 : 1))
      .slice(0, 24);
    const candidates = yield* store.similar(projectId, terms, excludeIds);
    return conflictHints(
      content,
      candidates.flatMap((candidate) =>
        candidate.content === null
          ? []
          : [{ id: candidate.id, revision: candidate.revision, content: candidate.content }],
      ),
    );
  });
  const hintsFor = Effect.fn("ProjectKnowledge.hintsFor")(function* (fact: ProjectFact) {
    if (fact.content === null || fact.supersededBy != null) return [];
    return yield* hintsForContent(
      fact.projectId,
      fact.content,
      [fact.id, fact.supersedes, fact.supersededBy].filter((id): id is ProjectFactId => id != null),
    );
  });
  const proposeAssisted: ProjectKnowledge["Service"]["proposeAssisted"] = Effect.fn(
    "ProjectKnowledge.proposeAssisted",
  )(function* (input, actor) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // A retry reuses the same fact id, so a forgotten or reviewed proposal stays as it is.
          if ((yield* store.find(input.projectId, input.factId)) !== null)
            return { outcome: "existing" as const };
          const hints = yield* hintsForContent(input.projectId, input.content, [input.factId]);
          if (hints.some((hint) => hint.kind === "duplicate"))
            return { outcome: "duplicate" as const };
          const created = yield* mutate(input, actor);
          const target = hints[0];
          if (target === undefined) return { outcome: "proposed" as const };
          if (!(yield* store.update({ ...created, supersedes: target.factId }, created.revision)))
            return yield* new ProjectKnowledgeError({
              reason: "conflict",
              projectId: input.projectId,
              factId: input.factId,
            });
          return { outcome: "suggested" as const };
        }),
      )
      .pipe(Effect.mapError(storageError(input.projectId)));
  });
  const hasAssistedRun: ProjectKnowledge["Service"]["hasAssistedRun"] = (projectId, runId) =>
    store.assistedRunRecorded(runId).pipe(Effect.mapError(storageError(projectId)));
  const recordAssistedRun: ProjectKnowledge["Service"]["recordAssistedRun"] = (projectId, run) =>
    store.recordAssistedRun(projectId, run).pipe(Effect.mapError(storageError(projectId)));
  const mutateWithHints: ProjectKnowledge["Service"]["mutateWithHints"] = Effect.fn(
    "ProjectKnowledge.mutateWithHints",
  )(function* (input, actor) {
    const fact = yield* mutate(input, actor);
    if (input.action !== "create" && input.action !== "edit" && input.action !== "supersede")
      return fact;
    const hints: ReadonlyArray<KnowledgeConflictHint> = yield* hintsFor(fact).pipe(
      Effect.mapError(storageError(input.projectId)),
    );
    return { ...fact, hints };
  });
  const readFact: ProjectKnowledge["Service"]["readFact"] = Effect.fn("ProjectKnowledge.readFact")(
    function* (input) {
      yield* requireProject(input.projectId);
      return yield* Effect.gen(function* () {
        const fact = yield* store.find(input.projectId, input.factId);
        if (fact === null)
          return yield* new ProjectKnowledgeError({
            reason: "missing_fact",
            projectId: input.projectId,
            factId: input.factId,
          });
        const rows = yield* store.history(input.projectId, input.factId, HISTORY_LIMIT + 1);
        const history = rows.slice(-HISTORY_LIMIT);
        const reasons = new Map(
          (yield* unavailableSources(input.projectId, [
            { id: "fact", sources: fact.sources },
            ...history.map((entry) => ({ id: String(entry.sequence), sources: entry.sources })),
          ])).map((item) => [item.factId, item.reason]),
        );
        const linked = new Map(
          (yield* store.findMany(
            input.projectId,
            [fact.supersedes, fact.supersededBy].filter((id): id is ProjectFactId => id != null),
          )).map((linkedFact) => [
            linkedFact.id,
            {
              id: linkedFact.id,
              status: linkedFact.status,
              revision: linkedFact.revision,
              excerpt: excerpt(linkedFact.content),
            },
          ]),
        );
        return {
          fact,
          sourceUnavailable: reasons.get("fact") ?? null,
          history: history.map((entry) => ({
            ...entry,
            sourceUnavailable: reasons.get(String(entry.sequence)) ?? null,
          })),
          historyTruncated: rows.length > HISTORY_LIMIT,
          supersedes: (fact.supersedes && linked.get(fact.supersedes)) ?? null,
          supersededBy: (fact.supersededBy && linked.get(fact.supersededBy)) ?? null,
          hints: yield* hintsFor(fact),
        };
      }).pipe(Effect.mapError(storageError(input.projectId)));
    },
  );
  const status: ProjectKnowledge["Service"]["status"] = Effect.fn("ProjectKnowledge.status")(
    function* (input) {
      yield* requireProject(input.projectId);
      return yield* Effect.gen(function* () {
        const counts = yield* store.statusCounts(input.projectId, RECALL_THRESHOLD);
        const assistedLearning = yield* store.assistedStatus(input.projectId);
        const cited = yield* store.citedFacts(input.projectId, null, false, SOURCE_CHECK_LIMIT + 1);
        const unavailable = yield* unavailableSources(
          input.projectId,
          cited.slice(0, SOURCE_CHECK_LIMIT),
        );
        return {
          counts: {
            proposed: counts.proposed,
            confirmed: counts.confirmed,
            superseded: counts.superseded,
            forgotten: counts.forgotten,
          },
          trustBands: {
            low: counts.low,
            guarded: counts.guarded,
            steady: counts.steady,
            high: counts.high,
          },
          recallThreshold: RECALL_THRESHOLD,
          belowRecallThreshold: counts.belowRecallThreshold,
          retrievals: counts.retrievals,
          feedback: { helpful: counts.helpful, unhelpful: counts.unhelpful },
          unavailableSources: unavailable.length,
          unavailableSourcesCoverage:
            cited.length > SOURCE_CHECK_LIMIT ? ("partial" as const) : ("complete" as const),
          assistedLearning,
        };
      }).pipe(Effect.mapError(storageError(input.projectId)));
    },
  );
  return ProjectKnowledge.of({
    list,
    mutate,
    mutateWithHints,
    readFact,
    status,
    readSource,
    readSources,
    search,
    prepareContext,
    resolveForTurn,
    recordDelivery,
    readDeliveries,
    readDeliveryState,
    nativeDeliveryEstimate,
    markDeliveryUncertain,
    readSentDeliveries,
    scrubDeliveryPage,
    proposeAssisted,
    hasAssistedRun,
    recordAssistedRun,
  });
});
export const layer = Layer.effect(ProjectKnowledge, make);
export const layerDeliveryScrubber = Layer.effect(
  DeliveryScrubRunner,
  Effect.map(ProjectKnowledge, (knowledge) => ({ scrubPage: knowledge.scrubDeliveryPage })),
);
