// @effect-diagnostics nodeBuiltinImport:off - bounded context digests are local integrity receipts.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MarketingCanonicalRegistryKey,
  MarketingCanonicalRevisionReference,
  MarketingCanonicalVersion,
  MarketingReviewRevisionReference,
  MarketingSourceLineageReference,
} from "./canonical.ts";
import { compareCanonicalText } from "./canonicalSeal.ts";
import {
  MarketingEvidenceContextError,
  MarketingEvidenceSafeReference,
} from "./evidenceContextErrors.ts";
import { MarketingDecisionId, MarketingPlanId, MarketingWorkspaceSelection } from "./identity.ts";

export const MARKETING_EVIDENCE_CONTEXT_FORMAT = "auldric-marketing-evidence-context-v1" as const;
export const MARKETING_EVIDENCE_TOKENIZER_REF = "auldric/utf8-ceil-4@1" as const;
export const MARKETING_EVIDENCE_POLICY_REF = "auldric/evidence-context@1" as const;
export const MARKETING_EVIDENCE_MAX_CANDIDATES = 256;
export const MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST = 24;
export const MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST = 32;
export const MARKETING_EVIDENCE_MAX_FACT_VALUE_BYTES = 32_768;
export const MARKETING_EVIDENCE_MAX_SYSTEM_GAPS = 64;

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

const RetrievalText = (maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum));

export const MarketingEvidenceRetrievalQuery = Schema.Struct({
  purpose: RetrievalText(2_000),
  terms: Schema.Array(RetrievalText(200)).check(Schema.isMaxLength(24)),
});
export type MarketingEvidenceRetrievalQuery = typeof MarketingEvidenceRetrievalQuery.Type;

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
  excerptSha256: MarketingEvidenceSha256,
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

const MarketingEvidenceGapFields = {
  key: MarketingEvidenceStableKey,
  summary: BoundedText(2_000),
  blocks: Schema.Boolean,
};

export const MarketingUserEvidenceGap = Schema.Struct({
  namespace: Schema.Literal("user"),
  ...MarketingEvidenceGapFields,
});
export type MarketingUserEvidenceGap = typeof MarketingUserEvidenceGap.Type;

export const MarketingSystemEvidenceGapCategory = Schema.Literals([
  "plan-selection",
  "accepted-fact",
  "source-state",
  "source-retrieval",
  "context-budget",
]);
export type MarketingSystemEvidenceGapCategory = typeof MarketingSystemEvidenceGapCategory.Type;

export const MarketingSystemEvidenceGap = Schema.Struct({
  namespace: Schema.Literal("system"),
  category: MarketingSystemEvidenceGapCategory,
  ...MarketingEvidenceGapFields,
});
export type MarketingSystemEvidenceGap = typeof MarketingSystemEvidenceGap.Type;

export const MarketingEvidenceGap = Schema.Union([
  MarketingUserEvidenceGap,
  MarketingSystemEvidenceGap,
]);
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

const MarketingEvidencePlanReferenceFields = {
  planId: MarketingPlanId,
  revision: MarketingCanonicalRevisionReference,
};

export const MarketingEvidencePlanReference = Schema.Struct(MarketingEvidencePlanReferenceFields);
export type MarketingEvidencePlanReference = typeof MarketingEvidencePlanReference.Type;

export const MarketingEvidencePlanSelection = Schema.Struct({
  ...MarketingEvidencePlanReferenceFields,
  stageSemantics: Schema.Literal("not-evaluated"),
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

export const MarketingEvidenceAdapterProvenance = Schema.Struct({
  source: MarketingSourceLineageReference,
  adapterKey: MarketingCanonicalRegistryKey,
  adapterVersion: MarketingCanonicalVersion,
  configurationSha256: MarketingEvidenceSha256,
});
export type MarketingEvidenceAdapterProvenance = typeof MarketingEvidenceAdapterProvenance.Type;

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
    locatorSha256: MarketingEvidenceSha256,
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
  required: Schema.Boolean,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MarketingEvidenceReceiptIncludedItem = typeof MarketingEvidenceReceiptIncludedItem.Type;

export const MarketingEvidenceReceiptExcludedItem = Schema.Struct({
  subject: MarketingEvidenceReceiptSubject,
  digest: MarketingEvidenceSha256,
  reason: MarketingEvidenceExclusionReason,
  required: Schema.Boolean,
  tokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MarketingEvidenceReceiptExcludedItem = typeof MarketingEvidenceReceiptExcludedItem.Type;

export const MarketingEvidenceReceipt = Schema.Struct({
  asOf: Schema.DateTimeUtc,
  planInput: Schema.optionalKey(MarketingEvidencePlanSelection),
  retrievalQuerySha256: MarketingEvidenceSha256,
  adapterInputs: Schema.Array(MarketingEvidenceAdapterProvenance).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
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
  includedTokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  packetTokenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
  gaps: Schema.Array(MarketingEvidenceGap).check(
    Schema.isMaxLength(32 + MARKETING_EVIDENCE_MAX_SYSTEM_GAPS),
  ),
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
  readonly retrievalQuery: MarketingEvidenceRetrievalQuery;
  readonly adapterProvenance: ReadonlyArray<MarketingEvidenceAdapterProvenance>;
  readonly sourceAllowlist: ReadonlyArray<MarketingSourceLineageReference>;
  readonly sources: ReadonlyArray<MarketingSourceObservation>;
  readonly candidates: ReadonlyArray<MarketingRetrievedEvidence>;
  readonly acceptedFacts: ReadonlyArray<MarketingAcceptedFact>;
  readonly assumptions?: ReadonlyArray<MarketingEvidenceAssumption>;
  readonly conflicts?: ReadonlyArray<MarketingEvidenceConflict>;
  readonly gaps?: ReadonlyArray<MarketingUserEvidenceGap>;
  readonly systemGaps?: ReadonlyArray<MarketingSystemEvidenceGap>;
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
const decodeCandidate = Schema.decodeUnknownSync(MarketingRetrievedEvidence);
const decodeCandidates = Schema.decodeUnknownSync(
  Schema.Array(MarketingRetrievedEvidence).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_CANDIDATES),
  ),
);
const decodeFact = Schema.decodeUnknownSync(MarketingAcceptedFact);
const decodeAcceptedFacts = Schema.decodeUnknownSync(
  Schema.Array(MarketingAcceptedFact).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST),
  ),
);
const decodeAssumption = Schema.decodeUnknownSync(MarketingEvidenceAssumption);
const decodeAssumptions = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceAssumption).check(Schema.isMaxLength(32)),
);
const decodeConflict = Schema.decodeUnknownSync(MarketingEvidenceConflict);
const decodeConflicts = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceConflict).check(Schema.isMaxLength(32)),
);
const decodeUserGap = Schema.decodeUnknownSync(MarketingUserEvidenceGap);
const decodeUserGaps = Schema.decodeUnknownSync(
  Schema.Array(MarketingUserEvidenceGap).check(Schema.isMaxLength(32)),
);
const decodeSystemGap = Schema.decodeUnknownSync(MarketingSystemEvidenceGap);
const decodeSystemGaps = Schema.decodeUnknownSync(
  Schema.Array(MarketingSystemEvidenceGap).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SYSTEM_GAPS - 1),
  ),
);
const decodeQuestion = Schema.decodeUnknownSync(MarketingDecisionChangingQuestion);
const decodeQuestions = Schema.decodeUnknownSync(
  Schema.Array(MarketingDecisionChangingQuestion).check(Schema.isMaxLength(32)),
);
const decodeSignal = Schema.decodeUnknownSync(MarketingDisconfirmationSignal);
const decodeSignals = Schema.decodeUnknownSync(
  Schema.Array(MarketingDisconfirmationSignal).check(Schema.isMaxLength(32)),
);
const decodeReadiness = Schema.decodeUnknownSync(MarketingPlanReadiness);
const decodePlan = Schema.decodeUnknownSync(MarketingEvidencePlanSelection);
const decodeUnresolvedItem = Schema.decodeUnknownSync(MarketingUnresolvedDecision);
const decodeUnresolved = Schema.decodeUnknownSync(
  Schema.Array(MarketingUnresolvedDecision).check(Schema.isMaxLength(32)),
);
const decodeBudget = Schema.decodeUnknownSync(MarketingContextBudget);
const decodeQuery = Schema.decodeUnknownSync(MarketingEvidenceRetrievalQuery);
const decodeAdapterProvenance = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceAdapterProvenance).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
);
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
const decodePacket = Schema.decodeUnknownSync(MarketingEvidenceContextPacket);
const encodePacketJson = Schema.encodeSync(Schema.toCodecJson(MarketingEvidenceContextPacket));
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeSafeReference = Schema.decodeUnknownSync(MarketingEvidenceSafeReference);
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
        reference: decodeSafeReference("normalized-json-key-collision"),
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

