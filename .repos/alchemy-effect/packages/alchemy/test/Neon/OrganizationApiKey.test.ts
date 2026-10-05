import {
  OrganizationApiKey,
  recoverOrganizationApiKey,
  type OrganizationApiKeyAttributes,
  type OrganizationApiKeyProps,
} from "@/Neon/OrganizationApiKey.ts";
import { Project } from "@/Neon/Project.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: providers() });

const context = {
  id: "OrganizationKeySafety",
  fqn: "OrganizationKeySafety",
  instanceId: "organization-key-safety",
  oldBindings: [],
  newBindings: [],
  bindings: [],
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
};

type Assert<T extends true> = T;
type OutputAlwaysRedacted = Assert<
  OrganizationApiKeyAttributes["key"] extends Redacted.Redacted<string>
    ? true
    : false
>;
type NoBranchScope = Assert<
  "branchId" extends keyof OrganizationApiKeyProps ? false : true
>;
type NoSecretInput = Assert<
  "key" extends keyof OrganizationApiKeyProps ? false : true
>;
const typeAssertions: [OutputAlwaysRedacted, NoBranchScope, NoSecretInput] = [
  true,
  true,
  true,
];

const scope = { orgId: "org-safety", projectId: "project-safety" };
const cached: OrganizationApiKeyAttributes = {
  ...scope,
  keyId: 123,
  name: "safety-key",
  key: Redacted.make("safety-only-not-a-deployment-token"),
  createdAt: "2026-09-17T00:00:00Z",
};
const metadata = {
  id: cached.keyId,
  name: cached.name,
  project_id: cached.projectId,
  created_at: cached.createdAt,
};

test(
  "key types exclude branch scope and secret inputs and require a redacted output",
  Effect.sync(() => expect(typeAssertions.every(Boolean)).toBe(true)),
  { tags: ["provider:neon", "provider:neon:organizationapikey", "live"] },
);

test(
  "pure recovery preserves the secret only for the exact observed ID and scope",
  Effect.gen(function* () {
    const recovered = yield* recoverOrganizationApiKey(scope, metadata, cached);
    expect(recovered.key).toBe(cached.key);
    expect(recovered.keyId).toBe(cached.keyId);
    const renamed = yield* recoverOrganizationApiKey(
      scope,
      { ...metadata, name: "observed-label" },
      cached,
    );
    expect(renamed.key).toBe(cached.key);
    expect(renamed.name).toBe("observed-label");
    expect(JSON.stringify(recovered)).not.toContain(Redacted.value(cached.key));
  }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationapikey",
      "local",
    ],
  },
);

test(
  "pure recovery rejects missing secrets, revoked IDs, same-name impostors, and scope changes without leaking tokens",
  Effect.gen(function* () {
    const missingSecret = { ...cached };
    yield* Effect.sync(() => Reflect.deleteProperty(missingSecret, "key"));
    const cases = [
      recoverOrganizationApiKey(scope, metadata, undefined),
      recoverOrganizationApiKey(scope, metadata, missingSecret),
      recoverOrganizationApiKey(scope, undefined, cached),
      recoverOrganizationApiKey(scope, { ...metadata, id: 124 }, cached),
      recoverOrganizationApiKey(scope, { ...metadata, id: NaN }, cached),
      recoverOrganizationApiKey(
        scope,
        { ...metadata, project_id: "other-project" },
        cached,
      ),
      recoverOrganizationApiKey(
        scope,
        { ...metadata, project_id: undefined },
        cached,
      ),
      recoverOrganizationApiKey(
        { ...scope, orgId: "other-org" },
        metadata,
        cached,
      ),
      recoverOrganizationApiKey(
        { ...scope, projectId: undefined },
        metadata,
        cached,
      ),
      recoverOrganizationApiKey(scope, metadata, {
        ...cached,
        key: Redacted.make(""),
      }),
    ];
    for (const recovery of cases) {
      const result = yield* recovery.pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("OrganizationApiKeyRecoveryError");
        expect(result.failure.message).toContain(
          "Restore the original Alchemy state",
        );
        expect(result.failure.message).not.toContain(
          Redacted.value(cached.key),
        );
        expect(JSON.stringify(result.failure)).not.toContain(
          Redacted.value(cached.key),
        );
      }
    }
  }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationapikey",
      "local",
    ],
  },
);

test.provider(
  "immutable scope/name and unresolved identity changes plan replacements, never in-place rotation",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationApiKey.Provider;
      for (const news of [
        { ...scope, orgId: "other-org" },
        { ...scope, projectId: "other-project" },
        { ...scope, projectId: undefined },
        { ...scope, name: "another-name" },
        { ...scope, orgId: Output.literal(scope.orgId) },
        { ...scope, projectId: Output.literal(scope.projectId) },
      ]) {
        expect(
          yield* provider.diff!({
            ...context,
            olds: scope,
            news,
            output: cached,
          }),
        ).toMatchObject({ action: "replace" });
      }
      expect(
        yield* provider.diff!({
          ...context,
          olds: scope,
          news: scope,
          output: cached,
        }),
      ).toBeUndefined();
      expect(
        yield* provider.diff!({
          ...context,
          olds: { ...scope, name: cached.name },
          news: { ...scope, projectId: "other-project", name: cached.name },
          output: cached,
        }),
      ).toMatchObject({ action: "replace", deleteFirst: true });
    }),
  { tags: ["provider:neon", "provider:neon:organizationapikey", "live"] },
);

