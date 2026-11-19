import {
  ActiveProjectFact,
  type KnowledgeMessageRef,
  type ProjectFactId,
  ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { validateProjectMemoryCuration } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";
import { projectMemorySearchTokens } from "./holographicScoring.ts";
import { makeStore } from "./persistence.ts";

const PAGE_SIZE = 16;
const CONTEXT_SIZE = 8;
const MAX_PROJECTS_PER_TICK = 4;
const PAGE_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_FACT_CHARS = 48_000;
const MAX_SOURCE_MESSAGES = 24;
const MAX_SOURCE_CHARS = 24_000;
const MAX_SOURCE_MESSAGE_CHARS = 3_000;
const isActiveFact = Schema.is(ActiveProjectFact);
const sourceKey = (source: KnowledgeMessageRef) =>
  JSON.stringify([source.threadId, source.messageId, source.digest]);
const eligible = (fact: typeof ActiveProjectFact.Type) =>
  ["assisted", "agent-thread", "agent-client"].includes(fact.origin.kind) &&
  !fact.sources.some((source) => source.kind === "user") &&
  fact.verdict?.by !== "person" &&
  (fact.verdict === undefined || fact.verdict.value === "standing") &&
  fact.supersededBy == null;

class InvalidMemoryCurationResponse extends Schema.TaggedError<InvalidMemoryCurationResponse>()(
  "InvalidMemoryCurationResponse",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The memory curator returned decisions outside the reviewed facts.";
  }
}
const isInvalidMemoryCurationResponse = Schema.is(InvalidMemoryCurationResponse);

export class MemoryCurationError extends Schema.TaggedError<MemoryCurationError>()(
  "MemoryCurationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Memory curation could not finish its scheduled work.";
  }
}

export class MemoryCuration extends Context.Service<
  MemoryCuration,
  { readonly drainDue: Effect.Effect<void, MemoryCurationError> }