function safeDigestReference(
  namespace: "adapter" | "locator" | "source",
  value: string,
): MarketingEvidenceSafeReference {
  return decodeSafeReference(`${namespace}:${sha256(value)}`);
}

function sourceReferenceText(source: MarketingSourceLineageReference): string {
  return `${source.sourceId}@${source.revision.version}:${source.revision.revisionId}`;
}

function sourceReferenceJson(source: MarketingSourceLineageReference): Schema.Json {
  return {
    sourceId: source.sourceId,
    revision: {
      revisionId: source.revision.revisionId,
      version: source.revision.version,
    },
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
        locatorSha256: subject.locatorSha256,
      };
    case "accepted-fact":
      return {
        kind: subject.kind,
        stableKey: subject.stableKey,
        decisionId: subject.decisionId,
        revision: {
          revisionId: subject.revision.revisionId,
          version: subject.revision.version,
        },
      };
  }
}

function evidenceJson(evidence: MarketingRetrievedEvidence): Schema.Json {
  return {
    source: sourceReferenceJson(evidence.source),
    locator: evidence.locator,
    excerpt: evidence.excerpt,
    excerptSha256: evidence.excerptSha256,
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
      revision: {
        revisionId: review.revision.revisionId,
        version: review.revision.version,
      },
    })),
    supportState: fact.supportState,
  };
}

function normalizeEvidence(evidence: MarketingRetrievedEvidence): MarketingRetrievedEvidence {
  const normalized = decodeCandidate({
    ...evidence,
    locator: normalizeText(evidence.locator, true),
    excerpt: normalizeText(evidence.excerpt, true),
  });
  if (sha256(normalized.excerpt) !== normalized.excerptSha256) {
    throw new MarketingEvidenceContextError({
      reason: "invalid_context_input",
      reference: safeDigestReference("locator", normalized.locator),
    });
  }
  return normalized;
}

function normalizeFact(fact: MarketingAcceptedFact): MarketingAcceptedFact {
  const normalized = decodeFact({
    ...fact,
    claim: normalizeText(fact.claim, true),
    value: normalizeJson(fact.value),
    support: [...fact.support].sort(compareSourceReference),
    reviews: [...fact.reviews].sort(
      (left, right) =>
        compareCanonicalText(left.reviewId, right.reviewId) ||
        left.revision.version - right.revision.version ||
        compareCanonicalText(left.revision.revisionId, right.revision.revisionId),
    ),
  });
  if (new Set(normalized.support.map(sourceReferenceText)).size !== normalized.support.length) {
    throw new MarketingEvidenceContextError({
      reason: "invalid_context_input",
      reference: decodeSafeReference("duplicate-fact-support"),
    });
  }
  return normalized;
}

function normalizeAssumption(value: MarketingEvidenceAssumption): MarketingEvidenceAssumption {
  return decodeAssumption({ ...value, statement: normalizeText(value.statement, true) });
}

function normalizeConflict(value: MarketingEvidenceConflict): MarketingEvidenceConflict {
  return decodeConflict({ ...value, summary: normalizeText(value.summary, true) });
}

function normalizeUserGap(value: MarketingUserEvidenceGap): MarketingUserEvidenceGap {
  return decodeUserGap({ ...value, summary: normalizeText(value.summary, true) });
}

function normalizeSystemGap(value: MarketingSystemEvidenceGap): MarketingSystemEvidenceGap {
  return decodeSystemGap({ ...value, summary: normalizeText(value.summary, true) });
}

function normalizeQuestion(
  value: MarketingDecisionChangingQuestion,
): MarketingDecisionChangingQuestion {
  return decodeQuestion({ ...value, question: normalizeText(value.question, true) });
}

function normalizeSignal(value: MarketingDisconfirmationSignal): MarketingDisconfirmationSignal {
  return decodeSignal({
    ...value,
    signal: normalizeText(value.signal, true),
    consequence: normalizeText(value.consequence, true),
  });
}

function normalizeUnresolved(value: MarketingUnresolvedDecision): MarketingUnresolvedDecision {
  return decodeUnresolvedItem({ ...value, summary: normalizeText(value.summary, true) });
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
        reference: decodeSafeReference(`duplicate-${collection}-key`),
      });
    }
  }
  return sorted;
}

