import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MarketingCanonicalFactKey,
  type MarketingCanonicalJson,
  MarketingCanonicalKey,
  type MarketingCanonicalObjectKind,
  MarketingCanonicalRegistryKey,
  MarketingCanonicalVersion,
  type MarketingCanonicalProjectionFact,
  type MarketingCanonicalSchemaReference,
  MarketingCanonicalRevisionReference,
} from "./canonical.ts";
import { compareCanonicalText } from "./canonicalSeal.ts";
import { MarketingCanonicalValidationError } from "./canonicalErrors.ts";
import type {
  MarketingCanonicalRegistry,
  MarketingCanonicalRegistryWriteContext,
} from "./canonicalStore.ts";
import {
  MarketingEvidenceFactValue,
  MarketingEvidenceStateCode,
  MarketingEvidenceStableKey,
  MarketingSourceAccessState,
  MarketingSourceCapabilityState,
} from "./evidenceContext.ts";

export const MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA_KEY =
  MarketingCanonicalRegistryKey.make("evidence/source-state");
export const MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA_KEY = MarketingCanonicalRegistryKey.make(
  "evidence.fact-acceptance",
);
export const MARKETING_EVIDENCE_SCHEMA_VERSION = MarketingCanonicalVersion.make(1);

export const MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA: MarketingCanonicalSchemaReference = {
  key: MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA_KEY,
  version: MARKETING_EVIDENCE_SCHEMA_VERSION,
};

export const MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA: MarketingCanonicalSchemaReference = {
  key: MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA_KEY,
  version: MARKETING_EVIDENCE_SCHEMA_VERSION,
};

const MarketingSourceImportPayloadState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("imported"), importedAt: Schema.DateTimeUtcFromString }),
  Schema.Struct({ state: Schema.Literal("not-imported") }),
  Schema.Struct({ state: Schema.Literal("not-required") }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    code: MarketingEvidenceStateCode,
  }),
]);

const MarketingSourceIndexPayloadState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("indexed"), indexedAt: Schema.DateTimeUtcFromString }),
  Schema.Struct({ state: Schema.Literal("not-indexed") }),
  Schema.Struct({ state: Schema.Literal("indexing") }),
  Schema.Struct({ state: Schema.Literal("not-required") }),
  Schema.Struct({
    state: Schema.Literal("stale"),
    indexedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    code: MarketingEvidenceStateCode,
  }),
]);

const MarketingSourceFreshnessPayloadState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("current"), checkedAt: Schema.DateTimeUtcFromString }),
  Schema.Struct({ state: Schema.Literal("stale"), checkedAt: Schema.DateTimeUtcFromString }),
  Schema.Struct({ state: Schema.Literal("unknown") }),
]);

export const MarketingEvidenceSourceStatePayload = Schema.Struct({
  adapterKey: MarketingCanonicalRegistryKey,
  capability: MarketingSourceCapabilityState,
  access: MarketingSourceAccessState,
  import: MarketingSourceImportPayloadState,
  index: MarketingSourceIndexPayloadState,
  freshness: MarketingSourceFreshnessPayloadState,
  observedAt: Schema.DateTimeUtcFromString,
});
export type MarketingEvidenceSourceStatePayload = typeof MarketingEvidenceSourceStatePayload.Type;

const AcceptedFactPayloadFields = {
  claim: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  value: MarketingEvidenceFactValue,
};

export const MarketingEvidenceFactAcceptancePayload = Schema.Union([
  Schema.Struct({
    ...AcceptedFactPayloadFields,
    status: Schema.Literal("accepted"),
    supersedes: Schema.optionalKey(MarketingCanonicalRevisionReference),
  }),
  Schema.Struct({
    ...AcceptedFactPayloadFields,
    status: Schema.Literal("withdrawn"),
    supersedes: MarketingCanonicalRevisionReference,
  }),
]);
export type MarketingEvidenceFactAcceptancePayload =
  typeof MarketingEvidenceFactAcceptancePayload.Type;

