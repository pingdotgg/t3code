import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** Organization roles supported by Neon; availability depends on the organization. */
export type OrganizationRole =
  | "admin"
  | "member"
  | "editor"
  | "viewer"
  | "collaborator";

export interface OrganizationMemberRoleProps {
  /** Existing Neon organization ID. Restore and remove this control before changing its identity. */
  orgId: string;
  /** Existing membership ID, not a user ID or email. Remove this control before changing the member. */
  memberId: string;
  /** Desired organization role. The legacy member role is equivalent to editor. No membership is created or invited. */
  role: OrganizationRole;
}

/** Durable ownership and restore evidence, persisted by the engine before reconciliation. */
export interface GovernanceRoleBaseline<Role> {
  /** Resource generation that captured the original role. */
  instanceId: string;
  /** Fully qualified logical resource identity. */
  fqn: string;
  /** User identity captured with the existing membership. */
  userId: string;
  /** Exact role before this resource first managed it. */
  originalRole: Role;
  /** Last successfully persisted managed role, never inferred from input properties. */
  managedRole: Role;
}

export interface OrganizationMemberRoleAttributes {
  /** Organization containing the membership. */
  orgId: string;
  /** Existing membership controlled by this resource. */
  memberId: string;
  /** Observed organization role. */
  role: OrganizationRole;
  /** Original role and ownership evidence required for safe restoration. */
  baseline: GovernanceRoleBaseline<OrganizationRole>;
}

export interface OrganizationMemberRole extends Resource<
  "Neon.OrganizationMemberRole",
  OrganizationMemberRoleProps,
  OrganizationMemberRoleAttributes,
  never,
  Providers
> {}

/**
 * Manage the role of an existing organization member, never their membership.
 * Existing roles require explicit adoption. Destruction restores the captured
 * original role, but refuses to overwrite a role changed outside this resource.
 * A complete bounded organization-member listing can prove that a removed
 * membership needs no restoration; listing failures never count as absence.
 * Self changes are refused, including restoration, to avoid self-demotion.
 * Neon enforces organization-admin authorization and organization role availability.
 *
 * The engine persists the adoption snapshot before reconciliation. Supply resolved
 * IDs and role values on first deployment; an unresolved first deployment fails
 * before mutation because this engine has no provider checkpoint API. Keep the
 * state: a lost baseline cannot be reconstructed from desired props. An ambiguous
 * interrupted write fails closed and requires operator reconciliation of state.
 * Role mutations have no compare-and-swap API; do not edit the same role concurrently.
 *
 * ### Manage an existing member
 * **Example:** Explicitly adopt a consenting member's role
 * ```typescript
 * const role = yield* Neon.OrganizationMemberRole("DeveloperRole", {
 *   orgId: "org-example",
 *   memberId: authorizedMemberId,
 *   role: "editor",
 * }).pipe(Alchemy.adopt(true));
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationMemberRole = Resource<OrganizationMemberRole>(
  "Neon.OrganizationMemberRole",
);

export class GovernanceRoleSafetyError extends Data.TaggedError(
  "NeonGovernanceRoleSafetyError",
)<{
  message: string;
}> {}

/** Validate scope without performing cloud I/O. @internal */
export const validateGovernanceScope = (
  scope: { orgId: string; memberId: string } | undefined,
) =>
  typeof scope?.orgId === "string" &&
  scope.orgId.trim().length > 0 &&
  typeof scope.memberId === "string" &&
  scope.memberId.trim().length > 0
    ? Effect.void
    : Effect.fail(
        new GovernanceRoleSafetyError({
          message:
            "An explicit organization ID and existing membership ID are required",
        }),
      );

/** Runtime validation also guards persisted state and unrecognized SDK enum values. @internal */
export const validateOrganizationRole = (role: OrganizationRole) =>
  role === "admin" ||
  role === "member" ||
  role === "editor" ||
  role === "viewer" ||
  role === "collaborator"
    ? Effect.void
    : Effect.fail(
        new GovernanceRoleSafetyError({
          message: "Unsupported organization role",
        }),
      );

/** Check persisted ownership independently of desired properties. @internal */
export const requireGovernanceBaseline = <Role>(
  baseline: GovernanceRoleBaseline<Role> | undefined,
  owner: { fqn: string; instanceId: string },
) =>
  baseline &&
  baseline.fqn === owner.fqn &&
  baseline.instanceId === owner.instanceId &&
  baseline.userId
    ? Effect.succeed(baseline)
    : Effect.fail(
        new GovernanceRoleSafetyError({
          message:
            "Missing or foreign durable role baseline; use a resolved initial declaration and explicit adoption, never reconstruct a lost baseline from props",
        }),
      );

