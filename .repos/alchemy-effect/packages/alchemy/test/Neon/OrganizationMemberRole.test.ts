import { adopt } from "@/AdoptPolicy.ts";
import {
  GovernanceRoleSafetyError,
  OrganizationMemberRole,
  governanceRoleTransition,
  organizationRoleTransition,
  sameOrganizationRole,
  requireGovernanceBaseline,
  validateGovernanceActor,
  validateGovernanceScope,
  validateOrganizationRole,
  type GovernanceRoleBaseline,
  type OrganizationRole,
} from "@/Neon/OrganizationMemberRole.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect, test as unit } from "alchemy-test";
import * as Effect from "effect/Effect";

const baseline: GovernanceRoleBaseline<OrganizationRole> = {
  fqn: "MemberRole",
  instanceId: "generation-one",
  userId: "authorized-user",
  originalRole: "member",
  managedRole: "viewer",
};

const refused = <A, R>(
  effect: Effect.Effect<A, GovernanceRoleSafetyError, R>,
) =>
  effect.pipe(
    Effect.as(false),
    Effect.catchTag("NeonGovernanceRoleSafetyError", () =>
      Effect.succeed(true),
    ),
  );

unit.effect(
  "organization role validation rejects missing explicit scope and unknown roles",
  () =>
    Effect.gen(function* () {
      expect(yield* refused(validateGovernanceScope(undefined))).toBe(true);
      expect(
        yield* refused(
          validateGovernanceScope({ orgId: "", memberId: "member" }),
        ),
      ).toBe(true);
      expect(
        yield* refused(
          validateGovernanceScope({ orgId: "org", memberId: " " }),
        ),
      ).toBe(true);
      for (const role of [
        "admin",
        "member",
        "editor",
        "viewer",
        "collaborator",
      ] as const) {
        yield* validateOrganizationRole(role);
      }
      // @ts-expect-error Runtime validation protects JavaScript callers and persisted state.
      expect(yield* refused(validateOrganizationRole("owner"))).toBe(true);
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "organization baseline is mandatory and bound to the resource generation",
  () =>
    Effect.gen(function* () {
      const owner = { fqn: baseline.fqn, instanceId: baseline.instanceId };
      expect(
        yield* refused(
          requireGovernanceBaseline<OrganizationRole>(undefined, owner),
        ),
      ).toBe(true);
      expect(
        yield* refused(
          requireGovernanceBaseline(baseline, { ...owner, fqn: "Other" }),
        ),
      ).toBe(true);
      expect(
        yield* refused(
          requireGovernanceBaseline(baseline, {
            ...owner,
            instanceId: "replacement",
          }),
        ),
      ).toBe(true);
      expect(yield* requireGovernanceBaseline(baseline, owner)).toEqual(
        baseline,
      );
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "organization role transitions preserve the original baseline and reject external edits",
  () =>
    Effect.gen(function* () {
      expect(
        yield* governanceRoleTransition(baseline, "viewer", "editor"),
      ).toBe(true);
      expect(
        yield* governanceRoleTransition(baseline, "viewer", "viewer"),
      ).toBe(false);
      expect(
        yield* refused(governanceRoleTransition(baseline, "admin", "editor")),
      ).toBe(true);
      expect(
        yield* refused(governanceRoleTransition(baseline, "editor", "editor")),
      ).toBe(true);
      expect(baseline.originalRole).toBe("member");
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "organization restoration is exact, idempotent and refuses out-of-band roles",
  () =>
    Effect.gen(function* () {
      expect(
        yield* governanceRoleTransition(baseline, "viewer", "member", true),
      ).toBe(true);
      expect(
        yield* governanceRoleTransition(baseline, "member", "member", true),
      ).toBe(false);
      expect(
        yield* refused(
          governanceRoleTransition(baseline, "editor", "member", true),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "governance refuses changes to the current actor or an unknown identity",
  () =>
    Effect.gen(function* () {
      expect(yield* refused(validateGovernanceActor("actor", "actor"))).toBe(
        true,
      );
      expect(yield* refused(validateGovernanceActor("", "actor"))).toBe(true);
      expect(yield* refused(validateGovernanceActor("member", ""))).toBe(true);
      yield* validateGovernanceActor("authorized-member", "administrator");
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "organization roles accept Neon's legacy member/editor alias without changing permissions",
  () =>
    Effect.gen(function* () {
      const legacy = { ...baseline, managedRole: "member" as const };
      expect(sameOrganizationRole("member", "editor")).toBe(true);
      expect(sameOrganizationRole("viewer", "editor")).toBe(false);
      expect(
        yield* organizationRoleTransition(legacy, "editor", "member"),
      ).toBe(false);
      expect(
        yield* organizationRoleTransition(legacy, "editor", "viewer"),
      ).toBe(true);
      expect(
        yield* organizationRoleTransition(baseline, "editor", "member", true),
      ).toBe(false);
      expect(
        yield* refused(organizationRoleTransition(legacy, "admin", "editor")),
      ).toBe(true);
      expect(legacy.originalRole).toBe("member");
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "local",
    ],
  },
);

const { test } = Test.make({ providers: providers() });

const context = {
  id: "MemberRole",
  fqn: baseline.fqn,
  instanceId: baseline.instanceId,
  oldBindings: [],
  newBindings: [],
  bindings: [],
  session: {
    emit: () => Effect.void,
    done: () => Effect.void,
    note: () => Effect.void,
  },
};

const noCloudCredentials = Effect.die(
  "Safety-only governance tests must not issue Neon requests",
);

test.provider(
  "organization role identity changes are refused by diff before cloud I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationMemberRole.Provider;
      const olds = {
        orgId: "org-original",
        memberId: "member-original",
        role: "viewer" as const,
      };
      const owned = { ...olds, baseline };
      for (const output of [undefined, owned]) {
        for (const news of [
          { ...olds, orgId: "org-other" },
          { ...olds, memberId: "member-other" },
        ]) {
          expect(
            yield* refused(provider.diff!({ ...context, olds, news, output })),
          ).toBe(true);
        }
        expect(
          yield* provider.diff!({
            ...context,
            olds,
            news: { ...olds, role: "editor" },
            output,
          }),
        ).toBeUndefined();
      }
    }).pipe(Effect.provideService(SDK.Credentials, noCloudCredentials)),
  {
    tags: ["provider:neon", "provider:neon:organizationmemberrole", "live"],
    timeout: 120_000,
  },
);

test.provider(
  "organization read reconcile and delete reject missing baselines before cloud I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationMemberRole.Provider;
      const news = {
        orgId: "org-original",
        memberId: "member-original",
        role: "viewer" as const,
      };
      for (const olds of [undefined, news]) {
        expect(
          yield* refused(
            provider.reconcile({ ...context, news, olds, output: undefined }),
          ),
        ).toBe(true);
      }
      const output = { ...news, baseline };
      yield* Effect.sync(() => Reflect.deleteProperty(output, "baseline"));
      expect(
        yield* refused(provider.read!({ ...context, olds: news, output })),
      ).toBe(true);
      expect(
        yield* refused(
          provider.reconcile({ ...context, news, olds: news, output }),
        ),
      ).toBe(true);
      expect(
        yield* refused(provider.delete({ ...context, olds: news, output })),
      ).toBe(true);
    }).pipe(Effect.provideService(SDK.Credentials, noCloudCredentials)),
  {
    tags: ["provider:neon", "provider:neon:organizationmemberrole", "live"],
    timeout: 120_000,
  },
);

const orgId = process.env.NEON_GOVERNANCE_TEST_ORG_ID;
const memberId = process.env.NEON_GOVERNANCE_TEST_MEMBER_ID;
// Opt in separately because an organization role affects access beyond test-owned projects.
const authorized =
  process.env.NEON_GOVERNANCE_TEST_ALLOW_ORG_ROLE_CHANGE === "1";

test.provider.skipIf(!orgId || !memberId || !authorized)(
  "live organization role requires adoption and restores the authorized non-admin member exactly",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      if (!orgId || !memberId || !authorized)
        return yield* new GovernanceRoleSafetyError({
          message: "Explicit governance fixture authorization is required",
        });
      const request = { org_id: orgId, member_id: memberId };
      const original = yield* SDK.getOrganizationMember(request);
      const actor = yield* SDK.getCurrentUserInfo({});
      if (original.role === "admin" || !original.joined_at)
        return yield* new GovernanceRoleSafetyError({
          message:
            "Governance test fixture must be an active, non-admin member",
        });
      yield* validateGovernanceActor(original.user_id, actor.id);
      const first: OrganizationRole =
        original.role === "viewer" ? "editor" : "viewer";
      const second: OrganizationRole = first === "viewer" ? "editor" : "viewer";
      const application = (role: OrganizationRole, takeOwnership: boolean) =>
        Effect.gen(function* () {
          const access = yield* OrganizationMemberRole("AuthorizedMemberRole", {
            orgId,
            memberId,
            role,
          }).pipe(adopt(takeOwnership));
          return { access };
        });
      expect(
        yield* stack.deploy(application(first, false)).pipe(
          Effect.as(false),
          Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      const initial = yield* stack.deploy(application(first, true));
      expect(initial.access.baseline.originalRole).toBe(original.role);
      expect((yield* SDK.getOrganizationMember(request)).role).toBe(first);
      const updated = yield* stack.deploy(application(second, false));
      expect(updated.access.baseline.originalRole).toBe(original.role);
      expect((yield* SDK.getOrganizationMember(request)).role).toBe(second);
      yield* stack.destroy();
      const restored = yield* SDK.getOrganizationMember(request);
      expect(sameOrganizationRole(restored.role, original.role)).toBe(true);
      expect(restored.id).toBe(original.id);
      expect(restored.user_id).toBe(original.user_id);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:organizationmemberrole", "live"],
    timeout: 120_000,
  },
);