export interface MarketingCanonicalSchemaRegistration {
  readonly schema: MarketingCanonicalSchemaReference;
  readonly objectKind: MarketingCanonicalObjectKind;
}

/** Narrow schema namespaces compose without teaching the canonical store about product catalogs. */
export interface MarketingCanonicalSchemaHandler {
  readonly namespace: string;
  readonly registrations: ReadonlyArray<MarketingCanonicalSchemaRegistration>;
  readonly validatePayload: (
    context: MarketingCanonicalRegistryWriteContext,
    payload: MarketingCanonicalJson,
  ) => Effect.Effect<MarketingCanonicalJson, MarketingCanonicalValidationError>;
  readonly projectFacts: (
    context: MarketingCanonicalRegistryWriteContext,
    payload: MarketingCanonicalJson,
  ) => Effect.Effect<
    ReadonlyArray<MarketingCanonicalProjectionFact>,
    MarketingCanonicalValidationError
  >;
}

function schemaText(reference: MarketingCanonicalSchemaReference): string {
  return `${reference.key}@${reference.version}`;
}

function registrationText(registration: MarketingCanonicalSchemaRegistration): string {
  return `${schemaText(registration.schema)}:${registration.objectKind}`;
}

function validationFailure(
  reason: MarketingCanonicalValidationError["reason"],
  reference: string,
): MarketingCanonicalValidationError {
  return new MarketingCanonicalValidationError({ reason, reference });
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
}

function normalizeJson(value: Schema.Json): Schema.Json {
  if (typeof value === "string") {
    return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeJson);
  const entries = Object.entries(value)
    .map(([key, entry]) => [key.normalize("NFC"), normalizeJson(entry)] as const)
    .sort(([left], [right]) => compareCanonicalText(left, right));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.[0] === entries[index]?.[0]) {
      throw new Error("Normalized JSON keys must remain unique");
    }
  }
  return Object.fromEntries(entries);
}

const decodeSourcePayload = Schema.decodeUnknownEffect(MarketingEvidenceSourceStatePayload);
const decodeFactPayload = Schema.decodeUnknownEffect(MarketingEvidenceFactAcceptancePayload);
const encodeSourcePayload = Schema.encodeSync(MarketingEvidenceSourceStatePayload);
const isEvidenceStableKey = Schema.is(MarketingEvidenceStableKey);

function sourcePayloadJson(payload: MarketingEvidenceSourceStatePayload): MarketingCanonicalJson {
  return encodeSourcePayload(payload);
}

function factPayloadJson(payload: MarketingEvidenceFactAcceptancePayload): MarketingCanonicalJson {
  return {
    claim: normalizeText(payload.claim),
    value: normalizeJson(payload.value),
    status: payload.status,
    ...(payload.supersedes === undefined ? {} : { supersedes: payload.supersedes }),
  };
}

function evidenceSchemaFor(
  context: MarketingCanonicalRegistryWriteContext,
): "source" | "fact" | undefined {
  if (
    context.schema.key === MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA_KEY &&
    context.schema.version === MARKETING_EVIDENCE_SCHEMA_VERSION
  ) {
    return "source";
  }
  if (
    context.schema.key === MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA_KEY &&
    context.schema.version === MARKETING_EVIDENCE_SCHEMA_VERSION
  ) {
    return "fact";
  }
  return undefined;
}

