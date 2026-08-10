import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  MarketingArtifactId,
  MarketingCanonicalRevisionId,
  MarketingDecisionId,
  MarketingNextActionId,
  MarketingPlanId,
  MarketingReviewId,
  MarketingSavedOutputId,
  MarketingSourceId,
  MarketingWorkflowInstanceId,
} from "./identity.ts";

export const MarketingCanonicalObjectKind = Schema.Literals([
  "source",
  "workflow-instance",
  "plan",
  "artifact",
  "saved-output",
  "review",
  "decision",
  "next-action",
]);
export type MarketingCanonicalObjectKind = typeof MarketingCanonicalObjectKind.Type;

export const MarketingCanonicalWritableObjectIdentity = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("source"), id: MarketingSourceId }),
  Schema.Struct({
    kind: Schema.Literal("workflow-instance"),
    id: MarketingWorkflowInstanceId,
  }),
  Schema.Struct({ kind: Schema.Literal("plan"), id: MarketingPlanId }),
  Schema.Struct({ kind: Schema.Literal("artifact"), id: MarketingArtifactId }),
  Schema.Struct({ kind: Schema.Literal("review"), id: MarketingReviewId }),
  Schema.Struct({ kind: Schema.Literal("decision"), id: MarketingDecisionId }),
  Schema.Struct({ kind: Schema.Literal("next-action"), id: MarketingNextActionId }),
]);
export type MarketingCanonicalWritableObjectIdentity =
  typeof MarketingCanonicalWritableObjectIdentity.Type;

export const MarketingSavedOutputIdentity = Schema.Struct({
  kind: Schema.Literal("saved-output"),
  id: MarketingSavedOutputId,
});
export type MarketingSavedOutputIdentity = typeof MarketingSavedOutputIdentity.Type;

export const MarketingCanonicalObjectIdentity = Schema.Union([
  MarketingCanonicalWritableObjectIdentity,
  MarketingSavedOutputIdentity,
]);
export type MarketingCanonicalObjectIdentity = typeof MarketingCanonicalObjectIdentity.Type;

const CanonicalRegistryKeyPattern = /^[a-z0-9](?:[a-z0-9._/-]{0,198}[a-z0-9])?$/u;
const CanonicalKeyPattern = /^[a-z0-9](?:[a-z0-9._/-]{0,238}[a-z0-9])?$/u;

export const MarketingCanonicalRegistryKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(CanonicalRegistryKeyPattern),
).pipe(Schema.brand("MarketingCanonicalRegistryKey"));
export type MarketingCanonicalRegistryKey = typeof MarketingCanonicalRegistryKey.Type;

export const MarketingCanonicalKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(240),
  Schema.isPattern(CanonicalKeyPattern),
).pipe(Schema.brand("MarketingCanonicalKey"));
export type MarketingCanonicalKey = typeof MarketingCanonicalKey.Type;

export const MarketingCanonicalFactKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(CanonicalRegistryKeyPattern),
).pipe(Schema.brand("MarketingCanonicalFactKey"));
export type MarketingCanonicalFactKey = typeof MarketingCanonicalFactKey.Type;

export const MarketingCanonicalVersion = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("MarketingCanonicalVersion"),
);
export type MarketingCanonicalVersion = typeof MarketingCanonicalVersion.Type;

export const MarketingExpectedVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand("MarketingExpectedVersion"),
);
export type MarketingExpectedVersion = typeof MarketingExpectedVersion.Type;

export const MarketingCanonicalSchemaReference = Schema.Struct({
  key: MarketingCanonicalRegistryKey,
  version: MarketingCanonicalVersion,
});
export type MarketingCanonicalSchemaReference = typeof MarketingCanonicalSchemaReference.Type;

export const MarketingCanonicalDefinitionReference = Schema.Struct({
  key: MarketingCanonicalRegistryKey,
  version: MarketingCanonicalVersion,
});
export type MarketingCanonicalDefinitionReference =
  typeof MarketingCanonicalDefinitionReference.Type;

export const MarketingRegisteredRendererReference = Schema.Struct({
  key: MarketingCanonicalRegistryKey,
  version: MarketingCanonicalVersion,
});
export type MarketingRegisteredRendererReference = typeof MarketingRegisteredRendererReference.Type;

export const MarketingCanonicalRevisionReference = Schema.Struct({
  revisionId: MarketingCanonicalRevisionId,
  version: MarketingCanonicalVersion,
});
export type MarketingCanonicalRevisionReference = typeof MarketingCanonicalRevisionReference.Type;

