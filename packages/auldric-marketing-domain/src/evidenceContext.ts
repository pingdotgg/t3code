// @effect-diagnostics nodeBuiltinImport:off - bounded context digests are local integrity receipts.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MarketingCanonicalRegistryKey,
  MarketingCanonicalRevisionReference,
  MarketingReviewRevisionReference,
  MarketingSourceLineageReference,
} from "./canonical.ts";
import { compareCanonicalText } from "./canonicalSeal.ts";
import { MarketingEvidenceContextError } from "./evidenceContextErrors.ts";
import { MarketingDecisionId, MarketingPlanId, MarketingWorkspaceSelection } from "./identity.ts";

export const MARKETING_EVIDENCE_CONTEXT_FORMAT = "auldric-marketing-evidence-context-v1" as const;
export const MARKETING_EVIDENCE_TOKENIZER_REF = "auldric/utf8-ceil-4@1" as const;
export const MARKETING_EVIDENCE_POLICY_REF = "auldric/evidence-context@1" as const;
export const MARKETING_EVIDENCE_ENVELOPE_TOKENS = 256;
export const MARKETING_EVIDENCE_MAX_CANDIDATES = 256;
export const MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST = 24;
export const MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST = 32;
export const MARKETING_EVIDENCE_MAX_FACT_VALUE_BYTES = 32_768;

const EvidenceKeyPattern = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;
const Sha256Pattern = /^[0-9a-f]{64}$/u;

const BoundedText = (maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum));

export const MarketingEvidenceStableKey = BoundedText(100)
  .check(Schema.isPattern(EvidenceKeyPattern))
  .pipe(Schema.brand("MarketingEvidenceStableKey"));
export type MarketingEvidenceStableKey = typeof MarketingEvidenceStableKey.Type;

export const MarketingEvidenceLocator = BoundedText(1_000).pipe(
  Schema.brand("MarketingEvidenceLocator"),
);
export type MarketingEvidenceLocator = typeof MarketingEvidenceLocator.Type;

export const MarketingEvidenceSha256 = Schema.String.check(Schema.isPattern(Sha256Pattern)).pipe(
  Schema.brand("MarketingEvidenceSha256"),
);
export type MarketingEvidenceSha256 = typeof MarketingEvidenceSha256.Type;

export const MarketingEvidenceFactValue = Schema.Json.check(
  Schema.makeFilter(
    (value: Schema.Json) =>
      Buffer.byteLength(JSON.stringify(value), "utf8") <= MARKETING_EVIDENCE_MAX_FACT_VALUE_BYTES ||
      `Accepted fact values must not exceed ${MARKETING_EVIDENCE_MAX_FACT_VALUE_BYTES} bytes.`,
  ),
);
export type MarketingEvidenceFactValue = typeof MarketingEvidenceFactValue.Type;

export const MarketingEvidenceStateCode = BoundedText(100)
  .check(Schema.isPattern(EvidenceKeyPattern))
  .pipe(Schema.brand("MarketingEvidenceStateCode"));
export type MarketingEvidenceStateCode = typeof MarketingEvidenceStateCode.Type;

export const MarketingSourceCapabilityState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available") }),
  Schema.Struct({ state: Schema.Literal("unavailable"), code: MarketingEvidenceStateCode }),
  Schema.Struct({ state: Schema.Literal("unsupported"), code: MarketingEvidenceStateCode }),
]);
export type MarketingSourceCapabilityState = typeof MarketingSourceCapabilityState.Type;

export const MarketingSourceAccessState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("authorized") }),
  Schema.Struct({ state: Schema.Literal("denied"), code: MarketingEvidenceStateCode }),
  Schema.Struct({ state: Schema.Literal("expired"), code: MarketingEvidenceStateCode }),
  Schema.Struct({ state: Schema.Literal("unknown"), code: MarketingEvidenceStateCode }),
]);
export type MarketingSourceAccessState = typeof MarketingSourceAccessState.Type;

export const MarketingSourceImportState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("imported"), importedAt: Schema.DateTimeUtc }),
  Schema.Struct({ state: Schema.Literal("not-imported") }),
  Schema.Struct({ state: Schema.Literal("not-required") }),
  Schema.Struct({ state: Schema.Literal("failed"), code: MarketingEvidenceStateCode }),
]);
export type MarketingSourceImportState = typeof MarketingSourceImportState.Type;

export const MarketingSourceIndexState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("indexed"), indexedAt: Schema.DateTimeUtc }),
  Schema.Struct({ state: Schema.Literal("not-indexed") }),
  Schema.Struct({ state: Schema.Literal("indexing") }),
  Schema.Struct({ state: Schema.Literal("not-required") }),
  Schema.Struct({
    state: Schema.Literal("stale"),
    indexedAt: Schema.optionalKey(Schema.DateTimeUtc),
  }),
  Schema.Struct({ state: Schema.Literal("failed"), code: MarketingEvidenceStateCode }),
]);
export type MarketingSourceIndexState = typeof MarketingSourceIndexState.Type;

export const MarketingSourceFreshnessState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("current"), checkedAt: Schema.DateTimeUtc }),
  Schema.Struct({ state: Schema.Literal("stale"), checkedAt: Schema.DateTimeUtc }),
  Schema.Struct({ state: Schema.Literal("unknown") }),
]);
export type MarketingSourceFreshnessState = typeof MarketingSourceFreshnessState.Type;

export const MarketingSourceObservation = Schema.Struct({
  source: MarketingSourceLineageReference,
  adapterKey: MarketingCanonicalRegistryKey,
  capability: MarketingSourceCapabilityState,
  access: MarketingSourceAccessState,
  import: MarketingSourceImportState,
  index: MarketingSourceIndexState,
  freshness: MarketingSourceFreshnessState,
  observedAt: Schema.DateTimeUtc,
});
export type MarketingSourceObservation = typeof MarketingSourceObservation.Type;