export const marketingEvidenceCanonicalSchemaHandler: MarketingCanonicalSchemaHandler = {
  namespace: "auldric-marketing-evidence-v1",
  registrations: [
    { schema: MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA, objectKind: "source" },
    { schema: MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA, objectKind: "decision" },
  ],
  validatePayload: (context, payload) => {
    const schema = evidenceSchemaFor(context);
    if (context.definition !== undefined || context.projection !== undefined) {
      return Effect.fail(
        validationFailure("schema_reference_incompatible", schemaText(context.schema)),
      );
    }
    if (schema === "source") {
      const stableKey = context.canonicalKey.slice("evidence/source/".length);
      if (
        context.object.kind !== "source" ||
        !context.canonicalKey.startsWith("evidence/source/") ||
        !isEvidenceStableKey(stableKey) ||
        context.sourceLineage.length !== 0 ||
        context.reviewReferences.length !== 0 ||
        context.decisionReferences.length !== 0
      ) {
        return Effect.fail(
          validationFailure("schema_reference_incompatible", schemaText(context.schema)),
        );
      }
      return decodeSourcePayload(payload).pipe(
        Effect.map(sourcePayloadJson),
        Effect.mapError(() =>
          validationFailure("payload_schema_invalid", schemaText(context.schema)),
        ),
      );
    }
    if (schema === "fact") {
      if (
        context.object.kind !== "decision" ||
        !context.canonicalKey.startsWith("evidence/fact/")
      ) {
        return Effect.fail(
          validationFailure("schema_reference_incompatible", schemaText(context.schema)),
        );
      }
      const stableKey = context.canonicalKey.slice("evidence/fact/".length);
      if (!isEvidenceStableKey(stableKey)) {
        return Effect.fail(
          validationFailure("schema_reference_incompatible", schemaText(context.schema)),
        );
      }
      return decodeFactPayload(payload).pipe(
        Effect.flatMap((fact) => {
          const transition = context.decisionReferences;
          if (
            context.sourceLineage.length === 0 ||
            context.sourceLineage.length > 32 ||
            context.reviewReferences.length > 16
          ) {
            return Effect.fail(
              validationFailure("payload_schema_invalid", schemaText(context.schema)),
            );
          }
          if (fact.supersedes === undefined && transition.length !== 0) {
            return Effect.fail(
              validationFailure("payload_schema_invalid", schemaText(context.schema)),
            );
          }
          if (
            fact.supersedes !== undefined &&
            (transition.length !== 1 ||
              transition[0]?.decisionId !== context.object.id ||
              transition[0].revision.revisionId !== fact.supersedes.revisionId ||
              transition[0].revision.version !== fact.supersedes.version)
          ) {
            return Effect.fail(
              validationFailure("payload_schema_invalid", schemaText(context.schema)),
            );
          }
          return Effect.try({
            try: () => factPayloadJson(fact),
            catch: () => validationFailure("payload_schema_invalid", schemaText(context.schema)),
          });
        }),
        Effect.mapError(() =>
          validationFailure("payload_schema_invalid", schemaText(context.schema)),
        ),
      );
    }
    return Effect.fail(
      validationFailure("schema_reference_unregistered", schemaText(context.schema)),
    );
  },
  projectFacts: (context, payload) => {
    const schema = evidenceSchemaFor(context);
    if (schema === "source") {
      return decodeSourcePayload(payload).pipe(
        Effect.map((source) => [
          {
            key: MarketingCanonicalFactKey.make("evidence/source-state"),
            value: {
              capability: source.capability.state,
              access: source.access.state,
              import: source.import.state,
              index: source.index.state,
              freshness: source.freshness.state,
            },
          },
        ]),
        Effect.mapError(() =>
          validationFailure("projection_fact_invalid", schemaText(context.schema)),
        ),
      );
    }
    if (schema === "fact") {
      return decodeFactPayload(payload).pipe(
        Effect.map((fact) => [
          {
            key: MarketingCanonicalFactKey.make("evidence/fact-status"),
            value: {
              status: fact.status,
              ...(fact.supersedes === undefined ? {} : { supersedes: fact.supersedes }),
            },
          },
        ]),
        Effect.mapError(() =>
          validationFailure("projection_fact_invalid", schemaText(context.schema)),
        ),
      );
    }
    return Effect.fail(
      validationFailure("schema_reference_unregistered", schemaText(context.schema)),
    );
  },
};

