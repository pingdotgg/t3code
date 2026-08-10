import { AuthSessionId, EnvironmentId, RuntimeSessionId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const MarketingIdentifierBodyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const makeMarketingIdentifier = (prefix: string) =>
  Schema.String.check(
    Schema.isTrimmed(),
    Schema.isPattern(
      new RegExp(`^${prefix}${MarketingIdentifierBodyPattern.source.slice(1)}`, "i"),
    ),
  );

export const MarketingActorId = makeMarketingIdentifier("mact_").pipe(
  Schema.brand("MarketingActorId"),
);
export type MarketingActorId = typeof MarketingActorId.Type;

export const MarketingOrganizationId = makeMarketingIdentifier("morg_").pipe(
  Schema.brand("MarketingOrganizationId"),
);
export type MarketingOrganizationId = typeof MarketingOrganizationId.Type;

export const MarketingProjectId = makeMarketingIdentifier("mprj_").pipe(
  Schema.brand("MarketingProjectId"),
);
export type MarketingProjectId = typeof MarketingProjectId.Type;

export const MarketingWorkspaceId = makeMarketingIdentifier("mwsp_").pipe(
  Schema.brand("MarketingWorkspaceId"),
);
export type MarketingWorkspaceId = typeof MarketingWorkspaceId.Type;

export const MarketingSourceId = makeMarketingIdentifier("msrc_").pipe(
  Schema.brand("MarketingSourceId"),
);
export type MarketingSourceId = typeof MarketingSourceId.Type;

export const MarketingWorkflowInstanceId = makeMarketingIdentifier("mwfi_").pipe(
  Schema.brand("MarketingWorkflowInstanceId"),
);
export type MarketingWorkflowInstanceId = typeof MarketingWorkflowInstanceId.Type;

export const MarketingArtifactId = makeMarketingIdentifier("mart_").pipe(
  Schema.brand("MarketingArtifactId"),
);
export type MarketingArtifactId = typeof MarketingArtifactId.Type;

export const MarketingPlanId = makeMarketingIdentifier("mpln_").pipe(
  Schema.brand("MarketingPlanId"),
);
export type MarketingPlanId = typeof MarketingPlanId.Type;

export const MarketingReviewId = makeMarketingIdentifier("mrev_").pipe(
  Schema.brand("MarketingReviewId"),
);
export type MarketingReviewId = typeof MarketingReviewId.Type;

export const MarketingSavedOutputId = makeMarketingIdentifier("mout_").pipe(
  Schema.brand("MarketingSavedOutputId"),
);
export type MarketingSavedOutputId = typeof MarketingSavedOutputId.Type;

export const MarketingDecisionId = makeMarketingIdentifier("mdec_").pipe(
  Schema.brand("MarketingDecisionId"),
);
export type MarketingDecisionId = typeof MarketingDecisionId.Type;

export const MarketingNextActionId = makeMarketingIdentifier("mnxt_").pipe(
  Schema.brand("MarketingNextActionId"),
);
export type MarketingNextActionId = typeof MarketingNextActionId.Type;

export const MarketingCanonicalRevisionId = makeMarketingIdentifier("mcrv_").pipe(
  Schema.brand("MarketingCanonicalRevisionId"),
);
export type MarketingCanonicalRevisionId = typeof MarketingCanonicalRevisionId.Type;

export const MarketingT3ReferenceBindingId = makeMarketingIdentifier("mt3r_").pipe(
  Schema.brand("MarketingT3ReferenceBindingId"),
);
export type MarketingT3ReferenceBindingId = typeof MarketingT3ReferenceBindingId.Type;

export const MarketingIdempotencyKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
).pipe(Schema.brand("MarketingIdempotencyKey"));
export type MarketingIdempotencyKey = typeof MarketingIdempotencyKey.Type;

export const T3ActorIssuer = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
).pipe(Schema.brand("T3ActorIssuer"));
export type T3ActorIssuer = typeof T3ActorIssuer.Type;

export const T3ActorSubject = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
).pipe(Schema.brand("T3ActorSubject"));
export type T3ActorSubject = typeof T3ActorSubject.Type;

/** T3 currently carries relay device identity as a string, so Marketing brands it locally as opaque. */
export const T3DeviceIdRef = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()).pipe(
  Schema.brand("T3DeviceIdRef"),
);
export type T3DeviceIdRef = typeof T3DeviceIdRef.Type;

export const ActiveT3Reference = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("environment"), value: EnvironmentId }),
  Schema.Struct({ kind: Schema.Literal("thread"), value: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("auth-session"), value: AuthSessionId }),
  Schema.Struct({ kind: Schema.Literal("runtime-session"), value: RuntimeSessionId }),
  Schema.Struct({ kind: Schema.Literal("device"), value: T3DeviceIdRef }),
]);
export type ActiveT3Reference = typeof ActiveT3Reference.Type;

export const MarketingReferenceTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("source"), id: MarketingSourceId }),
  Schema.Struct({ kind: Schema.Literal("workflow"), id: MarketingWorkflowInstanceId }),
  Schema.Struct({ kind: Schema.Literal("artifact"), id: MarketingArtifactId }),
  Schema.Struct({ kind: Schema.Literal("plan"), id: MarketingPlanId }),
  Schema.Struct({ kind: Schema.Literal("review"), id: MarketingReviewId }),
]);
export type MarketingReferenceTarget = typeof MarketingReferenceTarget.Type;

export const MarketingT3ReferenceLifecycle = Schema.Union([
  Schema.Struct({
    bindingId: MarketingT3ReferenceBindingId,
    organizationId: MarketingOrganizationId,
    target: MarketingReferenceTarget,
    state: Schema.Literal("active"),
    reference: ActiveT3Reference,
    linkedAt: Schema.DateTimeUtc,
    expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  }),
  Schema.Struct({
    bindingId: MarketingT3ReferenceBindingId,
    organizationId: MarketingOrganizationId,
    target: MarketingReferenceTarget,
    state: Schema.Literal("stale"),
    reference: ActiveT3Reference,
    linkedAt: Schema.DateTimeUtc,
    staleAt: Schema.DateTimeUtc,
  }),
  Schema.Struct({
    bindingId: MarketingT3ReferenceBindingId,
    organizationId: MarketingOrganizationId,
    target: MarketingReferenceTarget,
    state: Schema.Literal("deleted"),
    reference: Schema.Null,
    linkedAt: Schema.DateTimeUtc,
    deletedAt: Schema.DateTimeUtc,
  }),
]);
export type MarketingT3ReferenceLifecycle = typeof MarketingT3ReferenceLifecycle.Type;

export const MarketingWorkspaceSelection = Schema.Struct({
  organizationId: MarketingOrganizationId,
  projectId: MarketingProjectId,
  workspaceId: MarketingWorkspaceId,
});
export type MarketingWorkspaceSelection = typeof MarketingWorkspaceSelection.Type;