const QualityScore = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

export const MarketingEvidenceQuality = Schema.Struct({
  authority: QualityScore,
  directness: QualityScore,
  freshness: QualityScore,
  corroboration: QualityScore,
});
export type MarketingEvidenceQuality = typeof MarketingEvidenceQuality.Type;

export const MarketingRetrievedEvidence = Schema.Struct({
  source: MarketingSourceLineageReference,
  locator: MarketingEvidenceLocator,
  excerpt: BoundedText(12_000),
  contentSha256: MarketingEvidenceSha256,
  observedAt: Schema.DateTimeUtc,
  quality: MarketingEvidenceQuality,
  relation: Schema.Literals(["support", "conflict", "disconfirm"]),
  required: Schema.Boolean,
  decisionImpact: QualityScore,
  relevance: QualityScore,
});
export type MarketingRetrievedEvidence = typeof MarketingRetrievedEvidence.Type;

export const MarketingAcceptedFact = Schema.Struct({
  stableKey: MarketingEvidenceStableKey,
  decisionId: MarketingDecisionId,
  revision: MarketingCanonicalRevisionReference,
  claim: BoundedText(2_000),
  value: MarketingEvidenceFactValue,
  support: Schema.Array(MarketingSourceLineageReference).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  reviews: Schema.Array(MarketingReviewRevisionReference).check(Schema.isMaxLength(16)),
  supportState: Schema.Literals(["current", "stale", "unavailable"]),
});
export type MarketingAcceptedFact = typeof MarketingAcceptedFact.Type;

export const MarketingEvidenceAssumption = Schema.Struct({
  key: MarketingEvidenceStableKey,
  statement: BoundedText(2_000),
  risk: Schema.Literals(["low", "medium", "high"]),
  validationNeeded: Schema.Boolean,
});
export type MarketingEvidenceAssumption = typeof MarketingEvidenceAssumption.Type;

export const MarketingEvidenceConflict = Schema.Struct({
  key: MarketingEvidenceStableKey,
  summary: BoundedText(2_000),
  blocks: Schema.Boolean,
});
export type MarketingEvidenceConflict = typeof MarketingEvidenceConflict.Type;

export const MarketingEvidenceGap = Schema.Struct({
  key: MarketingEvidenceStableKey,
  summary: BoundedText(2_000),
  blocks: Schema.Boolean,
});
export type MarketingEvidenceGap = typeof MarketingEvidenceGap.Type;

export const MarketingDecisionChangingQuestion = Schema.Struct({
  key: MarketingEvidenceStableKey,
  question: BoundedText(2_000),
  decisionImpact: QualityScore,
});
export type MarketingDecisionChangingQuestion = typeof MarketingDecisionChangingQuestion.Type;

export const MarketingDisconfirmationSignal = Schema.Struct({
  key: MarketingEvidenceStableKey,
  signal: BoundedText(2_000),
  consequence: BoundedText(2_000),
});
export type MarketingDisconfirmationSignal = typeof MarketingDisconfirmationSignal.Type;

export const MarketingPlanReadiness = Schema.Union([
  Schema.Struct({ state: Schema.Literal("not-evaluated") }),
  Schema.Struct({
    state: Schema.Literal("blocked"),
    codes: Schema.Array(MarketingEvidenceStateCode).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({
    state: Schema.Literal("partial"),
    codes: Schema.Array(MarketingEvidenceStateCode).check(Schema.isMaxLength(16)),
  }),
  Schema.Struct({ state: Schema.Literal("ready") }),
]);
export type MarketingPlanReadiness = typeof MarketingPlanReadiness.Type;

export const MarketingEvidencePlanSelection = Schema.Struct({
  planId: MarketingPlanId,
  revision: MarketingCanonicalRevisionReference,
  stageKey: Schema.optionalKey(MarketingCanonicalRegistryKey),
  stepKey: Schema.optionalKey(MarketingCanonicalRegistryKey),
});
export type MarketingEvidencePlanSelection = typeof MarketingEvidencePlanSelection.Type;

export const MarketingUnresolvedDecision = Schema.Struct({
  key: MarketingEvidenceStableKey,
  summary: BoundedText(2_000),
  blocks: Schema.Boolean,
});
export type MarketingUnresolvedDecision = typeof MarketingUnresolvedDecision.Type;

export const MarketingContextBudget = Schema.Struct({
  maxTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
  maxItems: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxPerSource: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  maxCandidateBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 262_144 })),
  tokenizerRef: Schema.Literal(MARKETING_EVIDENCE_TOKENIZER_REF),
  policyRef: Schema.Literal(MARKETING_EVIDENCE_POLICY_REF),
});
export type MarketingContextBudget = typeof MarketingContextBudget.Type;

export const DEFAULT_MARKETING_CONTEXT_BUDGET: MarketingContextBudget = {
  maxTokens: 4_096,
  maxItems: 24,
  maxPerSource: 6,
  maxCandidateBytes: 96_000,
  tokenizerRef: MARKETING_EVIDENCE_TOKENIZER_REF,
  policyRef: MARKETING_EVIDENCE_POLICY_REF,
};

export const MarketingEvidenceExclusionReason = Schema.Literals([
  "duplicate",
  "inaccessible",
  "unindexed",
  "stale-policy",
  "superseded",
  "budget",
]);
export type MarketingEvidenceExclusionReason = typeof MarketingEvidenceExclusionReason.Type;

export const MarketingEvidenceReceiptSubject = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("source"),
    source: MarketingSourceLineageReference,
  }),
  Schema.Struct({
    kind: Schema.Literal("retrieved-evidence"),
    source: MarketingSourceLineageReference,
    locator: MarketingEvidenceLocator,
  }),
  Schema.Struct({
    kind: Schema.Literal("accepted-fact"),
    stableKey: MarketingEvidenceStableKey,
    decisionId: MarketingDecisionId,
    revision: MarketingCanonicalRevisionReference,
  }),
]);
export type MarketingEvidenceReceiptSubject = typeof MarketingEvidenceReceiptSubject.Type;

