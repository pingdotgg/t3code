// @effect-diagnostics nodeBuiltinImport:off - Day 0 receipts are local deterministic integrity digests.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MarketingCanonicalDefinitionReference,
  MarketingCanonicalRegistryKey,
  MarketingCanonicalVersion,
} from "./canonical.ts";
import { compareCanonicalText } from "./canonicalSeal.ts";
import { MarketingDay0Error, MarketingDay0SafeReference } from "./day0Errors.ts";
import {
  MarketingAcceptedFact,
  MarketingDecisionChangingQuestion,
  MarketingEvidenceGap,
  MarketingEvidenceReceipt,
  MarketingEvidenceSha256,
  MarketingEvidenceStableKey,
  MarketingEvidenceStateCode,
  MarketingEvidenceAssumption,
  MarketingEvidenceConflict,
  MarketingPlanReadiness,
  MarketingRetrievedEvidence,
  MarketingSourceObservation,
  MarketingUnresolvedDecision,
} from "./evidenceContext.ts";
import {
  readVerifiedMarketingEvidenceContext,
  type VerifiedMarketingEvidenceContextPacket,
} from "./evidenceContextService.ts";
import { MarketingWorkspaceSelection } from "./identity.ts";

export const MARKETING_DAY0_FORMAT = "auldric/day0-operating-packet@1" as const;
export const MARKETING_DAY0_POLICY_REF = "auldric/day0-kernel@1" as const;
export const MARKETING_DAY0_ROUTE_CHOICE_INTENT_FORMAT =
  "auldric/day0-route-choice-intent@1" as const;
export const MARKETING_DAY0_MAX_PACKET_BYTES = 262_144;
export const MARKETING_DAY0_ROUTE_CATALOG_KEY = "marketing/workflow-catalog" as const;
export const MARKETING_DAY0_ROUTE_CATALOG_VERSION = 1 as const;
export const MARKETING_DAY0_STRATEGY_DEFINITION_KEY =
  "marketing/workflow/marketing-strategy" as const;
export const MARKETING_DAY0_GTM_DEFINITION_KEY = "marketing/workflow/gtm" as const;

const Day0Text = (maximum: number) =>
  Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(maximum));

export const MarketingDay0RouteKey = Schema.Literals(["marketing-strategy", "gtm"]);
export type MarketingDay0RouteKey = typeof MarketingDay0RouteKey.Type;

export const MarketingDay0RouteReadiness = Schema.Union([
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
export type MarketingDay0RouteReadiness = typeof MarketingDay0RouteReadiness.Type;

/**
 * An injected projection over the future #19 catalog. The Day 0 kernel owns neither definitions
 * nor readiness calculation and accepts only the two versioned route references supplied here.
 */
export const MarketingDay0RouteDefinition = Schema.Struct({
  key: MarketingDay0RouteKey,
  definition: Schema.Struct({
    key: MarketingCanonicalRegistryKey,
    version: MarketingCanonicalVersion,
  }),
  readiness: MarketingDay0RouteReadiness,
});
export type MarketingDay0RouteDefinition = typeof MarketingDay0RouteDefinition.Type;

export const MarketingDay0RouteCatalogSnapshot = Schema.Struct({
  catalog: Schema.Struct({
    key: MarketingCanonicalRegistryKey,
    version: MarketingCanonicalVersion,
  }),
  routes: Schema.Array(MarketingDay0RouteDefinition).check(Schema.isMaxLength(2)),
  snapshotSha256: MarketingEvidenceSha256,
});
export type MarketingDay0RouteCatalogSnapshot = typeof MarketingDay0RouteCatalogSnapshot.Type;

export interface MarketingDay0RouteCatalogVerifier {
  readonly reference: MarketingCanonicalDefinitionReference;
  /** Purely returns the digest of the exact snapshot body accepted by the injected #19 adapter. */
  readonly verify: (snapshot: MarketingDay0RouteCatalogSnapshot) => MarketingEvidenceSha256;
}

export const MarketingDay0RouteCatalogBinding = Schema.Struct({
  catalog: MarketingDay0RouteCatalogSnapshot.fields.catalog,
  verifier: MarketingCanonicalDefinitionReference,
  snapshotSha256: MarketingEvidenceSha256,
  trust: Schema.Literal("injected-unapproved"),
});
export type MarketingDay0RouteCatalogBinding = typeof MarketingDay0RouteCatalogBinding.Type;

const MarketingDay0Support = Schema.Array(MarketingEvidenceSha256).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16),
);

export const MarketingDay0Confidence = Schema.Struct({
  score: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  basis: Day0Text(2_000),
});
export type MarketingDay0Confidence = typeof MarketingDay0Confidence.Type;

export const MarketingDay0PointOfViewDraft = Schema.Struct({
  statement: Day0Text(4_000),
  support: MarketingDay0Support,
});
export type MarketingDay0PointOfViewDraft = typeof MarketingDay0PointOfViewDraft.Type;

export const MarketingDay0HypothesisSignal = Schema.Struct({
  key: MarketingEvidenceStableKey,
  signal: Day0Text(2_000),
  consequence: Day0Text(2_000),
});
export type MarketingDay0HypothesisSignal = typeof MarketingDay0HypothesisSignal.Type;

