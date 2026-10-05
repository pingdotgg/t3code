import { adopt } from "@/AdoptPolicy.ts";
import {
  GovernanceRoleSafetyError,
  governanceRoleTransition,
  requireGovernanceBaseline,
  validateGovernanceActor,
  type GovernanceRoleBaseline,
} from "@/Neon/OrganizationMemberRole.ts";
import { Project } from "@/Neon/Project.ts";
import {
  ProjectMemberRole,
  projectMemberDirectRole,
  validateProjectGovernanceRole,
  type ProjectGovernanceRole,
} from "@/Neon/ProjectMemberRole.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect, test as unit } from "alchemy-test";
import * as Effect from "effect/Effect";

const member = {
  member_id: "authorized-member",
  user_id: "authorized-user",
  org_role: "editor" as const,
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
  "project role state distinguishes explicit grants from inherited effective access",
  () =>
    Effect.gen(function* () {
      expect(
        yield* projectMemberDirectRole({
          ...member,
          grant_source: "org_role_default",
          project_role: "editor",
          effective_project_permission: "EDITOR",
          org_default_project_permission: "EDITOR",
        }),
      ).toBeNull();
      expect(
        yield* projectMemberDirectRole({
          ...member,
          grant_source: "unassigned",
        }),
      ).toBeNull();
      expect(
        yield* projectMemberDirectRole({
          ...member,
          grant_source: "explicit",
          explicit_project_permission: "VIEWER",
          project_role: "editor",
          effective_project_permission: "EDITOR",
        }),
      ).toBe("viewer");
      expect(
        yield* projectMemberDirectRole({
          ...member,
          grant_source: "explicit",
          explicit_project_permission: "EDITOR",
        }),
      ).toBe("editor");
      expect(
        yield* projectMemberDirectRole({
          ...member,
          grant_source: "explicit",
          explicit_project_permission: "ADMIN",
        }),
      ).toBe("admin");
    }),
  {
    tags: ["unit", "provider:neon", "provider:neon:projectmemberrole", "local"],
  },
);

