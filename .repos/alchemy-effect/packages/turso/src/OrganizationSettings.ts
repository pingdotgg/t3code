import * as turso from "@distilled.cloud/turso/turso";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { organization } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationSettingsProps {
  /** Allow usage beyond the plan's quota to be billed as overages. */
  overages?: boolean;
  /**
   * Require every member to enable multi-factor authentication. The
   * deploying user must have MFA enabled first.
   */
  requireMfa?: boolean;
  /**
   * Keep deleted databases and groups recoverable. Requires an admin or
   * owner.
   */
  restoreEnabled?: boolean;
}

interface Settings {
  overages: boolean;
  requireMfa: boolean;
  restoreEnabled: boolean;
}

export interface OrganizationSettingsAttributes extends Settings {
  /** The organization slug. */
  organization: string;
  /** Settings observed before Alchemy first changed them; restored on destroy. */
  original: Settings;
}

export type OrganizationSettings = Resource<
  "Turso.OrganizationSettings",
  OrganizationSettingsProps,
  OrganizationSettingsAttributes,
  never,
  Providers
>;

/**
 * Settings of the Turso organization your credentials act on. Only the
 * settings you set are managed; destroying the resource restores the values
 * observed before Alchemy first changed them.
 * @see https://docs.turso.tech/api-reference/organizations/update
 *
 * ### Configuring the Organization
 * **Example:** Enable overages and require MFA
 * ```typescript
 * yield* Turso.OrganizationSettings("Org", {
 *   overages: true,
 *   requireMfa: true,
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationSettings = Resource<OrganizationSettings>("Turso.OrganizationSettings");

const toSettings = (org: turso.Organization | undefined): Settings => ({
  overages: org?.overages ?? false,
  requireMfa: org?.require_mfa ?? false,
  restoreEnabled: org?.restore_enabled ?? false,
});

export const OrganizationSettingsProvider = () =>
  Provider.effect(
    OrganizationSettings,
    Effect.gen(function* () {
      const observe = (slug: string) =>
        turso
          .getOrganization({ organizationSlug: slug })
          .pipe(Effect.map(({ organization }) => toSettings(organization)));

      // `restore_enabled` must be updated on its own (per the API).
      const apply = (slug: string, observed: Settings, desired: Partial<Settings>) =>
        Effect.gen(function* () {
          const patch: { overages?: boolean; require_mfa?: boolean } = {};
          if (desired.overages !== undefined && desired.overages !== observed.overages) {
            patch.overages = desired.overages;
          }
          if (desired.requireMfa !== undefined && desired.requireMfa !== observed.requireMfa) {
            patch.require_mfa = desired.requireMfa;
          }
          if (Object.keys(patch).length > 0) {
            yield* turso.updateOrganization({ organizationSlug: slug, ...patch });
          }
          if (
            desired.restoreEnabled !== undefined &&
            desired.restoreEnabled !== observed.restoreEnabled
          ) {
            yield* turso.updateOrganization({
              organizationSlug: slug,
              restore_enabled: desired.restoreEnabled,
            });
          }
        });

      return {
        stables: ["organization", "original"],
        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          return { ...output, ...(yield* observe(output.organization)) };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const slug = output?.organization ?? (yield* organization);
          const observed = yield* observe(slug);
          yield* apply(slug, observed, news);
          // Organization reads can briefly lag a PATCH; wait until the
          // settings we set are visible.
          const settled = yield* observe(slug).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (current) =>
                (news.overages === undefined || current.overages === news.overages) &&
                (news.requireMfa === undefined || current.requireMfa === news.requireMfa) &&
                (news.restoreEnabled === undefined ||
                  current.restoreEnabled === news.restoreEnabled),
              times: 10,
            }),
          );
          return {
            organization: slug,
            original: output?.original ?? observed,
            ...settled,
          };
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          const observed = yield* observe(output.organization);
          // Restore only the settings this resource managed.
          yield* apply(output.organization, observed, {
            overages: olds.overages !== undefined ? output.original.overages : undefined,
            requireMfa: olds.requireMfa !== undefined ? output.original.requireMfa : undefined,
            restoreEnabled:
              olds.restoreEnabled !== undefined ? output.original.restoreEnabled : undefined,
          });
        }),
      };
    }),
  );