export const MarketingDay0HypothesisDraft = Schema.Struct({
  statement: Day0Text(4_000),
  test: Day0Text(4_000),
  confidence: MarketingDay0Confidence,
  disconfirmationSignals: Schema.Array(MarketingDay0HypothesisSignal).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  support: MarketingDay0Support,
});
export type MarketingDay0HypothesisDraft = typeof MarketingDay0HypothesisDraft.Type;

export const MarketingDay0ImmediateAction = Schema.Struct({
  key: MarketingEvidenceStableKey,
  order: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  action: Day0Text(2_000),
  owner: Day0Text(500),
  output: Day0Text(2_000),
  completionPoint: Day0Text(2_000),
  successSignal: Day0Text(2_000),
  support: MarketingDay0Support,
});
export type MarketingDay0ImmediateAction = typeof MarketingDay0ImmediateAction.Type;

export const MarketingDay0RouteRecommendationDraft = Schema.Struct({
  route: MarketingDay0RouteKey,
  rationale: Day0Text(4_000),
  support: MarketingDay0Support,
});
export type MarketingDay0RouteRecommendationDraft =
  typeof MarketingDay0RouteRecommendationDraft.Type;

export const MarketingDay0UsefulDraft = Schema.Struct({
  state: Schema.Literal("useful-context"),
  pointOfView: MarketingDay0PointOfViewDraft,
  hypothesis: MarketingDay0HypothesisDraft,
  immediateActions: Schema.Array(MarketingDay0ImmediateAction).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(4),
  ),
  routeRecommendation: MarketingDay0RouteRecommendationDraft,
  questions: Schema.Array(MarketingDecisionChangingQuestion).check(Schema.isMaxLength(3)),
});
export type MarketingDay0UsefulDraft = typeof MarketingDay0UsefulDraft.Type;

export const MarketingDay0ContextlessDraft = Schema.Struct({
  state: Schema.Literal("contextless"),
  questions: Schema.Array(MarketingDecisionChangingQuestion).check(Schema.isMaxLength(3)),
});
export type MarketingDay0ContextlessDraft = typeof MarketingDay0ContextlessDraft.Type;

export const MarketingDay0Draft = Schema.Union([
  MarketingDay0UsefulDraft,
  MarketingDay0ContextlessDraft,
]);
export type MarketingDay0Draft = typeof MarketingDay0Draft.Type;

export const MarketingDay0PointOfView = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending"), reason: Schema.Literal("contextless") }),
  Schema.Struct({ state: Schema.Literal("ready"), ...MarketingDay0PointOfViewDraft.fields }),
]);
export type MarketingDay0PointOfView = typeof MarketingDay0PointOfView.Type;

export const MarketingDay0Hypothesis = Schema.Union([
  Schema.Struct({ state: Schema.Literal("pending"), reason: Schema.Literal("contextless") }),
  Schema.Struct({ state: Schema.Literal("ready"), ...MarketingDay0HypothesisDraft.fields }),
]);
export type MarketingDay0Hypothesis = typeof MarketingDay0Hypothesis.Type;

export const MarketingDay0RouteRecommendation = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("pending"),
    reason: Schema.Literal("contextless"),
    candidates: Schema.Array(MarketingDay0RouteDefinition).check(Schema.isMaxLength(2)),
  }),
  Schema.Struct({
    state: Schema.Literal("recommended"),
    route: MarketingDay0RouteDefinition,
    rationale: Day0Text(4_000),
    support: MarketingDay0Support,
    alternative: MarketingDay0RouteDefinition,
    alternativeAvailability: Schema.Literal("explicit-override-only"),
  }),
]);
export type MarketingDay0RouteRecommendation = typeof MarketingDay0RouteRecommendation.Type;

export const MarketingDay0EvidenceSummary = Schema.Struct({
  contextPacketSha256: MarketingEvidenceSha256,
  snapshotAsOf: Schema.DateTimeUtc,
  sources: Schema.Array(MarketingSourceObservation).check(Schema.isMaxLength(24)),
  selectedEvidence: Schema.Array(MarketingRetrievedEvidence).check(Schema.isMaxLength(64)),
  acceptedFacts: Schema.Array(MarketingAcceptedFact).check(Schema.isMaxLength(32)),
  assumptions: Schema.Array(MarketingEvidenceAssumption).check(Schema.isMaxLength(32)),
  conflicts: Schema.Array(MarketingEvidenceConflict).check(Schema.isMaxLength(32)),
  gaps: Schema.Array(MarketingEvidenceGap).check(Schema.isMaxLength(96)),
  readiness: MarketingPlanReadiness,
  unresolvedDecisions: Schema.Array(MarketingUnresolvedDecision).check(Schema.isMaxLength(32)),
  receipt: MarketingEvidenceReceipt,
});
export type MarketingDay0EvidenceSummary = typeof MarketingDay0EvidenceSummary.Type;