function sortUniqueGaps(
  userGaps: ReadonlyArray<MarketingUserEvidenceGap>,
  systemGaps: ReadonlyArray<MarketingSystemEvidenceGap>,
): ReadonlyArray<MarketingEvidenceGap> {
  const identity = (gap: MarketingEvidenceGap) =>
    `${gap.namespace}:${gap.namespace === "system" ? gap.category : "user-authored"}:${gap.key}`;
  const sorted = [...userGaps, ...systemGaps].sort((left, right) =>
    compareCanonicalText(identity(left), identity(right)),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1];
    const right = sorted[index];
    if (left !== undefined && right !== undefined && identity(left) === identity(right)) {
      throw new MarketingEvidenceContextError({
        reason: "invalid_context_input",
        reference: decodeSafeReference("duplicate-gap-key"),
      });
    }
  }
  return sorted;
}

function normalizeReadiness(readiness: MarketingPlanReadiness): MarketingPlanReadiness {
  if (readiness.state === "ready" || readiness.state === "not-evaluated") return readiness;
  return decodeReadiness({
    state: readiness.state,
    codes: [...new Set(readiness.codes)].sort(compareCanonicalText),
  });
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
    right.quality.corroboration - left.quality.corroboration ||
    right.relevance - left.relevance ||
    right.observedAt.epochMilliseconds - left.observedAt.epochMilliseconds ||
    compareCanonicalText(left.source.sourceId, right.source.sourceId) ||
    left.source.revision.version - right.source.revision.version ||
    compareCanonicalText(left.source.revision.revisionId, right.source.revision.revisionId) ||
    compareCanonicalText(left.locator, right.locator) ||
    compareCanonicalText(left.contentSha256, right.contentSha256) ||
    compareCanonicalText(left.excerptSha256, right.excerptSha256) ||
    compareCanonicalText(evidenceDigest(left), evidenceDigest(right))
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

function compareAdapterProvenance(
  left: MarketingEvidenceAdapterProvenance,
  right: MarketingEvidenceAdapterProvenance,
): number {
  return (
    compareSourceReference(left.source, right.source) ||
    compareCanonicalText(left.adapterKey, right.adapterKey) ||
    left.adapterVersion - right.adapterVersion ||
    compareCanonicalText(left.configurationSha256, right.configurationSha256)
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

interface AdmissionItem {
  readonly kind: "fact" | "evidence" | "pre-excluded";
  readonly subject: MarketingEvidenceReceiptSubject;
  readonly digest: MarketingEvidenceSha256;
  readonly required: boolean;
  readonly tokenCount: number;
  readonly fact?: MarketingAcceptedFact;
  readonly evidence?: MarketingRetrievedEvidence;
  readonly candidateBytes: number;
  readonly sourceKey?: string;
  included: boolean;
  reason?: MarketingEvidenceExclusionReason;
}

const zeroPacketDigest = MarketingEvidenceSha256.make("0".repeat(64));
const requiredOmissionCode = MarketingEvidenceStateCode.make("required-evidence-omitted");
const blockingGapCode = MarketingEvidenceStateCode.make("blocking-evidence-gap");
const requiredOmissionGap: MarketingSystemEvidenceGap = {
  namespace: "system",
  category: "context-budget",
  key: MarketingEvidenceStableKey.make("required-evidence-omitted"),
  summary: "Required evidence could not fit or was unavailable in this bounded context packet.",
  blocks: true,
};

function forceBlocked(
  readiness: MarketingPlanReadiness,
  derivedCodes: ReadonlyArray<MarketingEvidenceStateCode>,
): MarketingPlanReadiness {
  const callerCodes =
    readiness.state === "blocked" || readiness.state === "partial" ? readiness.codes : [];
  const prioritizedDerived = [...new Set(derivedCodes)].sort(compareCanonicalText).slice(0, 16);
  const remaining = 16 - prioritizedDerived.length;
  const retainedCaller = [...new Set(callerCodes)]
    .filter((code) => !prioritizedDerived.includes(code))
    .sort(compareCanonicalText)
    .slice(0, remaining);
  const combined = [...prioritizedDerived, ...retainedCaller];
  return decodeReadiness({ state: "blocked", codes: combined });
}

function packetJson(packet: MarketingEvidenceContextPacket): Schema.Json {
  return decodeJson(encodePacketJson(packet));
}

function packetDigestJson(packet: MarketingEvidenceContextPacket): Schema.Json {
  const encoded = packetJson(packet);
  if (encoded === null || Array.isArray(encoded) || typeof encoded !== "object") {
    throw new MarketingEvidenceContextError({
      reason: "invalid_context_input",
      reference: decodeSafeReference("packet-digest-shape"),
    });
  }
  const packetObject = encoded as { readonly [key: string]: Schema.Json };
  const receipt = packetObject.receipt;
  if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object") {
    throw new MarketingEvidenceContextError({
      reason: "invalid_context_input",
      reference: decodeSafeReference("packet-receipt-shape"),
    });
  }
  const receiptObject = receipt as { readonly [key: string]: Schema.Json };
  const { packetSha256: _packetSha256, ...receiptWithoutDigest } = receiptObject;
  return { ...packetObject, receipt: receiptWithoutDigest };
}

/**
 * Compiles a transient Marketing-only packet. It never persists or crosses the T3 provider seam.
 * The pinned tokenizer counts the complete schema-encoded packet, including its receipt and budget.
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
      } catch (cause) {
        if (isEvidenceContextError(cause)) throw cause;
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
      const userGaps = decodeUserGaps(rawInput.gaps ?? []).map(normalizeUserGap);
      const systemGaps = decodeSystemGaps(rawInput.systemGaps ?? []).map(normalizeSystemGap);
      if (
        systemGaps.some(
          ({ category, key }) =>
            category === requiredOmissionGap.category && key === requiredOmissionGap.key,
        )
      ) {
        throw new MarketingEvidenceContextError({
          reason: "invalid_context_input",
          reference: decodeSafeReference("reserved-system-gap-key"),
        });
      }
      const questions = sortUniqueByStableKey(
        decodeQuestions(rawInput.questions ?? []).map(normalizeQuestion),
        "question",
      );
      const signals = sortUniqueByStableKey(
        decodeSignals(rawInput.disconfirmationSignals ?? []).map(normalizeSignal),
        "disconfirmation-signal",
      );
      const initialReadiness = normalizeReadiness(
        decodeReadiness(rawInput.readiness ?? { state: "not-evaluated" }),
      );
      const unresolved = sortUniqueByStableKey(
        decodeUnresolved(rawInput.unresolvedDecisions ?? []).map(normalizeUnresolved),
        "unresolved-decision",
      );
      const budget = decodeBudget(rawInput.budget ?? DEFAULT_MARKETING_CONTEXT_BUDGET);
      const decodedQuery = decodeQuery(rawInput.retrievalQuery);
      const query = decodeQuery({
        purpose: normalizeText(decodedQuery.purpose, true),
        terms: [...new Set(decodedQuery.terms.map((term) => normalizeText(term, true)))].sort(
          compareCanonicalText,
        ),
      });
      const retrievalQuerySha256 = sha256(
        canonicalJson({ purpose: query.purpose, terms: [...query.terms] }),
      );
      const adapterInputs = [...decodeAdapterProvenance(rawInput.adapterProvenance)].sort(
        compareAdapterProvenance,
      );
      const sourceExclusions = decodeSourceExclusions(rawInput.sourceExclusions ?? []);
      const supersededFacts = decodeSupersededFacts(rawInput.supersededFacts ?? []);

      const allowlistKeys = new Set(sourceAllowlist.map(sourceReferenceText));
      if (allowlistKeys.size !== sourceAllowlist.length) {
        throw new MarketingEvidenceContextError({
          reason: "source_snapshot_mismatch",
          reference: decodeSafeReference("duplicate-source-allowlist-entry"),
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
          reference: decodeSafeReference("source-state-after-snapshot"),
        });
      }

      const sourceByKey = new Map(
        sources.map((source) => [sourceReferenceText(source.source), source] as const),
      );
      const activeSources = sources.filter((source) => stateExclusion(source) === undefined);
      const provenanceKeys = new Set<string>();
      for (const provenance of adapterInputs) {
        const key = sourceReferenceText(provenance.source);
        const source = sourceByKey.get(key);
        if (
          source === undefined ||
          stateExclusion(source) !== undefined ||
          source.adapterKey !== provenance.adapterKey ||
          provenanceKeys.has(key)
        ) {
          throw new MarketingEvidenceContextError({
            reason: "source_snapshot_mismatch",
            reference: safeDigestReference("adapter", provenance.adapterKey),
          });
        }
        provenanceKeys.add(key);
      }
      if (
        provenanceKeys.size !== activeSources.length ||
        activeSources.some((source) => !provenanceKeys.has(sourceReferenceText(source.source)))
      ) {
        throw new MarketingEvidenceContextError({
          reason: "source_snapshot_mismatch",
          reference: decodeSafeReference("adapter-provenance-mismatch"),
        });
      }

      for (const candidate of candidates) {
        if (candidate.observedAt.epochMilliseconds > asOf.epochMilliseconds) {
          throw new MarketingEvidenceContextError({
            reason: "invalid_context_input",
            reference: decodeSafeReference("evidence-after-snapshot"),
          });
        }
        const sourceKey = sourceReferenceText(candidate.source);
        if (!allowlistKeys.has(sourceKey)) {
          throw new MarketingEvidenceContextError({
            reason: "source_not_allowlisted",
            reference: safeDigestReference("source", sourceKey),
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
            reference: decodeSafeReference("duplicate-accepted-fact"),
          });
        }
        factKeys.add(fact.stableKey);
        factRevisionKeys.add(revisionKey);
      }
      for (const fact of supersededFacts) {
        const revisionKey = `${fact.decisionId}:${fact.revision.revisionId}:${fact.revision.version}`;
        if (factKeys.has(fact.stableKey) || factRevisionKeys.has(revisionKey)) {
          throw new MarketingEvidenceContextError({
            reason: "duplicate_fact_key",
            reference: decodeSafeReference("duplicate-accepted-fact"),
          });
        }
        factKeys.add(fact.stableKey);
        factRevisionKeys.add(revisionKey);
      }
      if (factKeys.size > MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST) {
        throw new MarketingEvidenceContextError({
          reason: "candidate_limit_exceeded",
          reference: decodeSafeReference("accepted-fact-inputs"),
        });
      }

      const sortedCandidates = [...candidates].sort(compareEvidence);
      const locatorBindings = new Map<
        string,
        { readonly content: MarketingEvidenceSha256; readonly excerpt: MarketingEvidenceSha256 }
      >();
      for (const candidate of sortedCandidates) {
        const locatorKey = `${sourceReferenceText(candidate.source)}\u0000${candidate.locator}`;
        const existing = locatorBindings.get(locatorKey);
        if (
          existing !== undefined &&
          (existing.content !== candidate.contentSha256 ||
            existing.excerpt !== candidate.excerptSha256)
        ) {
          throw new MarketingEvidenceContextError({
            reason: "locator_content_conflict",
            reference: safeDigestReference("locator", locatorKey),
          });
        }
        locatorBindings.set(locatorKey, {
          content: candidate.contentSha256,
          excerpt: candidate.excerptSha256,
        });
      }

      const items: AdmissionItem[] = [];
      for (const { source, reason } of sourceExclusions) {
        const sourceKey = sourceReferenceText(source);
        if (!allowlistKeys.has(sourceKey)) {
          throw new MarketingEvidenceContextError({
            reason: "source_snapshot_mismatch",
            reference: safeDigestReference("source", sourceKey),
          });
        }
        items.push({
          kind: "pre-excluded",
          subject: { kind: "source", source },
          digest: sourceDigest(source),
          required: false,
          tokenCount: 0,
          candidateBytes: 0,
          included: false,
          reason,
        });
      }
      for (const fact of supersededFacts) {
        const subject: MarketingEvidenceReceiptSubject = {
          kind: "accepted-fact",
          stableKey: fact.stableKey,
          decisionId: fact.decisionId,
          revision: fact.revision,
        };
        items.push({
          kind: "pre-excluded",
          subject,
          digest: sha256(canonicalJson(subjectJson(subject))),
          required: true,
          tokenCount: 0,
          candidateBytes: 0,
          included: false,
          reason: "superseded",
        });
      }

      const sortedFacts = [...acceptedFacts].sort((left, right) =>
        compareCanonicalText(left.stableKey, right.stableKey),
      );
      for (const fact of sortedFacts) {
        const subject: MarketingEvidenceReceiptSubject = {
          kind: "accepted-fact",
          stableKey: fact.stableKey,
          decisionId: fact.decisionId,
          revision: fact.revision,
        };
        items.push({
          kind: "fact",
          subject,
          digest: factDigest(fact),
          required: true,
          tokenCount: estimateTokens(canonicalJson(factJson(fact))),
          fact,
          candidateBytes: 0,
          included: false,
          reason: "budget",
        });
      }

      const seenCandidates = new Set<string>();
      for (const evidence of sortedCandidates) {
        const sourceKey = sourceReferenceText(evidence.source);
        const digest = evidenceDigest(evidence);
        const tuple = `${sourceKey}\u0000${evidence.locator}\u0000${evidence.contentSha256}`;
        const source = sourceByKey.get(sourceKey);
        if (source === undefined) {
          throw new MarketingEvidenceContextError({
            reason: "source_snapshot_mismatch",
            reference: safeDigestReference("source", sourceKey),
          });
        }
        const duplicate = seenCandidates.has(tuple);
        seenCandidates.add(tuple);
        const text = canonicalJson(evidenceJson(evidence));
        items.push({
          kind: "evidence",
          subject: {
            kind: "retrieved-evidence",
            source: evidence.source,
            locatorSha256: sha256(evidence.locator),
          },
          digest,
          required: evidence.required,
          tokenCount: estimateTokens(text),
          evidence,
          candidateBytes: Buffer.byteLength(text, "utf8"),
          sourceKey,
          included: false,
          reason: duplicate ? "duplicate" : (stateExclusion(source) ?? "budget"),
        });
      }

      const factInputs = [
        ...sortedFacts.map((fact) => ({
          stableKey: fact.stableKey,
          decisionId: fact.decisionId,
          revision: fact.revision,
        })),
        ...supersededFacts,
      ].sort((left, right) => compareCanonicalText(left.stableKey, right.stableKey));
      const candidateDigests = items
        .filter(({ subject }) => subject.kind !== "source")
        .map(({ digest }) => digest)
        .sort(compareCanonicalText);

      const buildPacket = (
        packetTokenCount: number,
        packetSha256: MarketingEvidenceSha256,
      ): MarketingEvidenceContextPacket => {
        const includedItems = items.filter(({ included }) => included);
        const includedDigests = new Set(includedItems.map(({ digest }) => digest));
        const requiredOmitted = items.some(
          (item) =>
            !item.included &&
            item.required &&
            (item.reason !== "duplicate" || !includedDigests.has(item.digest)),
        );
        const derivedSystemGaps = requiredOmitted
          ? [...systemGaps, requiredOmissionGap]
          : systemGaps;
        const gaps = sortUniqueGaps(userGaps, derivedSystemGaps);
        const blockingCodes: MarketingEvidenceStateCode[] = [];
        if (gaps.some(({ blocks }) => blocks)) blockingCodes.push(blockingGapCode);
        if (requiredOmitted) blockingCodes.push(requiredOmissionCode);
        const readiness =
          blockingCodes.length === 0
            ? initialReadiness
            : forceBlocked(initialReadiness, blockingCodes);
        const included = includedItems
          .map(({ subject, digest, required, tokenCount }) => ({
            subject,
            digest,
            required,
            tokenCount,
          }))
          .sort(
            (left, right) =>
              compareCanonicalText(left.digest, right.digest) ||
              compareReceiptSubject(left.subject, right.subject),
          );
        const excluded = items
          .filter(({ included }) => !included)
          .map(({ subject, digest, reason, required, tokenCount }) => ({
            subject,
            digest,
            reason: reason ?? "budget",
            required,
            tokenCount,
          }))
          .sort(
            (left, right) =>
              compareReceiptSubject(left.subject, right.subject) ||
              compareCanonicalText(left.reason, right.reason) ||
              compareCanonicalText(left.digest, right.digest),
          );
        const includedFacts = items.flatMap((item) =>
          item.included && item.fact !== undefined ? [item.fact] : [],
        );
        const includedEvidence = items.flatMap((item) =>
          item.included && item.evidence !== undefined ? [item.evidence] : [],
        );
        const includedTokenCount = included.reduce((total, item) => total + item.tokenCount, 0);

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
            retrievalQuerySha256,
            adapterInputs,
            sourceInputs: sourceAllowlist,
            factInputs,
            candidateDigests,
            included,
            excluded,
            includedTokenCount,
            packetTokenCount,
            budget,
            packetSha256,
            tokenizerRef: budget.tokenizerRef,
            policyRef: budget.policyRef,
          },
        };
      };

      const measurePacket = (): {
        readonly packet: MarketingEvidenceContextPacket;
        readonly tokenCount: number;
      } => {
        let tokenCount = 0;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          const packet = decodePacket(buildPacket(tokenCount, zeroPacketDigest));
          const next = estimateTokens(canonicalJson(packetJson(packet)));
          if (next === tokenCount) return { packet, tokenCount };
          tokenCount = next;
        }
        throw new MarketingEvidenceContextError({
          reason: "invalid_context_input",
          reference: decodeSafeReference("packet-token-fixed-point"),
        });
      };

      let includedCount = 0;
      let admittedCandidateBytes = 0;
      const perSourceCount = new Map<string, number>();
      for (const item of items) {
        if (item.kind === "pre-excluded" || item.reason !== "budget") continue;
        if (item.kind === "evidence") {
          const sourceKey = item.sourceKey;
          if (sourceKey === undefined) {
            throw new MarketingEvidenceContextError({
              reason: "invalid_context_input",
              reference: decodeSafeReference("missing-candidate-source"),
            });
          }
          if (
            (perSourceCount.get(sourceKey) ?? 0) >= budget.maxPerSource ||
            admittedCandidateBytes + item.candidateBytes > budget.maxCandidateBytes
          ) {
            continue;
          }
        }
        if (includedCount >= budget.maxItems) continue;

        item.included = true;
        delete item.reason;
        const trial = measurePacket();
        if (trial.tokenCount > budget.maxTokens) {
          item.included = false;
          item.reason = "budget";
          continue;
        }
        includedCount += 1;
        if (item.kind === "evidence" && item.sourceKey !== undefined) {
          admittedCandidateBytes += item.candidateBytes;
          perSourceCount.set(item.sourceKey, (perSourceCount.get(item.sourceKey) ?? 0) + 1);
        }
      }

      const measured = measurePacket();
      if (measured.tokenCount > budget.maxTokens) {
        throw new MarketingEvidenceContextError({
          reason: "budget_too_small",
          reference: decodeSafeReference("complete-packet-envelope"),
        });
      }
      const packetSha256 = sha256(canonicalJson(packetDigestJson(measured.packet)));
      const finalPacket = decodePacket(buildPacket(measured.tokenCount, packetSha256));
      const finalTokenCount = estimateTokens(canonicalJson(packetJson(finalPacket)));
      if (
        finalTokenCount !== measured.tokenCount ||
        finalTokenCount > finalPacket.budget.maxTokens ||
        finalPacket.receipt.packetTokenCount !== finalTokenCount
      ) {
        throw new MarketingEvidenceContextError({
          reason: "invalid_context_input",
          reference: decodeSafeReference("final-packet-validation"),
        });
      }
      return finalPacket;
    },
    catch: (cause) =>
      isEvidenceContextError(cause)
        ? cause
        : new MarketingEvidenceContextError({ reason: "invalid_context_input" }),
  });
}

export interface VerifyMarketingEvidenceContextPacketInput {
  readonly packet: unknown;
  /** The trusted service/read-back selection, not a caller-asserted packet field. */
  readonly expectedWorkspace?: MarketingWorkspaceSelection;
}

function verificationFailure(reference: string): never {
  throw new MarketingEvidenceContextError({
    reason: "invalid_context_input",
    reference: decodeSafeReference(reference),
  });
}

function sameWorkspace(
  left: MarketingWorkspaceSelection,
  right: MarketingWorkspaceSelection,
): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.workspaceId === right.workspaceId
  );
}

