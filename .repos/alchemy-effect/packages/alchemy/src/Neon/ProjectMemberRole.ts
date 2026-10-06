import * as Neon from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  GovernanceRoleSafetyError,
  governanceRoleTransition,
  listGovernanceOrganizationMembers,
  sameOrganizationRole,
  requireGovernanceBaseline,
  validateGovernanceActor,
  validateGovernanceScope,
  type GovernanceRoleBaseline,
} from "./OrganizationMemberRole.ts";
import type { Providers } from "./Providers.ts";

/** Direct project roles supported by Neon. */
export type ProjectGovernanceRole = "viewer" | "editor" | "admin";

export interface ProjectMemberRoleProps {
  /** Organization owning both the existing membership and project. */
  orgId: string;
  /** Existing organization membership ID, never a user ID or email. */
  memberId: string;
  /** Already-deployed organization project. Supply its resolved ID on first deployment. */
  project: { projectId: string };
  /** Direct project grant to manage; does not replace organization defaults. */
  role: ProjectGovernanceRole;
}

export interface ProjectMemberRoleAttributes {
  /** Project containing the direct grant. */
  projectId: string;
  /** Organization owning the project and member. */
  orgId: string;
  /** Existing membership receiving the direct grant. */
  memberId: string;
  /** Observed direct grant; null means no explicit grant, not no effective access. */
  role: ProjectGovernanceRole | null;
  /** Original direct grant and ownership evidence. Null originalRole means remove only our grant. */
  baseline: GovernanceRoleBaseline<ProjectGovernanceRole | null>;
}

export interface ProjectMemberRole extends Resource<
  "Neon.ProjectMemberRole",
  ProjectMemberRoleProps,
  ProjectMemberRoleAttributes,
  never,
  Providers
> {}

/**
 * Own one explicit project grant for an existing organization member.
 * Inherited/default access is not owned or removed. Adopting an existing direct
 * grant requires explicit adoption and captures it for exact restoration.
 * Deletion removes only a newly created direct grant, or restores the adopted one.
 * Organization-admin overrides and self changes are refused. This resource never
 * enables confirm_self_demotion or confirm_self_lockout and never invites anyone.
 *
 * Requires user credentials with observable ADMIN project permission. A missing
 * member, ambiguous grant source, or list failure is not evidence of no grant.
 * The list API's 404 can mean disabled permissions or insufficient access.
 * Cleanup accepts a removed membership only after a complete organization listing.
 * A missing project additionally requires an organization-admin scoped project
 * listing with no unavailable entries; an ambiguous 404 alone never discards state.
 *
 * The engine durably saves the initial read snapshot before reconciliation.
 * Deploy the project first, then supply its resolved ID and resolved settings.
 * Missing baselines and ambiguous interrupted writes fail closed. Do not discard
 * state or edit this grant concurrently: Neon has no conditional role-write API.
 *
 * ### Grant access to an existing member
 * **Example:** Manage a direct grant on an already-deployed project
 * ```typescript
 * const access = yield* Neon.ProjectMemberRole("ReviewerAccess", {
 *   orgId: "org-example",
 *   memberId: authorizedMemberId,
 *   project: { projectId: deployedProjectId },
 *   role: "viewer",
 * });
 * ```
 *
 * ### Adopt a direct grant
 * **Example:** Preserve and restore an existing explicit role
 * ```typescript
 * const access = yield* Neon.ProjectMemberRole("ExistingAccess", {
 *   orgId: "org-example",
 *   memberId: authorizedMemberId,
 *   project: { projectId: deployedProjectId },
 *   role: "editor",
 * }).pipe(Alchemy.adopt(true));
 * ```
 *
 * @resource
 * @product Project
 */
export const ProjectMemberRole = Resource<ProjectMemberRole>(
  "Neon.ProjectMemberRole",
);

/** Validate persisted or desired project grants. @internal */
export const validateProjectGovernanceRole = (
  role: ProjectGovernanceRole | null,
) =>
  role === null || role === "viewer" || role === "editor" || role === "admin"
    ? Effect.void
    : Effect.fail(
        new GovernanceRoleSafetyError({
          message: "Unsupported project grant role",
        }),
      );

/** Distinguish direct access from the effective role and organization defaults. @internal */
export const projectMemberDirectRole = (member: Neon.ProjectMember) => {
  if (
    member.org_role === "admin" ||
    member.grant_source === "org_admin_override"
  ) {
    return Effect.fail(
      new GovernanceRoleSafetyError({
        message:
          "Organization-admin project overrides cannot be managed as direct grants",
      }),
    );
  }
  const permission = member.explicit_project_permission;
  if (member.grant_source === "explicit") {
    if (permission === "VIEWER") return Effect.succeed("viewer" as const);
    if (permission === "EDITOR") return Effect.succeed("editor" as const);
    if (permission === "ADMIN") return Effect.succeed("admin" as const);
  } else if (
    (member.grant_source === "org_role_default" ||
      member.grant_source === "unassigned") &&
    permission === undefined
  ) {
    return Effect.succeed(null);
  }
  return Effect.fail(
    new GovernanceRoleSafetyError({
      message:
        "Project grant source and explicit permission do not establish a recoverable direct grant",
    }),
  );
};

