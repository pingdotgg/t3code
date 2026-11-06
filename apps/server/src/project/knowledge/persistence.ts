import {
  ActiveProjectFact,
  AssistedLearningRun,
  CommandId,
  KnowledgeDigest,
  KnowledgeScore,
  NonNegativeInt,
  PositiveInt,
  KnowledgeFactSource,
  KnowledgeOrigin,
  ProjectFact,
  ProjectFactHistoryEntry,
  ProjectFactId,
  ProjectFactStatus,
  ProjectId,
  ProjectKnowledgeDelivery,
  ProjectKnowledgeDeliveryBudget,
  ProjectKnowledgeDeliveryItem,
  ProjectKnowledgeDeliveryOmission,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { normalizeFactContent } from "./knowledgeConflicts.ts";

const encodeDeliveryBudget = Schema.encodeEffect(
  Schema.fromJsonString(ProjectKnowledgeDeliveryBudget),
);

const decodeAssistedRuns = Schema.decodeUnknownEffect(Schema.Array(AssistedLearningRun));
const SearchRanking = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({ factId: ProjectFactId, revision: PositiveInt, score: KnowledgeScore }),
  ).check(Schema.isMaxLength(1000)),
  coverage: Schema.Literals(["complete", "partial"]),
});
const SearchReceipt = Schema.Struct({
  rootRequestId: CommandId,
  queryDigest: KnowledgeDigest,
  ranking: Schema.NullOr(SearchRanking),
  positions: Schema.Array(NonNegativeInt).check(Schema.isMaxLength(50)),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type SearchReceipt = typeof SearchReceipt.Type;
const MAX_SEARCH_RECEIPTS = 100;
const ReceiptRow = Schema.Struct({
  projectId: ProjectId,
  factId: Schema.NullOr(ProjectFactId),
  digest: KnowledgeDigest,
  search: Schema.NullOr(Schema.fromJsonString(SearchReceipt)),
});
const decodeReceipts = Schema.decodeUnknownEffect(Schema.Array(ReceiptRow));
const encodeSearchReceipt = Schema.encodeSync(Schema.fromJsonString(SearchReceipt));

const FactRow = Schema.Struct({
  ...ActiveProjectFact.fields,
  content: Schema.NullOr(Schema.String),
  status: ProjectFactStatus,
  forgottenAt: Schema.NullOr(Schema.String),
  entities: Schema.fromJsonString(ActiveProjectFact.fields.entities),
  tags: Schema.fromJsonString(ActiveProjectFact.fields.tags),
  origin: Schema.fromJsonString(KnowledgeOrigin),
  sources: Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
});
const encodeOrigin = Schema.encodeSync(Schema.fromJsonString(KnowledgeOrigin));
const encodeLabels = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeSources = Schema.encodeSync(Schema.fromJsonString(Schema.Array(KnowledgeFactSource)));
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(FactRow));
const decodeProjectFacts = Schema.decodeUnknownEffect(Schema.Array(ProjectFact));
const decodeFacts = Effect.fn("ProjectKnowledgeStore.decodeFacts")(function* (rows: unknown) {
  return yield* decodeProjectFacts(yield* decodeRows(rows));
});

const HistoryRow = Schema.Struct({
  ...ProjectFactHistoryEntry.fields,
  actor: Schema.fromJsonString(KnowledgeOrigin),
  sources: Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
  helpful: Schema.NullOr(Schema.Number),
});
const decodeHistory = Schema.decodeUnknownEffect(Schema.Array(HistoryRow));
const decodeSources = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(KnowledgeFactSource)),
);
export type HistoryRecord = Omit<
  ProjectFactHistoryEntry,
  "sequence" | "sourceUnavailable" | "at" | "event"
> & {
  readonly projectId: ProjectId;
  readonly factId: ProjectFactId;
  readonly event: Exclude<ProjectFactHistoryEntry["event"], "baseline">;
  readonly at: string;
};

const DeliveryRow = Schema.Struct({
  ...ProjectKnowledgeDelivery.fields,
  budget: Schema.NullOr(Schema.fromJsonString(ProjectKnowledgeDeliveryBudget)),
  providerThreadId: Schema.NullOr(ProjectKnowledgeDelivery.fields.providerThreadId),
  items: Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryItem)),
  omissions: Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryOmission)),
});
const decodeDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
export type DeliveryStateInput = Pick<
  ProjectKnowledgeDelivery,
  | "projectId"
  | "threadId"
  | "messageId"
  | "attemptId"
  | "providerInstanceId"
  | "providerThreadId"
  | "nativeThreadId"