function sameJson(left: Schema.Json, right: Schema.Json): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceObservationJson(source: MarketingSourceObservation): Schema.Json {
  const index: Schema.Json = (() => {
    if (source.index.state === "indexed") {
      return { state: source.index.state, indexedAt: DateTime.formatIso(source.index.indexedAt) };
    }
    if (source.index.state === "stale") {
      return source.index.indexedAt === undefined
        ? { state: source.index.state }
        : { state: source.index.state, indexedAt: DateTime.formatIso(source.index.indexedAt) };
    }
    return source.index;
  })();
  return {
    source: sourceReferenceJson(source.source),
    adapterKey: source.adapterKey,
    capability: source.capability,
    access: source.access,
    import:
      source.import.state === "imported"
        ? { state: source.import.state, importedAt: DateTime.formatIso(source.import.importedAt) }
        : source.import,
    index,
    freshness:
      source.freshness.state === "unknown"
        ? source.freshness
        : {
            state: source.freshness.state,
            checkedAt: DateTime.formatIso(source.freshness.checkedAt),
          },
    observedAt: DateTime.formatIso(source.observedAt),
  };
}

function adapterProvenanceJson(value: MarketingEvidenceAdapterProvenance): Schema.Json {
  return {
    source: sourceReferenceJson(value.source),
    adapterKey: value.adapterKey,
    adapterVersion: value.adapterVersion,
    configurationSha256: value.configurationSha256,
  };
}