export const MarketingEvidenceReceiptIncludedItem = Schema.Struct({
  subject: MarketingEvidenceReceiptSubject,
  digest: MarketingEvidenceSha256,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MarketingEvidenceReceiptIncludedItem = typeof MarketingEvidenceReceiptIncludedItem.Type;

export const MarketingEvidenceReceiptExcludedItem = Schema.Struct({
  subject: MarketingEvidenceReceiptSubject,
  digest: MarketingEvidenceSha256,
  reason: MarketingEvidenceExclusionReason,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MarketingEvidenceReceiptExcludedItem = typeof MarketingEvidenceReceiptExcludedItem.Type;

export const MarketingEvidenceReceipt = Schema.Struct({
  asOf: Schema.DateTimeUtc,
  planInput: Schema.optionalKey(MarketingEvidencePlanSelection),
  sourceInputs: Schema.Array(MarketingSourceLineageReference).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
  factInputs: Schema.Array(
    Schema.Struct({
      stableKey: MarketingEvidenceStableKey,
      decisionId: MarketingDecisionId,
      revision: MarketingCanonicalRevisionReference,
    }),
  ).check(Schema.isMaxLength(MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST)),
  candidateDigests: Schema.Array(MarketingEvidenceSha256).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_CANDIDATES + MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST),
  ),
  included: Schema.Array(MarketingEvidenceReceiptIncludedItem).check(Schema.isMaxLength(64)),
  excluded: Schema.Array(MarketingEvidenceReceiptExcludedItem).check(
    Schema.isMaxLength(
      MARKETING_EVIDENCE_MAX_CANDIDATES + MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST + 64,
    ),
  ),
  envelopeTokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  includedTokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  budget: MarketingContextBudget,
  packetSha256: MarketingEvidenceSha256,
  tokenizerRef: Schema.Literal(MARKETING_EVIDENCE_TOKENIZER_REF),
  policyRef: Schema.Literal(MARKETING_EVIDENCE_POLICY_REF),
});
export type MarketingEvidenceReceipt = typeof MarketingEvidenceReceipt.Type;

export const MarketingEvidenceContextPacket = Schema.Struct({
  format: Schema.Literal(MARKETING_EVIDENCE_CONTEXT_FORMAT),
  workspace: MarketingWorkspaceSelection,
  asOf: Schema.DateTimeUtc,
  plan: Schema.optionalKey(MarketingEvidencePlanSelection),
  sources: Schema.Array(MarketingSourceObservation).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
  acceptedFacts: Schema.Array(MarketingAcceptedFact).check(Schema.isMaxLength(32)),
  evidence: Schema.Array(MarketingRetrievedEvidence).check(Schema.isMaxLength(64)),
  assumptions: Schema.Array(MarketingEvidenceAssumption).check(Schema.isMaxLength(32)),
  conflicts: Schema.Array(MarketingEvidenceConflict).check(Schema.isMaxLength(32)),
  gaps: Schema.Array(MarketingEvidenceGap).check(Schema.isMaxLength(32)),
  questions: Schema.Array(MarketingDecisionChangingQuestion).check(Schema.isMaxLength(32)),
  disconfirmationSignals: Schema.Array(MarketingDisconfirmationSignal).check(
    Schema.isMaxLength(32),
  ),
  readiness: MarketingPlanReadiness,
  unresolvedDecisions: Schema.Array(MarketingUnresolvedDecision).check(Schema.isMaxLength(32)),
  budget: MarketingContextBudget,
  receipt: MarketingEvidenceReceipt,
});
export type MarketingEvidenceContextPacket = typeof MarketingEvidenceContextPacket.Type;

export interface CompileMarketingEvidenceContextInput {
  readonly workspace: MarketingWorkspaceSelection;
  readonly asOf: DateTime.Utc;
  readonly plan?: MarketingEvidencePlanSelection;
  readonly sourceAllowlist: ReadonlyArray<MarketingSourceLineageReference>;
  readonly sources: ReadonlyArray<MarketingSourceObservation>;
  readonly candidates: ReadonlyArray<MarketingRetrievedEvidence>;
  readonly acceptedFacts: ReadonlyArray<MarketingAcceptedFact>;
  readonly assumptions?: ReadonlyArray<MarketingEvidenceAssumption>;
  readonly conflicts?: ReadonlyArray<MarketingEvidenceConflict>;
  readonly gaps?: ReadonlyArray<MarketingEvidenceGap>;
  readonly questions?: ReadonlyArray<MarketingDecisionChangingQuestion>;
  readonly disconfirmationSignals?: ReadonlyArray<MarketingDisconfirmationSignal>;
  readonly readiness?: MarketingPlanReadiness;
  readonly unresolvedDecisions?: ReadonlyArray<MarketingUnresolvedDecision>;
  readonly budget?: MarketingContextBudget;
  readonly sourceExclusions?: ReadonlyArray<{
    readonly source: MarketingSourceLineageReference;
    readonly reason: Extract<
      MarketingEvidenceExclusionReason,
      "inaccessible" | "unindexed" | "stale-policy"
    >;
  }>;
  readonly supersededFacts?: ReadonlyArray<{
    readonly stableKey: MarketingEvidenceStableKey;
    readonly decisionId: MarketingDecisionId;
    readonly revision: MarketingCanonicalRevisionReference;
  }>;
}

const decodeWorkspace = Schema.decodeUnknownSync(MarketingWorkspaceSelection);
const decodeSourceAllowlist = Schema.decodeUnknownSync(
  Schema.Array(MarketingSourceLineageReference).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
);
const decodeSources = Schema.decodeUnknownSync(
  Schema.Array(MarketingSourceObservation).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
);
const decodeCandidates = Schema.decodeUnknownSync(
  Schema.Array(MarketingRetrievedEvidence).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_CANDIDATES),
  ),
);
const decodeAcceptedFacts = Schema.decodeUnknownSync(
  Schema.Array(MarketingAcceptedFact).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST),
  ),
);
const decodeAssumptions = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceAssumption).check(Schema.isMaxLength(32)),
);
const decodeConflicts = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceConflict).check(Schema.isMaxLength(32)),
);
const decodeGaps = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceGap).check(Schema.isMaxLength(32)),
);
const decodeQuestions = Schema.decodeUnknownSync(
  Schema.Array(MarketingDecisionChangingQuestion).check(Schema.isMaxLength(32)),
);
const decodeSignals = Schema.decodeUnknownSync(
  Schema.Array(MarketingDisconfirmationSignal).check(Schema.isMaxLength(32)),
);
const decodeReadiness = Schema.decodeUnknownSync(MarketingPlanReadiness);
const decodePlan = Schema.decodeUnknownSync(MarketingEvidencePlanSelection);
const decodeUnresolved = Schema.decodeUnknownSync(
  Schema.Array(MarketingUnresolvedDecision).check(Schema.isMaxLength(32)),
);
const decodeBudget = Schema.decodeUnknownSync(MarketingContextBudget);
const decodeSourceExclusions = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      source: MarketingSourceLineageReference,
      reason: Schema.Literals(["inaccessible", "unindexed", "stale-policy"]),
    }),
  ).check(Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST)),
);
const decodeSupersededFacts = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      stableKey: MarketingEvidenceStableKey,
      decisionId: MarketingDecisionId,
      revision: MarketingCanonicalRevisionReference,
    }),
  ).check(Schema.isMaxLength(MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST)),
);
const decodeAsOf = Schema.decodeUnknownSync(Schema.DateTimeUtc);
const isEvidenceContextError = Schema.is(MarketingEvidenceContextError);

