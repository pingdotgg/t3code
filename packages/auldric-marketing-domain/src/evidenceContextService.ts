import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type MarketingCanonicalRecord,
  type MarketingCanonicalRegistryKey,
  MarketingCanonicalRegistryKey as MarketingCanonicalRegistryKeySchema,
  type MarketingCanonicalRevisionReference,
  MarketingCanonicalRevisionReference as MarketingCanonicalRevisionReferenceSchema,
  type MarketingCanonicalVersion,
  MarketingCanonicalVersion as MarketingCanonicalVersionSchema,
  type MarketingReviewRevisionReference,
  MarketingReviewRevisionReference as MarketingReviewRevisionReferenceSchema,
  type MarketingSourceLineageReference,
  MarketingSourceLineageReference as MarketingSourceLineageReferenceSchema,
  MarketingExpectedVersion,
} from "./canonical.ts";
import { compareCanonicalText } from "./canonicalSeal.ts";
import type {
  MarketingCanonicalStore,
  MarketingCanonicalStoreErrorType,
} from "./canonicalStore.ts";
import {
  MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA,
  MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA_KEY,
  MARKETING_EVIDENCE_SCHEMA_VERSION,
  MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA_KEY,
  MarketingEvidenceFactAcceptancePayload,
  MarketingEvidenceFactCanonicalKey,
  MarketingEvidenceSourceStatePayload,
} from "./evidenceCanonicalRegistry.ts";
import {
  compileMarketingEvidenceContext,
  DEFAULT_MARKETING_CONTEXT_BUDGET,
  MARKETING_EVIDENCE_MAX_CANDIDATES,
  MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST,
  MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST,
  type MarketingAcceptedFact,
  type MarketingContextBudget,
  MarketingContextBudget as MarketingContextBudgetSchema,
  type MarketingDecisionChangingQuestion,
  type MarketingDisconfirmationSignal,
  type MarketingEvidenceAssumption,
  type MarketingEvidenceConflict,
  type MarketingEvidenceContextPacket,
  type MarketingEvidenceFactValue,
  type MarketingEvidencePlanReference,
  MarketingEvidencePlanReference as MarketingEvidencePlanReferenceSchema,
  type MarketingEvidencePlanSelection,
  type MarketingEvidenceRetrievalQuery,
  MarketingEvidenceRetrievalQuery as MarketingEvidenceRetrievalQuerySchema,
  type MarketingEvidenceSha256,
  MarketingEvidenceSha256 as MarketingEvidenceSha256Schema,
  MarketingEvidenceStableKey,
  type MarketingSystemEvidenceGap,
  type MarketingUserEvidenceGap,
  type MarketingRetrievedEvidence,
  MarketingRetrievedEvidence as MarketingRetrievedEvidenceSchema,
  type MarketingSourceObservation,
  type MarketingUnresolvedDecision,
} from "./evidenceContext.ts";
import {
  type MarketingEvidenceContextError,
  MarketingEvidenceSafeReference,
  MarketingEvidenceServiceError,
  MarketingEvidenceSourceAdapterError,
} from "./evidenceContextErrors.ts";
import {
  MarketingDecisionId,
  type MarketingIdempotencyKey,
  type MarketingWorkspaceSelection,
} from "./identity.ts";

export { MarketingEvidenceRetrievalQuery } from "./evidenceContext.ts";

export interface MarketingEvidenceSourceAdapter<RequestAuthority> {
  readonly key: MarketingCanonicalRegistryKey;
  readonly version: MarketingCanonicalVersion;
  readonly configurationSha256: MarketingEvidenceSha256;
  readonly retrieve: (input: {
    readonly requestAuthority: RequestAuthority;
    readonly selection: MarketingWorkspaceSelection;
    readonly source: MarketingSourceObservation;
    readonly query: MarketingEvidenceRetrievalQuery;
    readonly asOf: DateTime.Utc;
    readonly limits: {
      readonly maxItems: number;
      readonly maxBytes: number;
    };
  }) => Effect.Effect<
    ReadonlyArray<MarketingRetrievedEvidence>,
    MarketingEvidenceSourceAdapterError
  >;
}

export interface MarketingEvidenceContextServiceConfig<RequestAuthority> {
  readonly canonicalStore: MarketingCanonicalStore<RequestAuthority>;
  readonly sourceAdapters: ReadonlyArray<MarketingEvidenceSourceAdapter<RequestAuthority>>;
}

export type MarketingEvidenceContextServiceError =
  | MarketingCanonicalStoreErrorType
  | MarketingEvidenceContextError
  | MarketingEvidenceServiceError;

