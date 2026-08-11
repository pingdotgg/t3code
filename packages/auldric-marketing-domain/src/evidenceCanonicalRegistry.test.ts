import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  MarketingCanonicalKey,
  MarketingCanonicalRegistryKey,
  MarketingCanonicalVersion,
  type MarketingCanonicalSchemaReference,
} from "./canonical.ts";
import type {
  MarketingCanonicalRegistry,
  MarketingCanonicalRegistryWriteContext,
} from "./canonicalStore.ts";
import {
  MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA,
  MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA,
  makeMarketingCanonicalRegistryWithSchemaHandlers,
  marketingEvidenceCanonicalSchemaHandler,
} from "./evidenceCanonicalRegistry.ts";
import {
  MarketingCanonicalRevisionId,
  MarketingDecisionId,
  MarketingSourceId,
} from "./identity.ts";

function uuid(suffix: number): string {
  return `523e4567-e89b-42d3-a456-${String(suffix).padStart(12, "0")}`;
}

function context(
  schema: MarketingCanonicalSchemaReference,
  kind: "source" | "decision" = "source",
): MarketingCanonicalRegistryWriteContext {
  return {
    object:
      kind === "source"
        ? { kind, id: MarketingSourceId.make(`msrc_${uuid(1)}`) }
        : { kind, id: MarketingDecisionId.make(`mdec_${uuid(1)}`) },
    canonicalKey: MarketingCanonicalKey.make(
      kind === "source" ? "evidence/source/research" : "evidence/fact/research",
    ),
    schema,
    scope: {},
    sourceLineage: [],
    reviewReferences: [],
    decisionReferences: [],
  };
}

const sourcePayload = {
  adapterKey: "evidence/test-adapter",
  capability: { state: "available" },
  access: { state: "authorized" },
  import: { state: "not-required" },
  index: { state: "not-required" },
  freshness: { state: "current", checkedAt: "2035-01-02T03:04:05.000Z" },
  observedAt: "2035-01-02T03:04:05.000Z",
} as const;