function normalizeText(value: string, trim = false): string {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC");
  return trim ? normalized.trim() : normalized;
}

function normalizeJson(value: Schema.Json): Schema.Json {
  if (typeof value === "string") return normalizeText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  const entries = Object.entries(value)
    .map(([key, entry]) => [normalizeText(key), normalizeJson(entry)] as const)
    .sort(([left], [right]) => compareCanonicalText(left, right));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.[0] === entries[index]?.[0]) {
      throw new MarketingEvidenceContextError({
        reason: "invalid_context_input",
        reference: "normalized-json-key-collision",
      });
    }
  }
  return Object.fromEntries(entries);
}

function canonicalJson(value: Schema.Json): string {
  return JSON.stringify(normalizeJson(value));
}

function sha256(value: string): MarketingEvidenceSha256 {
  return MarketingEvidenceSha256.make(NodeCrypto.createHash("sha256").update(value).digest("hex"));
}

function sourceReferenceText(source: MarketingSourceLineageReference): string {
  return `${source.sourceId}@${source.revision.version}:${source.revision.revisionId}`;
}

function sourceReferenceJson(source: MarketingSourceLineageReference): Schema.Json {
  return {
    sourceId: source.sourceId,
    revisionId: source.revision.revisionId,
    version: source.revision.version,
  };
}

function subjectJson(subject: MarketingEvidenceReceiptSubject): Schema.Json {
  switch (subject.kind) {
    case "source":
      return { kind: subject.kind, source: sourceReferenceJson(subject.source) };
    case "retrieved-evidence":
      return {
        kind: subject.kind,
        source: sourceReferenceJson(subject.source),
        locator: subject.locator,
      };
    case "accepted-fact":
      return {
        kind: subject.kind,
        stableKey: subject.stableKey,
        decisionId: subject.decisionId,
        revisionId: subject.revision.revisionId,
        version: subject.revision.version,
      };
  }
}

function evidenceJson(evidence: MarketingRetrievedEvidence): Schema.Json {
  return {
    source: sourceReferenceJson(evidence.source),
    locator: evidence.locator,
    excerpt: evidence.excerpt,
    contentSha256: evidence.contentSha256,
    observedAt: DateTime.formatIso(evidence.observedAt),
    quality: evidence.quality,
    relation: evidence.relation,
    required: evidence.required,
    decisionImpact: evidence.decisionImpact,
    relevance: evidence.relevance,
  };
}

function factJson(fact: MarketingAcceptedFact): Schema.Json {
  return {
    stableKey: fact.stableKey,
    decisionId: fact.decisionId,
    revision: {
      revisionId: fact.revision.revisionId,
      version: fact.revision.version,
    },
    claim: fact.claim,
    value: fact.value,
    support: fact.support.map(sourceReferenceJson),
    reviews: fact.reviews.map((review) => ({
      reviewId: review.reviewId,
      revisionId: review.revision.revisionId,
      version: review.revision.version,
    })),
    supportState: fact.supportState,
  };
}

function observationJson(observation: MarketingSourceObservation): Schema.Json {
  const stateJson = (state: object): Schema.Json => {
    const entries = Object.entries(state).map(([key, value]) => [
      key,
      DateTime.isDateTime(value) ? DateTime.formatIso(value) : value,
    ]);
    return Object.fromEntries(entries) as Schema.Json;
  };
  return {
    source: sourceReferenceJson(observation.source),
    adapterKey: observation.adapterKey,
    capability: stateJson(observation.capability),
    access: stateJson(observation.access),
    import: stateJson(observation.import),
    index: stateJson(observation.index),
    freshness: stateJson(observation.freshness),
    observedAt: DateTime.formatIso(observation.observedAt),
  };
}