export const MarketingDay0ActivationState = Schema.Struct({
  state: Schema.Literal("dormant"),
  blockers: Schema.Array(MarketingEvidenceStateCode).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type MarketingDay0ActivationState = typeof MarketingDay0ActivationState.Type;

export const MarketingDay0RouteReviewState = Schema.Struct({
  state: Schema.Literal("pending"),
  required: Schema.Literal(true),
});
export type MarketingDay0RouteReviewState = typeof MarketingDay0RouteReviewState.Type;

export const MarketingDay0Receipt = Schema.Struct({
  format: Schema.Literal(MARKETING_DAY0_FORMAT),
  policyRef: Schema.Literal(MARKETING_DAY0_POLICY_REF),
  compiledAsOf: Schema.DateTimeUtc,
  evidenceContextSha256: MarketingEvidenceSha256,
  evidenceReceiptSha256: MarketingEvidenceSha256,
  routesSha256: MarketingEvidenceSha256,
  inputSha256: MarketingEvidenceSha256,
  contextState: Schema.Literals(["useful-context", "contextless"]),
  questionInputCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  questionIncludedKeys: Schema.Array(MarketingEvidenceStableKey).check(Schema.isMaxLength(3)),
  questionExcludedKeys: Schema.Array(MarketingEvidenceStableKey).check(Schema.isMaxLength(32)),
  packetByteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  packetSha256: MarketingEvidenceSha256,
});
export type MarketingDay0Receipt = typeof MarketingDay0Receipt.Type;

export const MarketingDay0OperatingPacket = Schema.Struct({
  format: Schema.Literal(MARKETING_DAY0_FORMAT),
  workspace: MarketingWorkspaceSelection,
  asOf: Schema.DateTimeUtc,
  contextState: Schema.Literals(["useful-context", "contextless"]),
  pointOfView: MarketingDay0PointOfView,
  hypothesis: MarketingDay0Hypothesis,
  immediateActions: Schema.Array(MarketingDay0ImmediateAction).check(Schema.isMaxLength(4)),
  routeRecommendation: MarketingDay0RouteRecommendation,
  routeCatalog: MarketingDay0RouteCatalogBinding,
  questions: Schema.Array(MarketingDecisionChangingQuestion).check(Schema.isMaxLength(3)),
  evidence: MarketingDay0EvidenceSummary,
  routeReview: MarketingDay0RouteReviewState,
  activation: MarketingDay0ActivationState,
  receipt: MarketingDay0Receipt,
});
export type MarketingDay0OperatingPacket = typeof MarketingDay0OperatingPacket.Type;

export interface CompileMarketingDay0Input {
  readonly evidenceContext: VerifiedMarketingEvidenceContextPacket;
  readonly routeCatalog: MarketingDay0RouteCatalogSnapshot;
  readonly routeCatalogVerifier: MarketingDay0RouteCatalogVerifier;
  readonly draft: MarketingDay0Draft;
}

export const MarketingDay0RouteChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("accept") }),
  Schema.Struct({ kind: Schema.Literal("override"), rationale: Day0Text(4_000) }),
]);
export type MarketingDay0RouteChoice = typeof MarketingDay0RouteChoice.Type;

export const MarketingDay0RouteChoiceIntentReceipt = Schema.Struct({
  inputSha256: MarketingEvidenceSha256,
  intentSha256: MarketingEvidenceSha256,
});
export type MarketingDay0RouteChoiceIntentReceipt =
  typeof MarketingDay0RouteChoiceIntentReceipt.Type;

export const MarketingDay0RouteChoiceIntent = Schema.Struct({
  format: Schema.Literal(MARKETING_DAY0_ROUTE_CHOICE_INTENT_FORMAT),
  workspace: MarketingWorkspaceSelection,
  packetSha256: MarketingEvidenceSha256,
  choice: MarketingDay0RouteChoice,
  selectedRoute: MarketingDay0RouteDefinition,
  state: Schema.Literal("unverified-pending-intent"),
  laterAdapterRequirements: Schema.Array(MarketingEvidenceStateCode).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  activation: MarketingDay0ActivationState,
  receipt: MarketingDay0RouteChoiceIntentReceipt,
});
export type MarketingDay0RouteChoiceIntent = typeof MarketingDay0RouteChoiceIntent.Type;

export interface PrepareUnverifiedMarketingDay0RouteChoiceInput {
  readonly packet: MarketingDay0OperatingPacket;
  readonly choice: MarketingDay0RouteChoice;
}