export interface InspectMarketingEvidenceSourcesInput<RequestAuthority> {
  readonly requestAuthority: RequestAuthority;
  readonly selection: MarketingWorkspaceSelection;
  readonly sourceAllowlist: ReadonlyArray<MarketingSourceLineageReference>;
}

export interface CompileMarketingEvidenceServiceInput<
  RequestAuthority,
> extends InspectMarketingEvidenceSourcesInput<RequestAuthority> {
  readonly acceptedFactKeys: ReadonlyArray<MarketingEvidenceStableKey>;
  readonly query: MarketingEvidenceRetrievalQuery;
  readonly plan?: MarketingEvidencePlanReference;
  readonly budget?: MarketingContextBudget;
  readonly assumptions?: ReadonlyArray<MarketingEvidenceAssumption>;
  readonly conflicts?: ReadonlyArray<MarketingEvidenceConflict>;
  readonly gaps?: ReadonlyArray<MarketingUserEvidenceGap>;
  readonly questions?: ReadonlyArray<MarketingDecisionChangingQuestion>;
  readonly disconfirmationSignals?: ReadonlyArray<MarketingDisconfirmationSignal>;
  readonly unresolvedDecisions?: ReadonlyArray<MarketingUnresolvedDecision>;
}

interface FactWriteFields<RequestAuthority> {
  readonly requestAuthority: RequestAuthority;
  readonly selection: MarketingWorkspaceSelection;
  readonly stableKey: MarketingEvidenceStableKey;
  readonly decisionId: MarketingDecisionId;
  readonly idempotencyKey: MarketingIdempotencyKey;
  readonly reviewReferences?: ReadonlyArray<MarketingReviewRevisionReference>;
}

export interface AcceptMarketingEvidenceFactInput<
  RequestAuthority,
> extends FactWriteFields<RequestAuthority> {
  readonly claim: string;
  readonly value: MarketingEvidenceFactValue;
  readonly sourceLineage: ReadonlyArray<MarketingSourceLineageReference>;
}

export interface SupersedeMarketingEvidenceFactInput<
  RequestAuthority,
> extends AcceptMarketingEvidenceFactInput<RequestAuthority> {
  readonly expectedVersion: number;
  readonly supersedes: MarketingCanonicalRevisionReference;
}

export interface WithdrawMarketingEvidenceFactInput<
  RequestAuthority,
> extends FactWriteFields<RequestAuthority> {
  readonly expectedVersion: number;
  readonly supersedes: MarketingCanonicalRevisionReference;
}

export interface MarketingEvidenceContextService<RequestAuthority> {
  readonly inspectSources: (
    input: InspectMarketingEvidenceSourcesInput<RequestAuthority>,
  ) => Effect.Effect<
    { readonly asOf: DateTime.Utc; readonly sources: ReadonlyArray<MarketingSourceObservation> },
    MarketingEvidenceContextServiceError
  >;
  readonly compileContext: (
    input: CompileMarketingEvidenceServiceInput<RequestAuthority>,
  ) => Effect.Effect<MarketingEvidenceContextPacket, MarketingEvidenceContextServiceError>;
  readonly acceptFact: (
    input: AcceptMarketingEvidenceFactInput<RequestAuthority>,
  ) => Effect.Effect<MarketingAcceptedFact, MarketingEvidenceContextServiceError>;
  readonly supersedeFact: (
    input: SupersedeMarketingEvidenceFactInput<RequestAuthority>,
  ) => Effect.Effect<MarketingAcceptedFact, MarketingEvidenceContextServiceError>;
  readonly withdrawFact: (
    input: WithdrawMarketingEvidenceFactInput<RequestAuthority>,
  ) => Effect.Effect<MarketingCanonicalRecord, MarketingEvidenceContextServiceError>;
}