function normalizeEvidence(evidence: MarketingRetrievedEvidence): MarketingRetrievedEvidence {
  return {
    source: evidence.source,
    locator: MarketingEvidenceLocator.make(normalizeText(evidence.locator, true)),
    excerpt: normalizeText(evidence.excerpt, true),
    contentSha256: evidence.contentSha256,
    observedAt: evidence.observedAt,
    quality: evidence.quality,
    relation: evidence.relation,
    required: evidence.required,
    decisionImpact: evidence.decisionImpact,
    relevance: evidence.relevance,
  };
}

function normalizeFact(fact: MarketingAcceptedFact): MarketingAcceptedFact {
  return {
    stableKey: fact.stableKey,
    decisionId: fact.decisionId,
    revision: fact.revision,
    claim: normalizeText(fact.claim, true),
    value: normalizeJson(fact.value),
    support: [...fact.support].sort(compareSourceReference),
    reviews: [...fact.reviews].sort(
      (left, right) =>
        compareCanonicalText(left.reviewId, right.reviewId) ||
        left.revision.version - right.revision.version ||
        compareCanonicalText(left.revision.revisionId, right.revision.revisionId),
    ),
    supportState: fact.supportState,
  };
}

function normalizeAssumption(value: MarketingEvidenceAssumption): MarketingEvidenceAssumption {
  return { ...value, statement: normalizeText(value.statement, true) };
}

function normalizeConflict(value: MarketingEvidenceConflict): MarketingEvidenceConflict {
  return { ...value, summary: normalizeText(value.summary, true) };
}

function normalizeGap(value: MarketingEvidenceGap): MarketingEvidenceGap {
  return { ...value, summary: normalizeText(value.summary, true) };
}

function normalizeQuestion(
  value: MarketingDecisionChangingQuestion,
): MarketingDecisionChangingQuestion {
  return { ...value, question: normalizeText(value.question, true) };
}

function normalizeSignal(value: MarketingDisconfirmationSignal): MarketingDisconfirmationSignal {
  return {
    ...value,
    signal: normalizeText(value.signal, true),
    consequence: normalizeText(value.consequence, true),
  };
}

function normalizeUnresolved(value: MarketingUnresolvedDecision): MarketingUnresolvedDecision {
  return { ...value, summary: normalizeText(value.summary, true) };
}

function sortUniqueByStableKey<A extends { readonly key: MarketingEvidenceStableKey }>(
  values: ReadonlyArray<A>,
  collection: string,
): ReadonlyArray<A> {
  const sorted = [...values].sort((left, right) => compareCanonicalText(left.key, right.key));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]?.key === sorted[index]?.key) {
      throw new MarketingEvidenceContextError({
        reason: "invalid_context_input",
        reference: `duplicate-${collection}-key:${sorted[index]?.key}`,
      });
    }
  }
  return sorted;
}

function normalizeReadiness(readiness: MarketingPlanReadiness): MarketingPlanReadiness {
  if (readiness.state === "ready" || readiness.state === "not-evaluated") return readiness;
  return {
    state: readiness.state,
    codes: [...new Set(readiness.codes)].sort(compareCanonicalText),
  };
}

function sourceTimestampAfterSnapshot(
  source: MarketingSourceObservation,
  asOf: DateTime.Utc,
): boolean {
  const timestamps = [source.observedAt];
  if (source.import.state === "imported") timestamps.push(source.import.importedAt);
  if (
    (source.index.state === "indexed" || source.index.state === "stale") &&
    source.index.indexedAt !== undefined
  ) {
    timestamps.push(source.index.indexedAt);
  }
  if (source.freshness.state !== "unknown") timestamps.push(source.freshness.checkedAt);
  return timestamps.some((timestamp) => timestamp.epochMilliseconds > asOf.epochMilliseconds);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4));
}

function evidenceDigest(evidence: MarketingRetrievedEvidence): MarketingEvidenceSha256 {
  return sha256(canonicalJson(evidenceJson(evidence)));
}

function factDigest(fact: MarketingAcceptedFact): MarketingEvidenceSha256 {
  return sha256(canonicalJson(factJson(fact)));
}

function sourceDigest(source: MarketingSourceLineageReference): MarketingEvidenceSha256 {
  return sha256(canonicalJson(sourceReferenceJson(source)));
}

const relationRank: Readonly<Record<MarketingRetrievedEvidence["relation"], number>> = {
  conflict: 2,
  disconfirm: 2,
  support: 1,
};

function compareEvidence(
  left: MarketingRetrievedEvidence,
  right: MarketingRetrievedEvidence,
): number {
  return (
    Number(right.required) - Number(left.required) ||
    right.decisionImpact - left.decisionImpact ||
    relationRank[right.relation] - relationRank[left.relation] ||
    right.quality.authority - left.quality.authority ||
    right.quality.directness - left.quality.directness ||
    right.quality.freshness - left.quality.freshness ||
    right.relevance - left.relevance ||
    compareCanonicalText(left.source.sourceId, right.source.sourceId) ||
    left.source.revision.version - right.source.revision.version ||
    compareCanonicalText(left.source.revision.revisionId, right.source.revision.revisionId) ||
    compareCanonicalText(left.locator, right.locator) ||
    compareCanonicalText(left.contentSha256, right.contentSha256) ||
    compareCanonicalText(canonicalJson(evidenceJson(left)), canonicalJson(evidenceJson(right)))
  );
}

function compareSourceReference(
  left: MarketingSourceLineageReference,
  right: MarketingSourceLineageReference,
): number {
  return (
    compareCanonicalText(left.sourceId, right.sourceId) ||
    left.revision.version - right.revision.version ||
    compareCanonicalText(left.revision.revisionId, right.revision.revisionId)
  );
}

function compareReceiptSubject(
  left: MarketingEvidenceReceiptSubject,
  right: MarketingEvidenceReceiptSubject,
): number {
  return compareCanonicalText(canonicalJson(subjectJson(left)), canonicalJson(subjectJson(right)));
}