/** Observe-before-write guard; a completed restoration is idempotent. @internal */
export const governanceRoleTransition = <Role>(
  baseline: GovernanceRoleBaseline<Role>,
  observed: Role,
  desired: Role,
  restoring = false,
) => {
  if (restoring && observed === baseline.originalRole)
    return Effect.succeed(false);
  if (observed !== baseline.managedRole) {
    return Effect.fail(
      new GovernanceRoleSafetyError({
        message:
          "Observed role differs from the last persisted managed role; refusing an out-of-band edit or ambiguous interrupted write",
      }),
    );
  }
  return Effect.succeed(observed !== desired);
};

const normalizeOrganizationRole = (role: OrganizationRole) =>
  role === "member" ? "editor" : role;

/** Neon treats member as a legacy spelling of editor. @internal */
export const sameOrganizationRole = (
  a: OrganizationRole,
  b: OrganizationRole,
) => normalizeOrganizationRole(a) === normalizeOrganizationRole(b);

/** Preserve original spellings while comparing equivalent organization roles. @internal */
export const organizationRoleTransition = (
  baseline: GovernanceRoleBaseline<OrganizationRole>,
  observed: OrganizationRole,
  desired: OrganizationRole,
  restoring = false,
) =>
  governanceRoleTransition(
    {
      ...baseline,
      originalRole: normalizeOrganizationRole(baseline.originalRole),
      managedRole: normalizeOrganizationRole(baseline.managedRole),
    },
    normalizeOrganizationRole(observed),
    normalizeOrganizationRole(desired),
    restoring,
  );

/** Never mutate the authenticated actor, including during restoration. @internal */
export const validateGovernanceActor = (userId: string, actorId: string) =>
  userId && actorId && userId !== actorId
    ? Effect.void
    : Effect.fail(
        new GovernanceRoleSafetyError({
          message:
            "Cannot manage the current actor's role or a membership without a verified user identity",
        }),
      );

const request = (scope: { orgId: string; memberId: string }) => ({
  org_id: scope.orgId,
  member_id: scope.memberId,
});

/** Complete membership evidence for cleanup; failed or truncated listings never prove absence. @internal */
export const listGovernanceOrganizationMembers = Effect.fn(function* (
  orgId: string,
) {
  const members: Neon.Member[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = yield* Neon.getOrganizationMembers({
      org_id: orgId,
      cursor,
      limit: 100,
    });
    for (const { member } of response.members) {
      if (member.org_id !== orgId) {
        return yield* new GovernanceRoleSafetyError({
          message:
            "Organization member listing returned a different organization",
        });
      }
      members.push(member);
    }
    const next = response.pagination?.next;
    if (next === undefined) return members;
    if (!next || seen.has(next)) {
      return yield* new GovernanceRoleSafetyError({
        message:
          "Organization membership listing returned an invalid or repeated cursor",
      });
    }
    seen.add(next);
    cursor = next;
  }
  return yield* new GovernanceRoleSafetyError({
    message:
      "Organization membership listing exceeded its bounded pagination limit; absence is unproven",
  });
});

const validateObservedMember = Effect.fn(function* (
  scope: { orgId: string; memberId: string },
  member: Neon.Member,
) {
  if (
    member.id !== scope.memberId ||
    member.org_id !== scope.orgId ||
    !member.user_id
  ) {
    return yield* new GovernanceRoleSafetyError({
      message:
        "Organization membership identity does not match the requested scope",
    });
  }
  yield* validateOrganizationRole(member.role);
  return member;
});

const observe = Effect.fn(function* (scope: {
  orgId: string;
  memberId: string;
}) {
  yield* validateGovernanceScope(scope);
  return yield* validateObservedMember(
    scope,
    yield* Neon.getOrganizationMember(request(scope)),
  );
});

const validateScope = (
  scope: { orgId: string; memberId: string },
  output: OrganizationMemberRoleAttributes,
) =>
  scope.orgId === output.orgId && scope.memberId === output.memberId
    ? Effect.void
    : Effect.fail(
        new GovernanceRoleSafetyError({
          message: "Membership identity changed without replacement",
        }),
      );