>()("t3/project/knowledge/MemoryCuration") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* makeStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const eligibleSql = sql`f.status = 'saved' AND f.superseded_by_id IS NULL
    AND (f.verdict IS NULL OR f.verdict = 'standing')
    AND (f.verdict_by IS NULL OR f.verdict_by != 'person')
    AND json_extract(f.origin_json, '$.kind') IN ('assisted', 'agent-thread', 'agent-client')
    AND NOT EXISTS (SELECT 1 FROM json_each(f.sources_json) source WHERE json_extract(source.value, '$.kind') = 'user')`;

  const reviewProject = Effect.fn("MemoryCuration.reviewProject")(function* (projectId: ProjectId) {
    const started = DateTime.toEpochMillis(yield* DateTime.now);
    // Claim before invoking a model, so a restart retains the spend cooldown.
    const claims = yield* sql<{ readonly cursor: ProjectFactId | null }>`
      INSERT INTO project_knowledge_curation_state (
        project_id, cursor, next_due_at, last_started_at, status
      ) VALUES (${projectId}, NULL, ${started + PAGE_INTERVAL_MS}, ${started}, 'running')
      ON CONFLICT (project_id) DO UPDATE SET next_due_at = ${started + PAGE_INTERVAL_MS},
        last_started_at = ${started}, last_completed_at = NULL, status = 'running', reason = NULL,
        reviewed = 0, changed = 0, skipped = 0
      WHERE next_due_at <= ${started}
      RETURNING cursor`;
    if (claims.length === 0) return;
    const cursor = claims[0]!.cursor;
    const finish = Effect.fn("MemoryCuration.finish")(function* (outcome: {
      readonly status: "ran" | "skipped" | "failed";
      readonly reason: string;
      readonly reviewed?: number;
      readonly changed?: number;
      readonly skipped?: number;
      readonly cursor?: ProjectFactId | null;
      readonly sweepComplete?: boolean;
    }) {
      const now = yield* DateTime.now;
      yield* sql`UPDATE project_knowledge_curation_state SET
        cursor = ${outcome.cursor === undefined ? cursor : outcome.cursor},
        next_due_at = ${DateTime.toEpochMillis(now) + (outcome.sweepComplete ? SWEEP_INTERVAL_MS : PAGE_INTERVAL_MS)},
        last_completed_at = ${DateTime.formatIso(now)}, status = ${outcome.status},
        reason = ${outcome.reason}, reviewed = ${outcome.reviewed ?? 0},
        changed = ${outcome.changed ?? 0}, skipped = ${outcome.skipped ?? 0}
      WHERE project_id = ${projectId} AND last_started_at = ${started} AND status = 'running'`;
    });

    yield* Effect.gen(function* () {
      const project = yield* projects.get(projectId);
      if (Option.isNone(project) || project.value.archivedAt !== null)
        return yield* finish({ status: "skipped", reason: "project_unavailable" });
      const currentSettings = resolveProjectSettings(
        yield* settings.getSettings,
        projectId,
      ).settings;
      if (!currentSettings.enableMemoryCuration)
        return yield* finish({ status: "skipped", reason: "disabled" });
      if (
        !(yield* textGeneration.supportsOperation(
          "curateProjectMemory",
          currentSettings.textGenerationModelSelection.instanceId,
        ))
      )
        return yield* finish({ status: "skipped", reason: "provider_unsupported" });

      const ids = yield* sql<{ readonly id: ProjectFactId }>`
        SELECT f.id FROM project_knowledge_facts f
        WHERE f.project_id = ${projectId} AND ${eligibleSql}
          AND (${cursor} IS NULL OR f.id > ${cursor})
        ORDER BY f.id LIMIT ${PAGE_SIZE + 1}`;
      const hydrated = yield* store.findMany(
        projectId,
        ids.slice(0, PAGE_SIZE).map(({ id }) => id),
      );
      const byId = new Map(hydrated.map((fact) => [fact.id, fact]));
      const candidates: Array<typeof ActiveProjectFact.Type> = [];
      let remaining = MAX_FACT_CHARS;
      let scanned = 0;
      for (const { id } of ids.slice(0, PAGE_SIZE)) {
        const fact = byId.get(id);
        if (fact !== undefined && isActiveFact(fact) && eligible(fact)) {
          if (fact.content.length > remaining) break;
          candidates.push(fact);
          remaining -= fact.content.length;
        }
        scanned++;
      }
      const nextCursor = ids.length > scanned ? (ids[scanned - 1]?.id ?? cursor) : null;
      if (candidates.length === 0)
        return yield* finish({
          status: "skipped",
          reason: "nothing_to_review",
          cursor: nextCursor,
          sweepComplete: nextCursor === null,
        });

      const neighbours = yield* store.similar(
        projectId,
        [
          ...new Set(
            candidates.flatMap((fact) => projectMemorySearchTokens(fact.content).slice(0, 4)),
          ),
        ].slice(0, 64),
        candidates.map((fact) => fact.id),
      );
      const context: Array<typeof ActiveProjectFact.Type> = [];
      for (const fact of neighbours) {
        if (context.length === CONTEXT_SIZE) break;
        if (
          !isActiveFact(fact) ||
          fact.supersededBy != null ||
          (fact.verdict !== undefined && fact.verdict.value !== "standing") ||
          fact.content.length > remaining
        )
          continue;
        context.push(fact);
        remaining -= fact.content.length;
      }
      const facts = [...candidates, ...context];
      const cited = new Map<string, KnowledgeMessageRef>();
      for (const fact of facts) {
        for (const source of fact.sources
          .filter((source) => source.kind === "message")
          .slice(0, 2)) {
          if (cited.size === MAX_SOURCE_MESSAGES) break;
          cited.set(sourceKey(source), source);
        }
      }
      const sourceGroups = new Map<KnowledgeMessageRef["threadId"], Array<KnowledgeMessageRef>>();
      for (const source of cited.values()) {
        const group = sourceGroups.get(source.threadId) ?? [];
        group.push(source);
        sourceGroups.set(source.threadId, group);
      }
      const verified = new Map<
        string,
        { readonly excerpt: string; readonly source: KnowledgeMessageRef }
      >();
      let sourceBudget = MAX_SOURCE_CHARS;
      for (const [threadId, sources] of sourceGroups) {
        if (sourceBudget <= 0) break;
        const resolved = yield* knowledge.readSources({
          projectId,
          threadId,
          sources,
          includeArchived: true,
        });
        for (const source of resolved) {
          if (source.state !== "available") continue;
          const key = sourceKey(source.source);
          const requested = cited.get(key);
          if (
            requested === undefined ||
            (requested.runId !== undefined && requested.runId !== source.source.runId)
          )
            continue;
          const excerpt = source.text.slice(0, Math.min(MAX_SOURCE_MESSAGE_CHARS, sourceBudget));
          if (excerpt.length === 0) continue;
          verified.set(key, { excerpt: `${source.role}: ${excerpt}`, source: source.source });
          sourceBudget -= excerpt.length;
        }
      }
      const candidateIds = new Set(candidates.map((fact) => fact.id));
      let packetSourceBudget = MAX_SOURCE_CHARS;
      const reviewedSources = new Map<string, KnowledgeMessageRef>();
      const packet: Array<TextGeneration.ProjectMemoryCurationFact> = facts.map((fact) => ({
        id: fact.id,
        revision: fact.revision,
        kind: fact.kind,
        content: fact.content,
        protected: !candidateIds.has(fact.id),
        sources: fact.sources.flatMap((source) => {
          const evidence = source.kind === "message" ? verified.get(sourceKey(source)) : undefined;
          if (evidence === undefined || evidence.excerpt.length > packetSourceBudget) return [];
          packetSourceBudget -= evidence.excerpt.length;
          reviewedSources.set(sourceKey(evidence.source), evidence.source);
          return [evidence.excerpt];
        }),
      }));
      const beforeCall = resolveProjectSettings(yield* settings.getSettings, projectId).settings;
      if (!beforeCall.enableMemoryCuration)
        return yield* finish({ status: "skipped", reason: "disabled" });
      const output = yield* Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-memory-curation-" });
          return yield* textGeneration.curateProjectMemory({
            cwd,
            modelSelection: beforeCall.textGenerationModelSelection,
            facts: packet,
          });
        }),
      );
      if (!validateProjectMemoryCuration(output.decisions, packet))
        return yield* new InvalidMemoryCurationResponse({ projectId });

      yield* settings.withSettingsSnapshot((latest) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if (!resolveProjectSettings(latest, projectId).settings.enableMemoryCuration)
              return yield* finish({
                status: "skipped",
                reason: "disabled",
                reviewed: packet.length,
              });
            const currentProject = yield* projects.get(projectId);
            if (Option.isNone(currentProject) || currentProject.value.archivedAt !== null)
              return yield* finish({
                status: "skipped",
                reason: "project_unavailable",
                reviewed: packet.length,
              });
            const result = yield* knowledge.applyCuration({
              projectId,
              facts: facts.map(({ id, revision }) => ({
                id,
                revision,
                protected: !candidateIds.has(id),
              })),
              decisions: output.decisions,
              reviewedSources: [...reviewedSources.values()],
            });
            yield* finish({
              status: "ran",
              reason: result.changed > 0 ? "curated" : "unchanged",
              reviewed: packet.length,
              changed: result.changed,
              skipped: result.skipped,
              cursor: nextCursor,
              sweepComplete: nextCursor === null,
            });
          }),
        ),
      );
    }).pipe(
      Effect.catch((cause) =>
        finish({
          status: "failed",
          reason: isInvalidMemoryCurationResponse(cause) ? "invalid_output" : "review_failed",
        }).pipe(Effect.andThen(Effect.logWarning("Memory curation deferred", { projectId }))),
      ),
      Effect.onInterrupt(() => finish({ status: "failed", reason: "interrupted" })),
    );
  });

  const drainDue = Effect.gen(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const due = yield* sql<{ readonly projectId: ProjectId }>`
      SELECT p.project_id AS "projectId" FROM projection_projects p
      LEFT JOIN project_knowledge_curation_state s ON s.project_id = p.project_id
      WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
        AND (s.project_id IS NULL OR s.next_due_at <= ${now})
        AND EXISTS (SELECT 1 FROM project_knowledge_facts f WHERE f.project_id = p.project_id AND ${eligibleSql})
      ORDER BY COALESCE(s.next_due_at, 0), p.project_id LIMIT ${MAX_PROJECTS_PER_TICK}`;
    for (const { projectId } of due) yield* reviewProject(projectId);
  }).pipe(
    lock.withPermits(1),
    Effect.mapError((cause) => new MemoryCurationError({ cause })),
  );
  return MemoryCuration.of({ drainDue });
});

export const layerRunner = Layer.effect(MemoryCuration, make);
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const curator = yield* MemoryCuration;
    yield* forkParked(
      Effect.forever(
        Effect.gen(function* () {
          yield* curator.drainDue.pipe(
            Effect.catch(() => Effect.logWarning("Memory curation scheduler deferred")),
          );
          yield* Effect.sleep("1 minute");
        }),
      ),
    );
  }),
).pipe(Layer.provideMerge(layerRunner));