function stateExclusion(
  source: MarketingSourceObservation,
): MarketingEvidenceExclusionReason | undefined {
  if (source.capability.state !== "available" || source.access.state !== "authorized") {
    return "inaccessible";
  }
  if (
    !["imported", "not-required"].includes(source.import.state) ||
    !["indexed", "not-required"].includes(source.index.state)
  ) {
    return "unindexed";
  }
  return source.freshness.state === "current" ? undefined : "stale-policy";
}

function encodeEnvelope(input: {
  readonly workspace: MarketingWorkspaceSelection;
  readonly asOf: DateTime.Utc;
  readonly plan?: MarketingEvidencePlanSelection;
  readonly sources: ReadonlyArray<MarketingSourceObservation>;
  readonly assumptions: ReadonlyArray<MarketingEvidenceAssumption>;
  readonly conflicts: ReadonlyArray<MarketingEvidenceConflict>;
  readonly gaps: ReadonlyArray<MarketingEvidenceGap>;
  readonly questions: ReadonlyArray<MarketingDecisionChangingQuestion>;
  readonly signals: ReadonlyArray<MarketingDisconfirmationSignal>;
  readonly readiness: MarketingPlanReadiness;
  readonly unresolved: ReadonlyArray<MarketingUnresolvedDecision>;
}): Readonly<Record<string, Schema.Json>> {
  return {
    format: MARKETING_EVIDENCE_CONTEXT_FORMAT,
    workspace: input.workspace,
    asOf: DateTime.formatIso(input.asOf),
    ...(input.plan === undefined
      ? {}
      : {
          plan: {
            planId: input.plan.planId,
            revisionId: input.plan.revision.revisionId,
            version: input.plan.revision.version,
            ...(input.plan.stageKey === undefined ? {} : { stageKey: input.plan.stageKey }),
            ...(input.plan.stepKey === undefined ? {} : { stepKey: input.plan.stepKey }),
          },
        }),
    sources: input.sources.map(observationJson),
    assumptions: input.assumptions,
    conflicts: input.conflicts,
    gaps: input.gaps,
    questions: input.questions,
    disconfirmationSignals: input.signals,
    readiness: input.readiness,
    unresolvedDecisions: input.unresolved,
  };
}

/**
 * Compiles a transient Marketing-only packet. The function has no persistence or provider seam,
 * admits whole items only, and produces the same packet for the same normalized snapshot.
 */
