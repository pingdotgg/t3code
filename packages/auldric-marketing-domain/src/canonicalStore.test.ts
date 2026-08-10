// @effect-diagnostics nodeBuiltinImport:off - tests inspect disposable organization databases directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  type MarketingCanonicalContentOperation,
  MarketingCanonicalFactKey,
  MarketingCanonicalKey,
  type MarketingCanonicalObjectIdentity,
  MarketingCanonicalRegistryKey,
  MarketingCanonicalVersion,
  MarketingExpectedVersion,
  type MarketingCanonicalSchemaReference,
} from "./canonical.ts";
import {
  MarketingCanonicalAuthorizationError,
  MarketingCanonicalValidationError,
} from "./canonicalErrors.ts";
import {
  makeMarketingCanonicalStore,
  type MarketingCanonicalAuthorizationRequirement,
  type MarketingCanonicalRegistry,
} from "./canonicalStore.ts";
import {
  MarketingArtifactId,
  MarketingCanonicalRevisionId,
  MarketingDecisionId,
  MarketingIdempotencyKey,
  MarketingNextActionId,
  MarketingOrganizationId,
  MarketingPlanId,
  MarketingProjectId,
  MarketingReviewId,
  MarketingSavedOutputId,
  MarketingSourceId,
  MarketingWorkflowInstanceId,
  MarketingWorkspaceId,
  T3ActorIssuer,
  T3ActorSubject,
  type MarketingWorkspaceSelection,
} from "./identity.ts";
import { MarketingActorResolutionError } from "./errors.ts";
import {
  makeOrganizationWorkspaceStore,
  organizationWorkspaceDatabasePath,
  type MarketingAuthorizedActorIdentity,
  type MarketingWorkspacePermission,
} from "./workspaceStore.ts";

const testRoots: string[] = [];
const now = DateTime.makeUnsafe("2032-04-05T10:11:12.000Z");

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "auldric-canonical-store-"));
  testRoots.push(root);
  return root;
}

function uuid(suffix: number): string {
  return `223e4567-e89b-42d3-a456-${String(suffix).padStart(12, "0")}`;
}

function selection(seed: number): MarketingWorkspaceSelection {
  return {
    organizationId: MarketingOrganizationId.make(`morg_${uuid(seed)}`),
    projectId: MarketingProjectId.make(`mprj_${uuid(seed)}`),
    workspaceId: MarketingWorkspaceId.make(`mwsp_${uuid(seed)}`),
  };
}

const allWorkspacePermissions: ReadonlySet<MarketingWorkspacePermission> = new Set([
  "bootstrap-new-organization",
  "join-existing-organization",
  "resolve-workspace",
  "revoke-membership",
  "delete-workspace",
  "link-t3-reference",
  "mark-t3-reference-stale",
  "delete-t3-reference",
  "backfill-workspace",
  "rollback-provisioning",
]);