const decodeSourceAllowlist = Schema.decodeUnknownSync(
  Schema.Array(MarketingSourceLineageReferenceSchema).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_SOURCE_ALLOWLIST),
  ),
);
const decodeFactKeys = Schema.decodeUnknownSync(
  Schema.Array(MarketingEvidenceStableKey).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_FACT_ALLOWLIST),
  ),
);
const decodeQuery = Schema.decodeUnknownSync(MarketingEvidenceRetrievalQuerySchema);
const decodePlanReference = Schema.decodeUnknownSync(MarketingEvidencePlanReferenceSchema);
const decodeBudget = Schema.decodeUnknownSync(MarketingContextBudgetSchema);
const decodeExpectedVersion = Schema.decodeUnknownSync(MarketingExpectedVersion);
const decodeRevisionReference = Schema.decodeUnknownSync(MarketingCanonicalRevisionReferenceSchema);
const decodeSourceReferences = Schema.decodeUnknownSync(
  Schema.Array(MarketingSourceLineageReferenceSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
);
const decodeReviewReferences = Schema.decodeUnknownSync(
  Schema.Array(MarketingReviewRevisionReferenceSchema).check(Schema.isMaxLength(16)),
);
const decodeSourcePayload = Schema.decodeUnknownSync(MarketingEvidenceSourceStatePayload);
const decodeFactPayload = Schema.decodeUnknownSync(MarketingEvidenceFactAcceptancePayload);
const decodeRetrievedEvidence = Schema.decodeUnknownSync(
  Schema.Array(MarketingRetrievedEvidenceSchema).check(
    Schema.isMaxLength(MARKETING_EVIDENCE_MAX_CANDIDATES),
  ),
);
const decodeStableKey = Schema.decodeUnknownSync(MarketingEvidenceStableKey);
const decodeDecisionId = Schema.decodeUnknownSync(MarketingDecisionId);
const decodeSafeReference = Schema.decodeUnknownSync(MarketingEvidenceSafeReference);
const isAdapterKey = Schema.is(MarketingCanonicalRegistryKeySchema);
const isSafeReference = Schema.is(MarketingEvidenceSafeReference);

function failure(
  reason: MarketingEvidenceServiceError["reason"],
  reference?: string,
): MarketingEvidenceServiceError {
  const safe =
    reference === undefined
      ? undefined
      : isSafeReference(reference)
        ? MarketingEvidenceSafeReference.make(reference)
        : safeReference("redacted-reference");
  return new MarketingEvidenceServiceError({
    reason,
    ...(safe === undefined ? {} : { reference: safe }),
  });
}

function decodeServiceInput<A>(
  decode: () => A,
  reference: string,
): Effect.Effect<A, MarketingEvidenceServiceError> {
  return Effect.try({
    try: decode,
    catch: () => failure("invalid_service_input", reference),
  });
}

function safeReference(value: string): MarketingEvidenceSafeReference {
  return decodeSafeReference(value);
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
}

function candidateByteLength(candidate: MarketingRetrievedEvidence): number {
  return Buffer.byteLength(
    JSON.stringify({
      source: {
        sourceId: candidate.source.sourceId,
        revisionId: candidate.source.revision.revisionId,
        version: candidate.source.revision.version,
      },
      locator: normalizeText(candidate.locator),
      excerpt: normalizeText(candidate.excerpt),
      excerptSha256: candidate.excerptSha256,
      contentSha256: candidate.contentSha256,
      observedAt: DateTime.formatIso(candidate.observedAt),
      quality: candidate.quality,
      relation: candidate.relation,
      required: candidate.required,
      decisionImpact: candidate.decisionImpact,
      relevance: candidate.relevance,
    }),
    "utf8",
  );
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

function sameSourceReferences(
  left: ReadonlyArray<MarketingSourceLineageReference>,
  right: ReadonlyArray<MarketingSourceLineageReference>,
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        reference.sourceId === candidate.sourceId &&
        sameRevision(reference.revision, candidate.revision)
      );
    })
  );
}

function sameReviewReferences(
  left: ReadonlyArray<MarketingReviewRevisionReference>,
  right: ReadonlyArray<MarketingReviewRevisionReference>,
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        reference.reviewId === candidate.reviewId &&
        sameRevision(reference.revision, candidate.revision)
      );
    })
  );
}

function sameRevision(
  left: MarketingCanonicalRevisionReference,
  right: MarketingCanonicalRevisionReference,
): boolean {
  return left.revisionId === right.revisionId && left.version === right.version;
}

function recordRevision(record: MarketingCanonicalRecord): MarketingCanonicalRevisionReference {
  return { revisionId: record.revisionId, version: record.version };
}