export function compileMarketingEvidenceContext(
  rawInput: CompileMarketingEvidenceContextInput,
): Effect.Effect<MarketingEvidenceContextPacket, MarketingEvidenceContextError> {
  return Effect.try({
    try: () => {
      const workspace = decodeWorkspace(rawInput.workspace);
      const asOf = decodeAsOf(rawInput.asOf);
      const plan = rawInput.plan === undefined ? undefined : decodePlan(rawInput.plan);
      const sourceAllowlist = [...decodeSourceAllowlist(rawInput.sourceAllowlist)].sort(
        compareSourceReference,
      );
      const sources = [...decodeSources(rawInput.sources)].sort((left, right) =>
        compareSourceReference(left.source, right.source),
      );
      let candidates: ReadonlyArray<MarketingRetrievedEvidence>;
      try {
        candidates = decodeCandidates(rawInput.candidates).map(normalizeEvidence);
      } catch {
        if (rawInput.candidates.length > MARKETING_EVIDENCE_MAX_CANDIDATES) {
          throw new MarketingEvidenceContextError({ reason: "candidate_limit_exceeded" });
        }
        throw new MarketingEvidenceContextError({ reason: "invalid_context_input" });
      }
      const acceptedFacts = decodeAcceptedFacts(rawInput.acceptedFacts).map(normalizeFact);
      const assumptions = sortUniqueByStableKey(
        decodeAssumptions(rawInput.assumptions ?? []).map(normalizeAssumption),
        "assumption",
      );
      const conflicts = sortUniqueByStableKey(
        decodeConflicts(rawInput.conflicts ?? []).map(normalizeConflict),
        "conflict",
      );
      const gaps = sortUniqueByStableKey(decodeGaps(rawInput.gaps ?? []).map(normalizeGap), "gap");
      const questions = sortUniqueByStableKey(
        decodeQuestions(rawInput.questions ?? []).map(normalizeQuestion),
        "question",
      );
      const signals = sortUniqueByStableKey(
        decodeSignals(rawInput.disconfirmationSignals ?? []).map(normalizeSignal),
        "disconfirmation-signal",
      );
      const readiness = normalizeReadiness(
        decodeReadiness(rawInput.readiness ?? { state: "not-evaluated" }),
      );
      const unresolved = sortUniqueByStableKey(
        decodeUnresolved(rawInput.unresolvedDecisions ?? []).map(normalizeUnresolved),
        "unresolved-decision",
      );
      const budget = decodeBudget(rawInput.budget ?? DEFAULT_MARKETING_CONTEXT_BUDGET);
      const preExcluded = [
        ...decodeSourceExclusions(rawInput.sourceExclusions ?? []).map(({ source, reason }) =>
          sourceReceiptExclusion(source, reason),
        ),
        ...decodeSupersededFacts(rawInput.supersededFacts ?? []).map(
          ({ stableKey, decisionId, revision }) =>
            factReceiptExclusion(stableKey, decisionId, revision),
        ),
      ];

      const allowlistKeys = new Set(sourceAllowlist.map(sourceReferenceText));
      if (allowlistKeys.size !== sourceAllowlist.length) {
        throw new MarketingEvidenceContextError({
          reason: "source_snapshot_mismatch",
          reference: "duplicate-source-allowlist-entry",
        });
      }
      const sourceKeys = new Set(sources.map(({ source }) => sourceReferenceText(source)));
      if (
        sourceKeys.size !== sources.length ||
        sourceKeys.size !== allowlistKeys.size ||
        [...sourceKeys].some((key) => !allowlistKeys.has(key))
      ) {
        throw new MarketingEvidenceContextError({ reason: "source_snapshot_mismatch" });
      }
      if (sources.some((source) => sourceTimestampAfterSnapshot(source, asOf))) {
        throw new MarketingEvidenceContextError({
          reason: "source_snapshot_mismatch",
          reference: "source-state-after-snapshot",
        });
      }

      const sourceByKey = new Map(
        sources.map((source) => [sourceReferenceText(source.source), source] as const),
      );
      for (const candidate of candidates) {
        if (candidate.observedAt.epochMilliseconds > asOf.epochMilliseconds) {
          throw new MarketingEvidenceContextError({
            reason: "invalid_context_input",
            reference: "evidence-observed-after-snapshot",
          });
        }
        const sourceKey = sourceReferenceText(candidate.source);
        if (!allowlistKeys.has(sourceKey)) {
          throw new MarketingEvidenceContextError({
            reason: "source_not_allowlisted",
            reference: sourceKey,
          });
        }
      }

      const factKeys = new Set<string>();
      const factRevisionKeys = new Set<string>();
      for (const fact of acceptedFacts) {
        const revisionKey = `${fact.decisionId}:${fact.revision.revisionId}:${fact.revision.version}`;
        if (factKeys.has(fact.stableKey) || factRevisionKeys.has(revisionKey)) {
          throw new MarketingEvidenceContextError({
            reason: "duplicate_fact_key",
            reference: fact.stableKey,
          });
        }
        factKeys.add(fact.stableKey);
        factRevisionKeys.add(revisionKey);
      }
      for (const item of preExcluded) {
        if (item.subject.kind !== "accepted-fact") continue;
        const revisionKey = `${item.subject.decisionId}:${item.subject.revision.revisionId}:${item.subject.revision.version}`;
        if (factKeys.has(item.subject.stableKey) || factRevisionKeys.has(revisionKey)) {
          throw new MarketingEvidenceContextError({
            reason: "duplicate_fact_key",
            reference: item.subject.stableKey,
          });
        }
        factKeys.add(item.subject.stableKey);
        factRevisionKeys.add(revisionKey);
      }

      const locatorHashes = new Map<string, string>();
      for (const candidate of candidates) {
        const locatorKey = `${sourceReferenceText(candidate.source)}\u0000${candidate.locator}`;
        const existing = locatorHashes.get(locatorKey);
        if (existing !== undefined && existing !== candidate.contentSha256) {
          throw new MarketingEvidenceContextError({
            reason: "locator_content_conflict",
            reference: locatorKey,
          });
        }
        locatorHashes.set(locatorKey, candidate.contentSha256);
      }

      const envelopeTokenCount = Math.max(
        MARKETING_EVIDENCE_ENVELOPE_TOKENS,
        estimateTokens(
          canonicalJson(
            encodeEnvelope({
              workspace,
              asOf,
              ...(plan === undefined ? {} : { plan }),
              sources,
              assumptions,
              conflicts,
              gaps,
              questions,
              signals,
              readiness,
              unresolved,
            }),
          ),
        ),
      );
      if (envelopeTokenCount > budget.maxTokens) {
        throw new MarketingEvidenceContextError({ reason: "budget_too_small" });
      }

      const includedFacts: MarketingAcceptedFact[] = [];
      const includedEvidence: MarketingRetrievedEvidence[] = [];
      const included: MarketingEvidenceReceiptIncludedItem[] = [];
      const excluded: MarketingEvidenceReceiptExcludedItem[] = [...preExcluded];
      const candidateDigests: MarketingEvidenceSha256[] = preExcluded
        .filter(({ subject }) => subject.kind !== "source")
        .map(({ digest }) => digest);
      let includedTokenCount = 0;
      let includedItems = 0;

      const sortedFacts = [...acceptedFacts].sort((left, right) =>
        compareCanonicalText(left.stableKey, right.stableKey),
      );
      for (const fact of sortedFacts) {
        const digest = factDigest(fact);
        const tokenCount = estimateTokens(canonicalJson(factJson(fact)));
        const subject: MarketingEvidenceReceiptSubject = {
          kind: "accepted-fact",
          stableKey: fact.stableKey,
          decisionId: fact.decisionId,
          revision: fact.revision,
        };
        candidateDigests.push(digest);
        if (
          includedItems >= budget.maxItems ||
          envelopeTokenCount + includedTokenCount + tokenCount > budget.maxTokens
        ) {
          excluded.push({ subject, digest, reason: "budget", tokenCount });
          continue;
        }
        includedFacts.push(fact);
        included.push({ subject, digest, tokenCount });
        includedTokenCount += tokenCount;
        includedItems += 1;
      }

      const seenCandidates = new Set<string>();
      const perSourceCount = new Map<string, number>();
      let admittedCandidateBytes = 0;
      for (const candidate of [...candidates].sort(compareEvidence)) {
        const digest = evidenceDigest(candidate);
        const sourceKey = sourceReferenceText(candidate.source);
        const tuple = `${sourceKey}\u0000${candidate.locator}\u0000${candidate.contentSha256}`;
        const candidateText = canonicalJson(evidenceJson(candidate));
        const tokenCount = estimateTokens(candidateText);
        const candidateBytes = Buffer.byteLength(candidateText, "utf8");
        const subject: MarketingEvidenceReceiptSubject = {
          kind: "retrieved-evidence",
          source: candidate.source,
          locator: candidate.locator,
        };
        candidateDigests.push(digest);
        if (seenCandidates.has(tuple)) {
          excluded.push({ subject, digest, reason: "duplicate", tokenCount });
          continue;
        }
        seenCandidates.add(tuple);
        const source = sourceByKey.get(sourceKey);
        if (source === undefined) {
          throw new MarketingEvidenceContextError({
            reason: "source_snapshot_mismatch",
            reference: sourceKey,
          });
        }
        const sourceStateExclusion = stateExclusion(source);
        if (sourceStateExclusion !== undefined) {
          excluded.push({ subject, digest, reason: sourceStateExclusion, tokenCount });
          continue;
        }
        const sourceCount = perSourceCount.get(sourceKey) ?? 0;
        if (
          sourceCount >= budget.maxPerSource ||
          admittedCandidateBytes + candidateBytes > budget.maxCandidateBytes ||
          includedItems >= budget.maxItems ||
          envelopeTokenCount + includedTokenCount + tokenCount > budget.maxTokens
        ) {
          excluded.push({ subject, digest, reason: "budget", tokenCount });
          continue;
        }
        includedEvidence.push(candidate);
        included.push({ subject, digest, tokenCount });
        includedTokenCount += tokenCount;
        includedItems += 1;
        admittedCandidateBytes += candidateBytes;
        perSourceCount.set(sourceKey, sourceCount + 1);
      }

      const sortedIncluded = [...included].sort((left, right) =>
        compareCanonicalText(left.digest, right.digest),
      );
      const sortedExcluded = [...excluded].sort(
        (left, right) =>
          compareReceiptSubject(left.subject, right.subject) ||
          compareCanonicalText(left.reason, right.reason) ||
          compareCanonicalText(left.digest, right.digest),
      );
      const sortedDigests = [...candidateDigests].sort(compareCanonicalText);
      const factInputs = [
        ...sortedFacts.map((fact) => ({
          stableKey: fact.stableKey,
          decisionId: fact.decisionId,
          revision: fact.revision,
        })),
        ...preExcluded.flatMap((item) =>
          item.subject.kind === "accepted-fact"
            ? [
                {
                  stableKey: item.subject.stableKey,
                  decisionId: item.subject.decisionId,
                  revision: item.subject.revision,
                },
              ]
            : [],
        ),
      ].sort((left, right) => compareCanonicalText(left.stableKey, right.stableKey));
      if (factInputs.length > MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST) {
        throw new MarketingEvidenceContextError({
          reason: "candidate_limit_exceeded",
          reference: "accepted-fact-inputs",
        });
      }
      const receiptWithoutHash: Schema.Json = {
        asOf: DateTime.formatIso(asOf),
        ...(plan === undefined
          ? {}
          : {
              planInput: {
                planId: plan.planId,
                revisionId: plan.revision.revisionId,
                version: plan.revision.version,
                ...(plan.stageKey === undefined ? {} : { stageKey: plan.stageKey }),
                ...(plan.stepKey === undefined ? {} : { stepKey: plan.stepKey }),
              },
            }),
        sourceInputs: sourceAllowlist.map(sourceReferenceJson),
        factInputs: factInputs.map((fact) => ({
          stableKey: fact.stableKey,
          decisionId: fact.decisionId,
          revisionId: fact.revision.revisionId,
          version: fact.revision.version,
        })),
        candidateDigests: sortedDigests,
        included: sortedIncluded.map((item) => ({
          subject: subjectJson(item.subject),
          digest: item.digest,
          tokenCount: item.tokenCount,
        })),
        excluded: sortedExcluded.map((item) => ({
          subject: subjectJson(item.subject),
          digest: item.digest,
          reason: item.reason,
          tokenCount: item.tokenCount,
        })),
        envelopeTokenCount,
        includedTokenCount,
        budget,
        tokenizerRef: budget.tokenizerRef,
        policyRef: budget.policyRef,
      };
      const packetContent: Schema.Json = {
        ...encodeEnvelope({
          workspace,
          asOf,
          ...(plan === undefined ? {} : { plan }),
          sources,
          assumptions,
          conflicts,
          gaps,
          questions,
          signals,
          readiness,
          unresolved,
        }),
        acceptedFacts: includedFacts.map(factJson),
        evidence: includedEvidence.map(evidenceJson),
        budget,
        receipt: receiptWithoutHash,
      };
      const packetSha256 = sha256(canonicalJson(packetContent));

      return {
        format: MARKETING_EVIDENCE_CONTEXT_FORMAT,
        workspace,
        asOf,
        ...(plan === undefined ? {} : { plan }),
        sources,
        acceptedFacts: includedFacts,
        evidence: includedEvidence,
        assumptions,
        conflicts,
        gaps,
        questions,
        disconfirmationSignals: signals,
        readiness,
        unresolvedDecisions: unresolved,
        budget,
        receipt: {
          asOf,
          ...(plan === undefined ? {} : { planInput: plan }),
          sourceInputs: sourceAllowlist,
          factInputs,
          candidateDigests: sortedDigests,
          included: sortedIncluded,
          excluded: sortedExcluded,
          envelopeTokenCount,
          includedTokenCount,
          budget,
          packetSha256,
          tokenizerRef: budget.tokenizerRef,
          policyRef: budget.policyRef,
        },
      };
    },
    catch: (cause) =>
      isEvidenceContextError(cause)
        ? cause
        : new MarketingEvidenceContextError({ reason: "invalid_context_input" }),
  });
}

function sourceReceiptExclusion(
  source: MarketingSourceLineageReference,
  reason: Extract<MarketingEvidenceExclusionReason, "inaccessible" | "unindexed" | "stale-policy">,
): MarketingEvidenceReceiptExcludedItem {
  return {
    subject: { kind: "source", source },
    digest: sourceDigest(source),
    reason,
    tokenCount: 0,
  };
}

function factReceiptExclusion(
  stableKey: MarketingEvidenceStableKey,
  decisionId: MarketingDecisionId,
  revision: MarketingCanonicalRevisionReference,
): MarketingEvidenceReceiptExcludedItem {
  const subject: MarketingEvidenceReceiptSubject = {
    kind: "accepted-fact",
    stableKey,
    decisionId,
    revision,
  };
  return {
    subject,
    digest: sha256(canonicalJson(subjectJson(subject))),
    reason: "superseded",
    tokenCount: 0,
  };
}