> & { readonly scope: "native-conversation" | "attempt" };
export interface DeliveryState {
  readonly sent: boolean;
  readonly sentThisAttempt: boolean;
  readonly uncertain: boolean;
}
export type NativeDeliveryEstimateInput = Pick<
  ProjectKnowledgeDelivery,
  "projectId" | "threadId" | "providerInstanceId" | "providerThreadId" | "nativeThreadId"
>;
const DeliveryCursor = Schema.fromJsonString(
  Schema.Struct({
    attemptId: ProjectKnowledgeDelivery.fields.attemptId,
    messageId: ProjectKnowledgeDelivery.fields.messageId,
  }),
);
const decodeDeliveryCursor = Schema.decodeUnknownEffect(DeliveryCursor);
const encodeDeliveryCursor = Schema.encodeSync(DeliveryCursor);
const decodeDeliveryItems = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryItem)),
);
const encodeDeliveryItems = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryItem)),
);
const encodeDeliveryOmissions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ProjectKnowledgeDeliveryOmission)),
);

/** Blanks the excerpt of every item that selects a forgotten fact; returns the input if none do. */
const withoutForgotten = (
  items: ReadonlyArray<ProjectKnowledgeDeliveryItem>,
  forgotten: ReadonlySet<string>,
) => {
  const selectsForgotten = (item: ProjectKnowledgeDeliveryItem) =>
    !item.contentRemoved &&
    item.context.selections.some(
      (selection) => selection.kind === "fact" && forgotten.has(selection.factId),
    );
  if (!items.some(selectsForgotten)) return items;
  return items.map((item) =>
    selectsForgotten(item) ? { ...item, text: "", contentRemoved: true } : item,
  );
};