function sourceStateReason(
  source: MarketingSourceObservation,
): "inaccessible" | "unindexed" | "stale-policy" | undefined {
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

function sourceGap(
  source: MarketingSourceObservation,
  reason: "inaccessible" | "unindexed" | "stale-policy",
): MarketingSystemEvidenceGap {
  const suffix = source.source.sourceId.toLowerCase().replaceAll("_", "-");
  const summaries = {
    inaccessible: "An allowlisted source is unavailable or not currently authorized.",
    unindexed: "An allowlisted source is not ready for bounded retrieval.",
    "stale-policy": "An allowlisted source is outside the current-freshness policy.",
  } as const;
  return {
    namespace: "system",
    category: "source-state",
    key: MarketingEvidenceStableKey.make(`source-${suffix}-${reason}`),
    summary: summaries[reason],
    blocks: false,
  };
}

function adapterFailureGap(source: MarketingSourceObservation): MarketingSystemEvidenceGap {
  const suffix = source.source.sourceId.toLowerCase().replaceAll("_", "-");
  return {
    namespace: "system",
    category: "source-retrieval",
    key: MarketingEvidenceStableKey.make(`source-${suffix}-retrieval-failed`),
    summary: "An authorized source could not be retrieved for this evidence snapshot.",
    blocks: false,
  };
}

const validateSourceRecord = Effect.fn("MarketingEvidenceContextService.validateSourceRecord")(
  function* (record: MarketingCanonicalRecord, exact: MarketingSourceLineageReference) {
    if (
      record.object.kind !== "source" ||
      record.object.id !== exact.sourceId ||
      !sameRevision(recordRevision(record), exact.revision) ||
      record.schema.key !== MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA_KEY ||
      record.schema.version !== MARKETING_EVIDENCE_SCHEMA_VERSION
    ) {
      return yield* failure("source_record_invalid", exact.sourceId);
    }
    const payload = yield* decodeServiceInput(
      () => decodeSourcePayload(record.payload),
      `source:${exact.sourceId}`,
    );
    return {
      source: exact,
      adapterKey: payload.adapterKey,
      capability: payload.capability,
      access: payload.access,
      import: payload.import,
      index: payload.index,
      freshness: payload.freshness,
      observedAt: payload.observedAt,
    };
  },
);

const parseFactRecord = Effect.fn("MarketingEvidenceContextService.parseFactRecord")(function* (
  record: MarketingCanonicalRecord,
  stableKey: MarketingEvidenceStableKey,
  sourceHeads: ReadonlyMap<string, MarketingCanonicalRevisionReference>,
) {
  if (
    record.object.kind !== "decision" ||
    record.canonicalKey !== MarketingEvidenceFactCanonicalKey(stableKey) ||
    record.schema.key !== MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA_KEY ||
    record.schema.version !== MARKETING_EVIDENCE_SCHEMA_VERSION
  ) {
    return yield* failure("fact_record_invalid", stableKey);
  }
  const payload = yield* decodeServiceInput(
    () => decodeFactPayload(record.payload),
    `fact:${stableKey}`,
  );
  if (payload.status === "withdrawn") {
    return { withdrawn: true, decisionId: record.object.id };
  }

  let supportState: MarketingAcceptedFact["supportState"] = "current";
  for (const support of record.sourceLineage) {
    const head = sourceHeads.get(support.sourceId);
    if (head === undefined) {
      supportState = "unavailable";
      break;
    }
    if (!sameRevision(head, support.revision)) supportState = "stale";
  }
  return {
    withdrawn: false,
    decisionId: record.object.id,
    fact: {
      stableKey,
      decisionId: record.object.id,
      revision: recordRevision(record),
      claim: payload.claim,
      value: payload.value,
      support: record.sourceLineage,
      reviews: record.reviewReferences,
      supportState,
    },
  };
});

export function makeMarketingEvidenceContextService<RequestAuthority>(
  config: MarketingEvidenceContextServiceConfig<RequestAuthority>,
): MarketingEvidenceContextService<RequestAuthority> {
  const adapters = new Map<
    MarketingCanonicalRegistryKey,
    MarketingEvidenceSourceAdapter<RequestAuthority>
  >();
  const isAdapterVersion = Schema.is(MarketingCanonicalVersionSchema);
  const isConfigurationDigest = Schema.is(MarketingEvidenceSha256Schema);
  for (const adapter of config.sourceAdapters) {
    if (
      !isAdapterKey(adapter.key) ||
      !isAdapterVersion(adapter.version) ||
      !isConfigurationDigest(adapter.configurationSha256)
    ) {
      throw new Error("Invalid evidence source adapter registration");
    }
    if (adapters.has(adapter.key)) {
      throw new Error("Duplicate evidence source adapter registration");
    }
    adapters.set(adapter.key, adapter);
  }

  const loadSources = Effect.fn("MarketingEvidenceContextService.loadSources")(function* (
    input: InspectMarketingEvidenceSourcesInput<RequestAuthority>,
    asOf: DateTime.Utc,
  ) {
    const sourceAllowlist = yield* decodeServiceInput(
      () => decodeSourceAllowlist(input.sourceAllowlist),
      "source-allowlist",
    );
    const unique = new Set(
      sourceAllowlist.map(
        (source) => `${source.sourceId}:${source.revision.revisionId}:${source.revision.version}`,
      ),
    );
    if (unique.size !== sourceAllowlist.length) {
      return yield* failure("invalid_service_input", "duplicate-source-allowlist-entry");
    }

    const sources: MarketingSourceObservation[] = [];
    for (const exact of sourceAllowlist) {
      const record = yield* config.canonicalStore.read({
        requestAuthority: input.requestAuthority,
        selection: input.selection,
        object: { kind: "source", id: exact.sourceId },
      });
      if (!sameRevision(recordRevision(record), exact.revision)) {
        return yield* failure("canonical_snapshot_changed", exact.sourceId);
      }
      const source = yield* validateSourceRecord(record, exact);
      if (sourceTimestampAfterSnapshot(source, asOf)) {
        return yield* failure("source_record_invalid", exact.sourceId);
      }
      sources.push(source);
    }
    return { sourceAllowlist, sources };
  });

  const verifySourceHeads = Effect.fn("MarketingEvidenceContextService.verifySourceHeads")(
    function* (
      input: InspectMarketingEvidenceSourcesInput<RequestAuthority>,
      sourceAllowlist: ReadonlyArray<MarketingSourceLineageReference>,
    ) {
      for (const source of sourceAllowlist) {
        const record = yield* config.canonicalStore.read({
          requestAuthority: input.requestAuthority,
          selection: input.selection,
          object: { kind: "source", id: source.sourceId },
        });
        if (!sameRevision(recordRevision(record), source.revision)) {
          return yield* failure("canonical_snapshot_changed", source.sourceId);
        }
      }
    },
  );

  const inspectSources: MarketingEvidenceContextService<RequestAuthority>["inspectSources"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const asOf = yield* DateTime.now;
      const loaded = yield* loadSources(input, asOf);
      yield* verifySourceHeads(input, loaded.sourceAllowlist);
      return { asOf, sources: loaded.sources };
    });

  const compileContext: MarketingEvidenceContextService<RequestAuthority>["compileContext"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const factKeys = yield* decodeServiceInput(
        () => decodeFactKeys(input.acceptedFactKeys),
        "accepted-fact-keys",
      );
      if (new Set(factKeys).size !== factKeys.length) {
        return yield* failure("invalid_service_input", "duplicate-accepted-fact-key");
      }
      const decodedQuery = yield* decodeServiceInput(
        () => decodeQuery(input.query),
        "retrieval-query",
      );
      const query = yield* decodeServiceInput(
        () =>
          decodeQuery({
            purpose: normalizeText(decodedQuery.purpose),
            terms: [...new Set(decodedQuery.terms.map(normalizeText))].sort(compareCanonicalText),
          }),
        "normalized-retrieval-query",
      );
      const budget = yield* decodeServiceInput(
        () => decodeBudget(input.budget ?? DEFAULT_MARKETING_CONTEXT_BUDGET),
        "context-budget",
      );
      const asOf = yield* DateTime.now;
      const loaded = yield* loadSources(input, asOf);
      const sourceHeads = new Map<string, MarketingCanonicalRevisionReference>(
        loaded.sourceAllowlist.map((source) => [source.sourceId, source.revision] as const),
      );

      let planRecord: MarketingCanonicalRecord | undefined;
      let plan: MarketingEvidencePlanSelection | undefined;
      if (input.plan !== undefined) {
        const reference = yield* decodeServiceInput(
          () => decodePlanReference(input.plan),
          "plan-selection",
        );
        const record = yield* config.canonicalStore.read({
          requestAuthority: input.requestAuthority,
          selection: input.selection,
          object: { kind: "plan", id: reference.planId },
        });
        if (
          record.object.kind !== "plan" ||
          record.object.id !== reference.planId ||
          !sameRevision(recordRevision(record), reference.revision)
        ) {
          return yield* failure("canonical_snapshot_changed", reference.planId);
        }
        planRecord = record;
        plan = { ...reference, stageSemantics: "not-evaluated" };
      }

      const acceptedFacts: MarketingAcceptedFact[] = [];
      const selectedFactHeads = new Map<
        MarketingEvidenceStableKey,
        MarketingCanonicalRecord | undefined
      >();
      const sourceExclusions: Array<{
        source: MarketingSourceLineageReference;
        reason: "inaccessible" | "unindexed" | "stale-policy";
      }> = [];
      const supersededFacts: Array<{
        stableKey: MarketingEvidenceStableKey;
        decisionId: MarketingDecisionId;
        revision: MarketingCanonicalRevisionReference;
      }> = [];
      const automaticGaps: MarketingSystemEvidenceGap[] = [];
      if (plan === undefined) {
        automaticGaps.push({
          namespace: "system",
          category: "plan-selection",
          key: MarketingEvidenceStableKey.make("missing-plan"),
          summary: "No exact canonical Marketing plan was selected for this context snapshot.",
          blocks: false,
        });
      }

      for (const stableKey of factKeys) {
        const record = yield* config.canonicalStore.findByCanonicalKey({
          requestAuthority: input.requestAuthority,
          selection: input.selection,
          canonicalKey: MarketingEvidenceFactCanonicalKey(stableKey),
        });
        selectedFactHeads.set(stableKey, record);
        if (record === undefined) {
          automaticGaps.push({
            namespace: "system",
            category: "accepted-fact",
            key: stableKey,
            summary: "A requested accepted fact does not exist in the canonical workspace.",
            blocks: true,
          });
          continue;
        }
        const parsed = yield* parseFactRecord(record, stableKey, sourceHeads);
        if (parsed.fact !== undefined) acceptedFacts.push(parsed.fact);
        if (parsed.withdrawn) {
          supersededFacts.push({
            stableKey,
            decisionId: parsed.decisionId,
            revision: recordRevision(record),
          });
        }
      }

      const candidates: MarketingRetrievedEvidence[] = [];
      const adapterProvenance: Array<{
        source: MarketingSourceLineageReference;
        adapterKey: MarketingCanonicalRegistryKey;
        adapterVersion: MarketingCanonicalVersion;
        configurationSha256: MarketingEvidenceSha256;
      }> = [];
      const activeSourceCount = Math.max(
        1,
        loaded.sources.filter((source) => sourceStateReason(source) === undefined).length,
      );
      const maxItemsPerAdapter = Math.max(
        1,
        Math.min(
          budget.maxPerSource,
          Math.floor(MARKETING_EVIDENCE_MAX_CANDIDATES / activeSourceCount),
        ),
      );
      const maxBytesPerAdapter = Math.max(
        1,
        Math.floor(budget.maxCandidateBytes / activeSourceCount),
      );

      for (const source of loaded.sources) {
        const stateReason = sourceStateReason(source);
        if (stateReason !== undefined) {
          sourceExclusions.push({ source: source.source, reason: stateReason });
          automaticGaps.push(sourceGap(source, stateReason));
          continue;
        }
        const adapter = adapters.get(source.adapterKey);
        if (adapter === undefined) {
          return yield* failure("adapter_not_registered", "adapter-registration");
        }
        adapterProvenance.push({
          source: source.source,
          adapterKey: adapter.key,
          adapterVersion: adapter.version,
          configurationSha256: adapter.configurationSha256,
        });
        const retrieved = yield* Effect.result(
          adapter.retrieve({
            requestAuthority: input.requestAuthority,
            selection: input.selection,
            source,
            query,
            asOf,
            limits: { maxItems: maxItemsPerAdapter, maxBytes: maxBytesPerAdapter },
          }),
        );
        if (retrieved._tag === "Failure") {
          sourceExclusions.push({ source: source.source, reason: "inaccessible" });
          automaticGaps.push(adapterFailureGap(source));
          continue;
        }
        const adapterCandidates = yield* Effect.try({
          try: () => decodeRetrievedEvidence(retrieved.success),
          catch: () => failure("adapter_output_invalid", "adapter-output"),
        });
        if (
          adapterCandidates.length > maxItemsPerAdapter ||
          adapterCandidates.reduce(
            (total, candidate) => total + candidateByteLength(candidate),
            0,
          ) > maxBytesPerAdapter
        ) {
          return yield* failure("adapter_bounds_exceeded", "adapter-bounds");
        }
        for (const candidate of adapterCandidates) {
          if (
            !sameRevision(candidate.source.revision, source.source.revision) ||
            candidate.source.sourceId !== source.source.sourceId
          ) {
            return yield* failure("adapter_source_mismatch", "adapter-source");
          }
          if (candidate.observedAt.epochMilliseconds > asOf.epochMilliseconds) {
            return yield* failure("adapter_output_invalid", "adapter-timestamp");
          }
          candidates.push(candidate);
        }
      }

      yield* verifySourceHeads(input, loaded.sourceAllowlist);
      if (planRecord !== undefined) {
        const endingPlan = yield* config.canonicalStore.read({
          requestAuthority: input.requestAuthority,
          selection: input.selection,
          object: planRecord.object,
        });
        if (!sameRevision(recordRevision(endingPlan), recordRevision(planRecord))) {
          return yield* failure("canonical_snapshot_changed", planRecord.object.id);
        }
      }
      for (const [stableKey, initial] of selectedFactHeads) {
        const ending = yield* config.canonicalStore.findByCanonicalKey({
          requestAuthority: input.requestAuthority,
          selection: input.selection,
          canonicalKey: MarketingEvidenceFactCanonicalKey(stableKey),
        });
        if (
          (initial === undefined && ending !== undefined) ||
          (initial !== undefined &&
            (ending === undefined ||
              initial.object.kind !== ending.object.kind ||
              initial.object.id !== ending.object.id ||
              !sameRevision(recordRevision(initial), recordRevision(ending))))
        ) {
          return yield* failure("canonical_snapshot_changed", stableKey);
        }
      }

      return yield* compileMarketingEvidenceContext({
        workspace: input.selection,
        asOf,
        ...(plan === undefined ? {} : { plan }),
        retrievalQuery: query,
        adapterProvenance,
        sourceAllowlist: loaded.sourceAllowlist,
        sources: loaded.sources,
        candidates,
        acceptedFacts,
        ...(input.assumptions === undefined ? {} : { assumptions: input.assumptions }),
        ...(input.conflicts === undefined ? {} : { conflicts: input.conflicts }),
        ...(input.gaps === undefined ? {} : { gaps: input.gaps }),
        systemGaps: automaticGaps,
        ...(input.questions === undefined ? {} : { questions: input.questions }),
        ...(input.disconfirmationSignals === undefined
          ? {}
          : { disconfirmationSignals: input.disconfirmationSignals }),
        readiness: { state: "not-evaluated" },
        ...(input.unresolvedDecisions === undefined
          ? {}
          : { unresolvedDecisions: input.unresolvedDecisions }),
        budget,
        sourceExclusions,
        supersededFacts,
      });
    });

  const readFactRevision = Effect.fn("MarketingEvidenceContextService.readFactRevision")(function* (
    input: FactWriteFields<RequestAuthority>,
    exact: MarketingCanonicalRevisionReference,
  ) {
    const stableKey = yield* decodeServiceInput(
      () => decodeStableKey(input.stableKey),
      "fact-stable-key",
    );
    const decisionId = yield* decodeServiceInput(
      () => decodeDecisionId(input.decisionId),
      "fact-decision-id",
    );
    const record = yield* config.canonicalStore.readRevision({
      requestAuthority: input.requestAuthority,
      selection: input.selection,
      object: { kind: "decision", id: decisionId },
      revision: exact,
    });
    if (
      record.canonicalKey !== MarketingEvidenceFactCanonicalKey(stableKey) ||
      record.schema.key !== MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA_KEY ||
      record.schema.version !== MARKETING_EVIDENCE_SCHEMA_VERSION
    ) {
      return yield* failure("fact_record_invalid", stableKey);
    }
    const payload = yield* decodeServiceInput(
      () => decodeFactPayload(record.payload),
      `fact:${stableKey}`,
    );
    return { stableKey, decisionId, record, payload };
  });

  const writeAcceptedFact = Effect.fn("MarketingEvidenceContextService.writeAcceptedFact")(
    function* (
      input: AcceptMarketingEvidenceFactInput<RequestAuthority> & {
        readonly expectedVersion: number;
        readonly supersedes?: MarketingCanonicalRevisionReference;
      },
    ) {
      const stableKey = yield* decodeServiceInput(
        () => decodeStableKey(input.stableKey),
        "fact-stable-key",
      );
      const decisionId = yield* decodeServiceInput(
        () => decodeDecisionId(input.decisionId),
        "fact-decision-id",
      );
      const expectedVersion = yield* decodeServiceInput(
        () => decodeExpectedVersion(input.expectedVersion),
        "fact-expected-version",
      );
      const sourceLineage = yield* decodeServiceInput(
        () => decodeSourceReferences(input.sourceLineage),
        "fact-source-lineage",
      );
      if (new Set(sourceLineage.map(({ sourceId }) => sourceId)).size !== sourceLineage.length) {
        return yield* failure("invalid_service_input", "duplicate-fact-support");
      }
      const reviewReferences = yield* decodeServiceInput(
        () => decodeReviewReferences(input.reviewReferences ?? []),
        "fact-review-references",
      );
      const supersedes =
        input.supersedes === undefined
          ? undefined
          : yield* decodeServiceInput(
              () => decodeRevisionReference(input.supersedes),
              "fact-supersedes",
            );
      const payload = yield* decodeServiceInput(
        () =>
          decodeFactPayload({
            claim: normalizeText(input.claim),
            value: input.value,
            status: "accepted",
            ...(supersedes === undefined ? {} : { supersedes }),
          }),
        "fact-payload",
      );
      const record = yield* config.canonicalStore.write({
        requestAuthority: input.requestAuthority,
        selection: input.selection,
        object: { kind: "decision", id: decisionId },
        canonicalKey: MarketingEvidenceFactCanonicalKey(stableKey),
        expectedVersion,
        idempotencyKey: input.idempotencyKey,
        schema: MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA,
        payload,
        sourceLineage,
        reviewReferences,
        decisionReferences: supersedes === undefined ? [] : [{ decisionId, revision: supersedes }],
      });
      const storedPayload = yield* decodeServiceInput(
        () => decodeFactPayload(record.payload),
        `fact:${stableKey}`,
      );
      if (
        storedPayload.status !== "accepted" ||
        storedPayload.claim !== payload.claim ||
        record.version !== expectedVersion + 1 ||
        !sameSourceReferences(record.sourceLineage, sourceLineage) ||
        !sameReviewReferences(record.reviewReferences, reviewReferences) ||
        (supersedes === undefined
          ? storedPayload.supersedes !== undefined || record.decisionReferences.length !== 0
          : storedPayload.supersedes === undefined ||
            !sameRevision(storedPayload.supersedes, supersedes) ||
            record.decisionReferences.length !== 1 ||
            record.decisionReferences[0]?.decisionId !== decisionId ||
            !sameRevision(record.decisionReferences[0].revision, supersedes))
      ) {
        return yield* failure("canonical_readback_mismatch", stableKey);
      }
      const sourceHeads = new Map<string, MarketingCanonicalRevisionReference>();
      for (const support of sourceLineage) {
        const head = yield* config.canonicalStore.read({
          requestAuthority: input.requestAuthority,
          selection: input.selection,
          object: { kind: "source", id: support.sourceId },
        });
        sourceHeads.set(support.sourceId, recordRevision(head));
      }
      const parsed = yield* parseFactRecord(record, stableKey, sourceHeads);
      if (parsed.fact === undefined) {
        return yield* failure("canonical_readback_mismatch", stableKey);
      }
      return parsed.fact;
    },
  );

  const acceptFact: MarketingEvidenceContextService<RequestAuthority>["acceptFact"] = (input) =>
    writeAcceptedFact({ ...input, expectedVersion: 0 });

  const supersedeFact: MarketingEvidenceContextService<RequestAuthority>["supersedeFact"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const expectedVersion = yield* decodeServiceInput(
        () => decodeExpectedVersion(input.expectedVersion),
        "fact-expected-version",
      );
      const supersedes = yield* decodeServiceInput(
        () => decodeRevisionReference(input.supersedes),
        "fact-supersedes",
      );
      const prior = yield* readFactRevision(input, supersedes);
      if (expectedVersion === 0 || Number(supersedes.version) !== Number(expectedVersion)) {
        return yield* failure("fact_transition_invalid", prior.stableKey);
      }
      return yield* writeAcceptedFact({ ...input, expectedVersion, supersedes });
    });

  const withdrawFact: MarketingEvidenceContextService<RequestAuthority>["withdrawFact"] = (input) =>
    Effect.gen(function* () {
      const expectedVersion = yield* decodeServiceInput(
        () => decodeExpectedVersion(input.expectedVersion),
        "fact-expected-version",
      );
      const supersedes = yield* decodeServiceInput(
        () => decodeRevisionReference(input.supersedes),
        "fact-supersedes",
      );
      const prior = yield* readFactRevision(input, supersedes);
      if (
        expectedVersion === 0 ||
        Number(supersedes.version) !== Number(expectedVersion) ||
        prior.payload.status !== "accepted"
      ) {
        return yield* failure("fact_transition_invalid", prior.stableKey);
      }
      const reviewReferences = yield* decodeServiceInput(
        () => decodeReviewReferences(input.reviewReferences ?? prior.record.reviewReferences),
        "fact-review-references",
      );
      const record = yield* config.canonicalStore.write({
        requestAuthority: input.requestAuthority,
        selection: input.selection,
        object: { kind: "decision", id: prior.decisionId },
        canonicalKey: MarketingEvidenceFactCanonicalKey(prior.stableKey),
        expectedVersion,
        idempotencyKey: input.idempotencyKey,
        schema: MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA,
        payload: {
          claim: prior.payload.claim,
          value: prior.payload.value,
          status: "withdrawn",
          supersedes,
        },
        sourceLineage: prior.record.sourceLineage,
        reviewReferences,
        decisionReferences: [{ decisionId: prior.decisionId, revision: supersedes }],
      });
      const payload = yield* decodeServiceInput(
        () => decodeFactPayload(record.payload),
        `fact:${prior.stableKey}`,
      );
      if (
        payload.status !== "withdrawn" ||
        !sameRevision(payload.supersedes, supersedes) ||
        record.version !== expectedVersion + 1 ||
        record.object.kind !== "decision" ||
        record.object.id !== prior.decisionId ||
        record.canonicalKey !== MarketingEvidenceFactCanonicalKey(prior.stableKey) ||
        !sameSourceReferences(record.sourceLineage, prior.record.sourceLineage) ||
        !sameReviewReferences(record.reviewReferences, reviewReferences) ||
        record.decisionReferences.length !== 1 ||
        record.decisionReferences[0]?.decisionId !== prior.decisionId ||
        !sameRevision(record.decisionReferences[0].revision, supersedes)
      ) {
        return yield* failure("canonical_readback_mismatch", prior.stableKey);
      }
      return record;
    });

  return { inspectSources, compileContext, acceptFact, supersedeFact, withdrawFact };
}