const decodeRouteCatalog = Schema.decodeUnknownSync(MarketingDay0RouteCatalogSnapshot);
const decodeDefinitionReference = Schema.decodeUnknownSync(MarketingCanonicalDefinitionReference);
const encodeEvidenceReceiptJson = Schema.encodeSync(Schema.toCodecJson(MarketingEvidenceReceipt));
const decodeRoutes = Schema.decodeUnknownSync(
  Schema.Array(MarketingDay0RouteDefinition).check(Schema.isMaxLength(2)),
);
const decodeDraft = Schema.decodeUnknownSync(MarketingDay0Draft);
const decodePacket = Schema.decodeUnknownSync(MarketingDay0OperatingPacket);
const encodePacketJson = Schema.encodeSync(Schema.toCodecJson(MarketingDay0OperatingPacket));
const decodeChoice = Schema.decodeUnknownSync(MarketingDay0RouteChoice);
const decodeChoiceIntent = Schema.decodeUnknownSync(MarketingDay0RouteChoiceIntent);
const encodeChoiceIntentJson = Schema.encodeSync(
  Schema.toCodecJson(MarketingDay0RouteChoiceIntent),
);
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeSafeReference = Schema.decodeUnknownSync(MarketingDay0SafeReference);
const isDay0Error = Schema.is(MarketingDay0Error);

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
      throw new MarketingDay0Error({
        reason: "invalid_day0_input",
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

function safeDigestReference(namespace: string, value: string): MarketingDay0SafeReference {
  return decodeSafeReference(`${namespace}:${sha256(value)}`);
}

function encodedJson<T>(encode: (value: T) => unknown, value: T): Schema.Json {
  return decodeJson(encode(value));
}

function normalizeReadiness(readiness: MarketingDay0RouteReadiness): MarketingDay0RouteReadiness {
  return readiness.state === "blocked" || readiness.state === "partial"
    ? { ...readiness, codes: [...new Set(readiness.codes)].sort(compareCanonicalText) }
    : readiness;
}

function normalizeRouteDefinitions(
  rawRoutes: ReadonlyArray<MarketingDay0RouteDefinition>,
): ReadonlyArray<MarketingDay0RouteDefinition> {
  const routes = decodeRoutes(rawRoutes)
    .map((route) => ({ ...route, readiness: normalizeReadiness(route.readiness) }))
    .sort((left, right) => compareCanonicalText(left.key, right.key));
  const gtm = routes[0];
  const strategy = routes[1];
  if (
    routes.length !== 2 ||
    gtm?.key !== "gtm" ||
    strategy?.key !== "marketing-strategy" ||
    gtm.definition.key !== MARKETING_DAY0_GTM_DEFINITION_KEY ||
    strategy.definition.key !== MARKETING_DAY0_STRATEGY_DEFINITION_KEY ||
    Number(gtm.definition.version) !== MARKETING_DAY0_ROUTE_CATALOG_VERSION ||
    Number(strategy.definition.version) !== MARKETING_DAY0_ROUTE_CATALOG_VERSION
  ) {
    throw new MarketingDay0Error({ reason: "incomplete_route_contract" });
  }
  return routes;
}

/** Creates a deterministic but explicitly untrusted adapter envelope for the future #19 catalog. */
export function makeInjectedMarketingDay0RouteCatalogSnapshot(
  rawRoutes: ReadonlyArray<MarketingDay0RouteDefinition>,
): MarketingDay0RouteCatalogSnapshot {
  const routes = normalizeRouteDefinitions(rawRoutes);
  const catalog = {
    key: MarketingCanonicalRegistryKey.make(MARKETING_DAY0_ROUTE_CATALOG_KEY),
    version: MarketingCanonicalVersion.make(MARKETING_DAY0_ROUTE_CATALOG_VERSION),
  };
  const snapshotSha256 = sha256(
    canonicalJson(
      decodeJson({
        catalog,
        routes,
      }),
    ),
  );
  return {
    catalog,
    routes,
    snapshotSha256,
  };
}

function normalizeRouteCatalog(input: {
  readonly snapshot: MarketingDay0RouteCatalogSnapshot;
  readonly verifier: MarketingDay0RouteCatalogVerifier;
}): {
  readonly routes: ReadonlyArray<MarketingDay0RouteDefinition>;
  readonly binding: MarketingDay0RouteCatalogBinding;
} {
  const decoded = decodeRouteCatalog(input.snapshot);
  const normalizedSnapshot = makeInjectedMarketingDay0RouteCatalogSnapshot(decoded.routes);
  if (
    decoded.catalog.key !== MARKETING_DAY0_ROUTE_CATALOG_KEY ||
    Number(decoded.catalog.version) !== MARKETING_DAY0_ROUTE_CATALOG_VERSION
  ) {
    throw new MarketingDay0Error({ reason: "incomplete_route_contract" });
  }
  const verifier = decodeDefinitionReference(input.verifier.reference);
  const verifierSnapshot = decodeRouteCatalog(normalizedSnapshot);
  const acceptedSnapshotSha256 = input.verifier.verify(verifierSnapshot);
  const verifierSnapshotAfter = decodeRouteCatalog(verifierSnapshot);
  const normalizedVerifierSnapshotAfter = makeInjectedMarketingDay0RouteCatalogSnapshot(
    verifierSnapshotAfter.routes,
  );
  if (
    verifier.key !== MARKETING_DAY0_ROUTE_CATALOG_KEY ||
    Number(verifier.version) !== MARKETING_DAY0_ROUTE_CATALOG_VERSION ||
    canonicalJson(decodeJson(decoded.routes)) !==
      canonicalJson(decodeJson(normalizedSnapshot.routes)) ||
    decoded.snapshotSha256 !== normalizedSnapshot.snapshotSha256 ||
    verifierSnapshotAfter.catalog.key !== MARKETING_DAY0_ROUTE_CATALOG_KEY ||
    Number(verifierSnapshotAfter.catalog.version) !== MARKETING_DAY0_ROUTE_CATALOG_VERSION ||
    verifierSnapshotAfter.snapshotSha256 !== normalizedSnapshot.snapshotSha256 ||
    canonicalJson(decodeJson(verifierSnapshotAfter.routes)) !==
      canonicalJson(decodeJson(normalizedSnapshot.routes)) ||
    normalizedVerifierSnapshotAfter.snapshotSha256 !== normalizedSnapshot.snapshotSha256 ||
    acceptedSnapshotSha256 !== normalizedSnapshot.snapshotSha256
  ) {
    throw new MarketingDay0Error({
      reason: "incomplete_route_contract",
      reference: decodeSafeReference("route-catalog-verification"),
    });
  }
  return {
    routes: normalizedSnapshot.routes,
    binding: {
      catalog: decoded.catalog,
      verifier,
      snapshotSha256: normalizedSnapshot.snapshotSha256,
      trust: "injected-unapproved",
    },
  };
}

function normalizeSupport(
  support: ReadonlyArray<MarketingEvidenceSha256>,
  allowed: ReadonlySet<MarketingEvidenceSha256>,
): ReadonlyArray<MarketingEvidenceSha256> {
  const normalized = [...new Set(support)].sort(compareCanonicalText);
  const unsupported = normalized.find((digest) => !allowed.has(digest));
  if (unsupported !== undefined) {
    throw new MarketingDay0Error({
      reason: "unsupported_evidence_reference",
      reference: safeDigestReference("evidence", unsupported),
    });
  }
  return normalized;
}

function normalizeQuestion(
  question: MarketingDecisionChangingQuestion,
): MarketingDecisionChangingQuestion {
  return {
    ...question,
    question: normalizeText(question.question, true),
  };
}

function sortQuestions(
  questions: ReadonlyArray<MarketingDecisionChangingQuestion>,
): ReadonlyArray<MarketingDecisionChangingQuestion> {
  return questions
    .map(normalizeQuestion)
    .sort(
      (left, right) =>
        right.decisionImpact - left.decisionImpact || compareCanonicalText(left.key, right.key),
    );
}

function selectQuestions(
  packetQuestions: ReadonlyArray<MarketingDecisionChangingQuestion>,
  draftQuestions: ReadonlyArray<MarketingDecisionChangingQuestion>,
): {
  readonly included: ReadonlyArray<MarketingDecisionChangingQuestion>;
  readonly excluded: ReadonlyArray<MarketingEvidenceStableKey>;
  readonly inputCount: number;
} {
  const byKey = new Map<MarketingEvidenceStableKey, MarketingDecisionChangingQuestion>();
  for (const rawQuestion of [...packetQuestions, ...draftQuestions]) {
    const question = normalizeQuestion(rawQuestion);
    const existing = byKey.get(question.key);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(question)) {
      throw new MarketingDay0Error({
        reason: "invalid_day0_input",
        reference: safeDigestReference("question", question.key),
      });
    }
    byKey.set(question.key, question);
  }
  const ranked = [...byKey.values()].sort(
    (left, right) =>
      right.decisionImpact - left.decisionImpact || compareCanonicalText(left.key, right.key),
  );
  return {
    included: ranked.slice(0, 3),
    excluded: ranked.slice(3).map(({ key }) => key),
    inputCount: ranked.length,
  };
}

function normalizeUsefulDraft(
  draft: MarketingDay0UsefulDraft,
  allowedSupport: ReadonlySet<MarketingEvidenceSha256>,
): MarketingDay0UsefulDraft {
  const actions = draft.immediateActions
    .map((action) => ({
      ...action,
      action: normalizeText(action.action, true),
      owner: normalizeText(action.owner, true),
      output: normalizeText(action.output, true),
      completionPoint: normalizeText(action.completionPoint, true),
      successSignal: normalizeText(action.successSignal, true),
      support: normalizeSupport(action.support, allowedSupport),
    }))
    .sort((left, right) => left.order - right.order || compareCanonicalText(left.key, right.key));
  if (
    new Set(actions.map(({ key }) => key)).size !== actions.length ||
    actions.some(({ order }, index) => order !== index + 1)
  ) {
    throw new MarketingDay0Error({
      reason: "invalid_day0_input",
      reference: decodeSafeReference("immediate-action-order"),
    });
  }
  const signals = draft.hypothesis.disconfirmationSignals
    .map((signal) => ({
      ...signal,
      signal: normalizeText(signal.signal, true),
      consequence: normalizeText(signal.consequence, true),
    }))
    .sort((left, right) => compareCanonicalText(left.key, right.key));
  if (new Set(signals.map(({ key }) => key)).size !== signals.length) {
    throw new MarketingDay0Error({
      reason: "invalid_day0_input",
      reference: decodeSafeReference("duplicate-disconfirmation-signal"),
    });
  }
  return {
    state: "useful-context",
    pointOfView: {
      statement: normalizeText(draft.pointOfView.statement, true),
      support: normalizeSupport(draft.pointOfView.support, allowedSupport),
    },
    hypothesis: {
      statement: normalizeText(draft.hypothesis.statement, true),
      test: normalizeText(draft.hypothesis.test, true),
      confidence: {
        ...draft.hypothesis.confidence,
        basis: normalizeText(draft.hypothesis.confidence.basis, true),
      },
      disconfirmationSignals: signals,
      support: normalizeSupport(draft.hypothesis.support, allowedSupport),
    },
    immediateActions: actions,
    routeRecommendation: {
      ...draft.routeRecommendation,
      rationale: normalizeText(draft.routeRecommendation.rationale, true),
      support: normalizeSupport(draft.routeRecommendation.support, allowedSupport),
    },
    questions: sortQuestions(draft.questions),
  };
}

function activationBlockers(
  contextState: MarketingDay0OperatingPacket["contextState"],
  evidenceReadiness: MarketingPlanReadiness,
  route?: MarketingDay0RouteDefinition,
): ReadonlyArray<MarketingEvidenceStateCode> {
  const mandatory = [
    MarketingEvidenceStateCode.make("route-review-pending"),
    MarketingEvidenceStateCode.make("canonical-readback-required"),
    MarketingEvidenceStateCode.make("canonical-current-head-revalidation-required"),
    MarketingEvidenceStateCode.make("route-catalog-unapproved"),
    MarketingEvidenceStateCode.make("workflow-activation-adapter-unavailable"),
  ];
  const callerCodes: MarketingEvidenceStateCode[] = [];
  if (contextState === "contextless") {
    mandatory.push(MarketingEvidenceStateCode.make("useful-context-required"));
  }
  if (route === undefined) {
    mandatory.push(MarketingEvidenceStateCode.make("route-recommendation-required"));
  }
  if (evidenceReadiness.state === "not-evaluated") {
    mandatory.push(MarketingEvidenceStateCode.make("evidence-readiness-not-evaluated"));
  } else if (evidenceReadiness.state === "blocked" || evidenceReadiness.state === "partial") {
    mandatory.push(
      MarketingEvidenceStateCode.make(
        evidenceReadiness.state === "blocked"
          ? "evidence-readiness-blocked"
          : "evidence-readiness-partial",
      ),
    );
    callerCodes.push(...evidenceReadiness.codes);
  }
  if (route?.readiness.state === "not-evaluated") {
    mandatory.push(MarketingEvidenceStateCode.make("route-readiness-not-evaluated"));
  } else if (route?.readiness.state === "blocked" || route?.readiness.state === "partial") {
    mandatory.push(
      MarketingEvidenceStateCode.make(
        route.readiness.state === "blocked" ? "route-readiness-blocked" : "route-readiness-partial",
      ),
    );
    callerCodes.push(...route.readiness.codes);
  }
  const reserved = [...new Set(mandatory)];
  const remaining = Math.max(0, 16 - reserved.length);
  const retainedCallerCodes = [...new Set(callerCodes)]
    .filter((code) => !reserved.includes(code))
    .sort(compareCanonicalText)
    .slice(0, remaining);
  return [...reserved, ...retainedCallerCodes];
}

function packetDigestJson(packet: MarketingDay0OperatingPacket): Schema.Json {
  const encoded = encodedJson(encodePacketJson, packet);
  if (encoded === null || Array.isArray(encoded) || typeof encoded !== "object") {
    throw new MarketingDay0Error({ reason: "invalid_day0_input" });
  }
  const encodedObject = encoded as { readonly [key: string]: Schema.Json };
  const receipt = encodedObject.receipt;
  if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object") {
    throw new MarketingDay0Error({ reason: "invalid_day0_input" });
  }
  const receiptObject = receipt as { readonly [key: string]: Schema.Json };
  const { packetSha256: _packetSha256, ...receiptWithoutDigest } = receiptObject;
  return { ...encodedObject, receipt: receiptWithoutDigest };
}