export const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql`
    id, project_id AS "projectId", status, revision, content,
    entities_json AS entities, tags_json AS tags, kind, trust,
    retrieval_count AS "retrievalCount", created_at AS "createdAt",
    updated_at AS "updatedAt", forgotten_at AS "forgottenAt", sources_json AS sources, origin_json AS origin,
    supersedes_id AS supersedes, superseded_by_id AS "supersededBy"
  `;
  const find = Effect.fn("ProjectKnowledgeStore.find")(function* (
    projectId: ProjectId,
    id: ProjectFactId,
  ) {
    const rows =
      yield* sql`SELECT ${columns} FROM project_knowledge_facts WHERE project_id = ${projectId} AND id = ${id}`;
    return (yield* decodeFacts(rows))[0] ?? null;
  });
  const list = Effect.fn("ProjectKnowledgeStore.list")(function* (
    projectId: ProjectId,
    status: ProjectFact["status"],
    afterId: string | null,
    limit: number,
    includeSuperseded: boolean,
    onlyIds: ReadonlyArray<ProjectFactId> | null = null,
    origin: KnowledgeOrigin["kind"] | null = null,
  ) {
    if (onlyIds !== null && onlyIds.length === 0) return [];
    return yield* sql`
      SELECT ${columns} FROM project_knowledge_facts
      WHERE project_id = ${projectId}
        AND status = ${status}
        AND (${afterId} IS NULL OR id > ${afterId})
        AND (${includeSuperseded ? 1 : 0} = 1 OR status = 'forgotten' OR superseded_by_id IS NULL)
        AND ${onlyIds === null ? sql`1 = 1` : sql.in("id", onlyIds)}
        AND ${origin === null ? sql`1 = 1` : sql`json_extract(origin_json, '$.kind') = ${origin}`}
      ORDER BY id ASC LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeFacts));
  });
  const insert = Effect.fn("ProjectKnowledgeStore.insert")(function* (fact: ProjectFact) {
    yield* sql`INSERT INTO project_knowledge_facts (
      id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
      retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json,
      supersedes_id, superseded_by_id
    ) VALUES (
      ${fact.id}, ${fact.projectId}, ${fact.status}, ${fact.revision}, ${fact.content},
      ${encodeLabels(fact.entities)}, ${encodeLabels(fact.tags)}, ${fact.kind}, ${fact.trust},
      ${fact.retrievalCount}, ${fact.createdAt}, ${fact.updatedAt}, ${fact.forgottenAt}, ${encodeSources(fact.sources)}, ${encodeOrigin(fact.origin)},
      ${fact.supersedes ?? null}, ${fact.supersededBy ?? null}
    )`;
  });
  const update = Effect.fn("ProjectKnowledgeStore.update")(function* (
    fact: ProjectFact,
    expectedRevision: number,
  ) {
    const changed = yield* sql`UPDATE project_knowledge_facts SET
      status = ${fact.status}, revision = ${fact.revision}, content = ${fact.content},
      entities_json = ${encodeLabels(fact.entities)}, tags_json = ${encodeLabels(fact.tags)},
      kind = ${fact.kind}, trust = ${fact.trust}, updated_at = ${fact.updatedAt},
      forgotten_at = ${fact.forgottenAt}, sources_json = ${encodeSources(fact.sources)}, origin_json = ${encodeOrigin(fact.origin)},
      supersedes_id = ${fact.supersedes ?? null}, superseded_by_id = ${fact.supersededBy ?? null}
      WHERE id = ${fact.id} AND project_id = ${fact.projectId} AND revision = ${expectedRevision}
      RETURNING id`;
    return changed.length === 1;
  });
  // A search receipt older than searchNotBefore reads as absent: its cursor has expired.
  const receipt = Effect.fn("ProjectKnowledgeStore.receipt")(function* (
    commandId: string,
    searchNotBefore: string | null = null,
  ) {
    const rows = yield* sql`
      SELECT project_id AS "projectId", fact_id AS "factId", request_digest AS digest, search_json AS search
      FROM project_knowledge_commands WHERE command_id = ${commandId}
        AND (${searchNotBefore} IS NULL OR search_json IS NULL OR created_at >= ${searchNotBefore})`;
    return (yield* decodeReceipts(rows))[0] ?? null;
  });
  const record = Effect.fn("ProjectKnowledgeStore.record")(function* (
    commandId: string,
    projectId: ProjectId,
    factId: ProjectFactId | null,
    digest: string,
  ) {
    yield* sql`INSERT INTO project_knowledge_commands (command_id, project_id, fact_id, request_digest)
      VALUES (${commandId}, ${projectId}, ${factId}, ${digest})`;
  });
  // Search receipts are paging state, not history: each write drops expired ones and keeps at
  // most MAX_SEARCH_RECEIPTS, which bounds their total size.
  const recordSearch = Effect.fn("ProjectKnowledgeStore.recordSearch")(function* (
    commandId: string,
    projectId: ProjectId,
    digest: string,
    search: SearchReceipt,
    createdAt: string,
    notBefore: string,
  ) {
    yield* sql`DELETE FROM project_knowledge_commands
      WHERE search_json IS NOT NULL AND (created_at < ${notBefore} OR command_id NOT IN (
        SELECT command_id FROM project_knowledge_commands WHERE search_json IS NOT NULL
        ORDER BY created_at DESC LIMIT ${MAX_SEARCH_RECEIPTS - 1}
      ))`;
    yield* sql`INSERT INTO project_knowledge_commands (command_id, project_id, fact_id, request_digest, search_json, created_at)
      VALUES (${commandId}, ${projectId}, NULL, ${digest}, ${encodeSearchReceipt(search)}, ${createdAt})`;
  });
  const findMany = Effect.fn("ProjectKnowledgeStore.findMany")(function* (
    projectId: ProjectId,
    ids: ReadonlyArray<ProjectFactId>,
  ) {
    if (ids.length === 0) return [];
    return yield* sql`SELECT ${columns} FROM project_knowledge_facts WHERE project_id = ${projectId} AND ${sql.in("id", ids)}`.pipe(
      Effect.flatMap(decodeFacts),
    );
  });
  const candidates = Effect.fn("ProjectKnowledgeStore.candidates")(function* (
    projectId: ProjectId,
    terms: ReadonlyArray<string>,
    entities: ReadonlyArray<string>,
    minTrust: number,
    includeSuperseded: boolean,
  ) {
    const recallable = sql`f.status = 'saved' AND f.trust >= ${minTrust}
      AND (${includeSuperseded ? 1 : 0} = 1 OR f.superseded_by_id IS NULL)`;
    const ftsQuery = terms
      .map((term) => `"${term.replaceAll('"', '""')}"${Buffer.byteLength(term) >= 4 ? "*" : ""}`)
      .join(" OR ");
    const lexical =
      ftsQuery === ""
        ? []
        : yield* sql<{ id: ProjectFactId; rank: number }>`
      SELECT f.id, bm25(project_knowledge_fts) AS rank
      FROM project_knowledge_fts JOIN project_knowledge_facts f ON f.rowid = project_knowledge_fts.rowid
      WHERE project_knowledge_fts MATCH ${ftsQuery} AND f.project_id = ${projectId}
        AND ${recallable}
      ORDER BY rank ASC, f.updated_at DESC, f.id ASC LIMIT 1001`;
    const byEntity =
      entities.length === 0
        ? []
        : yield* sql<{ id: ProjectFactId }>`
      SELECT id FROM project_knowledge_facts f WHERE project_id = ${projectId}
        AND ${recallable}
        AND EXISTS (SELECT 1 FROM json_each(f.entities_json) e WHERE ${sql.or(entities.map((entity) => sql`lower(e.value) = ${entity}`))})
      ORDER BY updated_at DESC, id ASC LIMIT 1001`;
    const newest = yield* sql<{ id: ProjectFactId }>`SELECT id FROM project_knowledge_facts f
      WHERE project_id = ${projectId} AND ${recallable}
      ORDER BY updated_at DESC, id ASC LIMIT 1001`;
    const ids = [...new Set([...lexical, ...byEntity, ...newest].map((row) => row.id))];
    return {
      facts: yield* findMany(projectId, ids.slice(0, 1000)),
      ranks: new Map(lexical.map((row) => [row.id, row.rank])),
      partial: ids.length > 1000,
    };
  });
  const hasDuplicateContent = Effect.fn("ProjectKnowledgeStore.hasDuplicateContent")(function* (
    projectId: ProjectId,
    content: string,
  ) {
    type ContentRow = { readonly id: ProjectFactId; readonly content: string };
    const normalized = normalizeFactContent(content);
    let afterId: ProjectFactId | null = null;
    // Automatic saves need exact matching across all current facts, including text that the
    // lexical tokenizer cannot index. Page only content so this does not hydrate every fact.
    while (true) {
      const rows: ReadonlyArray<ContentRow> = yield* sql<ContentRow>`
        SELECT id, content FROM project_knowledge_facts
        WHERE project_id = ${projectId} AND status = 'saved' AND superseded_by_id IS NULL
          AND content IS NOT NULL AND id > ${afterId ?? ""}
        ORDER BY id ASC LIMIT 100`;
      if (rows.some((row) => normalizeFactContent(row.content) === normalized)) return true;
      if (rows.length < 100) return false;
      afterId = rows.at(-1)!.id;
    }
  });
  // Lexical neighbours for duplicate and conflict hints; bounded so a write stays cheap.
  const similar = Effect.fn("ProjectKnowledgeStore.similar")(function* (
    projectId: ProjectId,
    terms: ReadonlyArray<string>,
    excludeIds: ReadonlyArray<ProjectFactId>,
  ) {
    const ftsQuery = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    if (ftsQuery === "") return [];
    const rows = yield* sql<{ id: ProjectFactId }>`
      SELECT f.id FROM project_knowledge_fts JOIN project_knowledge_facts f ON f.rowid = project_knowledge_fts.rowid
      WHERE project_knowledge_fts MATCH ${ftsQuery} AND f.project_id = ${projectId}
        AND f.status = 'saved' AND f.superseded_by_id IS NULL
        AND ${excludeIds.length === 0 ? sql`1 = 1` : sql`f.id NOT IN ${sql.in(excludeIds)}`}
      ORDER BY bm25(project_knowledge_fts) ASC, f.id ASC LIMIT 40`;
    return yield* findMany(
      projectId,
      rows.map((row) => row.id),
    );
  });
  const recordHistory = Effect.fn("ProjectKnowledgeStore.recordHistory")(function* (
    entry: HistoryRecord,
  ) {
    yield* sql`INSERT INTO project_knowledge_fact_history (
      project_id, fact_id, revision, event, actor_json, content_digest, content, sources_json,
      trust_before, trust_after, helpful, related_fact_id, created_at
    ) VALUES (
      ${entry.projectId}, ${entry.factId}, ${entry.revision}, ${entry.event},
      ${encodeOrigin(entry.actor)}, ${entry.contentDigest}, ${entry.content},
      ${encodeSources(entry.sources)}, ${entry.trustBefore}, ${entry.trustAfter},
      ${entry.helpful === null ? null : entry.helpful ? 1 : 0}, ${entry.relatedFactId}, ${entry.at}
    )`;
  });
  const eraseHistory = Effect.fn("ProjectKnowledgeStore.eraseHistory")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
  ) {
    yield* sql`UPDATE project_knowledge_fact_history SET content = NULL, sources_json = '[]'
      WHERE project_id = ${projectId} AND fact_id = ${factId}`;
  });
  const history = Effect.fn("ProjectKnowledgeStore.history")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
    limit: number,
  ) {
    const rows = yield* sql`
      SELECT sequence, event, revision, actor_json AS actor, created_at AS at,
        content_digest AS "contentDigest", content, sources_json AS sources,
        trust_before AS "trustBefore", trust_after AS "trustAfter", helpful,
        related_fact_id AS "relatedFactId", NULL AS "sourceUnavailable"
      FROM project_knowledge_fact_history
      WHERE project_id = ${projectId} AND fact_id = ${factId}
      ORDER BY sequence DESC LIMIT ${limit}`;
    return (yield* decodeHistory(rows))
      .map((row) => ({ ...row, helpful: row.helpful === null ? null : row.helpful !== 0 }))
      .toReversed();
  });
  const sourcesAtRevision = Effect.fn("ProjectKnowledgeStore.sourcesAtRevision")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
    revision: number,
  ) {
    const rows = yield* sql<{ readonly sources: string }>`
      SELECT sources_json AS sources FROM project_knowledge_fact_history
      WHERE project_id = ${projectId} AND fact_id = ${factId} AND revision <= ${revision}
        AND event IN ('baseline', 'created', 'edited')
      ORDER BY sequence DESC LIMIT 1`;
    return rows[0] === undefined ? null : yield* decodeSources(rows[0].sources);
  });
  const statusCounts = Effect.fn("ProjectKnowledgeStore.statusCounts")(function* (
    projectId: ProjectId,
    recallThreshold: number,
  ) {
    const [facts] = yield* sql<{
      readonly saved: number;
      readonly superseded: number;
      readonly forgotten: number;
      readonly low: number;
      readonly guarded: number;
      readonly steady: number;
      readonly high: number;
      readonly belowRecallThreshold: number;
      readonly retrievals: number;
    }>`
      WITH recallable AS (
        SELECT trust FROM project_knowledge_facts
        WHERE project_id = ${projectId} AND status = 'saved'
          AND superseded_by_id IS NULL
      )
      SELECT
        (SELECT COUNT(*) FROM recallable) AS saved,
        (SELECT COUNT(*) FROM project_knowledge_facts WHERE project_id = ${projectId}
          AND status != 'forgotten' AND superseded_by_id IS NOT NULL) AS superseded,
        (SELECT COUNT(*) FROM project_knowledge_facts WHERE project_id = ${projectId}
          AND status = 'forgotten') AS forgotten,
        (SELECT COUNT(*) FROM recallable WHERE trust < 0.25) AS low,
        (SELECT COUNT(*) FROM recallable WHERE trust >= 0.25 AND trust < 0.5) AS guarded,
        (SELECT COUNT(*) FROM recallable WHERE trust >= 0.5 AND trust < 0.75) AS steady,
        (SELECT COUNT(*) FROM recallable WHERE trust >= 0.75) AS high,
        (SELECT COUNT(*) FROM recallable WHERE trust < ${recallThreshold}) AS "belowRecallThreshold",
        (SELECT COALESCE(SUM(retrieval_count), 0) FROM project_knowledge_facts
          WHERE project_id = ${projectId} AND status != 'forgotten') AS retrievals`;
    const feedback = yield* sql<{ readonly helpful: number; readonly count: number }>`
      SELECT helpful, COUNT(*) AS count FROM project_knowledge_fact_history
      WHERE project_id = ${projectId} AND event = 'feedback' GROUP BY helpful`;
    return {
      ...facts!,
      helpful: feedback.find((row) => row.helpful === 1)?.count ?? 0,
      unhelpful: feedback.find((row) => row.helpful === 0)?.count ?? 0,
    };
  });
  /** Citations of active facts, for whole-project source checks. */
  const citedFacts = Effect.fn("ProjectKnowledgeStore.citedFacts")(function* (
    projectId: ProjectId,
    status: ProjectFact["status"],
    includeSuperseded: boolean,
    limit: number,
  ) {
    const rows = yield* sql<{ readonly id: ProjectFactId; readonly sources: string }>`
      SELECT id, sources_json AS sources FROM project_knowledge_facts
      WHERE project_id = ${projectId}
        AND status = ${status}
        AND (${includeSuperseded ? 1 : 0} = 1 OR superseded_by_id IS NULL)
        AND sources_json LIKE '%"message"%'
      ORDER BY id ASC LIMIT ${limit}`;
    const facts = [];
    for (const row of rows) facts.push({ id: row.id, sources: yield* decodeSources(row.sources) });
    return facts;
  });
  const recordRetrieval = Effect.fn("ProjectKnowledgeStore.recordRetrieval")(function* (
    projectId: ProjectId,
    ids: ReadonlyArray<ProjectFactId>,
  ) {
    if (ids.length === 0) return;
    yield* sql`UPDATE project_knowledge_facts SET retrieval_count = retrieval_count + 1
      WHERE project_id = ${projectId} AND status = 'saved' AND ${sql.in("id", ids)}`;
  });
  // A sent record is final: a later re-preparation of the same attempt cannot rewrite what
  // the provider already received. Only a preparation writes excerpts; a status change keeps the
  // stored ones, which a forget may have blanked since they were resolved. Written excerpts are
  // checked against forgotten facts in the same transaction, so a write racing a forget loses.
  const recordDelivery = Effect.fn("ProjectKnowledgeStore.recordDelivery")(function* (
    delivery: ProjectKnowledgeDelivery,
  ) {
    const factIds = [
      ...new Set(
        delivery.items.flatMap((item) =>
          item.context.selections.flatMap((selection) =>
            selection.kind === "fact" ? [selection.factId] : [],
          ),
        ),
      ),
    ];
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const forgotten =
          factIds.length === 0
            ? []
            : yield* sql<{ readonly id: ProjectFactId }>`
                SELECT id FROM project_knowledge_facts
                WHERE project_id = ${delivery.projectId} AND status = 'forgotten'
                  AND ${sql.in("id", factIds)}`;
        const items = withoutForgotten(delivery.items, new Set(forgotten.map((row) => row.id)));
        yield* sql`INSERT INTO project_knowledge_deliveries (
          attempt_id, run_id, thread_id, message_id, project_id, provider_instance_id, status,
          items_json, omissions_json, created_at, updated_at, provider_thread_id, native_thread_id, budget_json
        ) VALUES (
          ${delivery.attemptId}, ${delivery.runId}, ${delivery.threadId}, ${delivery.messageId},
          ${delivery.projectId}, ${delivery.providerInstanceId}, ${delivery.status},
          ${encodeDeliveryItems(items)}, ${encodeDeliveryOmissions(delivery.omissions)},
          ${delivery.createdAt}, ${delivery.updatedAt}, ${delivery.providerThreadId ?? null},
          ${delivery.nativeThreadId ?? null}, ${delivery.budget === undefined ? null : yield* encodeDeliveryBudget(delivery.budget)}
        ) ON CONFLICT (attempt_id, message_id) DO UPDATE SET
          status = excluded.status, updated_at = excluded.updated_at,
          provider_thread_id = excluded.provider_thread_id, native_thread_id = excluded.native_thread_id, budget_json = excluded.budget_json, omissions_json = excluded.omissions_json
          ${
            delivery.status === "prepared"
              ? sql`, items_json = excluded.items_json, omissions_json = excluded.omissions_json`
              : sql``
          }
        WHERE project_knowledge_deliveries.status != 'sent'
          OR project_knowledge_deliveries.native_thread_id IS NOT excluded.native_thread_id`;
      }),
    );
  });
  // Forget must not leave a recoverable copy: as-sent excerpts of the fact go with it, while the
  // record skeleton (ids, revisions, digests, status) stays to explain what was sent. Matching
  // reads decoded selections, since an id with JSON-escaped characters is not a substring of
  // the stored JSON.
  const scrubDeliveries = Effect.fn("ProjectKnowledgeStore.scrubDeliveries")(function* (
    projectId: ProjectId,
    factId: ProjectFactId,
  ) {
    const rows = yield* sql<{
      readonly attemptId: string;
      readonly messageId: string;
      readonly items: string;
    }>`
      SELECT attempt_id AS "attemptId", message_id AS "messageId", items_json AS items FROM project_knowledge_deliveries d
      WHERE project_id = ${projectId} AND EXISTS (
        SELECT 1 FROM json_each(d.items_json) item,
          json_each(item.value, '$.context.selections') selection
        WHERE json_extract(selection.value, '$.kind') = 'fact'
          AND json_extract(selection.value, '$.factId') = ${factId}
      )`;
    for (const row of rows) {
      const items = yield* decodeDeliveryItems(row.items);
      const scrubbed = withoutForgotten(items, new Set([factId]));
      if (scrubbed !== items)
        yield* sql`UPDATE project_knowledge_deliveries SET items_json = ${encodeDeliveryItems(scrubbed)}
          WHERE attempt_id = ${row.attemptId} AND message_id = ${row.messageId}`;
    }
  });
  const replaceDeliveryItems = Effect.fn("ProjectKnowledgeStore.replaceDeliveryItems")(function* (
    delivery: ProjectKnowledgeDelivery,
    original: ProjectKnowledgeDelivery,
  ) {
    yield* sql`UPDATE project_knowledge_deliveries
      SET items_json = ${encodeDeliveryItems(delivery.items)}, omissions_json = ${encodeDeliveryOmissions(delivery.omissions)}
      WHERE attempt_id = ${delivery.attemptId} AND message_id = ${delivery.messageId}
        AND project_id = ${delivery.projectId}
        AND items_json = ${encodeDeliveryItems(original.items)}`;
  });
  // Dispatch safety reads status across every matching attempt, independently of
  // the inspector's page limit and evidence decoding/source revalidation.
  const deliveryTargetPredicate = (input: DeliveryStateInput) => sql`
    project_id = ${input.projectId} AND thread_id = ${input.threadId} AND message_id = ${input.messageId}
    AND provider_instance_id = ${input.providerInstanceId}
    AND ${
      input.scope === "attempt"
        ? sql`attempt_id = ${input.attemptId} AND (provider_thread_id IS NULL OR provider_thread_id IS ${input.providerThreadId ?? null})`
        : sql`provider_thread_id IS ${input.providerThreadId ?? null}
          AND native_thread_id IS ${input.nativeThreadId}
          AND (${input.nativeThreadId} IS NOT NULL OR attempt_id = ${input.attemptId})`
    }`;
  const readDeliveryState = Effect.fn("ProjectKnowledgeStore.readDeliveryState")(function* (
    input: DeliveryStateInput,
  ) {
    const [row] = yield* sql<{ sent: number; sentThisAttempt: number; uncertain: number }>`
      SELECT COALESCE(MAX(status = 'sent'), 0) AS sent,
        COALESCE(MAX(status = 'sent' AND attempt_id = ${input.attemptId}), 0) AS "sentThisAttempt",
        COALESCE(MAX(status IN ('prepared', 'uncertain')), 0) AS uncertain
      FROM project_knowledge_deliveries
      WHERE ${deliveryTargetPredicate(input)}`;
    return {
      sent: row?.sent === 1,
      sentThisAttempt: row?.sentThisAttempt === 1,
      uncertain: row?.uncertain === 1,
    };
  });
  const nativeDeliveryEstimate = Effect.fn("ProjectKnowledgeStore.nativeDeliveryEstimate")(
    function* (input: NativeDeliveryEstimateInput) {
      if (input.nativeThreadId == null) return 0;
      // A retry can record the same message after suppressing its already-sent body.
      // Reserve it once, without loading or revalidating retained excerpts. Old
      // receipts use their accepted allowance (or the 48k composer contract limit).
      const [row] = yield* sql<{ readonly estimatedTokens: number }>`
        SELECT COALESCE(SUM(estimate), 0) AS "estimatedTokens" FROM (
          SELECT MAX(COALESCE(
            json_extract(budget_json, '$.estimatedTokens'),
            CASE WHEN items_json = '[]' THEN 0
              ELSE COALESCE(json_extract(budget_json, '$.knowledgeAllowance'), 48000) END
          )) AS estimate
          FROM project_knowledge_deliveries
          WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
            AND provider_instance_id = ${input.providerInstanceId}
            AND provider_thread_id IS ${input.providerThreadId ?? null}
            AND native_thread_id = ${input.nativeThreadId} AND status = 'sent'
          GROUP BY message_id
        )`;
      return row?.estimatedTokens ?? 0;
    },
  );
  const markDeliveryUncertain = Effect.fn("ProjectKnowledgeStore.markDeliveryUncertain")(function* (
    input: DeliveryStateInput,
    updatedAt: string,
  ) {
    yield* sql`UPDATE project_knowledge_deliveries SET status = 'uncertain', updated_at = ${updatedAt}
      WHERE status = 'prepared' AND ${deliveryTargetPredicate(input)}`;
  });
  const deliveries = Effect.fn("ProjectKnowledgeStore.deliveries")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const rows = yield* sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", thread_id AS "threadId",
        message_id AS "messageId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", provider_thread_id AS "providerThreadId",
        native_thread_id AS "nativeThreadId", status, items_json AS items,
        budget_json AS budget, omissions_json AS omissions, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_knowledge_deliveries
      WHERE project_id = ${projectId} AND thread_id = ${threadId} AND message_id = ${messageId}
      ORDER BY created_at ASC, attempt_id ASC LIMIT 20`;
    return (yield* decodeDeliveries(rows)).map(({ providerThreadId, budget, ...row }) => ({
      ...row,
      ...(budget == null ? {} : { budget }),
      ...(providerThreadId == null ? {} : { providerThreadId }),
    }));
  });
  const deliveryPage = Effect.fn("ProjectKnowledgeStore.deliveryPage")(function* (
    projectId: ProjectId,
    afterId: string | undefined,
    limit: number,
  ) {
    // Durable continuations from older builds carry only an attempt id.
    const cursor = afterId?.startsWith("message:")
      ? yield* decodeDeliveryCursor(afterId.slice("message:".length))
      : undefined;
    const rows = yield* sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", thread_id AS "threadId",
        message_id AS "messageId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", provider_thread_id AS "providerThreadId",
        native_thread_id AS "nativeThreadId", status, items_json AS items,
        budget_json AS budget, omissions_json AS omissions, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_knowledge_deliveries
      WHERE project_id = ${projectId} AND ${
        cursor === undefined
          ? sql`attempt_id > ${afterId ?? ""}`
          : sql`(attempt_id, message_id) > (${cursor.attemptId}, ${cursor.messageId})`
      }
      ORDER BY attempt_id ASC, message_id ASC LIMIT ${limit}`;
    const deliveries = (yield* decodeDeliveries(rows)).map(
      ({ providerThreadId, budget, ...row }) => ({
        ...row,
        ...(budget == null ? {} : { budget }),
        ...(providerThreadId == null ? {} : { providerThreadId }),
      }),
    );
    const last = deliveries.at(-1);
    return {
      deliveries,
      afterId:
        last !== undefined && deliveries.length === limit
          ? `message:${encodeDeliveryCursor({ attemptId: last.attemptId, messageId: last.messageId })}`
          : null,
    };
  });
  const sentDeliveries = Effect.fn("ProjectKnowledgeStore.sentDeliveries")(function* (
    projectId: ProjectId,
    threadIds: ReadonlyArray<ThreadId>,
    runIds: ReadonlyArray<RunId>,
  ) {
    if (threadIds.length === 0 || runIds.length === 0) return [];
    const rows = yield* sql`
      SELECT attempt_id AS "attemptId", run_id AS "runId", thread_id AS "threadId",
        message_id AS "messageId", project_id AS "projectId",
        provider_instance_id AS "providerInstanceId", provider_thread_id AS "providerThreadId",
        native_thread_id AS "nativeThreadId", status, items_json AS items,
        budget_json AS budget, omissions_json AS omissions, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_knowledge_deliveries
      WHERE project_id = ${projectId} AND ${sql.in("thread_id", threadIds)}
        AND ${sql.in("run_id", runIds)} AND status = 'sent'
      ORDER BY created_at ASC, attempt_id ASC`;
    return (yield* decodeDeliveries(rows)).map(({ providerThreadId, budget, ...row }) => ({
      ...row,
      ...(budget == null ? {} : { budget }),
      ...(providerThreadId == null ? {} : { providerThreadId }),
    }));
  });
  const assistedRunRecorded = Effect.fn("ProjectKnowledgeStore.assistedRunRecorded")(function* (
    runId: RunId,
  ) {
    const rows = yield* sql`SELECT 1 FROM project_knowledge_assisted_runs WHERE run_id = ${runId}`;
    return rows.length > 0;
  });
  // First outcome wins, so a retried job cannot rewrite what an earlier attempt finished.
  const recordAssistedRun = Effect.fn("ProjectKnowledgeStore.recordAssistedRun")(function* (
    projectId: ProjectId,
    run: AssistedLearningRun,
  ) {
    yield* sql`INSERT INTO project_knowledge_assisted_runs (
      run_id, project_id, thread_id, run_outcome, result, reason, saved, completed_at
    ) VALUES (
      ${run.runId}, ${projectId}, ${run.threadId}, ${run.runOutcome}, ${run.result}, ${run.reason},
      ${run.saved}, ${run.at}
    ) ON CONFLICT (run_id) DO NOTHING`;
  });
  const assistedStatus = Effect.fn("ProjectKnowledgeStore.assistedStatus")(function* (
    projectId: ProjectId,
  ) {
    const runs = yield* sql`
      SELECT thread_id AS "threadId", run_id AS "runId", run_outcome AS "runOutcome", result,
        reason, saved, completed_at AS at
      FROM project_knowledge_assisted_runs WHERE project_id = ${projectId}
      ORDER BY completed_at DESC, run_id DESC LIMIT 1`.pipe(Effect.flatMap(decodeAssistedRuns));
    return { lastRun: runs[0] ?? null };
  });
  return {
    assistedRunRecorded,
    recordAssistedRun,
    assistedStatus,
    find,
    findMany,
    list,
    insert,
    update,
    receipt,
    record,
    recordSearch,
    candidates,
    similar,
    hasDuplicateContent,
    recordHistory,
    eraseHistory,
    history,
    sourcesAtRevision,
    statusCounts,
    citedFacts,
    recordRetrieval,
    recordDelivery,
    readDeliveryState,
    nativeDeliveryEstimate,
    markDeliveryUncertain,
    scrubDeliveries,
    replaceDeliveryItems,
    deliveries,
    sentDeliveries,
    deliveryPage,
  };
});
