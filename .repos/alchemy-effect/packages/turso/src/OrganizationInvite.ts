import * as turso from "@distilled.cloud/turso/turso";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organization } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

/** Role granted to an invited or added organization member. */
export type MemberRole = "admin" | "member" | "viewer";

export interface OrganizationInviteProps {
  /** Email address to invite. Changing it replaces the invite. */
  email: string;
  /**
   * Role the invitee receives on accepting.
   * @default "member"
   */
  role?: MemberRole;
}

export interface OrganizationInviteAttributes {
  /** The invited email address. */
  email: string;
  /** The organization slug the invite is for. */
  organization: string;
  /** Role the invitee receives on accepting. */
  role: string;
}

export type OrganizationInvite = Resource<
  "Turso.OrganizationInvite",
  OrganizationInviteProps,
  OrganizationInviteAttributes,
  never,
  Providers
>;

/**
 * An invitation for someone to join your Turso organization by email.
 * Changing `role` re-sends the invite with the new role; destroying the
 * resource withdraws a pending invite. Requires a team organization on a
 * paid plan — the Starter plan rejects invites with `BadRequest`.
 * @see https://docs.turso.tech/api-reference/organizations/invites/create
 *
 * ### Inviting Members
 * **Example:** Invite a teammate as an admin
 * ```typescript
 * yield* Turso.OrganizationInvite("Alice", {
 *   email: "alice@example.com",
 *   role: "admin",
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationInvite = Resource<OrganizationInvite>("Turso.OrganizationInvite");

export const OrganizationInviteProvider = () =>
  Provider.effect(
    OrganizationInvite,
    Effect.gen(function* () {
      const observe = (org: string, email: string) =>
        turso
          .listOrganizationInvitesV2({ organizationSlug: org })
          .pipe(
            Effect.map(({ invites }) =>
              (invites ?? []).find((i) => i.email?.toLowerCase() === email.toLowerCase()),
            ),
          );

      const withdraw = (org: string, email: string) =>
        turso.deleteOrganizationInviteByEmailV2({ organizationSlug: org, email }).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );

      return {
        stables: ["email", "organization"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (news.email.toLowerCase() !== olds?.email.toLowerCase()) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const org = output?.organization ?? (yield* organization);
          const invite = yield* observe(org, output?.email ?? olds.email);
          if (!invite?.email) return undefined;
          return { email: invite.email, organization: org, role: invite.role ?? "member" };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const org = output?.organization ?? (yield* organization);
          const role = news.role ?? "member";

          // Observe
          const invite = yield* observe(org, news.email);

          // Ensure / sync — invites have no update API, so a role change
          // withdraws and re-sends.
          if (invite?.role === role) {
            return { email: invite.email ?? news.email, organization: org, role };
          }
          if (invite) yield* withdraw(org, news.email);
          const { invited } = yield* turso.inviteOrganizationMemberV2({
            organizationSlug: org,
            email: news.email,
            role,
          });
          return { email: invited?.email ?? news.email, organization: org, role };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* withdraw(output.organization, output.email);
        }),
      };
    }),
  );