function missingRegistry(): MarketingCanonicalRegistry {
  const unregistered = (context: MarketingCanonicalRegistryWriteContext) =>
    Effect.fail(validationFailure("schema_reference_unregistered", schemaText(context.schema)));
  return {
    validatePayload: unregistered,
    projectFacts: unregistered,
    validateDefinition: (context) =>
      Effect.fail(
        validationFailure(
          "definition_reference_unregistered",
          `${context.definition.key}@${context.definition.version}`,
        ),
      ),
    validateRenderer: (context) =>
      Effect.fail(
        validationFailure(
          "renderer_reference_unregistered",
          `${context.projection.renderer.key}@${context.projection.renderer.version}`,
        ),
      ),
  };
}

export function makeMarketingCanonicalRegistryWithSchemaHandlers(input: {
  readonly handlers: ReadonlyArray<MarketingCanonicalSchemaHandler>;
  readonly fallback?: MarketingCanonicalRegistry;
}): MarketingCanonicalRegistry {
  const fallback = input.fallback ?? missingRegistry();
  const exact = new Map<string, MarketingCanonicalSchemaHandler>();
  const claimedReferences = new Set<string>();
  const claimedSchemaKeys = new Set<string>();
  const namespaces = new Set<string>();
  for (const handler of input.handlers) {
    if (handler.namespace.trim().length === 0 || namespaces.has(handler.namespace)) {
      throw new Error(
        `Duplicate or empty Marketing canonical handler namespace: ${handler.namespace}`,
      );
    }
    namespaces.add(handler.namespace);
    for (const registration of handler.registrations) {
      const exactKey = registrationText(registration);
      if (exact.has(exactKey)) {
        throw new Error(`Duplicate Marketing canonical schema registration: ${exactKey}`);
      }
      const reference = schemaText(registration.schema);
      if (claimedReferences.has(reference)) {
        throw new Error(`Duplicate Marketing canonical schema namespace: ${reference}`);
      }
      exact.set(exactKey, handler);
      claimedReferences.add(reference);
      claimedSchemaKeys.add(registration.schema.key);
    }
  }

  const resolve = (context: MarketingCanonicalRegistryWriteContext) => {
    const reference = schemaText(context.schema);
    const handler = exact.get(`${reference}:${context.object.kind}`);
    if (handler !== undefined) return { handler } as const;
    if (claimedReferences.has(reference)) return { incompatible: true } as const;
    if (claimedSchemaKeys.has(context.schema.key)) return { unregistered: true } as const;
    return {} as const;
  };

  return {
    validatePayload: (context, payload) => {
      const resolution = resolve(context);
      if ("handler" in resolution) return resolution.handler.validatePayload(context, payload);
      if ("incompatible" in resolution) {
        return Effect.fail(
          validationFailure("schema_reference_incompatible", schemaText(context.schema)),
        );
      }
      if ("unregistered" in resolution) {
        return Effect.fail(
          validationFailure("schema_reference_unregistered", schemaText(context.schema)),
        );
      }
      return fallback.validatePayload(context, payload);
    },
    projectFacts: (context, payload) => {
      const resolution = resolve(context);
      if ("handler" in resolution) return resolution.handler.projectFacts(context, payload);
      if ("incompatible" in resolution) {
        return Effect.fail(
          validationFailure("schema_reference_incompatible", schemaText(context.schema)),
        );
      }
      if ("unregistered" in resolution) {
        return Effect.fail(
          validationFailure("schema_reference_unregistered", schemaText(context.schema)),
        );
      }
      return fallback.projectFacts(context, payload);
    },
    validateDefinition: fallback.validateDefinition,
    validateRenderer: fallback.validateRenderer,
  };
}

export const MarketingEvidenceSourceCanonicalKey = (stableKey: MarketingEvidenceStableKey) =>
  MarketingCanonicalKey.make(`evidence/source/${stableKey}`);

export const MarketingEvidenceFactCanonicalKey = (stableKey: MarketingEvidenceStableKey) =>
  MarketingCanonicalKey.make(`evidence/fact/${stableKey}`);