const validateProps = Effect.fn(function* (props: ProjectMemberRoleProps) {
  yield* validateGovernanceScope(props);
  if (
    !props.project?.projectId ||
    typeof props.project.projectId !== "string"
  ) {
    return yield* new GovernanceRoleSafetyError({
      message: "An explicit resolved existing project ID is required",
    });
  }
  yield* validateProjectGovernanceRole(props.role);
  if (props.role === null)
    return yield* new GovernanceRoleSafetyError({
      message: "A desired direct project role is required",
    });
});

const request = (scope: { projectId: string; memberId: string }) => ({
  project_id: scope.projectId,
  member_id: scope.memberId,
});

const observe = Effect.fn(function* (
  scope: { orgId: string; memberId: string; projectId: string },
  listedMembership?: Neon.Member,
) {
  yield* validateGovernanceScope(scope);
  const { project } = yield* Neon.getProject({ project_id: scope.projectId });
  if (
    project.org_id !== scope.orgId ||
    project.effective_project_permission !== "ADMIN"
  ) {
    return yield* new GovernanceRoleSafetyError({
      message:
        "Project organization and caller ADMIN permission must be observable before managing grants",
    });
  }
  const membership =
    listedMembership ??
    (yield* Neon.getOrganizationMember({
      org_id: scope.orgId,
      member_id: scope.memberId,
    }));
  if (membership.org_id !== scope.orgId || membership.id !== scope.memberId) {
    return yield* new GovernanceRoleSafetyError({
      message: "Membership identity does not match the project organization",
    });
  }
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const response = yield* Neon.listProjectMembers({
      project_id: scope.projectId,
      cursor,
      limit: 500,
    });
    const member = response.project_members.find(
      (member) => member.member_id === scope.memberId,
    );
    if (member) {
      if (
        member.user_id !== membership.user_id ||
        member.org_role === undefined ||
        !sameOrganizationRole(member.org_role, membership.role) ||
        !member.user_id
      ) {
        return yield* new GovernanceRoleSafetyError({
          message:
            "Project member does not match the observed organization membership",
        });
      }
      return {
        role: yield* projectMemberDirectRole(member),
        userId: member.user_id,
      };
    }
    const next = response.pagination?.next;
    if (!next) break;
    if (seen.has(next))
      return yield* new GovernanceRoleSafetyError({
        message: "Project membership pagination repeated a cursor",
      });
    seen.add(next);
    cursor = next;
  }
  return yield* new GovernanceRoleSafetyError({
    message:
      "Member is not visible in a complete bounded project-member listing; refusing to infer an absent grant",
  });
});

const projectAbsenceProven = Effect.fn(function* (
  scope: { orgId: string; projectId: string },
  members: readonly Neon.Member[],
) {
  const actor = yield* Neon.getCurrentUserInfo({});
  if (
    !members.some(
      (member) => member.user_id === actor.id && member.role === "admin",
    )
  ) {
    return yield* new GovernanceRoleSafetyError({
      message:
        "Project absence requires an organization-admin listing; restricted project visibility is not proof of deletion",
    });
  }
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = yield* Neon.listProjects({
      org_id: scope.orgId,
      cursor,
      limit: 400,
    });
    if (response.unavailable_project_ids?.length) {
      return yield* new GovernanceRoleSafetyError({
        message:
          "Project listing contains unavailable projects; absence is unproven",
      });
    }
    if (
      response.projects.some(
        (project) =>
          project.org_id !== undefined && project.org_id !== scope.orgId,
      )
    ) {
      return yield* new GovernanceRoleSafetyError({
        message: "Scoped project listing returned a different organization",
      });
    }
    if (response.projects.some((project) => project.id === scope.projectId))
      return false;
    if (response.projects.length === 0) return true;
    const next = response.pagination?.cursor;
    if (next === undefined) return true;
    if (!next || seen.has(next)) {
      return yield* new GovernanceRoleSafetyError({
        message:
          "Scoped project listing returned an invalid or repeated cursor",
      });
    }
    seen.add(next);
    cursor = next;
  }
  return yield* new GovernanceRoleSafetyError({
    message:
      "Scoped project listing exceeded its bounded pagination limit; absence is unproven",
  });
});

const verifyBaseline = Effect.fn(function* (
  output: ProjectMemberRoleAttributes | undefined,
  owner: { fqn: string; instanceId: string },
) {
  const baseline = yield* requireGovernanceBaseline(output?.baseline, owner);
  yield* validateProjectGovernanceRole(baseline.originalRole);
  yield* validateProjectGovernanceRole(baseline.managedRole);
  return baseline;
});