function receiptIncludedJson(value: MarketingEvidenceReceiptIncludedItem): Schema.Json {
  return {
    subject: subjectJson(value.subject),
    digest: value.digest,
    required: value.required,
    tokenCount: value.tokenCount,
  };
}

function receiptExcludedJson(value: MarketingEvidenceReceiptExcludedItem): Schema.Json {
  return {
    subject: subjectJson(value.subject),
    digest: value.digest,
    reason: value.reason,
    required: value.required,
    tokenCount: value.tokenCount,
  };
}

function stableKeyItemJson(
  value:
    | MarketingEvidenceAssumption
    | MarketingEvidenceConflict
    | MarketingDecisionChangingQuestion
    | MarketingDisconfirmationSignal
    | MarketingUnresolvedDecision,
): Schema.Json {
  if ("statement" in value) {
    return {
      key: value.key,
      statement: value.statement,
      risk: value.risk,
      validationNeeded: value.validationNeeded,
    };
  }
  if ("question" in value) {
    return { key: value.key, question: value.question, decisionImpact: value.decisionImpact };
  }
  if ("signal" in value) {
    return { key: value.key, signal: value.signal, consequence: value.consequence };
  }
  return { key: value.key, summary: value.summary, blocks: value.blocks };
}

function gapJson(value: MarketingEvidenceGap): Schema.Json {
  return value.namespace === "system"
    ? {
        namespace: value.namespace,
        category: value.category,
        key: value.key,
        summary: value.summary,
        blocks: value.blocks,
      }
    : {
        namespace: value.namespace,
        key: value.key,
        summary: value.summary,
        blocks: value.blocks,
      };
}