function verifyDay0Packet(packet: MarketingDay0OperatingPacket): void {
  const expectedSha256 = sha256(canonicalJson(packetDigestJson(packet)));
  const packetByteCount = Buffer.byteLength(
    canonicalJson(encodedJson(encodePacketJson, packet)),
    "utf8",
  );
  if (
    expectedSha256 !== packet.receipt.packetSha256 ||
    packetByteCount !== packet.receipt.packetByteCount ||
    packetByteCount > MARKETING_DAY0_MAX_PACKET_BYTES
  ) {
    throw new MarketingDay0Error({ reason: "invalid_day0_input" });
  }
}

/**
 * Compiles one transient Day 0 operating packet from an exact #9 evidence packet. It performs no
 * I/O or persistence and never activates a workflow.
 */
export function compileMarketingDay0(
  rawInput: CompileMarketingDay0Input,
): Effect.Effect<MarketingDay0OperatingPacket, MarketingDay0Error> {
  return Effect.flatMap(
    readVerifiedMarketingEvidenceContext(rawInput.evidenceContext).pipe(
      Effect.mapError(
        () =>
          new MarketingDay0Error({
            reason: "evidence_receipt_mismatch",
            reference: decodeSafeReference("canonical-current-head-capability-required"),
          }),
      ),
    ),
    (evidenceContext) =>
      Effect.try({
        try: () => {
          const routeCatalog = normalizeRouteCatalog({
            snapshot: rawInput.routeCatalog,
            verifier: rawInput.routeCatalogVerifier,
          });
          const routes = routeCatalog.routes;
          const draft = decodeDraft(rawInput.draft);
          const includedSupport = new Set(
            evidenceContext.receipt.included
              .filter(({ subject }) => subject.kind !== "source")
              .map(({ digest }) => digest),
          );
          const usefulContext = includedSupport.size > 0;
          if (
            (usefulContext && draft.state !== "useful-context") ||
            (!usefulContext && draft.state !== "contextless")
          ) {
            throw new MarketingDay0Error({ reason: "context_state_mismatch" });
          }

          const normalizedDraft =
            draft.state === "useful-context"
              ? normalizeUsefulDraft(draft, includedSupport)
              : {
                  state: "contextless" as const,
                  questions: sortQuestions(draft.questions),
                };
          const selectedQuestions = selectQuestions(
            evidenceContext.questions,
            normalizedDraft.questions,
          );
          const evidenceReceiptSha256 = sha256(
            canonicalJson(encodedJson(encodeEvidenceReceiptJson, evidenceContext.receipt)),
          );
          const routesSha256 = routeCatalog.binding.snapshotSha256;
          const inputSha256 = sha256(
            canonicalJson(
              decodeJson({
                evidenceContextSha256: evidenceContext.receipt.packetSha256,
                evidenceReceiptSha256,
                routeCatalog: routeCatalog.binding,
                routes,
                draft: normalizedDraft,
              }),
            ),
          );
          const recommendedRoute =
            normalizedDraft.state === "useful-context"
              ? routes.find(({ key }) => key === normalizedDraft.routeRecommendation.route)
              : undefined;
          if (normalizedDraft.state === "useful-context" && recommendedRoute === undefined) {
            throw new MarketingDay0Error({ reason: "route_not_registered" });
          }
          const alternativeRoute =
            recommendedRoute === undefined
              ? undefined
              : routes.find(({ key }) => key !== recommendedRoute.key);
          if (recommendedRoute !== undefined && alternativeRoute === undefined) {
            throw new MarketingDay0Error({ reason: "incomplete_route_contract" });
          }

          const zeroDigest = MarketingEvidenceSha256.make("0".repeat(64));
          const evidenceSummary: MarketingDay0EvidenceSummary = {
            contextPacketSha256: evidenceContext.receipt.packetSha256,
            snapshotAsOf: evidenceContext.asOf,
            sources: evidenceContext.sources,
            selectedEvidence: evidenceContext.evidence,
            acceptedFacts: evidenceContext.acceptedFacts,
            assumptions: evidenceContext.assumptions,
            conflicts: evidenceContext.conflicts,
            gaps: evidenceContext.gaps,
            readiness: evidenceContext.readiness,
            unresolvedDecisions: evidenceContext.unresolvedDecisions,
            receipt: evidenceContext.receipt,
          };
          const buildPacket = (
            packetByteCount: number,
            packetSha256: MarketingEvidenceSha256,
          ): MarketingDay0OperatingPacket => ({
            format: MARKETING_DAY0_FORMAT,
            workspace: evidenceContext.workspace,
            asOf: evidenceContext.asOf,
            contextState: normalizedDraft.state,
            pointOfView:
              normalizedDraft.state === "useful-context"
                ? { state: "ready", ...normalizedDraft.pointOfView }
                : { state: "pending", reason: "contextless" },
            hypothesis:
              normalizedDraft.state === "useful-context"
                ? { state: "ready", ...normalizedDraft.hypothesis }
                : { state: "pending", reason: "contextless" },
            immediateActions:
              normalizedDraft.state === "useful-context" ? normalizedDraft.immediateActions : [],
            routeRecommendation:
              normalizedDraft.state === "useful-context" &&
              recommendedRoute !== undefined &&
              alternativeRoute !== undefined
                ? {
                    state: "recommended",
                    route: recommendedRoute,
                    rationale: normalizedDraft.routeRecommendation.rationale,
                    support: normalizedDraft.routeRecommendation.support,
                    alternative: alternativeRoute,
                    alternativeAvailability: "explicit-override-only",
                  }
                : { state: "pending", reason: "contextless", candidates: routes },
            routeCatalog: routeCatalog.binding,
            questions: selectedQuestions.included,
            evidence: evidenceSummary,
            routeReview: { state: "pending", required: true },
            activation: {
              state: "dormant",
              blockers: activationBlockers(
                normalizedDraft.state,
                evidenceContext.readiness,
                recommendedRoute,
              ),
            },
            receipt: {
              format: MARKETING_DAY0_FORMAT,
              policyRef: MARKETING_DAY0_POLICY_REF,
              compiledAsOf: evidenceContext.asOf,
              evidenceContextSha256: evidenceContext.receipt.packetSha256,
              evidenceReceiptSha256,
              routesSha256,
              inputSha256,
              contextState: normalizedDraft.state,
              questionInputCount: selectedQuestions.inputCount,
              questionIncludedKeys: selectedQuestions.included.map(({ key }) => key),
              questionExcludedKeys: selectedQuestions.excluded,
              packetByteCount,
              packetSha256,
            },
          });

          let packetByteCount = 0;
          let packetByteCountConverged = false;
          for (let attempt = 0; attempt < 16; attempt += 1) {
            const packet = decodePacket(buildPacket(packetByteCount, zeroDigest));
            const nextByteCount = Buffer.byteLength(
              canonicalJson(encodedJson(encodePacketJson, packet)),
              "utf8",
            );
            if (nextByteCount === packetByteCount) {
              packetByteCountConverged = true;
              break;
            }
            packetByteCount = nextByteCount;
          }
          if (!packetByteCountConverged) {
            throw new MarketingDay0Error({ reason: "invalid_day0_input" });
          }
          if (packetByteCount > MARKETING_DAY0_MAX_PACKET_BYTES) {
            throw new MarketingDay0Error({ reason: "output_budget_exceeded" });
          }
          const measured = decodePacket(buildPacket(packetByteCount, zeroDigest));
          const packetSha256 = sha256(canonicalJson(packetDigestJson(measured)));
          const finalPacket = decodePacket(buildPacket(packetByteCount, packetSha256));
          verifyDay0Packet(finalPacket);
          return finalPacket;
        },
        catch: (cause) =>
          isDay0Error(cause) ? cause : new MarketingDay0Error({ reason: "invalid_day0_input" }),
      }),
  );
}

