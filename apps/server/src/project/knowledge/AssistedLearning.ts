import {
  CommandId,
  ProjectFactId,
  ProjectKnowledgeMutation,
  type AssistedLearningRun,
  type KnowledgeMessageRef,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  AssistedLearningError,
  AssistedLearningRunner,
  type AssistedLearningRunnerShape,
} from "./assistedLearningSchedule.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

// Bounds on what one run sends to the model and what it may propose back.
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_TRANSCRIPT_CHARS = 32_000;
const MAX_CANDIDATES = 3;
const MAX_CANDIDATE_CHARS = 2_000;
const MAX_ENTITIES = 5;

// The provider schema keeps the reply loosely typed; this is the boundary that decides what
// may become a proposal.
const Candidate = Schema.Struct({
  kind: Schema.Literals(["decision", "constraint", "convention"]),
  content: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_CANDIDATE_CHARS)),
  entities: Schema.Array(Schema.String),
  citations: Schema.Array(Schema.String),
});
const decodeCandidate = Schema.decodeUnknownOption(Candidate);
// The proposal must also satisfy the mutation contract, which caps citations per fact.
const isMutation = Schema.is(ProjectKnowledgeMutation);

const make = Effect.gen(function* () {
  const crypto = yield* Digest.Digest;
  const sql = yield* SqlClient.SqlClient;
  const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const digest = (text: string) =>
    crypto.digest(Digest.sha256, new TextEncoder().encode(text)).pipe(Effect.map(Hex.encode));

  const extractRun: AssistedLearningRunnerShape["extractRun"] = Effect.fn(
    "AssistedLearning.extractRun",
  )(
    function* ({ threadId, runId, runOutcome }) {
      const records = yield* projections
        // The run's request and its replies both carry the run id.
        .getThreadRecords(threadId, ["messages"], { messageRunIds: [runId] })
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      // With no thread there is no project to attribute an outcome to.
      if (records === null) return;
      const projectId: ProjectId = records.thread.projectId;
      if (yield* knowledge.hasAssistedRun(projectId, runId)) return;
      const finish = (
        result: AssistedLearningRun["result"],
        reason: string | null,
        counts: { readonly proposed: number; readonly suggested: number } = {
          proposed: 0,
          suggested: 0,
        },
      ) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            knowledge.recordAssistedRun(projectId, {
              threadId,
              runId,
              runOutcome,
              result,
              reason,
              ...counts,
              at: DateTime.formatIso(now),
            }),
          ),
        );
      if (records.thread.deletedAt !== null) return yield* finish("skipped", "Thread was deleted.");
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        projectId,
      ).settings;
      // The setting can change between scheduling and running; the latest choice wins.
      if (!settings.enableAssistedLearning)
        return yield* finish("skipped", "Assisted learning is off for this project.");
      const finalized = records.messages
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            !message.streaming &&
            message.text.trim() !== "",
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
        );
      if (!finalized.some((message) => message.role === "assistant"))
        return yield* finish("skipped", "The run has no finished reply to learn from.");
      // Keep the request and the latest replies; the middle of a long run goes first.
      const kept: typeof finalized = [];
      let budget = MAX_TRANSCRIPT_CHARS;
      for (const message of [finalized[0]!, ...finalized.slice(1).toReversed()]) {
        if (kept.length >= MAX_MESSAGES || budget <= 0) break;
        kept.push(message);
        budget -= Math.min(message.text.length, MAX_MESSAGE_CHARS);
      }
      const transcript = kept.toSorted(
        (left, right) => finalized.indexOf(left) - finalized.indexOf(right),
      );
      // Citations are message ids and digests from this canonical read; the model only names refs.
      const refs = new Map<string, KnowledgeMessageRef>();
      const messages = [];
      for (const [index, message] of transcript.entries()) {
        const ref = `M${index + 1}`;
        refs.set(ref, {
          kind: "message",
          threadId,
          messageId: message.id,
          digest: yield* digest(message.text),
        });
        messages.push({
          ref,
          role: message.role as "user" | "assistant",
          text:
            message.text.length > MAX_MESSAGE_CHARS
              ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}\n[truncated]`
              : message.text,
        });
      }
      const project = yield* projects.get(projectId);
      const cwd =
        records.thread.worktreePath ??
        (Option.isSome(project) ? project.value.workspaceRoot : undefined);
      if (cwd === undefined) return yield* finish("skipped", "The project was not found.");
      const generated = yield* textGeneration
        .generateKnowledgeCandidates({
          cwd,
          runOutcome,
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
      const actor = { kind: "assisted" as const, threadId, runId, runOutcome };
      // Proposals commit with the run's outcome. A lost outcome then leaves nothing a user could
      // have reviewed or forgotten, and an attempt that finished first keeps its result.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (yield* knowledge.hasAssistedRun(projectId, runId)) return;
          let proposed = 0;
          let suggested = 0;
          let dropped = 0;
          for (const raw of generated.candidates.slice(0, MAX_CANDIDATES)) {
            const candidate = Option.getOrNull(decodeCandidate(raw));
            const sources = [
              ...new Set((candidate?.citations ?? []).map((ref) => ref.trim())),
            ].flatMap((ref) => {
              const source = refs.get(ref);
              return source ? [source] : [];
            });
            if (candidate === null || sources.length === 0) {
              dropped += 1;
              continue;
            }
            // Named by run and content, so a retry that regenerates candidates in another order
            // lands on the same ids and cannot bring back a proposal that was since forgotten.
            const id = `assisted:${runId}:${(yield* digest(candidate.content)).slice(0, 32)}`;
            const proposal = {
              action: "create" as const,
              commandId: CommandId.make(id),
              factId: ProjectFactId.make(id),
              projectId,
              kind: candidate.kind,
              content: candidate.content,
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
            if (!isMutation(proposal)) {
              dropped += 1;
              continue;
            }
            const result = yield* knowledge.proposeAssisted(proposal, actor).pipe(
              Effect.catchTags({
                ProjectKnowledgeError: (error) =>
                  error.reason === "storage" || error.reason === "missing_project"
                    ? Effect.fail(error)
                    : Effect.succeed({ outcome: "dropped" as const }),
              }),
            );
            if (result.outcome === "proposed") proposed += 1;
            else if (result.outcome === "suggested") {
              proposed += 1;
              suggested += 1;
            } else if (result.outcome === "dropped") dropped += 1;
          }
          yield* finish(
            "ran",
            proposed === 0 && dropped === 0
              ? "Nothing durable to propose."
              : dropped > 0
                ? `${dropped} candidate${dropped === 1 ? "" : "s"} dropped: citations did not verify or exceeded the limit.`
                : null,
            { proposed, suggested },
          );
        }),
      );
    },
    (effect, { runId }) =>
      effect.pipe(Effect.mapError((cause) => new AssistedLearningError({ runId, cause }))),
  );

  return { extractRun };
});

export const layerRunner = Layer.effect(AssistedLearningRunner, make);