export const MarketingCanonicalWorkflowContext = Schema.Struct({
  workflowInstanceId: MarketingWorkflowInstanceId,
  revision: MarketingCanonicalRevisionReference,
  stageKey: Schema.optionalKey(MarketingCanonicalRegistryKey),
  stepKey: Schema.optionalKey(MarketingCanonicalRegistryKey),
});
export type MarketingCanonicalWorkflowContext = typeof MarketingCanonicalWorkflowContext.Type;

export const MarketingSourceLineageReference = Schema.Struct({
  sourceId: MarketingSourceId,
  revision: MarketingCanonicalRevisionReference,
});
export type MarketingSourceLineageReference = typeof MarketingSourceLineageReference.Type;

export const MarketingReviewRevisionReference = Schema.Struct({
  reviewId: MarketingReviewId,
  revision: MarketingCanonicalRevisionReference,
});
export type MarketingReviewRevisionReference = typeof MarketingReviewRevisionReference.Type;

export const MarketingDecisionRevisionReference = Schema.Struct({
  decisionId: MarketingDecisionId,
  revision: MarketingCanonicalRevisionReference,
});
export type MarketingDecisionRevisionReference = typeof MarketingDecisionRevisionReference.Type;

export const MarketingCanonicalScope = Schema.Struct({
  environmentId: Schema.optionalKey(EnvironmentId),
  workflow: Schema.optionalKey(MarketingCanonicalWorkflowContext),
});
export type MarketingCanonicalScope = typeof MarketingCanonicalScope.Type;

export const MarketingCanonicalContentOperation = Schema.Literals([
  "list-canonical-inventory",
  "list-canonical-revisions",
  "query-canonical-facts",
  "read-canonical-object",
  "create-source",
  "edit-source",
  "create-workflow-instance",
  "edit-workflow-instance",
  "create-plan",
  "edit-plan",
  "create-artifact",
  "save-artifact-revision",
  "create-review",
  "record-review-revision",
  "create-decision",
  "record-decision-revision",
  "create-next-action",
  "edit-next-action",
  "save-registered-output",
  "save-registered-output-revision",
]);
export type MarketingCanonicalContentOperation = typeof MarketingCanonicalContentOperation.Type;

export type MarketingCanonicalJson = Schema.Json;

export const MarketingCanonicalProjectionFact = Schema.Struct({
  key: MarketingCanonicalFactKey,
  value: Schema.Json,
});
export type MarketingCanonicalProjectionFact = typeof MarketingCanonicalProjectionFact.Type;

export interface MarketingCanonicalProjectionReference {
  readonly source: MarketingCanonicalObjectIdentity;
  readonly revision: MarketingCanonicalRevisionReference;
  readonly renderer: MarketingRegisteredRendererReference;
}

export interface MarketingCanonicalInventoryItem {
  readonly object: MarketingCanonicalObjectIdentity;
  readonly canonicalKey: MarketingCanonicalKey;
  readonly version: MarketingCanonicalVersion;
  readonly revisionId: MarketingCanonicalRevisionId;
  readonly schema: MarketingCanonicalSchemaReference;
  readonly definition?: MarketingCanonicalDefinitionReference;
  readonly scope: MarketingCanonicalScope;
  readonly actorId: import("./identity.ts").MarketingActorId;
  readonly createdAt: import("effect/DateTime").Utc;
  readonly updatedAt: import("effect/DateTime").Utc;
}

export interface MarketingCanonicalRecord extends MarketingCanonicalInventoryItem {
  readonly payload: MarketingCanonicalJson;
  readonly facts: ReadonlyArray<MarketingCanonicalProjectionFact>;
  readonly sourceLineage: ReadonlyArray<MarketingSourceLineageReference>;
  readonly reviewReferences: ReadonlyArray<MarketingReviewRevisionReference>;
  readonly decisionReferences: ReadonlyArray<MarketingDecisionRevisionReference>;
  readonly projection?: MarketingCanonicalProjectionReference;
}

export interface MarketingCanonicalFactRecord {
  readonly object: MarketingCanonicalObjectIdentity;
  readonly revisionId: MarketingCanonicalRevisionId;
  readonly version: MarketingCanonicalVersion;
  readonly fact: MarketingCanonicalProjectionFact;
}