const verifyBaseline = Effect.fn(function* (
  output: OrganizationMemberRoleAttributes | undefined,
  owner: { fqn: string; instanceId: string },
) {
  const baseline = yield* requireGovernanceBaseline(output?.baseline, owner);
  yield* validateOrganizationRole(baseline.originalRole);
  yield* validateOrganizationRole(baseline.managedRole);
  return baseline;
});

export const OrganizationMemberRoleProvider = () =>
  Provider.succeed(OrganizationMemberRole, {
    nuke: { skip: true },
    stables: ["orgId", "memberId"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      yield* validateGovernanceScope(news);
      yield* validateOrganizationRole(news.role);
      const previous = output ?? olds;
      if (
        news.orgId !== previous.orgId ||
        news.memberId !== previous.memberId
      ) {
        return yield* new GovernanceRoleSafetyError({
          message:
            "Restore and remove the existing role control before changing its membership identity; the new membership requires a separate durable adoption snapshot",
        });
      }
    }),
    read: Effect.fn(function* ({ olds, output, fqn, instanceId }) {
      const scope = output ?? olds;
      yield* validateGovernanceScope(scope);
      const baseline = output
        ? yield* verifyBaseline(output, { fqn, instanceId })
        : undefined;
      const member = yield* observe(scope);
      if (output && baseline) {
        if (member.user_id !== baseline.userId) {
          return yield* new GovernanceRoleSafetyError({
            message:
              "Membership user changed; refusing to reuse the captured baseline",
          });
        }
        yield* organizationRoleTransition(baseline, member.role, member.role);
        return { ...output, role: member.role };
      }
      return Unowned({
        orgId: scope.orgId,
        memberId: scope.memberId,
        role: member.role,
        baseline: {
          fqn,
          instanceId,
          userId: member.user_id,
          originalRole: member.role,
          managedRole: member.role,
        },
      });
    }),
    reconcile: Effect.fn(function* ({ news, output, fqn, instanceId }) {
      yield* validateGovernanceScope(news);
      yield* validateOrganizationRole(news.role);
      const baseline = yield* verifyBaseline(output, { fqn, instanceId });
      if (!output)
        return yield* new GovernanceRoleSafetyError({
          message:
            "A persisted adoption snapshot is required before changing an organization role",
        });
      yield* validateScope(news, output);
      const member = yield* observe(news);
      if (member.user_id !== baseline.userId)
        return yield* new GovernanceRoleSafetyError({
          message: "Membership user changed",
        });
      if (yield* organizationRoleTransition(baseline, member.role, news.role)) {
        yield* validateGovernanceActor(
          member.user_id,
          (yield* Neon.getCurrentUserInfo({})).id,
        );
        yield* Neon.updateOrganizationMember({
          ...request(news),
          role: news.role,
        });
      }
      const current = yield* observe(news);
      if (
        current.user_id !== baseline.userId ||
        !sameOrganizationRole(current.role, news.role)
      ) {
        return yield* new GovernanceRoleSafetyError({
          message:
            "Organization role did not converge; retaining the original baseline",
        });
      }
      return {
        orgId: news.orgId,
        memberId: news.memberId,
        role: current.role,
        baseline: { ...baseline, managedRole: current.role },
      };
    }),
    delete: Effect.fn(function* ({ output, fqn, instanceId }) {
      const baseline = yield* verifyBaseline(output, { fqn, instanceId });
      yield* validateGovernanceScope(output);
      // getOrganizationMember has no typed missing-member error in the SDK.
      const listed = (yield* listGovernanceOrganizationMembers(
        output.orgId,
      )).find((member) => member.id === output.memberId);
      if (!listed) return;
      const member = yield* validateObservedMember(output, listed);
      if (member.user_id !== baseline.userId)
        return yield* new GovernanceRoleSafetyError({
          message: "Membership user changed",
        });
      if (
        yield* organizationRoleTransition(
          baseline,
          member.role,
          baseline.originalRole,
          true,
        )
      ) {
        yield* validateGovernanceActor(
          member.user_id,
          (yield* Neon.getCurrentUserInfo({})).id,
        );
        yield* Neon.updateOrganizationMember({
          ...request(output),
          role: baseline.originalRole,
        });
        const restored = yield* observe(output);
        if (
          restored.user_id !== baseline.userId ||
          !sameOrganizationRole(restored.role, baseline.originalRole)
        ) {
          return yield* new GovernanceRoleSafetyError({
            message: "Original organization role was not restored",
          });
        }
      }
    }),
  });
