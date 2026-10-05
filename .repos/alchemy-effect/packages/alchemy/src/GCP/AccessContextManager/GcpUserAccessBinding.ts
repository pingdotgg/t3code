import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  jsonEqual,
  lastSegment,
  organizationParent,
  replaceOnIdentity,
  resolveOrganization,
  resourceNameFromOperation,
  sameStringList,
  tryResolveOrganization,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GcpUserAccessBindingApplication = acm.Application;
export type GcpUserAccessBindingSessionSettings = acm.SessionSettings;
export type GcpUserAccessBindingScopedAccessSettings = acm.ScopedAccessSettings;

export type GcpUserAccessBindingProps = {
  /**
   * Organization parent (`organizations/{organization}` or the numeric
   * organization id). If omitted, Alchemy uses `GOOGLE_ORGANIZATION_ID`
   * or the project's Resource Manager parent. Immutable — changing it
   * replaces the binding.
   */
  organization?: string;
  /**
   * Google Group id whose users are subject to this binding. Directory
   * API group `id`, not the group email. Immutable — changing it
   * replaces the binding. Unique per organization.
   */
  groupKey: string;
  /**
   * Access levels a user must satisfy. At most one entry. Example:
   * `accessPolicies/9522/accessLevels/device_trusted`.
   */
  accessLevels?: string[];
  /**
   * Dry-run access levels that are evaluated but not enforced. At most
   * one entry.
   */
  dryRunAccessLevels?: string[];
  /**
   * Google Cloud session length settings for the group.
   */
  sessionSettings?: GcpUserAccessBindingSessionSettings;
  /**
   * Applications subject to this binding. Empty applies the binding to
   * every application. Mutually exclusive with `scopedAccessSettings`.
   */
  restrictedClientApplications?: GcpUserAccessBindingApplication[];
  /**
   * Per-application access settings. Mutually exclusive with
   * `restrictedClientApplications`.
   */
  scopedAccessSettings?: GcpUserAccessBindingScopedAccessSettings[];
};

export type GcpUserAccessBinding = Resource<
  "GCP.AccessContextManager.GcpUserAccessBinding",
  GcpUserAccessBindingProps,
  {
    /** Resource name `organizations/{org}/gcpUserAccessBindings/{id}`. */
    name: string;
    /** Binding id (last path segment). Assigned by the API. */
    gcpUserAccessBindingId: string;
    /** Organization id. */
    organization: string;
    /** Google Group id. */
    groupKey: string | undefined;
    /** Enforced access levels. */
    accessLevels: string[];
    /** Dry-run access levels. */
    dryRunAccessLevels: string[];
    /** Session settings, if set. */
    sessionSettings: GcpUserAccessBindingSessionSettings | undefined;
    /** Restricted client applications. */
    restrictedClientApplications: GcpUserAccessBindingApplication[];
    /** Scoped access settings. */
    scopedAccessSettings: GcpUserAccessBindingScopedAccessSettings[];
  },
  never,
  Providers
>;

/**
 * A Context-Aware Access binding of Cloud Console / API restrictions to
 * a Google Group.
 *
 * Bindings live on an organization. The API assigns the resource name
 * and has no labels or description field. Identity is
 * `(organization, groupKey)` — Alchemy treats existence at that pair as
 * ownership, and `list` returns every binding on the current
 * organization so `pnpm nuke:gcp` can clean leaks.
 *
 * `organization` and `groupKey` are immutable. Access levels, dry-run
 * levels, session settings, restricted applications, and scoped settings
 * update in place.
 *
 * ### Creating a Binding
 * **Example:** Require an access level for a group
 * ```typescript
 * const binding = yield* GCP.AccessContextManager.GcpUserAccessBinding(
 *   "Engineers",
 *   {
 *     groupKey: "01d520gv4vjcrht",
 *     accessLevels: ["accessPolicies/9522/accessLevels/device_trusted"],
 *   },
 * );
 * ```
 *
 * ### Updating a Binding
 * **Example:** Change the required access level
 * ```typescript
 * const binding = yield* GCP.AccessContextManager.GcpUserAccessBinding(
 *   "Engineers",
 *   {
 *     groupKey: "01d520gv4vjcrht",
 *     accessLevels: ["accessPolicies/9522/accessLevels/corp_network"],
 *   },
 * );
 * ```
 *
 * @resource
 * @category AccessContextManager
 */
export const GcpUserAccessBinding = Resource<GcpUserAccessBinding>(
  "GCP.AccessContextManager.GcpUserAccessBinding",
);

export class GcpUserAccessBindingNotResolved extends Data.TaggedError(
  "GCP.AccessContextManager.GcpUserAccessBindingNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  binding: acm.GcpUserAccessBinding,
): GcpUserAccessBinding["Attributes"] => {
  const name = binding.name ?? "";
  const parts = name.split("/").filter((part) => part.length > 0);
  const orgsAt = parts.lastIndexOf("organizations");
  return {
    name,
    gcpUserAccessBindingId: lastSegment(name),
    organization: orgsAt >= 0 && parts[orgsAt + 1] ? parts[orgsAt + 1]! : "",
    groupKey: binding.groupKey,
    accessLevels: binding.accessLevels ?? [],
    dryRunAccessLevels: binding.dryRunAccessLevels ?? [],
    sessionSettings: binding.sessionSettings,
    restrictedClientApplications: binding.restrictedClientApplications ?? [],
    scopedAccessSettings: binding.scopedAccessSettings ?? [],
  };
};