function assertSameJsonArray(
  actual: ReadonlyArray<Schema.Json>,
  expected: ReadonlyArray<Schema.Json>,
  reference: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => !sameJson(value, expected[index] ?? null))
  ) {
    verificationFailure(reference);
  }
}

/**
 * Replays the #9 packet's semantic invariants. Passing this check proves self-consistency only;
 * canonical current-head trust is added separately by the authorized evidence service.
 */
export function verifyMarketingEvidenceContextPacketSemantics(
  input: VerifyMarketingEvidenceContextPacketInput,
): Effect.Effect<MarketingEvidenceContextPacket, MarketingEvidenceContextError> {
  return Effect.try({
    try: () => {
      const packet = decodePacket(input.packet);
      if (
        input.expectedWorkspace !== undefined &&
        !sameWorkspace(packet.workspace, input.expectedWorkspace)
      ) {
        verificationFailure("verified-workspace-mismatch");
      }
      if (
        packet.receipt.asOf.epochMilliseconds !== packet.asOf.epochMilliseconds ||
        !sameJson(packet.budget, packet.receipt.budget) ||
        packet.receipt.tokenizerRef !== packet.budget.tokenizerRef ||
        packet.receipt.policyRef !== packet.budget.policyRef ||
        (packet.plan === undefined) !== (packet.receipt.planInput === undefined) ||
        (packet.plan !== undefined &&
          packet.receipt.planInput !== undefined &&
          !sameJson(
            {
              planId: packet.plan.planId,
              revision: packet.plan.revision,
              stageSemantics: packet.plan.stageSemantics,
            },
            {
              planId: packet.receipt.planInput.planId,
              revision: packet.receipt.planInput.revision,
              stageSemantics: packet.receipt.planInput.stageSemantics,
            },
          ))
      ) {
        verificationFailure("packet-envelope-mismatch");
      }

      const sortedSources = [...packet.sources].sort((left, right) =>
        compareSourceReference(left.source, right.source),
      );
      if (
        new Set(packet.sources.map(({ source }) => sourceReferenceText(source))).size !==
          packet.sources.length ||
        packet.sources.some((source) => sourceTimestampAfterSnapshot(source, packet.asOf))
      ) {
        verificationFailure("source-order-or-snapshot");
      }
      assertSameJsonArray(
        packet.sources.map(sourceObservationJson),
        sortedSources.map(sourceObservationJson),
        "source-total-order",
      );
      assertSameJsonArray(
        packet.receipt.sourceInputs.map(sourceReferenceJson),
        packet.sources.map(({ source }) => sourceReferenceJson(source)),
        "source-allowlist-ledger",
      );
      const sourceObservationByKey = new Map(
        packet.sources.map((source) => [sourceReferenceText(source.source), source]),
      );

      const sortedAdapters = [...packet.receipt.adapterInputs].sort(compareAdapterProvenance);
      assertSameJsonArray(
        packet.receipt.adapterInputs.map(adapterProvenanceJson),
        sortedAdapters.map(adapterProvenanceJson),
        "adapter-total-order",
      );
      const adapterBySource = new Map(
        packet.receipt.adapterInputs.map((adapter) => [
          sourceReferenceText(adapter.source),
          adapter,
        ]),
      );
      if (adapterBySource.size !== packet.receipt.adapterInputs.length) {
        verificationFailure("duplicate-adapter-provenance");
      }
      for (const source of packet.sources) {
        const adapter = adapterBySource.get(sourceReferenceText(source.source));
        if (stateExclusion(source) === undefined) {
          if (adapter === undefined || adapter.adapterKey !== source.adapterKey) {
            verificationFailure("active-source-adapter-provenance");
          }
        } else if (adapter !== undefined) {
          verificationFailure("inactive-source-adapter-provenance");
        }
      }

      const normalizedEvidence = packet.evidence.map(normalizeEvidence);
      const sortedEvidence = [...normalizedEvidence].sort(compareEvidence);
      const evidenceTuples = new Set<string>();
      const locatorBindings = new Map<string, string>();
      for (const evidence of normalizedEvidence) {
        const sourceKey = sourceReferenceText(evidence.source);
        const source = sourceObservationByKey.get(sourceKey);
        if (
          evidence.observedAt.epochMilliseconds > packet.asOf.epochMilliseconds ||
          source === undefined ||
          stateExclusion(source) !== undefined
        ) {
          verificationFailure("included-evidence-source");
        }
        const tuple = `${sourceKey}\u0000${evidence.locator}\u0000${evidence.contentSha256}`;
        if (evidenceTuples.has(tuple)) verificationFailure("duplicate-included-evidence");
        evidenceTuples.add(tuple);
        const locatorKey = `${sourceKey}\u0000${evidence.locator}`;
        const binding = `${evidence.contentSha256}:${evidence.excerptSha256}`;
        const existing = locatorBindings.get(locatorKey);
        if (existing !== undefined && existing !== binding) {
          verificationFailure("included-locator-rebinding");
        }
        locatorBindings.set(locatorKey, binding);
      }
      assertSameJsonArray(
        packet.evidence.map(evidenceJson),
        normalizedEvidence.map(evidenceJson),
        "evidence-normalization",
      );
      assertSameJsonArray(
        packet.evidence.map(evidenceJson),
        sortedEvidence.map(evidenceJson),
        "evidence-total-order",
      );

      const normalizedFacts = packet.acceptedFacts.map(normalizeFact);
      const sortedFacts = [...normalizedFacts].sort((left, right) =>
        compareCanonicalText(left.stableKey, right.stableKey),
      );
      if (
        new Set(packet.acceptedFacts.map(({ stableKey }) => stableKey)).size !==
          packet.acceptedFacts.length ||
        new Set(
          packet.acceptedFacts.map(
            ({ decisionId, revision }) =>
              `${decisionId}:${revision.revisionId}:${revision.version}`,
          ),
        ).size !== packet.acceptedFacts.length
      ) {
        verificationFailure("duplicate-included-fact");
      }
      assertSameJsonArray(
        packet.acceptedFacts.map(factJson),
        normalizedFacts.map(factJson),
        "fact-normalization",
      );
      assertSameJsonArray(
        packet.acceptedFacts.map(factJson),
        sortedFacts.map(factJson),
        "fact-total-order",
      );

      const normalizedCollections = [
        {
          actual: packet.assumptions,
          normalized: packet.assumptions.map(normalizeAssumption),
          reference: "assumption-order",
        },
        {
          actual: packet.conflicts,
          normalized: packet.conflicts.map(normalizeConflict),
          reference: "conflict-order",
        },
        {
          actual: packet.questions,
          normalized: packet.questions.map(normalizeQuestion),
          reference: "question-order",
        },
        {
          actual: packet.disconfirmationSignals,
          normalized: packet.disconfirmationSignals.map(normalizeSignal),
          reference: "signal-order",
        },
        {
          actual: packet.unresolvedDecisions,
          normalized: packet.unresolvedDecisions.map(normalizeUnresolved),
          reference: "unresolved-order",
        },
      ] as const;
      for (const { actual, normalized, reference } of normalizedCollections) {
        const sorted = [...normalized].sort((left, right) =>
          compareCanonicalText(left.key, right.key),
        );
        if (new Set(actual.map(({ key }) => key)).size !== actual.length) {
          verificationFailure(reference);
        }
        assertSameJsonArray(
          actual.map(stableKeyItemJson),
          normalized.map(stableKeyItemJson),
          `${reference}-normalization`,
        );
        assertSameJsonArray(
          actual.map(stableKeyItemJson),
          sorted.map(stableKeyItemJson),
          reference,
        );
      }

      const normalizedGaps = packet.gaps.map((gap) =>
        gap.namespace === "system" ? normalizeSystemGap(gap) : normalizeUserGap(gap),
      );
      const gapIdentity = (gap: MarketingEvidenceGap) =>
        `${gap.namespace}:${gap.namespace === "system" ? gap.category : "user-authored"}:${gap.key}`;
      const sortedGaps = [...normalizedGaps].sort((left, right) =>
        compareCanonicalText(gapIdentity(left), gapIdentity(right)),
      );
      if (new Set(packet.gaps.map(gapIdentity)).size !== packet.gaps.length) {
        verificationFailure("duplicate-gap-ledger");
      }
      assertSameJsonArray(
        packet.gaps.map(gapJson),
        normalizedGaps.map(gapJson),
        "gap-normalization",
      );
      assertSameJsonArray(packet.gaps.map(gapJson), sortedGaps.map(gapJson), "gap-total-order");
      if (!sameJson(packet.readiness, normalizeReadiness(packet.readiness))) {
        verificationFailure("readiness-normalization");
      }

      const expectedIncluded: MarketingEvidenceReceiptIncludedItem[] = [
        ...packet.acceptedFacts.map((fact) => ({
          subject: {
            kind: "accepted-fact" as const,
            stableKey: fact.stableKey,
            decisionId: fact.decisionId,
            revision: fact.revision,
          },
          digest: factDigest(fact),
          required: true,
          tokenCount: estimateTokens(canonicalJson(factJson(fact))),
        })),
        ...packet.evidence.map((evidence) => ({
          subject: {
            kind: "retrieved-evidence" as const,
            source: evidence.source,
            locatorSha256: sha256(evidence.locator),
          },
          digest: evidenceDigest(evidence),
          required: evidence.required,
          tokenCount: estimateTokens(canonicalJson(evidenceJson(evidence))),
        })),
      ].sort(
        (left, right) =>
          compareCanonicalText(left.digest, right.digest) ||
          compareReceiptSubject(left.subject, right.subject),
      );
      assertSameJsonArray(
        packet.receipt.included.map(receiptIncludedJson),
        expectedIncluded.map(receiptIncludedJson),
        "included-evidence-ledger",
      );
      const includedEvidenceBytes = packet.evidence.reduce(
        (total, evidence) =>
          total + Buffer.byteLength(canonicalJson(evidenceJson(evidence)), "utf8"),
        0,
      );
      const includedPerSource = new Map<string, number>();
      for (const evidence of packet.evidence) {
        const key = sourceReferenceText(evidence.source);
        includedPerSource.set(key, (includedPerSource.get(key) ?? 0) + 1);
      }
      if (
        packet.receipt.included.length > packet.budget.maxItems ||
        includedEvidenceBytes > packet.budget.maxCandidateBytes ||
        [...includedPerSource.values()].some((count) => count > packet.budget.maxPerSource)
      ) {
        verificationFailure("included-evidence-budget");
      }

      const sortedExcluded = [...packet.receipt.excluded].sort(
        (left, right) =>
          compareReceiptSubject(left.subject, right.subject) ||
          compareCanonicalText(left.reason, right.reason) ||
          compareCanonicalText(left.digest, right.digest),
      );
      assertSameJsonArray(
        packet.receipt.excluded.map(receiptExcludedJson),
        sortedExcluded.map(receiptExcludedJson),
        "excluded-evidence-ledger-order",
      );
      const sourceKeys = new Set(packet.receipt.sourceInputs.map(sourceReferenceText));
      const excludedSourceKeys = new Set<string>();
      for (const excluded of packet.receipt.excluded) {
        switch (excluded.subject.kind) {
          case "source": {
            const key = sourceReferenceText(excluded.subject.source);
            const source = sourceObservationByKey.get(key);
            const expectedReason = source === undefined ? undefined : stateExclusion(source);
            if (
              !sourceKeys.has(key) ||
              source === undefined ||
              excludedSourceKeys.has(key) ||
              excluded.required ||
              excluded.tokenCount !== 0 ||
              excluded.digest !== sourceDigest(excluded.subject.source) ||
              excluded.reason !== (expectedReason ?? "inaccessible")
            ) {
              verificationFailure("excluded-source-ledger");
            }
            excludedSourceKeys.add(key);
            break;
          }
          case "accepted-fact":
            if (
              !excluded.required ||
              (excluded.reason !== "budget" && excluded.reason !== "superseded") ||
              (excluded.reason === "budget" && excluded.tokenCount < 1) ||
              (excluded.reason === "superseded" &&
                (excluded.tokenCount !== 0 ||
                  excluded.digest !== sha256(canonicalJson(subjectJson(excluded.subject)))))
            ) {
              verificationFailure("excluded-fact-ledger");
            }
            break;
          case "retrieved-evidence": {
            const key = sourceReferenceText(excluded.subject.source);
            const source = sourceObservationByKey.get(key);
            if (
              !sourceKeys.has(key) ||
              source === undefined ||
              stateExclusion(source) !== undefined ||
              excluded.tokenCount < 1 ||
              (excluded.reason !== "budget" && excluded.reason !== "duplicate")
            ) {
              verificationFailure("excluded-evidence-source");
            }
            break;
          }
        }
      }
      for (const source of packet.sources) {
        if (
          stateExclusion(source) !== undefined &&
          !excludedSourceKeys.has(sourceReferenceText(source.source))
        ) {
          verificationFailure("missing-source-exclusion");
        }
      }
      if (
        packet.evidence.some(({ source }) => excludedSourceKeys.has(sourceReferenceText(source)))
      ) {
        verificationFailure("excluded-source-has-included-evidence");
      }

      const ledgerDigests = [
        ...packet.receipt.included.map(({ digest }) => digest),
        ...packet.receipt.excluded.flatMap(({ subject, digest }) =>
          subject.kind === "source" ? [] : [digest],
        ),
      ].sort(compareCanonicalText);
      if (
        ledgerDigests.length !== packet.receipt.candidateDigests.length ||
        ledgerDigests.some((digest, index) => digest !== packet.receipt.candidateDigests[index])
      ) {
        verificationFailure("candidate-digest-ledger");
      }

      const factInputs = [...packet.receipt.included, ...packet.receipt.excluded].flatMap(
        ({ subject }) =>
          subject.kind === "accepted-fact"
            ? [
                {
                  stableKey: subject.stableKey,
                  decisionId: subject.decisionId,
                  revision: subject.revision,
                },
              ]
            : [],
      );
      factInputs.sort((left, right) => compareCanonicalText(left.stableKey, right.stableKey));
      if (
        new Set(factInputs.map(({ stableKey }) => stableKey)).size !== factInputs.length ||
        !sameJson(packet.receipt.factInputs, factInputs)
      ) {
        verificationFailure("fact-input-ledger");
      }

      const includedTokenCount = packet.receipt.included.reduce(
        (total, item) => total + item.tokenCount,
        0,
      );
      const includedDigests = new Set(packet.receipt.included.map(({ digest }) => digest));
      const requiredOmitted = packet.receipt.excluded.some(
        (item) =>
          item.required && (item.reason !== "duplicate" || !includedDigests.has(item.digest)),
      );
      const omissionGap = packet.gaps.some(
        (gap) =>
          gap.namespace === "system" &&
          gap.category === requiredOmissionGap.category &&
          gap.key === requiredOmissionGap.key &&
          gap.blocks,
      );
      const blockingGap = packet.gaps.some(({ blocks }) => blocks);
      if (
        includedTokenCount !== packet.receipt.includedTokenCount ||
        requiredOmitted !== omissionGap ||
        (blockingGap &&
          (packet.readiness.state !== "blocked" ||
            !packet.readiness.codes.includes(blockingGapCode))) ||
        (requiredOmitted &&
          (packet.readiness.state !== "blocked" ||
            !packet.readiness.codes.includes(requiredOmissionCode)))
      ) {
        verificationFailure("required-omission-ledger");
      }

      const exactTokenCount = estimateTokens(canonicalJson(packetJson(packet)));
      const exactPacketSha256 = sha256(canonicalJson(packetDigestJson(packet)));
      if (
        exactTokenCount !== packet.receipt.packetTokenCount ||
        exactTokenCount > packet.budget.maxTokens ||
        exactPacketSha256 !== packet.receipt.packetSha256
      ) {
        verificationFailure("complete-packet-receipt");
      }
      return packet;
    },
    catch: (cause) =>
      isEvidenceContextError(cause)
        ? cause
        : new MarketingEvidenceContextError({ reason: "invalid_context_input" }),
  });
}
