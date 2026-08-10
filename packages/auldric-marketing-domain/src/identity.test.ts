import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  MarketingActorId,
  MarketingArtifactId,
  MarketingCanonicalRevisionId,
  MarketingDecisionId,
  MarketingNextActionId,
  MarketingOrganizationId,
  MarketingPlanId,
  MarketingProjectId,
  MarketingReferenceTarget,
  MarketingReviewId,
  MarketingSavedOutputId,
  MarketingSourceId,
  MarketingT3ReferenceLifecycle,
  MarketingWorkflowInstanceId,
  MarketingWorkspaceId,
} from "./identity.ts";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const decodeActorId = Schema.decodeUnknownSync(MarketingActorId);
const decodeArtifactId = Schema.decodeUnknownSync(MarketingArtifactId);
const decodeCanonicalRevisionId = Schema.decodeUnknownSync(MarketingCanonicalRevisionId);
const decodeDecisionId = Schema.decodeUnknownSync(MarketingDecisionId);
const decodeNextActionId = Schema.decodeUnknownSync(MarketingNextActionId);
const decodeOrganizationId = Schema.decodeUnknownSync(MarketingOrganizationId);
const decodePlanId = Schema.decodeUnknownSync(MarketingPlanId);
const decodeProjectId = Schema.decodeUnknownSync(MarketingProjectId);
const decodeReviewId = Schema.decodeUnknownSync(MarketingReviewId);
const decodeSavedOutputId = Schema.decodeUnknownSync(MarketingSavedOutputId);
const decodeSourceId = Schema.decodeUnknownSync(MarketingSourceId);
const decodeT3ReferenceLifecycle = Schema.decodeUnknownSync(MarketingT3ReferenceLifecycle);
const decodeWorkflowId = Schema.decodeUnknownSync(MarketingWorkflowInstanceId);
const decodeWorkspaceId = Schema.decodeUnknownSync(MarketingWorkspaceId);
const isMarketingOrganizationId = Schema.is(MarketingOrganizationId);
const isMarketingProjectId = Schema.is(MarketingProjectId);
const isMarketingWorkspaceId = Schema.is(MarketingWorkspaceId);

describe("Marketing identity contracts", () => {
  it("decodes each Marketing identity only under its own prefix and brand", () => {
    const organizationId = decodeOrganizationId(`morg_${uuid}`);
    const projectId = decodeProjectId(`mprj_${uuid}`);
    const workspaceId = decodeWorkspaceId(`mwsp_${uuid}`);
    const sourceId = decodeSourceId(`msrc_${uuid}`);
    const workflowId = decodeWorkflowId(`mwfi_${uuid}`);
    const artifactId = decodeArtifactId(`mart_${uuid}`);
    const planId = decodePlanId(`mpln_${uuid}`);
    const reviewId = decodeReviewId(`mrev_${uuid}`);
    const savedOutputId = decodeSavedOutputId(`mout_${uuid}`);
    const decisionId = decodeDecisionId(`mdec_${uuid}`);
    const nextActionId = decodeNextActionId(`mnxt_${uuid}`);
    const revisionId = decodeCanonicalRevisionId(`mcrv_${uuid}`);

    assert.equal(organizationId, `morg_${uuid}`);
    assert.equal(projectId, `mprj_${uuid}`);
    assert.equal(workspaceId, `mwsp_${uuid}`);
    assert.equal(sourceId, `msrc_${uuid}`);
    assert.equal(workflowId, `mwfi_${uuid}`);
    assert.equal(artifactId, `mart_${uuid}`);
    assert.equal(planId, `mpln_${uuid}`);
    assert.equal(reviewId, `mrev_${uuid}`);
    assert.equal(savedOutputId, `mout_${uuid}`);
    assert.equal(decisionId, `mdec_${uuid}`);
    assert.equal(nextActionId, `mnxt_${uuid}`);
    assert.equal(revisionId, `mcrv_${uuid}`);

    assert.isFalse(isMarketingOrganizationId(projectId));
    assert.isFalse(isMarketingWorkspaceId(ThreadId.make("thread-upstream")));
    assert.isFalse(isMarketingProjectId(EnvironmentId.make("environment-upstream")));

    const acceptOrganization = (_id: MarketingOrganizationId): void => undefined;
    acceptOrganization(organizationId);
    // @ts-expect-error Marketing project IDs cannot be passed as organization IDs.
    acceptOrganization(projectId);
    // @ts-expect-error T3 thread IDs cannot be passed as Marketing organization IDs.
    acceptOrganization(ThreadId.make("thread-upstream"));
  });

  it("requires deleted optional T3 references to erase the upstream identifier", () => {
    const binding = decodeT3ReferenceLifecycle({
      bindingId: `mt3r_${uuid}`,
      organizationId: `morg_${uuid}`,
      target: {
        kind: "artifact",
        id: MarketingArtifactId.make(`mart_${uuid}`),
      } satisfies MarketingReferenceTarget,
      state: "deleted",
      reference: null,
      linkedAt: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
      deletedAt: DateTime.makeUnsafe("2030-01-02T00:00:00.000Z"),
    });

    assert.equal(binding.state, "deleted");
    assert.isNull(binding.reference);

    assert.throws(() =>
      decodeT3ReferenceLifecycle({
        ...binding,
        reference: { kind: "thread", value: ThreadId.make("thread-upstream") },
      }),
    );
  });

  it("keeps every canonical Marketing object identity nominally distinct", () => {
    const actor = decodeActorId(`mact_${uuid}`);
    const source = MarketingSourceId.make(`msrc_${uuid}`);
    const artifact = MarketingArtifactId.make(`mart_${uuid}`);

    const acceptActor = (_id: MarketingActorId): void => undefined;
    acceptActor(actor);
    // @ts-expect-error Marketing source IDs cannot be passed as Marketing actor IDs.
    acceptActor(source);
    // @ts-expect-error Marketing artifact IDs cannot be passed as Marketing actor IDs.
    acceptActor(artifact);
  });
});