/**
 * Produces only an unverified choice intent. A later adapter must re-read the canonical packet head,
 * bind actor/workspace/version/idempotency, save, and read back before review or activation.
 */
export function prepareUnverifiedMarketingDay0RouteChoice(
  rawInput: PrepareUnverifiedMarketingDay0RouteChoiceInput,
): Effect.Effect<MarketingDay0RouteChoiceIntent, MarketingDay0Error> {
  return Effect.try({
    try: () => {
      const packet = decodePacket(rawInput.packet);
      verifyDay0Packet(packet);
      if (packet.routeRecommendation.state !== "recommended") {
        throw new MarketingDay0Error({ reason: "route_not_registered" });
      }
      const decodedChoice = decodeChoice(rawInput.choice);
      const choice: MarketingDay0RouteChoice =
        decodedChoice.kind === "override"
          ? { kind: decodedChoice.kind, rationale: normalizeText(decodedChoice.rationale, true) }
          : decodedChoice;
      const selectedRoute =
        choice.kind === "accept"
          ? packet.routeRecommendation.route
          : packet.routeRecommendation.alternative;
      const laterAdapterRequirements = [
        MarketingEvidenceStateCode.make("trusted-current-packet-reference-required"),
        MarketingEvidenceStateCode.make("workspace-match-required"),
        MarketingEvidenceStateCode.make("expected-version-required"),
        MarketingEvidenceStateCode.make("idempotency-key-required"),
        MarketingEvidenceStateCode.make("verified-actor-review-required"),
        MarketingEvidenceStateCode.make("canonical-route-choice-save-required"),
        MarketingEvidenceStateCode.make("canonical-readback-required"),
        MarketingEvidenceStateCode.make("approved-route-catalog-snapshot-required"),
      ];
      const activation: MarketingDay0ActivationState = {
        state: "dormant",
        blockers: activationBlockers(
          packet.contextState,
          packet.evidence.readiness,
          selectedRoute,
        ).map((code) =>
          code === "route-review-pending"
            ? MarketingEvidenceStateCode.make("unverified-route-choice-intent")
            : code,
        ),
      };
      const inputSha256 = sha256(
        canonicalJson(
          decodeJson({
            packetSha256: packet.receipt.packetSha256,
            choice,
            selectedRoute,
            laterAdapterRequirements,
          }),
        ),
      );
      const zeroDigest = MarketingEvidenceSha256.make("0".repeat(64));
      const buildIntent = (
        intentSha256: MarketingEvidenceSha256,
      ): MarketingDay0RouteChoiceIntent => ({
        format: MARKETING_DAY0_ROUTE_CHOICE_INTENT_FORMAT,
        workspace: packet.workspace,
        packetSha256: packet.receipt.packetSha256,
        choice,
        selectedRoute,
        state: "unverified-pending-intent",
        laterAdapterRequirements,
        activation,
        receipt: { inputSha256, intentSha256 },
      });
      const measured = decodeChoiceIntent(buildIntent(zeroDigest));
      const measuredJson = encodedJson(encodeChoiceIntentJson, measured);
      if (
        measuredJson === null ||
        Array.isArray(measuredJson) ||
        typeof measuredJson !== "object"
      ) {
        throw new MarketingDay0Error({ reason: "invalid_day0_input" });
      }
      const measuredObject = measuredJson as { readonly [key: string]: Schema.Json };
      const receipt = measuredObject.receipt;
      if (receipt === null || Array.isArray(receipt) || typeof receipt !== "object") {
        throw new MarketingDay0Error({ reason: "invalid_day0_input" });
      }
      const receiptObject = receipt as { readonly [key: string]: Schema.Json };
      const { intentSha256: _intentSha256, ...receiptWithoutDigest } = receiptObject;
      const intentSha256 = sha256(
        canonicalJson({ ...measuredObject, receipt: receiptWithoutDigest }),
      );
      return decodeChoiceIntent(buildIntent(intentSha256));
    },
    catch: (cause) =>
      isDay0Error(cause) ? cause : new MarketingDay0Error({ reason: "invalid_day0_input" }),
  });
}