export const ProjectMemberRoleProvider = () =>
  Provider.succeed(ProjectMemberRole, {
    nuke: { skip: true },
    stables: ["orgId", "memberId", "projectId"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      yield* validateProps(news);
      if (
        news.orgId !== (output?.orgId ?? olds.orgId) ||
        news.memberId !== (output?.memberId ?? olds.memberId) ||
        news.project.projectId !== (output?.projectId ?? olds.project.projectId)
      )
        return yield* new GovernanceRoleSafetyError({
          message:
            "Restore and remove the existing grant control before changing its project or membership identity; a new durable grant snapshot is required",
        });
    }),
    read: Effect.fn(function* ({ olds, output, fqn, instanceId }) {
      if (!output) yield* validateProps(olds);
      const scope = output ?? {
        orgId: olds.orgId,
        memberId: olds.memberId,
        projectId: olds.project.projectId,
      };
      const baseline = output
        ? yield* verifyBaseline(output, { fqn, instanceId })
        : undefined;
      const observed = yield* observe(scope);
      if (output && baseline) {
        if (observed.userId !== baseline.userId)
          return yield* new GovernanceRoleSafetyError({
            message: "Membership user changed",
          });
        yield* governanceRoleTransition(baseline, observed.role, observed.role);
        return { ...output, role: observed.role };
      }
      const attributes: ProjectMemberRoleAttributes = {
        orgId: scope.orgId,
        memberId: scope.memberId,
        projectId: scope.projectId,
        role: observed.role,
        baseline: {
          fqn,
          instanceId,
          userId: observed.userId,
          originalRole: observed.role,
          managedRole: observed.role,
        },
      };
      return observed.role === null ? attributes : Unowned(attributes);
    }),
    reconcile: Effect.fn(function* ({ news, output, fqn, instanceId }) {
      yield* validateProps(news);
      const baseline = yield* verifyBaseline(output, { fqn, instanceId });
      if (!output)
        return yield* new GovernanceRoleSafetyError({
          message:
            "A persisted initial grant snapshot is required before changing project access",
        });
      if (
        news.orgId !== output.orgId ||
        news.memberId !== output.memberId ||
        news.project.projectId !== output.projectId
      ) {
        return yield* new GovernanceRoleSafetyError({
          message: "Project grant identity changed without replacement",
        });
      }
      const observed = yield* observe(output);
      if (observed.userId !== baseline.userId)
        return yield* new GovernanceRoleSafetyError({
          message: "Membership user changed",
        });
      if (yield* governanceRoleTransition(baseline, observed.role, news.role)) {
        yield* validateGovernanceActor(
          observed.userId,
          (yield* Neon.getCurrentUserInfo({})).id,
        );
        yield* Neon.setProjectMemberRole({
          ...request(output),
          role: news.role,
          confirm_self_demotion: false,
        });
      }
      const current = yield* observe(output);
      if (current.userId !== baseline.userId || current.role !== news.role) {
        return yield* new GovernanceRoleSafetyError({
          message: "Direct project grant did not converge",
        });
      }
      return {
        ...output,
        role: current.role,
        baseline: { ...baseline, managedRole: current.role },
      };
    }),
    delete: Effect.fn(function* ({ output, fqn, instanceId }) {
      const baseline = yield* verifyBaseline(output, { fqn, instanceId });
      yield* validateGovernanceScope(output);
      const members = yield* listGovernanceOrganizationMembers(output.orgId);
      const membership = members.find(
        (member) => member.id === output.memberId,
      );
      if (!membership) return;
      if (membership.user_id !== baseline.userId) {
        return yield* new GovernanceRoleSafetyError({
          message: "Membership user changed",
        });
      }
      const observed = yield* observe(output, membership).pipe(
        Effect.catchTag("NotFound", (error) =>
          Effect.gen(function* () {
            if (yield* projectAbsenceProven(output, members)) return undefined;
            return yield* Effect.fail(error);
          }),
        ),
      );
      if (!observed) return;
      if (observed.userId !== baseline.userId)
        return yield* new GovernanceRoleSafetyError({
          message: "Membership user changed",
        });
      if (
        yield* governanceRoleTransition(
          baseline,
          observed.role,
          baseline.originalRole,
          true,
        )
      ) {
        yield* validateGovernanceActor(
          observed.userId,
          (yield* Neon.getCurrentUserInfo({})).id,
        );
        if (baseline.originalRole === null) {
          yield* Neon.removeProjectMemberRole({
            ...request(output),
            confirm_self_lockout: false,
          });
        } else {
          yield* Neon.setProjectMemberRole({
            ...request(output),
            role: baseline.originalRole,
            confirm_self_demotion: false,
          });
        }
        const restored = yield* observe(output);
        if (
          restored.userId !== baseline.userId ||
          restored.role !== baseline.originalRole
        ) {
          return yield* new GovernanceRoleSafetyError({
            message: "Original explicit project grant was not restored",
          });
        }
      }
    }),
  });