const getByName = (name: string) =>
  acm
    .getOrganizationsGcpUserAccessBindings({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listBindings = (organization: string) =>
  collectPages(
    acm.listOrganizationsGcpUserAccessBindings.pages({
      parent: organizationParent(organization),
      pageSize: 100,
    }),
    (page) => page.gcpUserAccessBindings,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as acm.GcpUserAccessBinding[]),
    ),
  );

const findByGroupKey = (organization: string, groupKey: string) =>
  Effect.gen(function* () {
    const bindings = yield* listBindings(organization);
    return bindings.find((binding) => binding.groupKey === groupKey);
  });

const observe = (
  name: string | undefined,
  organization: string,
  groupKey: string | undefined,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const byName = yield* getByName(name);
      if (byName !== undefined) return byName;
    }
    if (groupKey !== undefined && groupKey.length > 0) {
      return yield* findByGroupKey(organization, groupKey);
    }
    return undefined;
  });

export const GcpUserAccessBindingProvider = () =>
  Provider.succeed(GcpUserAccessBinding, {
    stables: ["name", "gcpUserAccessBindingId", "organization", "groupKey"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization ?? previousOrg;
      const orgChanged =
        previousOrg !== undefined &&
        nextOrg !== undefined &&
        lastSegment(previousOrg) !== lastSegment(nextOrg);
      const previousGroup = olds?.groupKey ?? output?.groupKey;
      const groupChanged =
        previousGroup !== undefined && news.groupKey !== previousGroup;
      return replaceOnIdentity(orgChanged || groupChanged);
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const organization = yield* resolveOrganization(
        olds?.organization,
        output?.organization,
      );
      const existing = yield* observe(
        output?.name,
        organization,
        olds?.groupKey ?? output?.groupKey,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      if (output?.name !== undefined && existing.name === output.name) {
        return attrs;
      }
      if (
        (olds?.groupKey ?? output?.groupKey) !== undefined &&
        existing.groupKey === (olds?.groupKey ?? output?.groupKey)
      ) {
        return attrs;
      }
      return Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const bindings = yield* listBindings(organization);
        return bindings.map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const desiredLevels = news.accessLevels ?? [];
      const desiredDryRun = news.dryRunAccessLevels ?? [];

      let current = yield* observe(output?.name, organization, news.groupKey);

      if (current === undefined) {
        const created = yield* acm
          .createOrganizationsGcpUserAccessBindings({
            parent: organization,
            body: {
              groupKey: news.groupKey,
              accessLevels:
                desiredLevels.length > 0 ? desiredLevels : undefined,
              dryRunAccessLevels:
                desiredDryRun.length > 0 ? desiredDryRun : undefined,
              sessionSettings: news.sessionSettings,
              scopedAccessSettings: news.scopedAccessSettings,
              restrictedClientApplications: news.restrictedClientApplications,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          const settled = yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.succeed(created) : Effect.fail(error),
            ),
          );
          const createdName =
            resourceNameFromOperation(settled) ??
            resourceNameFromOperation(created) ??
            output?.name;
          current =
            createdName !== undefined
              ? yield* waitUntilExists(getByName(createdName), createdName)
              : yield* waitUntilExists(
                  findByGroupKey(organization, news.groupKey),
                  `${organization}/gcpUserAccessBindings/${news.groupKey}`,
                );
        } else {
          current = yield* waitUntilExists(
            findByGroupKey(organization, news.groupKey),
            `${organization}/gcpUserAccessBindings/${news.groupKey}`,
          );
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new GcpUserAccessBindingNotResolved({
          name: output?.name ?? `${organization}/${news.groupKey}`,
        });
      }

      const levelsChanged = !sameStringList(
        current.accessLevels,
        desiredLevels,
      );
      const dryRunChanged = !sameStringList(
        current.dryRunAccessLevels,
        desiredDryRun,
      );
      const sessionChanged =
        news.sessionSettings !== undefined &&
        !jsonEqual(current.sessionSettings, news.sessionSettings);
      const appsChanged =
        news.restrictedClientApplications !== undefined &&
        !jsonEqual(
          current.restrictedClientApplications,
          news.restrictedClientApplications,
        );
      const scopedChanged =
        news.scopedAccessSettings !== undefined &&
        !jsonEqual(current.scopedAccessSettings, news.scopedAccessSettings);

      const updateMask = [
        levelsChanged ? "access_levels" : undefined,
        dryRunChanged ? "dry_run_access_levels" : undefined,
        sessionChanged ? "session_settings" : undefined,
        appsChanged ? "restricted_client_applications" : undefined,
        scopedChanged ? "scoped_access_settings" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const operation = yield* acm.patchOrganizationsGcpUserAccessBindings({
          name: current.name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name,
            accessLevels: desiredLevels,
            dryRunAccessLevels: desiredDryRun,
            sessionSettings: news.sessionSettings,
            scopedAccessSettings: news.scopedAccessSettings,
            restrictedClientApplications: news.restrictedClientApplications,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getByName(current.name), current.name);
      }

      if (current === undefined) {
        return yield* new GcpUserAccessBindingNotResolved({
          name: output?.name ?? `${organization}/${news.groupKey}`,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* acm
        .deleteOrganizationsGcpUserAccessBindings({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
