import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, RunId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const ModelEvaluationTaskCategory = Schema.Literals([
  "coding",
  "debugging",
  "review",
  "testing",
  "documentation",
  "research",
  "planning",
  "other",
]);
const ModelEvaluationConfidence = Schema.Literals(["low", "medium", "high"]);
export const ModelEvaluationRunOutcome = Schema.Literals([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type ModelEvaluationRunOutcome = typeof ModelEvaluationRunOutcome.Type;

const Score = Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })));
const MeanScore = Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 4 })));

const ModelEvaluationScores = Schema.Struct({
  taskCompletion: Score,
  correctness: Score,
  instructionFollowing: Score,
  verification: Score,
});
const ModelEvaluationObservation = Schema.Struct({
  text: Schema.NonEmptyString.check(Schema.isMaxLength(600)),
  citations: Schema.Array(Schema.String.check(Schema.isPattern(/^[UEC][1-9]\d{0,2}$/))).check(
    Schema.isMaxLength(5),
  ),
});
const Observations = Schema.Array(ModelEvaluationObservation).check(Schema.isMaxLength(3));

export const ModelEvaluationVerdict = Schema.Struct({
  outcome: Schema.Literals(["scored", "insufficient_evidence"]),
  taskCategory: ModelEvaluationTaskCategory,
  scores: ModelEvaluationScores,
  confidence: ModelEvaluationConfidence,
  rationale: ModelEvaluationObservation,
  strengths: Observations,
  weaknesses: Observations,
  promptAdvice: Observations,
});
export type ModelEvaluationVerdict = typeof ModelEvaluationVerdict.Type;

const Evidence = Schema.Struct({
  ref: Schema.String.check(Schema.isPattern(/^[UEC][1-9]\d{0,2}$/)),
  kind: Schema.Literals(["user", "assistant", "command", "file_change", "tool", "subagent"]),
  text: Schema.String.check(Schema.isMaxLength(8_000)),
});

export const BlindModelEvaluationPacket = Schema.Struct({
  scope: Schema.Literals(["turn", "subagent"]),
  runOutcome: ModelEvaluationRunOutcome,
  request: Schema.Struct({
    ref: Schema.Literal("U1"),
    text: Schema.String.check(Schema.isMaxLength(8_000)),
  }),
  context: Schema.Array(Evidence).check(Schema.isMaxLength(8)),
  evidence: Schema.Array(Evidence).check(Schema.isMaxLength(32)),
  truncated: Schema.Boolean,
  omittedItems: NonNegativeInt,
  missingArtifacts: Schema.Boolean,
});
export type BlindModelEvaluationPacket = typeof BlindModelEvaluationPacket.Type;

export const ModelEvaluationRecord = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  projectId: ProjectId,
  scope: Schema.Literals(["turn", "subagent"]),
  runOutcome: ModelEvaluationRunOutcome,
  modelSelection: ModelSelection,
  evaluatorSelection: ModelSelection,
  rubricVersion: Schema.String,
  at: IsoDateTime,
  status: Schema.Literals(["scored", "insufficient_evidence", "failed", "skipped"]),
  reason: Schema.NullOr(Schema.String),
  verdict: Schema.NullOr(ModelEvaluationVerdict),
  promptChars: NonNegativeInt,
  evidenceChars: NonNegativeInt,
});
export type ModelEvaluationRecord = typeof ModelEvaluationRecord.Type;

export const ModelEvaluationGuidance = Schema.Struct({
  scope: Schema.Literals(["turn", "subagent"]),
  modelSelection: ModelSelection,
  evaluatorSelection: ModelSelection,
  rubricVersion: Schema.String,
  taskCategory: ModelEvaluationTaskCategory,
  sampleCount: NonNegativeInt,
  insufficientEvidenceCount: NonNegativeInt,
  meanScores: Schema.Struct({
    taskCompletion: MeanScore,
    correctness: MeanScore,
    instructionFollowing: MeanScore,
    verification: MeanScore,
  }),
  scoreCounts: Schema.Struct({
    taskCompletion: NonNegativeInt,
    correctness: NonNegativeInt,
    instructionFollowing: NonNegativeInt,
    verification: NonNegativeInt,
  }),
  confidence: Schema.Literals(["provisional", "observed"]),
  promptChars: Schema.Struct({ min: NonNegativeInt, median: Schema.Number, max: NonNegativeInt }),
  strengths: Schema.Array(Schema.String),
  weaknesses: Schema.Array(Schema.String),
  promptAdvice: Schema.Array(Schema.String),
  latestAt: IsoDateTime,
});
export type ModelEvaluationGuidance = typeof ModelEvaluationGuidance.Type;

export const ModelEvaluationReport = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
  records: Schema.Array(ModelEvaluationRecord),
  guidance: Schema.Array(ModelEvaluationGuidance),
  windowLimit: NonNegativeInt,
});
export type ModelEvaluationReport = typeof ModelEvaluationReport.Type;

export const ModelEvaluationListInput = Schema.Struct({ projectId: ProjectId });
export const ModelEvaluationClearInput = Schema.Struct({ projectId: ProjectId });

export class ModelEvaluationError extends Schema.TaggedError<ModelEvaluationError>()(
  "ModelEvaluationError",
  {
    projectId: ProjectId,
    reason: Schema.Literals(["missing_project", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "missing_project"
      ? "The project for model evaluations is unavailable."
      : "Model evaluations could not be read or saved.";
  }
}