test.provider(
  "reconciliation rejects mismatched cached scope and lost existing output before any cloud call",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationApiKey.Provider;
      for (const news of [
        { ...scope, orgId: "other-org" },
        { ...scope, projectId: "other-project" },
        { ...scope, projectId: undefined },
        { ...scope, name: "another-name" },
        { ...scope, orgId: "" },
        { ...scope, projectId: "" },
      ]) {
        expect(
          yield* provider
            .reconcile({ ...context, olds: scope, news, output: cached })
            .pipe(
              Effect.as(false),
              Effect.catchTag("OrganizationApiKeyRecoveryError", () =>
                Effect.succeed(true),
              ),
            ),
        ).toBe(true);
      }
      expect(
        yield* provider
          .reconcile({
            ...context,
            olds: scope,
            news: scope,
            output: undefined,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("OrganizationApiKeyRecoveryError", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
    }),
  { tags: ["provider:neon", "provider:neon:organizationapikey", "live"] },
);

test.provider(
  "pure name diff replaces added or removed explicit names even when the observed label matches",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationApiKey.Provider;
      const named = { ...scope, name: cached.name };
      for (const [olds, news] of [
        [named, scope],
        [scope, named],
      ] as const) {
        expect(
          yield* provider.diff!({ ...context, olds, news, output: cached }),
        ).toMatchObject({ action: "replace" });
        expect(
          yield* provider
            .reconcile({ ...context, olds, news, output: cached })
            .pipe(
              Effect.as(false),
              Effect.catchTag("OrganizationApiKeyRecoveryError", () =>
                Effect.succeed(true),
              ),
            ),
        ).toBe(true);
      }
      expect(
        yield* provider.diff!({
          ...context,
          olds: named,
          news: scope,
          output: cached,
        }),
      ).toMatchObject({ action: "replace", deleteFirst: false });
      for (const props of [scope, named]) {
        expect(
          yield* provider.diff!({
            ...context,
            olds: props,
            news: props,
            output: cached,
          }),
        ).toBeUndefined();
      }
    }),
  { tags: ["provider:neon", "provider:neon:organizationapikey", "live"] },
);

const orgId = process.env.NEON_GOVERNANCE_TEST_ORG_ID;

test.provider.skipIf(!orgId)(
  "project-restricted organization key lifecycle, recovery refusal, replacement and idempotent revoke",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const application = (renamed = false) =>
        Effect.gen(function* () {
          const project = yield* Project("OrganizationKeyProject", {
            orgId: orgId!,
            region: "aws-us-east-2",
          });
          const key = yield* OrganizationApiKey("OrganizationKey", {
            orgId: orgId!,
            projectId: project.projectId,
            ...(renamed ? { name: "alchemy-governance-replaced-key" } : {}),
          });
          return { project, key };
        });
      const first = yield* stack.deploy(application());
      expect(first.key.orgId).toBe(orgId!);
      expect(first.key.projectId).toBe(first.project.projectId);
      expect(Redacted.isRedacted(first.key.key)).toBe(true);
      expect(first.key.name).toBeTruthy();
      const request = { org_id: orgId! };
      const listed = yield* SDK.listOrgApiKeys(request);
      expect(listed.find((key) => key.id === first.key.keyId)).toMatchObject({
        name: first.key.name,
        project_id: first.project.projectId,
      });
      const provider = yield* OrganizationApiKey.Provider;
      const props = {
        orgId: orgId!,
        projectId: first.project.projectId,
        name: first.key.name,
      };
      const refreshed = yield* provider.read!({
        ...context,
        olds: props,
        output: first.key,
      });
      expect(refreshed?.key).toBe(first.key.key);
      for (const recovery of [
        provider.read!({ ...context, olds: props, output: undefined }),
        provider.reconcile({
          ...context,
          olds: undefined,
          news: props,
          output: undefined,
        }),
      ]) {
        expect(
          yield* recovery.pipe(
            Effect.as(false),
            Effect.catchTag("OrganizationApiKeyRecoveryError", () =>
              Effect.succeed(true),
            ),
          ),
        ).toBe(true);
      }
      const again = yield* stack.deploy(application());
      expect(again.key.keyId).toBe(first.key.keyId);
      expect(Redacted.value(again.key.key)).toBe(Redacted.value(first.key.key));
      const replaced = yield* stack.deploy(application(true));
      expect(replaced.project.projectId).toBe(first.project.projectId);
      expect(replaced.key.keyId).not.toBe(first.key.keyId);
      const remaining = yield* SDK.listOrgApiKeys(request).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (keys) => !keys.some((key) => key.id === first.key.keyId),
          times: 8,
        }),
      );
      expect(remaining.some((key) => key.id === first.key.keyId)).toBe(false);
      expect(
        remaining.find((key) => key.id === replaced.key.keyId)?.project_id,
      ).toBe(first.project.projectId);
      yield* SDK.revokeOrgApiKey({ ...request, key_id: replaced.key.keyId });
      expect(
        yield* provider
          .reconcile({
            ...context,
            olds: { ...props, name: replaced.key.name },
            news: { ...props, name: replaced.key.name },
            output: replaced.key,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("OrganizationApiKeyRecoveryError", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
      yield* provider.delete({
        ...context,
        olds: { ...props, name: replaced.key.name },
        output: replaced.key,
      });
      yield* provider.delete({
        ...context,
        olds: { ...props, name: replaced.key.name },
        output: replaced.key,
      });
      yield* stack.destroy();
      expect(
        (yield* SDK.listOrgApiKeys(request)).some(
          (key) => key.id === replaced.key.keyId || key.id === first.key.keyId,
        ),
      ).toBe(false);
      expect(
        yield* SDK.getProject({ project_id: first.project.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:organizationapikey",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