const allContentOperations: ReadonlySet<MarketingCanonicalContentOperation> = new Set([
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

declare const TestRequestAuthorityTypeId: unique symbol;
interface TestRequestAuthority {
  readonly [TestRequestAuthorityTypeId]: true;
}

interface TestAuthorityGrant {
  readonly actor: MarketingAuthorizedActorIdentity;
  readonly workspacePermissions: ReadonlySet<MarketingWorkspacePermission>;
  readonly contentOperations: ReadonlySet<MarketingCanonicalContentOperation>;
  readonly organizationId?: MarketingOrganizationId;
}

const authorityGrants = new WeakMap<object, TestAuthorityGrant>();

function requestAuthority(
  actorSeed: number,
  workspacePermissions: ReadonlySet<MarketingWorkspacePermission> = allWorkspacePermissions,
  contentOperations: ReadonlySet<MarketingCanonicalContentOperation> = allContentOperations,
  organizationId?: MarketingOrganizationId,
): TestRequestAuthority {
  const authority = {} as TestRequestAuthority;
  authorityGrants.set(authority, {
    actor: {
      issuer: T3ActorIssuer.make("https://identity.t3.codes"),
      subject: T3ActorSubject.make(`canonical-user-${actorSeed}`),
    },
    workspacePermissions,
    contentOperations,
    ...(organizationId === undefined ? {} : { organizationId }),
  });
  return authority;
}

const Payload = Schema.Struct({ value: Schema.String });
const decodePayload = Schema.decodeUnknownEffect(Payload);
const registeredSchemas = new Map<string, MarketingCanonicalObjectIdentity["kind"]>([
  ["source/basic@1", "source"],
  ["workflow/instance@1", "workflow-instance"],
  ["plan/basic@1", "plan"],
  ["artifact/basic@1", "artifact"],
  ["saved-output/basic@1", "saved-output"],
  ["review/basic@1", "review"],
  ["decision/basic@1", "decision"],
  ["next-action/basic@1", "next-action"],
]);

function ref(key: string): MarketingCanonicalSchemaReference {
  return {
    key: MarketingCanonicalRegistryKey.make(key),
    version: MarketingCanonicalVersion.make(1),
  };
}

const registry: MarketingCanonicalRegistry = {
  validatePayload: (context, payload) => {
    const key = `${context.schema.key}@${context.schema.version}`;
    const objectKind = registeredSchemas.get(key);
    if (objectKind === undefined) {
      return Effect.fail(
        new MarketingCanonicalValidationError({
          reason: "schema_reference_unregistered",
          reference: key,
        }),
      );
    }
    if (objectKind !== context.object.kind) {
      return Effect.fail(
        new MarketingCanonicalValidationError({
          reason: "schema_reference_incompatible",
          reference: key,
        }),
      );
    }
    return decodePayload(payload).pipe(
      Effect.map((decoded) => decoded as Schema.Json),
      Effect.mapError(
        () =>
          new MarketingCanonicalValidationError({
            reason: "payload_schema_invalid",
            reference: key,
          }),
      ),
    );
  },
  projectFacts: (context, payload) => {
    if (context.object.kind === "artifact") {
      return Effect.succeed([
        {
          key: MarketingCanonicalFactKey.make("source/coverage"),
          value: {
            revisionIds: context.sourceLineage.map(({ revision }) => revision.revisionId),
          },
        },
        {
          key: MarketingCanonicalFactKey.make("review/signal"),
          value: {
            revisionIds: context.reviewReferences.map(({ revision }) => revision.revisionId),
          },
        },
      ]);
    }
    const keys = new Map([
      ["source/basic", "source/coverage"],
      ["workflow/instance", "workflow/readiness"],
      ["review/basic", "review/signal"],
    ]);
    const key = keys.get(context.schema.key);
    return Effect.succeed(
      key === undefined ? [] : [{ key: MarketingCanonicalFactKey.make(key), value: payload }],
    );
  },
  validateDefinition: (context) => {
    const key = `${context.definition.key}@${context.definition.version}`;
    if (key !== "workflow/marketing-strategy@1") {
      return Effect.fail(
        new MarketingCanonicalValidationError({
          reason: "definition_reference_unregistered",
          reference: key,
        }),
      );
    }
    return context.object.kind === "workflow-instance"
      ? Effect.void
      : Effect.fail(
          new MarketingCanonicalValidationError({
            reason: "definition_reference_incompatible",
            reference: key,
          }),
        );
  },
  validateRenderer: (context) => {
    const key = `${context.projection.renderer.key}@${context.projection.renderer.version}`;
    if (key !== "artifact/summary@1") {
      return Effect.fail(
        new MarketingCanonicalValidationError({
          reason: "renderer_reference_unregistered",
          reference: key,
        }),
      );
    }
    return context.source.object.kind === "artifact" &&
      context.source.schema.key === "artifact/basic"
      ? Effect.void
      : Effect.fail(
          new MarketingCanonicalValidationError({
            reason: "renderer_reference_incompatible",
            reference: key,
          }),
        );
  },
};

function makeStores(
  root: string,
  observed: Array<MarketingCanonicalAuthorizationRequirement> = [],
) {
  const workspaceStore = makeOrganizationWorkspaceStore<TestRequestAuthority>({
    stateRoot: root,
    authorize: (authority, requirement) => {
      const grant = authorityGrants.get(authority);
      if (
        grant === undefined ||
        !grant.workspacePermissions.has(requirement.permission) ||
        (grant.organizationId !== undefined &&
          grant.organizationId !== requirement.selection.organizationId)
      ) {
        return Effect.fail(
          new MarketingActorResolutionError({ reason: "request_authority_rejected" }),
        );
      }
      return Effect.succeed(grant.actor);
    },
  });
  const canonicalStore = makeMarketingCanonicalStore({
    workspaceStore,
    registry,
    authorize: (authority, requirement) => {
      observed.push(requirement);
      const grant = authorityGrants.get(authority);
      if (
        grant === undefined ||
        !grant.contentOperations.has(requirement.operation) ||
        (grant.organizationId !== undefined &&
          grant.organizationId !== requirement.selection.organizationId)
      ) {
        return Effect.fail(
          new MarketingCanonicalAuthorizationError({ reason: "content_operation_denied" }),
        );
      }
      return Effect.void;
    },
  });
  return { workspaceStore, canonicalStore };
}

function bootstrapInput(seed: number, authority: TestRequestAuthority) {
  return {
    requestAuthority: authority,
    selection: selection(seed),
    idempotencyKey: MarketingIdempotencyKey.make(`canonical-bootstrap-${seed}`),
  };
}

function baseWrite(
  request: TestRequestAuthority,
  workspaceSelection: MarketingWorkspaceSelection,
  seed: number,
) {
  return {
    requestAuthority: request,
    selection: workspaceSelection,
    expectedVersion: MarketingExpectedVersion.make(0),
    idempotencyKey: MarketingIdempotencyKey.make(`canonical-write-${seed}`),
    scope: {},
    payload: { value: `value-${seed}` },
    sourceLineage: [],
    reviewReferences: [],
    decisionReferences: [],
  };
}

describe("canonical Marketing organization store", () => {
  it.effect(
    "shares inventory and immutable revisions across members and survives a new factory",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const observed: Array<MarketingCanonicalAuthorizationRequirement> = [];
        const firstFactory = makeStores(root, observed);
        const ownerAuthority = requestAuthority(1);
        const owner = bootstrapInput(1, ownerAuthority);
        const ownerBinding = yield* firstFactory.workspaceStore.bootstrap(owner);

        const invitationAuthority = requestAuthority(
          2,
          new Set<MarketingWorkspacePermission>(["join-existing-organization"]),
          new Set(),
          owner.selection.organizationId,
        );
        const memberBinding = yield* firstFactory.workspaceStore.join({
          requestAuthority: invitationAuthority,
          selection: owner.selection,
        });
        const memberAuthority = requestAuthority(
          2,
          new Set<MarketingWorkspacePermission>(["resolve-workspace"]),
          allContentOperations,
          owner.selection.organizationId,
        );

        const sourceObject = {
          kind: "source" as const,
          id: MarketingSourceId.make(`msrc_${uuid(1)}`),
        };
        const workflowObject = {
          kind: "workflow-instance" as const,
          id: MarketingWorkflowInstanceId.make(`mwfi_${uuid(2)}`),
        };
        const decisionObject = {
          kind: "decision" as const,
          id: MarketingDecisionId.make(`mdec_${uuid(3)}`),
        };
        const reviewObject = {
          kind: "review" as const,
          id: MarketingReviewId.make(`mrev_${uuid(4)}`),
        };
        const artifactObject = {
          kind: "artifact" as const,
          id: MarketingArtifactId.make(`mart_${uuid(6)}`),
        };
        const outputObject = {
          kind: "saved-output" as const,
          id: MarketingSavedOutputId.make(`mout_${uuid(8)}`),
        };

        const source = yield* firstFactory.canonicalStore.write({
          ...baseWrite(ownerAuthority, owner.selection, 1),
          object: sourceObject,
          canonicalKey: MarketingCanonicalKey.make("sources/customer-interviews"),
          schema: ref("source/basic"),
        });
        const workflow = yield* firstFactory.canonicalStore.write({
          ...baseWrite(ownerAuthority, owner.selection, 2),
          object: workflowObject,
          canonicalKey: MarketingCanonicalKey.make("workflows/strategy-2026"),
          schema: ref("workflow/instance"),
          definition: {
            key: MarketingCanonicalRegistryKey.make("workflow/marketing-strategy"),
            version: MarketingCanonicalVersion.make(1),
          },
        });
        const decision = yield* firstFactory.canonicalStore.write({
          ...baseWrite(ownerAuthority, owner.selection, 3),
          object: decisionObject,
          canonicalKey: MarketingCanonicalKey.make("decisions/primary-route"),
          schema: ref("decision/basic"),
          sourceLineage: [
            {
              sourceId: sourceObject.id,
              revision: { revisionId: source.revisionId, version: source.version },
            },
          ],
        });
        const review = yield* firstFactory.canonicalStore.write({
          ...baseWrite(memberAuthority, owner.selection, 4),
          object: reviewObject,
          canonicalKey: MarketingCanonicalKey.make("reviews/route-review"),
          schema: ref("review/basic"),
          decisionReferences: [
            {
              decisionId: decisionObject.id,
              revision: { revisionId: decision.revisionId, version: decision.version },
            },
          ],
        });
        const plan = yield* firstFactory.canonicalStore.write({
          ...baseWrite(ownerAuthority, owner.selection, 5),
          object: { kind: "plan", id: MarketingPlanId.make(`mpln_${uuid(5)}`) },
          canonicalKey: MarketingCanonicalKey.make("plans/90-day"),
          schema: ref("plan/basic"),
          scope: {
            environmentId: EnvironmentId.make("environment-canonical-1"),
            workflow: {
              workflowInstanceId: workflowObject.id,
              revision: { revisionId: workflow.revisionId, version: workflow.version },
            },
          },
          sourceLineage: [
            {
              sourceId: sourceObject.id,
              revision: { revisionId: source.revisionId, version: source.version },
            },
          ],
          reviewReferences: [
            {
              reviewId: reviewObject.id,
              revision: { revisionId: review.revisionId, version: review.version },
            },
          ],
          decisionReferences: [
            {
              decisionId: decisionObject.id,
              revision: { revisionId: decision.revisionId, version: decision.version },
            },
          ],
        });
        const artifactV1 = yield* firstFactory.canonicalStore.write({
          ...baseWrite(ownerAuthority, owner.selection, 6),
          object: artifactObject,
          canonicalKey: MarketingCanonicalKey.make("artifacts/strategy-brief"),
          schema: ref("artifact/basic"),
          scope: {
            environmentId: EnvironmentId.make("environment-canonical-1"),
            workflow: {
              workflowInstanceId: workflowObject.id,
              revision: { revisionId: workflow.revisionId, version: workflow.version },
              stageKey: MarketingCanonicalRegistryKey.make("strategy"),
              stepKey: MarketingCanonicalRegistryKey.make("positioning"),
            },
          },
          sourceLineage: [
            {
              sourceId: sourceObject.id,
              revision: { revisionId: source.revisionId, version: source.version },
            },
          ],
          reviewReferences: [
            {
              reviewId: reviewObject.id,
              revision: { revisionId: review.revisionId, version: review.version },
            },
          ],
          decisionReferences: [
            {
              decisionId: decisionObject.id,
              revision: { revisionId: decision.revisionId, version: decision.version },
            },
          ],
        });
        const artifactV2 = yield* firstFactory.canonicalStore.write({
          ...baseWrite(memberAuthority, owner.selection, 7),
          object: artifactObject,
          canonicalKey: artifactV1.canonicalKey,
          expectedVersion: MarketingExpectedVersion.make(1),
          schema: ref("artifact/basic"),
          payload: { value: "member revision" },
          scope: artifactV1.scope,
          sourceLineage: artifactV1.sourceLineage,
          reviewReferences: artifactV1.reviewReferences,
          decisionReferences: artifactV1.decisionReferences,
        });
        const output = yield* firstFactory.canonicalStore.saveRegisteredOutput({
          ...baseWrite(ownerAuthority, owner.selection, 8),
          object: outputObject,
          canonicalKey: MarketingCanonicalKey.make("outputs/strategy-summary"),
          schema: ref("saved-output/basic"),
          projection: {
            source: artifactObject,
            revision: { revisionId: artifactV1.revisionId, version: artifactV1.version },
            renderer: {
              key: MarketingCanonicalRegistryKey.make("artifact/summary"),
              version: MarketingCanonicalVersion.make(1),
            },
          },
        });
        const sourceV2 = yield* firstFactory.canonicalStore.write({
          ...baseWrite(ownerAuthority, owner.selection, 9),
          object: sourceObject,
          canonicalKey: source.canonicalKey,
          expectedVersion: MarketingExpectedVersion.make(1),
          schema: ref("source/basic"),
          payload: { value: "current source coverage" },
        });

        assert.equal(plan.sourceLineage[0]?.sourceId, source.object.id);
        assert.equal(artifactV2.version, 2);
        assert.equal(artifactV2.actorId, memberBinding.marketingActorId);
        assert.equal(artifactV1.actorId, ownerBinding.marketingActorId);
        assert.deepEqual(output.projection?.revision, {
          revisionId: artifactV1.revisionId,
          version: artifactV1.version,
        });

        const secondFactory = makeStores(root, observed);
        const ownerInventory = yield* secondFactory.canonicalStore.listInventory({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
        });
        const memberInventory = yield* secondFactory.canonicalStore.listInventory({
          requestAuthority: memberAuthority,
          selection: owner.selection,
        });
        assert.deepEqual(memberInventory, ownerInventory);
        assert.equal(ownerInventory.length, 7);

        const ownerFacts = yield* secondFactory.canonicalStore.queryFacts({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
        });
        const memberFacts = yield* secondFactory.canonicalStore.queryFacts({
          requestAuthority: memberAuthority,
          selection: owner.selection,
        });
        assert.deepEqual(memberFacts, ownerFacts);
        assert.deepEqual(
          ownerFacts.map(({ object, fact }) => ({ object, fact })),
          [
            {
              object: artifactObject,
              fact: {
                key: MarketingCanonicalFactKey.make("review/signal"),
                value: { revisionIds: [review.revisionId] },
              },
            },
            {
              object: reviewObject,
              fact: {
                key: MarketingCanonicalFactKey.make("review/signal"),
                value: { value: "value-4" },
              },
            },
            {
              object: artifactObject,
              fact: {
                key: MarketingCanonicalFactKey.make("source/coverage"),
                value: { revisionIds: [source.revisionId] },
              },
            },
            {
              object: sourceObject,
              fact: {
                key: MarketingCanonicalFactKey.make("source/coverage"),
                value: { value: "current source coverage" },
              },
            },
            {
              object: workflowObject,
              fact: {
                key: MarketingCanonicalFactKey.make("workflow/readiness"),
                value: { value: "value-2" },
              },
            },
          ],
        );
        assert.deepEqual(
          yield* secondFactory.canonicalStore.queryFacts({
            requestAuthority: ownerAuthority,
            selection: owner.selection,
            key: MarketingCanonicalFactKey.make("source/coverage"),
          }),
          ownerFacts.filter(({ fact }) => fact.key === "source/coverage"),
        );
        assert.equal(
          ownerFacts.find(({ object }) => object.id === sourceObject.id)?.revisionId,
          sourceV2.revisionId,
        );
        assert.deepEqual(artifactV2.facts, [
          {
            key: MarketingCanonicalFactKey.make("review/signal"),
            value: { revisionIds: [review.revisionId] },
          },
          {
            key: MarketingCanonicalFactKey.make("source/coverage"),
            value: { revisionIds: [source.revisionId] },
          },
        ]);
        assert.deepEqual(
          (yield* secondFactory.canonicalStore.listRevisions({
            requestAuthority: ownerAuthority,
            selection: owner.selection,
            object: sourceObject,
          })).map((revision) => revision.facts),
          [
            [
              {
                key: MarketingCanonicalFactKey.make("source/coverage"),
                value: { value: "value-1" },
              },
            ],
            [
              {
                key: MarketingCanonicalFactKey.make("source/coverage"),
                value: { value: "current source coverage" },
              },
            ],
          ],
        );

        const ownerHistory = yield* secondFactory.canonicalStore.listRevisions({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
          object: artifactObject,
        });
        const memberHistory = yield* secondFactory.canonicalStore.listRevisions({
          requestAuthority: memberAuthority,
          selection: owner.selection,
          object: artifactObject,
        });
        assert.deepEqual(memberHistory, ownerHistory);
        assert.deepEqual(
          ownerHistory.map((revision) => ({
            version: revision.version,
            actorId: revision.actorId,
            payload: revision.payload,
          })),
          [
            {
              version: MarketingCanonicalVersion.make(1),
              actorId: ownerBinding.marketingActorId,
              payload: { value: "value-6" },
            },
            {
              version: MarketingCanonicalVersion.make(2),
              actorId: memberBinding.marketingActorId,
              payload: { value: "member revision" },
            },
          ],
        );
        const immutableDatabase = new NodeSqlite.DatabaseSync(
          organizationWorkspaceDatabasePath(root, owner.selection.organizationId),
        );
        assert.throws(() =>
          immutableDatabase
            .prepare(
              "UPDATE auldric_canonical_revisions SET payload_json = '{}' WHERE revision_id = ?",
            )
            .run(artifactV1.revisionId),
        );
        immutableDatabase.close();
        assert.deepEqual(
          yield* secondFactory.canonicalStore.read({
            requestAuthority: memberAuthority,
            selection: owner.selection,
            object: outputObject,
          }),
          output,
        );
        assert.isTrue(
          observed.some((requirement) => requirement.operation === "save-artifact-revision"),
        );
        assert.isTrue(
          observed.some(
            (requirement) =>
              requirement.operation === "query-canonical-facts" &&
              requirement.factKey === MarketingCanonicalFactKey.make("source/coverage"),
          ),
        );
        assert.isTrue(
          observed.every(
            (requirement) =>
              requirement.selection.organizationId === owner.selection.organizationId,
          ),
        );
      }),
  );

  it.effect("returns exact stale, duplicate-claim, identity, and idempotency conflicts", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const ownerAuthority = requestAuthority(10);
      const owner = bootstrapInput(10, ownerAuthority);
      const stores = makeStores(root);
      yield* stores.workspaceStore.bootstrap(owner);
      const originalInput = {
        ...baseWrite(ownerAuthority, owner.selection, 10),
        object: { kind: "source" as const, id: MarketingSourceId.make(`msrc_${uuid(10)}`) },
        canonicalKey: MarketingCanonicalKey.make("sources/canonical"),
        schema: ref("source/basic"),
      };

      const original = yield* stores.canonicalStore.write(originalInput);
      assert.deepEqual(yield* stores.canonicalStore.write(originalInput), original);

      const reused = yield* stores.canonicalStore
        .write({ ...originalInput, payload: { value: "different" } })
        .pipe(Effect.flip);
      assert.equal(reused._tag, "MarketingCanonicalConflictError");
      if (reused._tag === "MarketingCanonicalConflictError") {
        assert.equal(reused.reason, "idempotency_key_reused");
      }

      const stale = yield* stores.canonicalStore
        .write({
          ...originalInput,
          idempotencyKey: MarketingIdempotencyKey.make("stale-version"),
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "MarketingCanonicalConflictError");
      if (stale._tag === "MarketingCanonicalConflictError") {
        assert.equal(stale.reason, "stale_version");
        assert.equal(stale.expectedVersion, 0);
        assert.equal(stale.actualVersion, 1);
      }

      const duplicateClaim = yield* stores.canonicalStore
        .write({
          ...originalInput,
          object: { kind: "source", id: MarketingSourceId.make(`msrc_${uuid(11)}`) },
          idempotencyKey: MarketingIdempotencyKey.make("duplicate-claim"),
        })
        .pipe(Effect.flip);
      assert.equal(duplicateClaim._tag, "MarketingCanonicalConflictError");
      if (duplicateClaim._tag === "MarketingCanonicalConflictError") {
        assert.equal(duplicateClaim.reason, "duplicate_canonical_claim");
      }

      const identityConflict = yield* stores.canonicalStore
        .write({
          ...originalInput,
          canonicalKey: MarketingCanonicalKey.make("sources/renamed-claim"),
          idempotencyKey: MarketingIdempotencyKey.make("identity-conflict"),
        })
        .pipe(Effect.flip);
      assert.equal(identityConflict._tag, "MarketingCanonicalConflictError");
      if (identityConflict._tag === "MarketingCanonicalConflictError") {
        assert.equal(identityConflict.reason, "canonical_identity_conflict");
      }

      const revisions = yield* stores.canonicalStore.listRevisions({
        requestAuthority: ownerAuthority,
        selection: owner.selection,
        object: original.object,
      });
      assert.equal(revisions.length, 1);
    }),
  );

  it.effect("serializes concurrent expected-version writes across store factories", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const ownerAuthority = requestAuthority(15);
      const owner = bootstrapInput(15, ownerAuthority);
      const first = makeStores(root);
      const second = makeStores(root);
      yield* first.workspaceStore.bootstrap(owner);
      const sourceObject = {
        kind: "source" as const,
        id: MarketingSourceId.make(`msrc_${uuid(15)}`),
      };
      yield* first.canonicalStore.write({
        ...baseWrite(ownerAuthority, owner.selection, 15),
        object: sourceObject,
        canonicalKey: MarketingCanonicalKey.make("sources/concurrent"),
        schema: ref("source/basic"),
      });

      const attempts = yield* Effect.all(
        [
          first.canonicalStore.write({
            ...baseWrite(ownerAuthority, owner.selection, 151),
            object: sourceObject,
            canonicalKey: MarketingCanonicalKey.make("sources/concurrent"),
            expectedVersion: MarketingExpectedVersion.make(1),
            schema: ref("source/basic"),
            payload: { value: "first contender" },
          }),
          second.canonicalStore.write({
            ...baseWrite(ownerAuthority, owner.selection, 152),
            object: sourceObject,
            canonicalKey: MarketingCanonicalKey.make("sources/concurrent"),
            expectedVersion: MarketingExpectedVersion.make(1),
            schema: ref("source/basic"),
            payload: { value: "second contender" },
          }),
        ].map(Effect.result),
        { concurrency: "unbounded" },
      );

      assert.equal(attempts.filter((result) => result._tag === "Success").length, 1);
      const failure = attempts.find((result) => result._tag === "Failure");
      assert.isDefined(failure);
      if (failure?._tag === "Failure") {
        assert.equal(failure.failure._tag, "MarketingCanonicalConflictError");
        if (failure.failure._tag === "MarketingCanonicalConflictError") {
          assert.equal(failure.failure.reason, "stale_version");
          assert.equal(failure.failure.actualVersion, 2);
        }
      }
      assert.equal(
        (yield* second.canonicalStore.listRevisions({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
          object: sourceObject,
        })).length,
        2,
      );
    }),
  );

  it.effect("keeps registered views separate from canonical artifact heads", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const ownerAuthority = requestAuthority(20);
      const owner = bootstrapInput(20, ownerAuthority);
      const stores = makeStores(root);
      yield* stores.workspaceStore.bootstrap(owner);
      const artifact = yield* stores.canonicalStore.write({
        ...baseWrite(ownerAuthority, owner.selection, 20),
        object: { kind: "artifact", id: MarketingArtifactId.make(`mart_${uuid(20)}`) },
        canonicalKey: MarketingCanonicalKey.make("artifacts/canonical"),
        schema: ref("artifact/basic"),
      });
      const outputInput = {
        ...baseWrite(ownerAuthority, owner.selection, 21),
        object: {
          kind: "saved-output" as const,
          id: MarketingSavedOutputId.make(`mout_${uuid(21)}`),
        },
        canonicalKey: MarketingCanonicalKey.make("outputs/registered"),
        schema: ref("saved-output/basic"),
        projection: {
          source: artifact.object,
          revision: { revisionId: artifact.revisionId, version: artifact.version },
          renderer: {
            key: MarketingCanonicalRegistryKey.make("artifact/summary"),
            version: MarketingCanonicalVersion.make(1),
          },
        },
      };
      const outputV1 = yield* stores.canonicalStore.saveRegisteredOutput(outputInput);
      const outputV2 = yield* stores.canonicalStore.saveRegisteredOutput({
        ...outputInput,
        expectedVersion: MarketingExpectedVersion.make(1),
        idempotencyKey: MarketingIdempotencyKey.make("output-v2"),
        payload: { value: "regenerated" },
      });
      assert.equal(outputV2.version, 2);
      assert.deepEqual(yield* stores.canonicalStore.saveRegisteredOutput(outputInput), outputV1);
      assert.equal(
        (yield* stores.canonicalStore.read({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
          object: artifact.object,
        })).version,
        1,
      );

      const invalidTarget = yield* stores.canonicalStore
        .saveRegisteredOutput({
          ...outputInput,
          object: artifact.object as never,
          idempotencyKey: MarketingIdempotencyKey.make("projection-artifact-target"),
        })
        .pipe(Effect.flip);
      assert.equal(invalidTarget._tag, "MarketingCanonicalValidationError");

      const outputChain = yield* stores.canonicalStore
        .saveRegisteredOutput({
          ...outputInput,
          object: {
            kind: "saved-output",
            id: MarketingSavedOutputId.make(`mout_${uuid(22)}`),
          },
          canonicalKey: MarketingCanonicalKey.make("outputs/chained"),
          idempotencyKey: MarketingIdempotencyKey.make("output-chain"),
          projection: { ...outputInput.projection, source: outputV1.object },
        })
        .pipe(Effect.flip);
      assert.equal(outputChain._tag, "MarketingCanonicalConflictError");
      if (outputChain._tag === "MarketingCanonicalConflictError") {
        assert.equal(outputChain.reason, "projection_source_cannot_be_saved_output");
      }

      const unknownRenderer = yield* stores.canonicalStore
        .saveRegisteredOutput({
          ...outputInput,
          object: {
            kind: "saved-output",
            id: MarketingSavedOutputId.make(`mout_${uuid(23)}`),
          },
          canonicalKey: MarketingCanonicalKey.make("outputs/unknown-renderer"),
          idempotencyKey: MarketingIdempotencyKey.make("unknown-renderer"),
          projection: {
            ...outputInput.projection,
            renderer: {
              key: MarketingCanonicalRegistryKey.make("artifact/unregistered"),
              version: MarketingCanonicalVersion.make(1),
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(unknownRenderer._tag, "MarketingCanonicalValidationError");
      if (unknownRenderer._tag === "MarketingCanonicalValidationError") {
        assert.equal(unknownRenderer.reason, "renderer_reference_unregistered");
      }

      const missingRevision = yield* stores.canonicalStore
        .saveRegisteredOutput({
          ...outputInput,
          object: {
            kind: "saved-output",
            id: MarketingSavedOutputId.make(`mout_${uuid(25)}`),
          },
          canonicalKey: MarketingCanonicalKey.make("outputs/missing-revision"),
          idempotencyKey: MarketingIdempotencyKey.make("missing-projection-revision"),
          projection: {
            ...outputInput.projection,
            revision: {
              revisionId: MarketingCanonicalRevisionId.make(`mcrv_${uuid(25)}`),
              version: MarketingCanonicalVersion.make(1),
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(missingRevision._tag, "MarketingCanonicalConflictError");
      if (missingRevision._tag === "MarketingCanonicalConflictError") {
        assert.equal(missingRevision.reason, "referenced_revision_missing");
      }

      const plan = yield* stores.canonicalStore.write({
        ...baseWrite(ownerAuthority, owner.selection, 24),
        object: { kind: "plan", id: MarketingPlanId.make(`mpln_${uuid(24)}`) },
        canonicalKey: MarketingCanonicalKey.make("plans/not-renderable-as-artifact"),
        schema: ref("plan/basic"),
      });
      const incompatibleRenderer = yield* stores.canonicalStore
        .saveRegisteredOutput({
          ...outputInput,
          object: {
            kind: "saved-output",
            id: MarketingSavedOutputId.make(`mout_${uuid(24)}`),
          },
          canonicalKey: MarketingCanonicalKey.make("outputs/incompatible-renderer"),
          idempotencyKey: MarketingIdempotencyKey.make("incompatible-renderer"),
          projection: {
            ...outputInput.projection,
            source: plan.object,
            revision: { revisionId: plan.revisionId, version: plan.version },
          },
        })
        .pipe(Effect.flip);
      assert.equal(incompatibleRenderer._tag, "MarketingCanonicalValidationError");
      if (incompatibleRenderer._tag === "MarketingCanonicalValidationError") {
        assert.equal(incompatibleRenderer.reason, "renderer_reference_incompatible");
      }
    }),
  );

  it.effect(
    "fails closed for invalid JSON, unregistered schemas, and corrupt stored payloads",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(now.epochMilliseconds);
        const root = makeRoot();
        const ownerAuthority = requestAuthority(30);
        const owner = bootstrapInput(30, ownerAuthority);
        const stores = makeStores(root);
        yield* stores.workspaceStore.bootstrap(owner);
        const base = {
          ...baseWrite(ownerAuthority, owner.selection, 30),
          object: { kind: "source" as const, id: MarketingSourceId.make(`msrc_${uuid(30)}`) },
          canonicalKey: MarketingCanonicalKey.make("sources/validation"),
          schema: ref("source/basic"),
        };

        const nonJson = yield* stores.canonicalStore
          .write({ ...base, payload: { value: Number.NaN } })
          .pipe(Effect.flip);
        assert.equal(nonJson._tag, "MarketingCanonicalValidationError");
        if (nonJson._tag === "MarketingCanonicalValidationError") {
          assert.equal(nonJson.reason, "payload_not_json");
        }

        const invalidShape = yield* stores.canonicalStore
          .write({
            ...base,
            idempotencyKey: MarketingIdempotencyKey.make("invalid-shape"),
            payload: { wrong: "field" },
          })
          .pipe(Effect.flip);
        assert.equal(invalidShape._tag, "MarketingCanonicalValidationError");
        if (invalidShape._tag === "MarketingCanonicalValidationError") {
          assert.equal(invalidShape.reason, "payload_schema_invalid");
        }

        const unknownSchema = yield* stores.canonicalStore
          .write({
            ...base,
            idempotencyKey: MarketingIdempotencyKey.make("unknown-schema"),
            schema: ref("source/unregistered"),
          })
          .pipe(Effect.flip);
        assert.equal(unknownSchema._tag, "MarketingCanonicalValidationError");
        if (unknownSchema._tag === "MarketingCanonicalValidationError") {
          assert.equal(unknownSchema.reason, "schema_reference_unregistered");
        }

        const incompatibleSchema = yield* stores.canonicalStore
          .write({
            ...base,
            idempotencyKey: MarketingIdempotencyKey.make("incompatible-schema"),
            schema: ref("review/basic"),
          })
          .pipe(Effect.flip);
        assert.equal(incompatibleSchema._tag, "MarketingCanonicalValidationError");
        if (incompatibleSchema._tag === "MarketingCanonicalValidationError") {
          assert.equal(incompatibleSchema.reason, "schema_reference_incompatible");
        }

        const incompatibleDefinition = yield* stores.canonicalStore
          .write({
            ...base,
            idempotencyKey: MarketingIdempotencyKey.make("incompatible-definition"),
            definition: {
              key: MarketingCanonicalRegistryKey.make("workflow/marketing-strategy"),
              version: MarketingCanonicalVersion.make(1),
            },
          })
          .pipe(Effect.flip);
        assert.equal(incompatibleDefinition._tag, "MarketingCanonicalValidationError");
        if (incompatibleDefinition._tag === "MarketingCanonicalValidationError") {
          assert.equal(incompatibleDefinition.reason, "definition_reference_incompatible");
        }

        const unknownDefinition = yield* stores.canonicalStore
          .write({
            ...base,
            object: {
              kind: "workflow-instance",
              id: MarketingWorkflowInstanceId.make(`mwfi_${uuid(31)}`),
            },
            canonicalKey: MarketingCanonicalKey.make("workflows/unregistered"),
            idempotencyKey: MarketingIdempotencyKey.make("unknown-definition"),
            schema: ref("workflow/instance"),
            definition: {
              key: MarketingCanonicalRegistryKey.make("workflow/unknown"),
              version: MarketingCanonicalVersion.make(1),
            },
          })
          .pipe(Effect.flip);
        assert.equal(unknownDefinition._tag, "MarketingCanonicalValidationError");
        if (unknownDefinition._tag === "MarketingCanonicalValidationError") {
          assert.equal(unknownDefinition.reason, "definition_reference_unregistered");
        }

        const stored = yield* stores.canonicalStore.write(base);
        const databasePath = organizationWorkspaceDatabasePath(
          root,
          owner.selection.organizationId,
        );
        const database = new NodeSqlite.DatabaseSync(databasePath);
        const invalidStoredJson = "{";
        database.exec("DROP TRIGGER auldric_canonical_revisions_immutable_update;");
        database
          .prepare(
            `UPDATE auldric_canonical_revisions
           SET payload_json = ?, payload_sha256 = ? WHERE revision_id = ?`,
          )
          .run(
            invalidStoredJson,
            NodeCrypto.createHash("sha256").update(invalidStoredJson).digest("hex"),
            stored.revisionId,
          );
        database.exec(`
        CREATE TRIGGER auldric_canonical_revisions_immutable_update
        BEFORE UPDATE ON auldric_canonical_revisions
        BEGIN
          SELECT RAISE(ABORT, 'canonical revisions are immutable');
        END;
      `);
        database.close();

        const corrupt = yield* stores.canonicalStore
          .read({
            requestAuthority: ownerAuthority,
            selection: owner.selection,
            object: stored.object,
          })
          .pipe(Effect.flip);
        assert.equal(corrupt._tag, "MarketingCanonicalValidationError");
        if (corrupt._tag === "MarketingCanonicalValidationError") {
          assert.equal(corrupt.reason, "invalid_stored_payload");
        }
      }),
  );

  it.effect("never falls back across organizations or after workspace deletion", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const firstAuthority = requestAuthority(40);
      const secondAuthority = requestAuthority(41);
      const first = bootstrapInput(40, firstAuthority);
      const second = bootstrapInput(41, secondAuthority);
      const stores = makeStores(root);
      yield* stores.workspaceStore.bootstrap(first);
      yield* stores.workspaceStore.bootstrap(second);
      const source = yield* stores.canonicalStore.write({
        ...baseWrite(firstAuthority, first.selection, 40),
        object: { kind: "source", id: MarketingSourceId.make(`msrc_${uuid(40)}`) },
        canonicalKey: MarketingCanonicalKey.make("sources/only-first-org"),
        schema: ref("source/basic"),
      });

      const secondRead = yield* stores.canonicalStore
        .read({
          requestAuthority: secondAuthority,
          selection: second.selection,
          object: source.object,
        })
        .pipe(Effect.flip);
      assert.equal(secondRead._tag, "MarketingCanonicalNotFoundError");

      const firstScoped = requestAuthority(
        40,
        new Set<MarketingWorkspacePermission>(["resolve-workspace"]),
        allContentOperations,
        first.selection.organizationId,
      );
      const wrongOrganization = yield* stores.canonicalStore
        .read({
          requestAuthority: firstScoped,
          selection: second.selection,
          object: source.object,
        })
        .pipe(Effect.flip);
      assert.equal(wrongOrganization._tag, "MarketingActorResolutionError");

      assert.isTrue(
        yield* stores.workspaceStore.deleteOrganizationWorkspace({
          requestAuthority: firstAuthority,
          selection: first.selection,
        }),
      );
      assert.isFalse(
        NodeFS.existsSync(organizationWorkspaceDatabasePath(root, first.selection.organizationId)),
      );
      const afterDeletion = yield* stores.canonicalStore
        .read({
          requestAuthority: firstAuthority,
          selection: first.selection,
          object: source.object,
        })
        .pipe(Effect.flip);
      assert.equal(afterDeletion._tag, "MarketingActorResolutionError");
    }),
  );

  it.effect("rejects an interrupted v1-to-v2 migration without partial activation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const ownerAuthority = requestAuthority(50);
      const owner = bootstrapInput(50, ownerAuthority);
      const first = makeStores(root);
      yield* first.workspaceStore.bootstrap(owner);
      const databasePath = organizationWorkspaceDatabasePath(root, owner.selection.organizationId);
      const database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TABLE auldric_canonical_idempotency;
        DROP TABLE auldric_canonical_projection_facts;
        DROP TABLE auldric_canonical_revision_references;
        DROP TABLE auldric_canonical_revisions;
        DROP TABLE auldric_canonical_objects;
        DELETE FROM auldric_organization_schema_migrations WHERE version = 2;
        CREATE TABLE auldric_canonical_objects(interrupted TEXT NOT NULL);
      `);
      database.close();

      const failure = yield* makeStores(root)
        .canonicalStore.listInventory({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "MarketingWorkspaceStoreError");

      const inspection = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      const versions = inspection
        .prepare("SELECT version FROM auldric_organization_schema_migrations ORDER BY version")
        .all() as unknown as ReadonlyArray<{ readonly version: number }>;
      const columns = inspection
        .prepare("PRAGMA table_info(auldric_canonical_objects)")
        .all() as unknown as ReadonlyArray<{ readonly name: string }>;
      inspection.close();
      assert.deepEqual(versions, [{ version: 1 }]);
      assert.deepEqual(
        columns.map((column) => column.name),
        ["interrupted"],
      );
    }),
  );

  it.effect("rejects a v2 schema whose immutability trigger was replaced by name", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const ownerAuthority = requestAuthority(51);
      const owner = bootstrapInput(51, ownerAuthority);
      const stores = makeStores(root);
      yield* stores.workspaceStore.bootstrap(owner);
      const database = new NodeSqlite.DatabaseSync(
        organizationWorkspaceDatabasePath(root, owner.selection.organizationId),
      );
      database.exec(`
        DROP TRIGGER auldric_canonical_revisions_immutable_update;
        CREATE TRIGGER auldric_canonical_revisions_immutable_update
        BEFORE UPDATE ON auldric_canonical_revisions
        BEGIN
          SELECT 1;
        END;
      `);
      database.close();

      const failure = yield* makeStores(root)
        .canonicalStore.listInventory({
          requestAuthority: ownerAuthority,
          selection: owner.selection,
        })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "MarketingWorkspaceUnavailableError");
      if (failure._tag === "MarketingWorkspaceUnavailableError") {
        assert.equal(failure.reason, "workspace_database_schema_stale");
      }
    }),
  );

  it.effect("requires independent opaque content authorization after workspace resolution", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now.epochMilliseconds);
      const root = makeRoot();
      const ownerAuthority = requestAuthority(60);
      const owner = bootstrapInput(60, ownerAuthority);
      const stores = makeStores(root);
      yield* stores.workspaceStore.bootstrap(owner);

      const readOnly = requestAuthority(
        60,
        new Set<MarketingWorkspacePermission>(["resolve-workspace"]),
        new Set<MarketingCanonicalContentOperation>(["read-canonical-object"]),
        owner.selection.organizationId,
      );
      const denied = yield* stores.canonicalStore
        .write({
          ...baseWrite(readOnly, owner.selection, 60),
          object: { kind: "next-action", id: MarketingNextActionId.make(`mnxt_${uuid(60)}`) },
          canonicalKey: MarketingCanonicalKey.make("next-actions/denied"),
          schema: ref("next-action/basic"),
        })
        .pipe(Effect.flip);
      assert.equal(denied._tag, "MarketingCanonicalAuthorizationError");

      const deniedFacts = yield* stores.canonicalStore
        .queryFacts({ requestAuthority: readOnly, selection: owner.selection })
        .pipe(Effect.flip);
      assert.equal(deniedFacts._tag, "MarketingCanonicalAuthorizationError");

      const clone = {} as TestRequestAuthority;
      const copiedAuthority = yield* stores.canonicalStore
        .listInventory({ requestAuthority: clone, selection: owner.selection })
        .pipe(Effect.flip);
      assert.equal(copiedAuthority._tag, "MarketingActorResolutionError");
    }),
  );
});
