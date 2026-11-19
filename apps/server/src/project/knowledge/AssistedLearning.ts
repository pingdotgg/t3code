import {
  CommandId,
  ProjectFactId,
  ProjectKnowledgeMutation,
  type AssistedLearningRun,
  type KnowledgeMessageRef,
  type KnowledgeOrigin,
  type MessageId,
  type OrchestrationV2MessageSpeaker,
  type ProjectId,
  RunId,
  ThreadId,
  AssistedLearningRunOutcome,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  messageEvidenceDigestInput,
  messageProvenance,
} from "@t3tools/provider-core/server/messageProvenance";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../../serverActivation.ts";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ManagedProjectFolders from "../ManagedProjectFolders.ts";
import {
  AssistedLearningError,
  AssistedLearningRunner,
  type AssistedLearningRunnerShape,
} from "./assistedLearningSchedule.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_TRANSCRIPT_CHARS = 32_000;
const MAX_CANDIDATES = 3;
const MAX_CANDIDATE_CHARS = 2_000;
const MAX_ENTITIES = 5;
const MAX_CHECK_ATTEMPTS = 3;
const CHECK_RETRY_MS = 30 * 60 * 1000;
const ACKNOWLEDGEMENTS = new Set([
  "ok",
  "okay",
  "thanks",
  "thank you",
  "continue",
  "go on",
  "proceed",
  "hi",
  "hello",
  "hey",
  "next",
  "yes",
  "yep",
  "sure",
  "sounds good",
  "great",
  "nice",
  "done",
  "go ahead",
]);
const supportsLearning = (text: string) =>
  !ACKNOWLEDGEMENTS.has(
    text
      .trim()
      .toLowerCase()
      .replace(/[.!?…]+$/gu, "")
      .trim(),
  );

const Candidate = Schema.Struct({
  kind: Schema.Literals(["decision", "constraint", "convention"]),
  content: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_CANDIDATE_CHARS)),
  entities: Schema.Array(Schema.String),
  citations: Schema.Array(Schema.String),
});
const decodeCandidate = Schema.decodeUnknownOption(Candidate);
const isMutation = Schema.is(ProjectKnowledgeMutation);

