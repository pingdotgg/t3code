import * as organizations from "@distilled.cloud/cloudflare/organizations";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Organization.Organization" as const;
type TypeId = typeof TypeId;

/**
 * Business profile attached to an organization. All fields are required
 * when a profile is present — the API stores the profile as a unit.
 */
export interface Profile {
  /**
   * Street address of the business that owns the organization.
   */
  businessAddress: string;
  /**
   * Contact email of the business.
   */
  businessEmail: string;
  /**
   * Legal name of the business.
   */
  businessName: string;
  /**
   * Contact phone number of the business.
   */
  businessPhone: string;
  /**
   * Free-form external metadata (e.g. a CRM or billing reference).
   */
  externalMetadata: string;
}

/**
 * Feature flags Cloudflare sets on an organization. Read-only —
 * controlled by the organization's entitlements.
 */
export interface Flags {
  /**
   * Whether accounts may be created under this organization.
   */
  accountCreation: string;
  /**
   * Whether accounts may be deleted under this organization.
   */
  accountDeletion: string;
  /**
   * Whether accounts may be migrated into this organization.
   */
  accountMigration: string;
  /**
   * Whether accounts may be moved between organizations.
   */
  accountMobility: string;
  /**
   * Whether sub-organizations may be created under this organization.
   */
  subOrgCreation: string;
}

export interface Props {
  /**
   * Display name of the organization. Mutable in place. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * ID of the parent organization, for building an organization
   * hierarchy. Changing the parent triggers a replacement — re-parenting
   * is gated by the organization's `accountMobility`/flags and is not
   * supported in place.
   */
  parent?: string;
  /**
   * Business profile of the organization. Mutable in place.
   */
  profile?: Profile;
}

export interface Attributes {
  /**
   * Cloudflare-assigned identifier of the organization.
   */
  organizationId: string;
  /**
   * Display name of the organization.
   */
  name: string;
  /**
   * ISO8601 timestamp of when the organization was created.
   */
  createTime: string;
  /**
   * Who manages this organization, if it is managed by a parent entity.
   */
  managedBy: string | undefined;
  /**
   * Feature flags controlled by the organization's entitlements.
   */
  flags: Flags | undefined;
  /**
   * Parent organization, if this organization is part of a hierarchy.
   */
  parent: { id: string; name: string } | undefined;
  /**
   * Business profile of the organization, if one is set.
   */
  profile: Profile | undefined;
}

export type Organization = Resource<
  TypeId,
  Props,
  Attributes,
  never,
  Providers
>;

/**
 * A Cloudflare Organization — the hierarchical container above accounts.
 *
 * Organizations group accounts (and sub-organizations) under a single
 * management umbrella; an account's `managedBy.parentOrgId` points at its
 * owning organization. The feature is entitlement-gated: only tenant /
 * organizations-enabled customers can create organizations — on a standard
 * account every `/organizations` call fails with the typed `Forbidden`
 * error.
 *
 * `name` and `profile` are mutable in place; changing `parent` triggers a
 * replacement.
 *
 * Safety: organizations carry no ownership markers. When there is no prior
 * state, `read` scans for an existing organization with the same name
 * (and parent) and reports it as `Unowned`, so the engine refuses to take
 * it over unless `--adopt` (or `adopt(true)`) is set.
 * @resource
 * @product Organizations
 * @category Account & Identity
 * @section Creating an Organization
 * @example Basic organization
 * ```typescript
 * const org = yield* Cloudflare.Organization.Organization("Platform", {
 *   name: "acme-platform",
 * });
 * ```
 *
 * @example Organization with a business profile
 * ```typescript
 * const org = yield* Cloudflare.Organization.Organization("Platform", {
 *   name: "acme-platform",
 *   profile: {
 *     businessName: "Acme Corp",
 *     businessEmail: "ops@acme.com",
 *     businessPhone: "+1-555-0100",
 *     businessAddress: "1 Acme Way, Springfield",
 *     externalMetadata: "crm:acct-42",
 *   },
 * });
 * ```
 *
 * @section Hierarchies
 * @example Sub-organization under a parent
 * ```typescript
 * const parent = yield* Cloudflare.Organization.Organization("Root", {
 *   name: "acme-root",
 * });
 * // Changing `parent` later replaces the sub-organization.
 * const sub = yield* Cloudflare.Organization.Organization("Emea", {
 *   name: "acme-emea",
 *   parent: parent.organizationId,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/fundamentals/setup/manage-organizations/
 */
export const Organization = Resource<Organization>(TypeId, {
  aliases: ["Cloudflare.Organization"],
});

/**
 * Returns true if the given value is an Organization resource.
 */
