import * as turso from "@distilled.cloud/turso/turso";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organization } from "./Credentials.ts";
import type { MemberRole } from "./OrganizationInvite.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationMemberProps {
  /** Username of an existing Turso user. Changing it replaces the member. */
  username: string;
  /**
   * Role of the member in the organization.
   * @default "member"
   */
  role?: MemberRole;
}

export interface OrganizationMemberAttributes {
  /** Username of the member. */
  username: string;
  /** The organization slug. */
  organization: string;
  /** Role of the member. */
  role: string;
  /** Email of the member. */
  email: string | undefined;
}

export type OrganizationMember = Resource<
  "Turso.OrganizationMember",
  OrganizationMemberProps,
  OrganizationMemberAttributes,
  never,
  Providers
>;

/**
 * Adds an existing Turso user to your organization with a role, and keeps
 * that role in sync. Destroying the resource removes the member. Use
 * {@link OrganizationInvite} for people who don't have a Turso account
 * yet. Requires a team organization on a paid plan.
 * @see https://docs.turso.tech/api-reference/organizations/members/add
 *
 * ### Managing Members
 * **Example:** Add a user as a viewer
 * ```typescript
 * yield* Turso.OrganizationMember("Bob", {
 *   username: "bob",
 *   role: "viewer",
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationMember = Resource<OrganizationMember>("Turso.OrganizationMember");

export const OrganizationMemberProvider = () =>
  Provider.effect(
    OrganizationMember,
    Effect.gen(function* () {
      const observe = (org: string, username: string) =>
        turso.getOrganizationMember({ organizationSlug: org, username }).pipe(
          Effect.map(({ member }) => member),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      return {
        stables: ["username", "organization"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (news.username !== olds?.username) return { action: "replace" } as const;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const org = output?.organization ?? (yield* organization);
          const member = yield* observe(org, output?.username ?? olds.username);
          if (!member?.username) return undefined;
          return {
            username: member.username,
            organization: org,
            role: member.role ?? "member",
            email: member.email,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const org = output?.organization ?? (yield* organization);
          const role = news.role ?? "member";

          // Observe
          let member = yield* observe(org, news.username);

          // Ensure
          if (!member) {
            yield* turso
              .addOrganizationMember({ organizationSlug: org, username: news.username, role })
              .pipe(Effect.catchTag("Conflict", () => Effect.void));
            member = yield* observe(org, news.username);
          }

          // Sync role
          if (member?.role !== role) {
            yield* turso.updateMemberRole({
              organizationSlug: org,
              username: news.username,
              role,
            });
          }
          return { username: news.username, organization: org, role, email: member?.email };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* turso
            .removeOrganizationMember({
              organizationSlug: output.organization,
              username: output.username,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