unit.effect(
  "project role state refuses missing, inconsistent and org-admin grant evidence",
  () =>
    Effect.gen(function* () {
      expect(yield* refused(projectMemberDirectRole(member))).toBe(true);
      expect(
        yield* refused(
          projectMemberDirectRole({ ...member, grant_source: "explicit" }),
        ),
      ).toBe(true);
      expect(
        yield* refused(
          projectMemberDirectRole({
            ...member,
            grant_source: "org_role_default",
            explicit_project_permission: "VIEWER",
          }),
        ),
      ).toBe(true);
      expect(
        yield* refused(
          projectMemberDirectRole({
            ...member,
            org_role: "admin",
            grant_source: "org_admin_override",
            project_role: "admin",
          }),
        ),
      ).toBe(true);
      expect(
        yield* refused(
          projectMemberDirectRole({
            ...member,
            grant_source: "org_admin_override",
            explicit_project_permission: "VIEWER",
          }),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "provider:neon:projectmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "project restoration removes only an owned direct grant and preserves adopted roles",
  () =>
    Effect.gen(function* () {
      const baseline: GovernanceRoleBaseline<ProjectGovernanceRole | null> = {
        fqn: "ProjectRole",
        instanceId: "generation",
        userId: member.user_id,
        originalRole: null,
        managedRole: "editor",
      };
      expect(
        yield* governanceRoleTransition(baseline, "editor", null, true),
      ).toBe(true);
      expect(yield* governanceRoleTransition(baseline, null, null, true)).toBe(
        false,
      );
      expect(
        yield* refused(
          governanceRoleTransition(baseline, "viewer", null, true),
        ),
      ).toBe(true);
      const adopted = { ...baseline, originalRole: "viewer" as const };
      expect(
        yield* governanceRoleTransition(adopted, "editor", "viewer", true),
      ).toBe(true);
      expect(
        yield* governanceRoleTransition(adopted, "viewer", "viewer", true),
      ).toBe(false);
      expect(
        yield* refused(governanceRoleTransition(adopted, null, "viewer", true)),
      ).toBe(true);
      expect(
        yield* refused(
          requireGovernanceBaseline<ProjectGovernanceRole | null>(
            undefined,
            baseline,
          ),
        ),
      ).toBe(true);
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "provider:neon:projectmemberrole",
      "local",
    ],
  },
);

unit.effect(
  "project role validation rejects unknown persisted permissions",
  () =>
    Effect.gen(function* () {
      for (const role of [null, "viewer", "editor", "admin"] as const)
        yield* validateProjectGovernanceRole(role);
      // @ts-expect-error Runtime validation protects JavaScript callers and persisted state.
      expect(yield* refused(validateProjectGovernanceRole("owner"))).toBe(true);
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "provider:neon:projectmemberrole",
      "local",
    ],
  },
);

const { test } = Test.make({ providers: providers() });

const baseline: GovernanceRoleBaseline<ProjectGovernanceRole | null> = {
  fqn: "ProjectRole",
  instanceId: "project-role-generation",
  userId: member.user_id,
  originalRole: null,
  managedRole: "viewer",
};
const context = {
  id: "ProjectRole",
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
  "project grant identity changes are refused by diff before cloud I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* ProjectMemberRole.Provider;
      const olds = {
        orgId: "org-original",
        memberId: "member-original",
        project: { projectId: "project-original" },
        role: "viewer" as const,
      };
      const owned = {
        orgId: olds.orgId,
        memberId: olds.memberId,
        projectId: olds.project.projectId,
        role: olds.role,
        baseline,
      };
      for (const output of [undefined, owned]) {
        for (const news of [
          { ...olds, orgId: "org-other" },
          { ...olds, memberId: "member-other" },
          { ...olds, project: { projectId: "project-other" } },
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
    tags: [
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "provider:neon:projectmemberrole",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "project grant read reconcile and delete reject missing baselines before cloud I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* ProjectMemberRole.Provider;
      const news = {
        orgId: "org-original",
        memberId: "member-original",
        project: { projectId: "project-original" },
        role: "viewer" as const,
      };
      for (const olds of [undefined, news]) {
        expect(
          yield* refused(
            provider.reconcile({ ...context, news, olds, output: undefined }),
          ),
        ).toBe(true);
      }
      const output = {
        orgId: news.orgId,
        memberId: news.memberId,
        projectId: news.project.projectId,
        role: news.role,
        baseline,
      };
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
    tags: [
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "provider:neon:projectmemberrole",
      "live",
    ],
    timeout: 120_000,
  },
);

const orgId = process.env.NEON_GOVERNANCE_TEST_ORG_ID;
const memberId = process.env.NEON_GOVERNANCE_TEST_MEMBER_ID;

test.provider.skipIf(!orgId || !memberId)(
  "live direct project grants restore absence and an adopted explicit grant on a test-owned project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      if (!orgId || !memberId)
        return yield* new GovernanceRoleSafetyError({
          message: "Explicit governance fixture authorization is required",
        });
      const membership = yield* SDK.getOrganizationMember({
        org_id: orgId,
        member_id: memberId,
      });
      if (membership.role === "admin" || !membership.joined_at)
        return yield* new GovernanceRoleSafetyError({
          message:
            "Governance test fixture must be an active, non-admin member",
        });
      yield* validateGovernanceActor(
        membership.user_id,
        (yield* SDK.getCurrentUserInfo({})).id,
      );
      const base = Effect.gen(function* () {
        const project = yield* Project("GovernanceProject", {
          orgId,
          region: "aws-us-east-2",
        });
        return { project };
      });
      const initial = yield* stack.deploy(base);
      const projectId = initial.project.projectId;
      const request = { project_id: projectId, member_id: memberId };
      const observeGrant = Effect.gen(function* () {
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const response = yield* SDK.listProjectMembers({
            project_id: projectId,
            limit: 500,
            cursor,
          });
          const current = response.project_members.find(
            (entry) => entry.member_id === memberId,
          );
          if (current) return yield* projectMemberDirectRole(current);
          if (!response.pagination?.next) break;
          cursor = response.pagination.next;
        }
        return yield* new GovernanceRoleSafetyError({
          message:
            "Authorized fixture member is not visible; project-role management and ADMIN access are required",
        });
      });
      expect(yield* observeGrant).toBeNull();
      const application = (
        role: ProjectGovernanceRole,
        takeOwnership = false,
      ) =>
        Effect.gen(function* () {
          yield* base;
          const access = yield* ProjectMemberRole("AuthorizedProjectGrant", {
            orgId,
            memberId,
            project: { projectId },
            role,
          }).pipe(adopt(takeOwnership));
          return { access };
        });
      const created = yield* stack.deploy(application("viewer"));
      expect(created.access.baseline.originalRole).toBeNull();
      expect(yield* observeGrant).toBe("viewer");
      const updated = yield* stack.deploy(application("editor"));
      expect(updated.access.baseline.originalRole).toBeNull();
      expect(yield* observeGrant).toBe("editor");
      yield* stack.deploy(base);
      expect(yield* observeGrant).toBeNull();

      yield* SDK.setProjectMemberRole({
        ...request,
        role: "viewer",
        confirm_self_demotion: false,
      });
      expect(
        yield* stack.deploy(application("editor")).pipe(
          Effect.as(false),
          Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      const adopted = yield* stack.deploy(application("editor", true));
      expect(adopted.access.baseline.originalRole).toBe("viewer");
      expect(yield* observeGrant).toBe("editor");
      yield* stack.deploy(base);
      expect(yield* observeGrant).toBe("viewer");
      expect(
        (yield* SDK.getOrganizationMember({
          org_id: orgId,
          member_id: memberId,
        })).role,
      ).toBe(membership.role);
      yield* stack.destroy();
      expect(
        yield* SDK.getProject({ project_id: projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:organizationmemberrole",
      "provider:neon:project",
      "provider:neon:projectmemberrole",
      "live",
    ],
    timeout: 120_000,
  },
);