export const isOrganization = (value: unknown): value is Organization =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: ["organizationId", "createTime"],

    // Enumerate every organization reachable by the credentials. Cloudflare's
    // `/organizations` collection is account-wide (no per-account scoping
    // beyond the token), so there is no env scope to resolve — just paginate
    // exhaustively and map each row to the same `Attributes` shape `read`
    // returns. The op is entitlement-gated: on an unentitled account it
    // rejects with the typed `Forbidden` error, which `list()` tolerates
    // (returns `[]`) so account-wide enumeration / `nuke` never blows up.
    list: () =>
      organizations.listOrganizations.pages({}).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map(toAttributes),
          ),
        ),
        // Organizations are a Tenant/reseller feature — a regular account
        // token gets `Forbidden` ("Authentication error"). Nothing to list.
        Effect.catchTag("Forbidden", () => Effect.succeed([])),
      ),

    diff: Effect.fn(function* ({ olds, news, output }) {
      // `news` may still carry unresolved plan-time expressions — defer
      // to the engine's default update logic until everything is concrete.
      if (!isResolved(news)) return undefined;
      // Re-parenting is not supported in place — hierarchy moves are
      // gated by `accountMobility`/flags, so a parent change replaces.
      const oldParent =
        output?.parent?.id ?? (olds?.parent as string | undefined);
      const newParent = news.parent;
      // `parent` is Input<string>; only compare once both are concrete.
      if (
        (oldParent === undefined) !== (newParent === undefined) ||
        (typeof oldParent === "string" &&
          typeof newParent === "string" &&
          oldParent !== newParent)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      // Owned path: refresh by our persisted organization id.
      if (output?.organizationId) {
        const observed = yield* getOrganization(output.organizationId);
        return observed ? toAttributes(observed) : undefined;
      }

      // Cold read — recover from lost state by matching the deterministic
      // physical name (+ parent). Organization names are not guaranteed
      // unique and carry no ownership markers, so report the match as
      // `Unowned`: the engine refuses to take it over unless `adopt` is
      // set.
      const name = yield* createOrganizationName(id, olds?.name);
      const parent = olds?.parent as string | undefined;
      const match = yield* findByName(name, parent);
      return match ? Unowned(toAttributes(match)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createOrganizationName(id, news.name);
      // Inputs have been resolved to concrete strings by Plan.
      const parent = news.parent as string | undefined;

      // Observe — the organization id cached on `output` is a hint, not
      // a guarantee: a missing organization falls through to create.
      const observed = output?.organizationId
        ? yield* getOrganization(output.organizationId)
        : undefined;

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. Names are not unique on Cloudflare's side,
        // so there is no AlreadyExists race to tolerate.
        const created = yield* organizations.createOrganization({
          name,
          parent: parent !== undefined ? { id: parent } : undefined,
          profile: news.profile,
        });
        return toAttributes(created);
      }

      // Sync — diff observed cloud state against desired; the update API
      // is a PUT requiring `name`, so send the full desired shape, but
      // skip the call entirely on a no-op. The desired profile keeps the
      // observed one when the props omit it (the PUT would otherwise
      // clear it).
      const desiredProfile = news.profile ?? observed.profile ?? undefined;
      const dirty =
        observed.name !== name || !sameProfile(observed.profile, news.profile);

      if (!dirty) {
        return toAttributes(observed);
      }

      const updated = yield* organizations.updateOrganization({
        organizationId: observed.id,
        name,
        parent:
          observed.parent != null ? { id: observed.parent.id } : undefined,
        profile: desiredProfile,
      });
      return toAttributes(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Deletion is refused while the organization still manages
      // accounts or sub-organizations — that's a genuine dependency
      // violation, so it propagates. Already-gone is success.
      yield* organizations
        .deleteOrganization({ organizationId: output.organizationId })
        .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.void));
    }),
  });

type ObservedOrganization = organizations.GetOrganizationResponse;

/**
 * Read an organization by id, mapping "gone" (`OrganizationNotFound`,
 * HTTP 404) to `undefined`.
 */
const getOrganization = (organizationId: string) =>
  organizations.getOrganization({ organizationId }).pipe(
    Effect.map((org): ObservedOrganization | undefined => org),
    Effect.catchTag("OrganizationNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find an organization by exact name (and parent, when one is expected).
 * Cloudflare's name filter narrows server-side; re-check exactly
 * client-side. If several organizations carry the same name, pick the
 * oldest for determinism.
 */
const findByName = (name: string, parent: string | undefined) =>
  organizations.listOrganizations.items({ name: { contains: name } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk)
        .filter(
          (org) =>
            org.name === name &&
            (parent === undefined || org.parent?.id === parent),
        )
        .sort((a, b) => a.createTime.localeCompare(b.createTime))
        .at(0),
    ),
  );

const createOrganizationName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * Compare the observed profile against the desired one. An omitted
 * desired profile is "keep whatever is there" — never a diff.
 */
const sameProfile = (
  observed: Profile | null | undefined,
  desired: Profile | undefined,
) =>
  desired === undefined ||
  (observed != null &&
    observed.businessAddress === desired.businessAddress &&
    observed.businessEmail === desired.businessEmail &&
    observed.businessName === desired.businessName &&
    observed.businessPhone === desired.businessPhone &&
    observed.externalMetadata === desired.externalMetadata);

const toAttributes = (
  org:
    | organizations.GetOrganizationResponse
    | organizations.CreateOrganizationResponse
    | organizations.UpdateOrganizationResponse
    | organizations.ListOrganizationsResponse["result"][number],
): Attributes => ({
  organizationId: org.id,
  name: org.name,
  createTime: org.createTime,
  managedBy: org.meta.managedBy ?? undefined,
  flags: org.meta.flags ?? undefined,
  parent: org.parent ?? undefined,
  profile: org.profile ?? undefined,
});