describe("Marketing canonical schema-handler composition", () => {
  it.effect("routes exact evidence schemas and delegates an unrelated namespace", () =>
    Effect.gen(function* () {
      let fallbackCalls = 0;
      const fallback: MarketingCanonicalRegistry = {
        validatePayload: (_context, payload) => {
          fallbackCalls += 1;
          return Effect.succeed(payload);
        },
        projectFacts: () => Effect.succeed([]),
        validateDefinition: () => Effect.void,
        validateRenderer: () => Effect.void,
      };
      const registry = makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [marketingEvidenceCanonicalSchemaHandler],
        fallback,
      });
      const evidence = yield* registry.validatePayload(
        context(MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA),
        sourcePayload,
      );
      assert.equal(fallbackCalls, 0);
      assert.deepEqual(evidence, sourcePayload);

      const unrelatedSchema = {
        key: MarketingCanonicalRegistryKey.make("audit/review"),
        version: MarketingCanonicalVersion.make(1),
      };
      const unrelatedPayload = { status: "pending" };
      assert.deepEqual(
        yield* registry.validatePayload(context(unrelatedSchema), unrelatedPayload),
        unrelatedPayload,
      );
      assert.equal(fallbackCalls, 1);
    }),
  );

  it.effect("fails a claimed evidence schema on the wrong object kind without fallback", () =>
    Effect.gen(function* () {
      let fallbackCalls = 0;
      const fallback: MarketingCanonicalRegistry = {
        validatePayload: (_context, payload) => {
          fallbackCalls += 1;
          return Effect.succeed(payload);
        },
        projectFacts: () => Effect.succeed([]),
        validateDefinition: () => Effect.void,
        validateRenderer: () => Effect.void,
      };
      const registry = makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [marketingEvidenceCanonicalSchemaHandler],
        fallback,
      });
      const result = yield* Effect.result(
        registry.validatePayload(
          context(MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA, "decision"),
          sourcePayload,
        ),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "schema_reference_incompatible");
      }
      assert.equal(fallbackCalls, 0);
    }),
  );

  it.effect("fails an unregistered version of an evidence-owned schema without fallback", () =>
    Effect.gen(function* () {
      let fallbackCalls = 0;
      const fallback: MarketingCanonicalRegistry = {
        validatePayload: (_context, payload) => {
          fallbackCalls += 1;
          return Effect.succeed(payload);
        },
        projectFacts: () => Effect.succeed([]),
        validateDefinition: () => Effect.void,
        validateRenderer: () => Effect.void,
      };
      const registry = makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [marketingEvidenceCanonicalSchemaHandler],
        fallback,
      });
      const result = yield* Effect.result(
        registry.validatePayload(
          context({
            key: MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA.key,
            version: MarketingCanonicalVersion.make(2),
          }),
          sourcePayload,
        ),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "schema_reference_unregistered");
      }
      assert.equal(fallbackCalls, 0);
    }),
  );

  it("rejects duplicate schema namespaces when registries are composed", () => {
    assert.throws(() =>
      makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [
          marketingEvidenceCanonicalSchemaHandler,
          marketingEvidenceCanonicalSchemaHandler,
        ],
      }),
    );
    assert.throws(() =>
      makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [
          marketingEvidenceCanonicalSchemaHandler,
          { ...marketingEvidenceCanonicalSchemaHandler, registrations: [] },
        ],
      }),
    );
  });

  it.effect("requires a stable evidence source canonical namespace", () =>
    Effect.gen(function* () {
      const registry = makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [marketingEvidenceCanonicalSchemaHandler],
      });
      const invalid = {
        ...context(MARKETING_EVIDENCE_SOURCE_STATE_SCHEMA),
        canonicalKey: MarketingCanonicalKey.make("evidence/source/not/narrow"),
      };
      const result = yield* Effect.result(registry.validatePayload(invalid, sourcePayload));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "schema_reference_incompatible");
      }
    }),
  );

  it.effect("rejects fact values whose keys collide after canonical normalization", () =>
    Effect.gen(function* () {
      const registry = makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [marketingEvidenceCanonicalSchemaHandler],
      });
      const factContext = {
        ...context(MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA, "decision"),
        sourceLineage: [
          {
            sourceId: MarketingSourceId.make(`msrc_${uuid(2)}`),
            revision: {
              revisionId: MarketingCanonicalRevisionId.make(`mcrv_${uuid(2)}`),
              version: MarketingCanonicalVersion.make(1),
            },
          },
        ],
      };
      const result = yield* Effect.result(
        registry.validatePayload(factContext, {
          claim: "Canonical keys remain unambiguous.",
          value: { "e\u0301": "first", é: "second" },
          status: "accepted",
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "payload_schema_invalid");
      }
    }),
  );

  it.effect("revalidates fact bounds after Unicode normalization expands text", () =>
    Effect.gen(function* () {
      const registry = makeMarketingCanonicalRegistryWithSchemaHandlers({
        handlers: [marketingEvidenceCanonicalSchemaHandler],
      });
      const factContext = {
        ...context(MARKETING_EVIDENCE_FACT_ACCEPTANCE_SCHEMA, "decision"),
        sourceLineage: [
          {
            sourceId: MarketingSourceId.make(`msrc_${uuid(3)}`),
            revision: {
              revisionId: MarketingCanonicalRevisionId.make(`mcrv_${uuid(3)}`),
              version: MarketingCanonicalVersion.make(1),
            },
          },
        ],
      };
      const result = yield* Effect.result(
        registry.validatePayload(factContext, {
          claim: "Normalized fact values remain bounded.",
          value: "\u0344".repeat(12_000),
          status: "accepted",
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.reason, "payload_schema_invalid");
      }
    }),
  );
});