const make = Effect.gen(function* () {
  const crypto = yield* Digest.Digest;
  const sql = yield* SqlClient.SqlClient;
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const fileSystem = yield* FileSystem.FileSystem;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));

  const lock = yield* Semaphore.make(1);
  const extractBatch = Effect.fn("AssistedLearning.extractRun")(
    function* (
      projectId: ProjectId,
      scheduledBatch: ReadonlyArray<Parameters<AssistedLearningRunnerShape["extractRun"]>[0]>,
      rootThreadId?: ThreadId,
    ) {
      const batch: Array<Parameters<AssistedLearningRunnerShape["extractRun"]>[0]> = [];
      for (const entry of scheduledBatch) {
        if (yield* knowledge.hasAssistedRun(projectId, entry.runId)) {
          yield* sql`DELETE FROM project_knowledge_learning_queue WHERE run_id = ${entry.runId}`;
        } else batch.push(entry);
      }
      if (batch.length === 0) return;
      const savedByRun = new Map<RunId, number>();
      const skippedRuns = new Set<RunId>();
      const finish = (result: AssistedLearningRun["result"], reason: string | null) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const at = DateTime.formatIso(yield* DateTime.now);
            for (const entry of batch) {
              if (!(yield* knowledge.hasAssistedRun(projectId, entry.runId)))
                yield* knowledge.recordAssistedRun(projectId, {
                  ...entry,
                  result: skippedRuns.has(entry.runId) ? "skipped" : result,
                  reason: skippedRuns.has(entry.runId)
                    ? "The source thread is unavailable or moved."
                    : reason,
                  saved: savedByRun.get(entry.runId) ?? 0,
                  at,
                });
              yield* sql`DELETE FROM project_knowledge_learning_queue WHERE run_id = ${entry.runId}`;
            }
          }),
        );
      if (yield* managedFolders.isScratchProject(projectId))
        return yield* finish("skipped", "Automatic memory is off for threads without a project.");
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projectId,
      ).settings;
      // The setting can change between scheduling and running; the latest choice wins.
      if (!settings.enableAssistedLearning)
        return yield* finish("skipped", "Automatic memory is off for this project.");
      // Without the check nothing can be saved, so don't pay for extraction.
      if (
        !(yield* textGeneration.supportsOperation(
          "checkFactStanding",
          settings.textGenerationModelSelection.instanceId,
        ))
      )
        return yield* finish(
          "skipped",
          "The text generation model's provider can't check memories. Choose another model in Settings → Threads → Text generation.",
        );
      const evidence = [];
      // A seat's reply published into its parent and the seat's own thread are one speaker.
      const speakerThreads = new Map<RunId, ThreadId>();
      for (const entry of batch) {
        if (yield* knowledge.hasAssistedRun(projectId, entry.runId)) continue;
        const source = yield* projections
          .getThreadRecords(entry.threadId, ["messages", "runs"], {
            messageRunIds: [entry.runId],
            runIds: [entry.runId],
          })
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          );
        if (
          source === null ||
          source.thread.projectId !== projectId ||
          (rootThreadId !== undefined && source.thread.lineage.rootThreadId !== rootThreadId) ||
          source.thread.deletedAt !== null
        ) {
          skippedRuns.add(entry.runId);
          continue;
        }
        const publication = source.runs[0]?.publication;
        speakerThreads.set(
          entry.runId,
          publication?.type === "peer_reply" ? publication.seatThreadId : entry.threadId,
        );
        evidence.push(
          ...source.messages.filter(
            (message) =>
              (message.role === "user" || message.role === "assistant") &&
              !message.streaming &&
              message.text.trim() !== "",
          ),
        );
      }
      const finalized = evidence.toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      );
      if (!finalized.some((message) => message.role === "assistant"))
        return yield* finish("skipped", "The run has no finished reply to learn from.");
      const humanMessages = finalized.filter(
        (message) =>
          message.role === "user" &&
          message.notification === undefined &&
          message.delegatedCompletion === undefined &&
          messageProvenance(message) === undefined &&
          supportsLearning(message.text),
      );
      const evidenceSpeaker = (message: (typeof finalized)[number]) => {
        if (message.role === "assistant") {
          const thread = speakerThreads.get(message.runId!);
          return thread === undefined ? undefined : JSON.stringify(["local", thread]);
        }
        if (message.linkedSender !== undefined)
          return JSON.stringify([
            "linked",
            message.linkedSender.environmentId,
            message.linkedSender.threadId,
          ]);
        return message.senderThreadId === undefined
          ? undefined
          : JSON.stringify(["local", message.senderThreadId]);
      };
      const speakersByRef = new Map<string, string>();
      const completedEvidence = finalized.filter((message) =>
        batch.some((entry) => entry.runId === message.runId && entry.runOutcome === "completed"),
      );
      if (
        humanMessages.length === 0 &&
        (new Set(completedEvidence.map((message) => message.runId)).size < 2 ||
          new Set(
            completedEvidence.flatMap((message) => {
              const speaker = evidenceSpeaker(message);
              return speaker === undefined ? [] : [speaker];
            }),
          ).size < 2 ||
          new Set(completedEvidence.map((message) => message.text.trim().toLowerCase())).size < 2)
      )
        return yield* finish(
          "skipped",
          "No user-supported or independently corroborated evidence.",
        );
      // Human corrections can occur mid-batch; reserve their evidence before verbose replies.
      const kept: typeof finalized = [];
      const textLimits = new Map<string, number>();
      let budget = MAX_TRANSCRIPT_CHARS;
      const prioritized = new Set([
        ...humanMessages.toReversed(),
        finalized[0]!,
        ...finalized.toReversed(),
      ]);
      for (const message of prioritized) {
        if (kept.length >= MAX_MESSAGES || budget <= 0) break;
        const available = Math.min(budget, MAX_MESSAGE_CHARS);
        kept.push(message);
        textLimits.set(message.id, available);
        budget -= Math.min(message.text.length, available);
      }
      const transcript = kept.toSorted(
        (left, right) => finalized.indexOf(left) - finalized.indexOf(right),
      );
      // Citations are message ids and digests from this canonical read; the model only names refs.
      const speakersByMessage = new Map<MessageId, OrchestrationV2MessageSpeaker>();
      const assistantIds = new Map<ThreadId, Array<MessageId>>();
      for (const message of transcript) {
        if (message.role !== "assistant") continue;
        const ids = assistantIds.get(message.threadId) ?? [];
        ids.push(message.id);
        assistantIds.set(message.threadId, ids);
      }
      for (const [id, messageIds] of assistantIds)
        for (const [messageId, speaker] of yield* projections.getPeerSpeakers(id, messageIds))
          speakersByMessage.set(messageId, speaker);
      const refs = new Map<string, KnowledgeMessageRef>();
      const userRefs = new Set<string>();
      const messages: Array<
        TextGeneration.KnowledgeCandidatesGenerationInput["messages"][number] & {
          threadId: ThreadId;
          runId: RunId;
          runOutcome: AssistedLearningRunOutcome;
        }
      > = [];
      for (const [index, message] of transcript.entries()) {
        const ref = `M${index + 1}`;
        if (humanMessages.includes(message)) userRefs.add(ref);
        const provenance = message.role === "user" ? messageProvenance(message) : undefined;
        const evidenceSpeakerId = evidenceSpeaker(message);
        if (evidenceSpeakerId !== undefined) speakersByRef.set(ref, evidenceSpeakerId);
        refs.set(ref, {
          kind: "message",
          threadId: message.threadId,
          runId: message.runId!,
          messageId: message.id,
          digest: yield* digest(messageEvidenceDigestInput(message.text, provenance)),
        });
        const speaker =
          message.role === "assistant" ? speakersByMessage.get(message.id) : undefined;
        const shared = {
          ref,
          threadId: message.threadId,
          runId: message.runId!,
          runOutcome: batch.find((entry) => entry.runId === message.runId)!.runOutcome,
          text: message.text.slice(0, textLimits.get(message.id)),
          ...(provenance === undefined ? {} : { provenance }),
        };
        messages.push(
          speaker === undefined
            ? {
                ...shared,
                role:
                  provenance === undefined
                    ? (message.role as "user" | "assistant")
                    : provenance.createdBy === "system"
                      ? "system"
                      : "agent",
              }
            : { ...shared, role: "peer" as const, speaker },
        );
      }
      const project = yield* projects.get(projectId);
      const cwd = Option.isSome(project) ? project.value.workspaceRoot : undefined;
      if (cwd === undefined) return yield* finish("skipped", "The project was not found.");
      const generated = yield* textGeneration
        .generateKnowledgeCandidates({
          cwd,
          runOutcome: batch.length === 1 ? batch[0]!.runOutcome : "completed",
          messages,
          modelSelection: settings.textGenerationModelSelection,
        })
        .pipe(
          Effect.map((result) => ({ ok: true as const, candidates: result.candidates })),
          Effect.catchTags({
            TextGenerationError: (error) =>
              Effect.succeed({ ok: false as const, detail: error.detail }),
          }),
        );
      if (!generated.ok) return yield* finish("failed", generated.detail.slice(0, 300));
      let dropped = 0;
      const proposed: Array<{
        readonly create: Extract<ProjectKnowledgeMutation, { readonly action: "create" }>;
        readonly actor: Extract<KnowledgeOrigin, { readonly kind: "assisted" }>;
        readonly userSupported: boolean;
      }> = [];
      for (const raw of generated.candidates.slice(0, MAX_CANDIDATES)) {
        const candidate = Option.getOrNull(decodeCandidate(raw));
        const sources = [...new Set((candidate?.citations ?? []).map((ref) => ref.trim()))].flatMap(
          (ref) => {
            const source = refs.get(ref);
            return source ? [source] : [];
          },
        );
        const citedMessages = messages.filter((message) =>
          (candidate?.citations ?? []).some((ref) => ref.trim() === message.ref),
        );
        const corroborated =
          citedMessages.every((message) => message.runOutcome === "completed") &&
          new Set(citedMessages.map((message) => message.runId)).size >= 2 &&
          new Set(
            citedMessages.flatMap((message) => {
              const speaker = speakersByRef.get(message.ref);
              return speaker === undefined ? [] : [speaker];
            }),
          ).size >= 2 &&
          new Set(citedMessages.map((message) => message.text.trim().toLowerCase())).size >= 2;
        const userSupported = (candidate?.citations ?? []).some((ref) => userRefs.has(ref.trim()));
        if (
          candidate === null ||
          sources.length === 0 ||
          candidate.citations.some((ref) => !refs.has(ref.trim())) ||
          (!userSupported && (!corroborated || candidate.kind === "decision"))
        ) {
          dropped += 1;
          continue;
        }
        const support =
          citedMessages.find((message) => userRefs.has(message.ref)) ?? citedMessages[0]!;
        const actor = {
          kind: "assisted" as const,
          threadId: support.threadId,
          runId: support.runId,
          runOutcome: support.runOutcome,
        };
        const notePrefix = "Unverified agent report: ";
        const content = userSupported
          ? candidate.content
          : notePrefix + candidate.content.slice(0, MAX_CANDIDATE_CHARS - notePrefix.length);
        const runContentId = `assisted:${actor.runId}:${(yield* digest(content)).slice(0, 32)}`;
        const create = {
          action: "create" as const,
          commandId: CommandId.make(runContentId),
          factId: ProjectFactId.make(runContentId),
          projectId,
          kind: userSupported ? candidate.kind : ("note" as const),
          content,
          entities: [
            ...new Set(
              candidate.entities
                .map((entity) => entity.trim().slice(0, 200))
                .filter((entity) => entity !== ""),
            ),
          ].slice(0, MAX_ENTITIES),
          tags: [],
          sources,
        };
        if (!isMutation(create)) {
          dropped += 1;
          continue;
        }
        proposed.push({ create, actor, userSupported });
      }
      // The check reads only the statements, from an empty directory, never the transcript.
      const checked = yield* (
        proposed.length === 0
          ? Effect.succeed({ verdicts: [] })
          : fileSystem.makeTempDirectoryScoped({ prefix: "t3-memory-check-" }).pipe(
              Effect.flatMap((emptyDirectory) =>
                textGeneration.checkFactStanding({
                  cwd: emptyDirectory,
                  statements: proposed.map(({ create }) => ({
                    kind: create.kind,
                    content: create.content,
                  })),
                  modelSelection: settings.textGenerationModelSelection,
                }),
              ),
              Effect.scoped,
            )
      ).pipe(
        Effect.map((result) => ({ ok: true as const, verdicts: result.verdicts })),
        Effect.catchTags({
          TextGenerationError: (error) =>
            Effect.succeed({ ok: false as const, detail: error.detail }),
        }),
      );
      if (!checked.ok) {
        // Saving unchecked is the failure the check exists to prevent; retry the whole batch later.
        const runIds = batch.map((entry) => entry.runId);
        const [previous] = yield* sql<{ readonly attempts: number | null }>`
          SELECT MAX(check_attempts) AS attempts FROM project_knowledge_learning_queue
          WHERE ${sql.in("run_id", runIds)}`;
        const attempts = (previous?.attempts ?? 0) + 1;
        if (attempts >= MAX_CHECK_ATTEMPTS)
          return yield* finish("failed", `Standing check failed: ${checked.detail}`.slice(0, 300));
        const retryAt = DateTime.toEpochMillis(yield* DateTime.now) + CHECK_RETRY_MS;
        yield* sql`UPDATE project_knowledge_learning_queue
          SET check_attempts = ${attempts}, retry_at = ${retryAt} WHERE ${sql.in("run_id", runIds)}`;
        return yield* Effect.logWarning("Automatic memory standing check deferred", {
          projectId,
          attempts,
          detail: checked.detail,
        });
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (
            (yield* Effect.forEach(batch, (entry) =>
              knowledge.hasAssistedRun(projectId, entry.runId),
            )).every(Boolean)
          )
            return;
          if (
            !resolveProjectSettings(yield* serverSettings.getSettings, projectId).settings
              .enableAssistedLearning
          )
            return yield* finish("skipped", "Automatic memory is off for this project.");
          let saved = 0;
          let duplicates = 0;
          const setAside = { task: 0, code: 0 };
          for (const [index, { create, actor, userSupported }] of proposed.entries()) {
            if (yield* knowledge.hasAssistedRun(projectId, actor.runId)) continue;
            // Repetition and a text-only classifier cannot verify an agent's causal claim.
            const verdict = userSupported ? (checked.verdicts[index] ?? "task") : "task";
            const result = yield* knowledge.saveAutomatic(create, actor, verdict).pipe(
              Effect.catchTags({
                ProjectKnowledgeError: (error) =>
                  error.reason === "storage" || error.reason === "missing_project"
                    ? Effect.fail(error)
                    : Effect.succeed({ outcome: "dropped" as const }),
              }),
            );
            if (result.outcome === "saved" && verdict !== "standing") setAside[verdict] += 1;
            else if (result.outcome === "saved") {
              saved += 1;
              savedByRun.set(actor.runId, (savedByRun.get(actor.runId) ?? 0) + 1);
            } else if (result.outcome === "duplicate") duplicates += 1;
            else if (result.outcome === "dropped") dropped += 1;
          }
          const plural = (count: number, noun: string) =>
            `${count} ${noun}${count === 1 ? "" : "s"}`;
          const asideTotal = setAside.task + setAside.code;
          const notes = [
            ...(asideTotal > 0
              ? [
                  `${asideTotal} set aside: ${[
                    ...(setAside.task > 0 ? [plural(setAside.task, "task note")] : []),
                    ...(setAside.code > 0 ? [plural(setAside.code, "code description")] : []),
                  ].join(", ")}.`,
                ]
              : []),
            ...(duplicates > 0 ? [`${plural(duplicates, "duplicate")} skipped.`] : []),
            ...(dropped > 0
              ? [
                  `${plural(dropped, "candidate")} dropped: citations did not verify or exceeded the limit.`,
                ]
              : []),
          ];
          yield* finish(
            "ran",
            notes.length > 0 ? notes.join(" ") : saved === 0 ? "Nothing durable to save." : null,
          );
        }),
      );
    },
    (effect, _projectId, batch, _rootThreadId) =>
      effect.pipe(
        Effect.mapError((cause) => new AssistedLearningError({ runId: batch[0]!.runId, cause })),
      ),
  );

  const extractRun: AssistedLearningRunnerShape["extractRun"] = Effect.fn(
    "AssistedLearning.extractSingleRun",
  )(
    function* (input) {
      const records = yield* projections
        .getThreadRecords(input.threadId, [])
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      if (records !== null)
        yield* extractBatch(records.thread.projectId, [input], records.thread.lineage.rootThreadId);
    },
    (effect, { runId }) =>
      effect.pipe(Effect.mapError((cause) => new AssistedLearningError({ runId, cause }))),
  );
  const decodeQueue = Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        runId: RunId,
        runOutcome: AssistedLearningRunOutcome,
      }),
    ),
  );
  const drainDue = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const families = yield* sql<{
          projectId: ProjectId;
          rootThreadId: ThreadId;
          completed: number;
          lastQueuedAt: number;
        }>`
      SELECT project_id AS "projectId", root_thread_id AS "rootThreadId",
        SUM(CASE WHEN run_outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
        MAX(queued_at) AS "lastQueuedAt"
      FROM project_knowledge_learning_queue GROUP BY project_id, root_thread_id
      HAVING COALESCE(MAX(retry_at), 0) <= ${now}`;
        if (families.length === 0) return;
        const settings = yield* serverSettings.getSettings;
        for (const family of families) {
          const enabled = resolveProjectSettings(settings, family.projectId).settings
            .enableAssistedLearning;
          if (enabled && family.completed < 8) {
            if (family.lastQueuedAt > now - 30 * 60 * 1000) continue;
            const shells = yield* projections.getShellSnapshot({
              familyOf: family.rootThreadId,
              projectId: family.projectId,
            });
            const members = [...shells.threads, ...shells.archivedThreads];
            const busy = members.some(
              (thread) =>
                thread.activeRunId !== null ||
                thread.activityRunStatus != null ||
                thread.pendingRuntimeRequest !== null,
            );
            const latestActivity = members.reduce(
              (latest, thread) =>
                Math.max(
                  latest,
                  ...[
                    thread.latestVisibleMessage?.updatedAt,
                    thread.latestUserMessageAt,
                    thread.latestRunRequestedAt,
                    thread.latestRunCompletedAt,
                  ].flatMap((at) => (at == null ? [] : [DateTime.toEpochMillis(at)])),
                ),
              family.lastQueuedAt,
            );
            if (busy || latestActivity > now - 30 * 60 * 1000) continue;
          }
          const batch = yield* sql`
        SELECT thread_id AS "threadId", run_id AS "runId", run_outcome AS "runOutcome"
        FROM project_knowledge_learning_queue WHERE project_id = ${family.projectId}
          AND root_thread_id = ${family.rootThreadId} ORDER BY queued_at, run_id LIMIT 8
      `.pipe(Effect.flatMap(decodeQueue));
          if (batch.length > 0) yield* extractBatch(family.projectId, batch, family.rootThreadId);
        }
      }),
    )
    .pipe(
      Effect.mapError((cause) => new AssistedLearningError({ runId: "learning-queue", cause })),
    );
  const enqueueRun: AssistedLearningRunnerShape["enqueueRun"] = Effect.fn(
    "AssistedLearning.enqueueRun",
  )(
    function* (input) {
      const records = yield* projections
        .getThreadRecords(input.threadId, [])
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      if (records === null) return;
      if (yield* managedFolders.isScratchProject(records.thread.projectId)) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql`INSERT INTO project_knowledge_learning_queue
        (run_id, project_id, root_thread_id, thread_id, run_outcome, queued_at)
        SELECT ${input.runId}, ${records.thread.projectId}, ${records.thread.lineage.rootThreadId},
          ${input.threadId}, ${input.runOutcome}, ${now}
        WHERE NOT EXISTS (SELECT 1 FROM project_knowledge_assisted_runs WHERE run_id = ${input.runId})
        ON CONFLICT (run_id) DO NOTHING`;
    },
    (effect, { runId }) =>
      effect.pipe(Effect.mapError((cause) => new AssistedLearningError({ runId, cause }))),
  );
  return { extractRun, enqueueRun, drainDue };
});

export const layerRunner = Layer.effect(AssistedLearningRunner, make);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* AssistedLearningRunner;
    yield* forkParked(
      Effect.forever(
        Effect.gen(function* () {
          yield* runner.drainDue.pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Automatic memory review deferred", { cause }),
            ),
          );
          yield* Effect.sleep("1 minute");
        }),
      ),
    );
  }),
).pipe(Layer.provideMerge(layerRunner));
