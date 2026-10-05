import * as logging from "@distilled.cloud/gcp/logging_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  encodeDescription,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  organizationIdOf,
  parseDescription,
  resolveOrganization,
  sorted,
  toPhysicalId,
  tryResolveOrganization,
} from "./internal.ts";

export type OrganizationLogScopeProps = {
  /**
   * Log scope id (the last segment of the resource name). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Limited to 100 characters: letters, digits, underscores, hyphens,
   * periods; first character must be alphanumeric. Immutable — changing
   * it replaces the log scope.
   */
  logScopeId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project ancestor organization. Immutable —
   * changing it replaces the log scope.
   */
  organization?: string;
  /**
   * Location. Log scopes are only available in `global`. Immutable —
   * changing it replaces the log scope.
   * @default "global"
   */
  location?: string;
  /**
   * Names of parent resources to read logs from. Projects and views are
   * supported (organizations and folders are not). Defaults to the
   * current GCP project. Maximum 5 projects and 100 resources total.
   */
  resourceNames?: string[];
  /**
   * Human-readable description (max 8000 characters). Log scopes have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
};

export type OrganizationLogScope = Resource<
  "GCP.Logging.OrganizationLogScope",
  OrganizationLogScopeProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/logScopes/{logScope}`. */
    name: string;
    /** Log scope id (last path segment). */
    logScopeId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Location (`global`). */
    location: string;
    /** Resource names included in this log scope. */
    resourceNames: string[];
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Logging log scope on an organization.
 *
 * A log scope groups projects (and views) to read logs from. Log scopes
 * exist only in the `global` location. They have no labels field, so
 * Alchemy stamps ownership into the description for `list` / nuke.
 * `logScopeId`, organization, and location are identity.
 *
 * ### Creating an Organization Log Scope
 * **Example:** Scope the current project
 * ```typescript
 * const scope = yield* GCP.Logging.OrganizationLogScope("App", {
 *   description: "application projects",
 * });
 * ```
 *
 * **Example:** Named scope with explicit resources
 * ```typescript
 * const scope = yield* GCP.Logging.OrganizationLogScope("App", {
 *   logScopeId: "app-scope",
 *   resourceNames: ["projects/my-project"],
 *   description: "application projects",
 * });
 * ```
 *
 * ### Updating an Organization Log Scope
 * **Example:** Change description and resource names
 * ```typescript
 * const scope = yield* GCP.Logging.OrganizationLogScope("App", {
 *   resourceNames: ["projects/my-project", "projects/other"],
 *   description: "two application projects",
 * });
 * ```
 *
 * @resource
 * @category Logging
 */
export const OrganizationLogScope = Resource<OrganizationLogScope>(
  "GCP.Logging.OrganizationLogScope",
);

export class OrganizationLogScopeNotResolved extends Data.TaggedError(
  "GCP.Logging.OrganizationLogScopeNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organization: string,
  location: string,
  logScopeId: string,
) => `${organization}/locations/${location}/logScopes/${logScopeId}`;

const parseScopeName = (name: string) => {
  const match = name.match(
    /^(organizations\/[^/]+)\/locations\/([^/]+)\/logScopes\/([^/]+)$/,
  );
  if (!match) return undefined;
  return {
    organization: match[1]!,
    location: match[2]!,
    logScopeId: match[3]!,
  };
};

const toAttrs = (
  scope: logging.LogScope,
  organization: string,
  project: string,
  location: string,
) => {
  const parsed = parseScopeName(scope.name ?? "");
  const logScopeId = parsed?.logScopeId ?? lastSegment(scope.name ?? "");
  const description = parseDescription(scope.description);
  const resolvedOrg = parsed?.organization ?? organization;
  const resolvedLocation = parsed?.location ?? location;
  return {
    name:
      scope.name ??
      (logScopeId
        ? resourceName(resolvedOrg, resolvedLocation, logScopeId)
        : ""),
    logScopeId,
    organization: resolvedOrg,
    organizationId: organizationIdOf(resolvedOrg),
    project,
    location: resolvedLocation,
    resourceNames: [...(scope.resourceNames ?? [])],
    description: description.description,
    createTime: scope.createTime,
    updateTime: scope.updateTime,
  };
};

const getByName = (name: string) =>
  logging
    .getOrganizationsLocationsLogScopes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const OrganizationLogScopeProvider = () =>
  Provider.succeed(OrganizationLogScope, {
    stables: [
      "name",
      "logScopeId",
      "organization",
      "organizationId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.logScopeId ?? output?.logScopeId;
      const idChanged =
        previousId !== undefined &&
        news.logScopeId !== undefined &&
        news.logScopeId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        news.location !== previousLocation;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        news.organization !== previousOrg;
      if (!idChanged && !locationChanged && !orgChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = olds?.location ?? output?.location ?? DEFAULT_LOCATION;
      const logScopeId = yield* toPhysicalId(
        id,
        olds?.logScopeId,
        output?.logScopeId,
        "s",
      );
      const name =
        output?.name ?? resourceName(organization, location, logScopeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project, location);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* logging.listOrganizationsLocationsLogScopes
          .pages({
            parent: `${organization}/locations/${DEFAULT_LOCATION}`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.logScopes ?? [])),
            Stream.filter((scope) => hasOwnershipMarker(scope.description)),
            Stream.map((scope) =>
              toAttrs(scope, organization, env.project, DEFAULT_LOCATION),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = news.location ?? output?.location ?? DEFAULT_LOCATION;
      const logScopeId = yield* toPhysicalId(
        id,
        news.logScopeId,
        output?.logScopeId,
        "s",
      );
      const name = resourceName(organization, location, logScopeId);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredResources = news.resourceNames ??
        output?.resourceNames ?? [`projects/${env.project}`];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* logging
          .createOrganizationsLocationsLogScopes({
            parent: `${organization}/locations/${location}`,
            logScopeId,
            body: {
              resourceNames: [...desiredResources],
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new OrganizationLogScopeNotResolved({ name });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const resourcesChanged =
        news.resourceNames !== undefined &&
        !jsonEqual(sorted(current.resourceNames), sorted(news.resourceNames));
      const updateMask = [
        descriptionChanged ? "description" : undefined,
        resourcesChanged ? "resourceNames" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* logging.patchOrganizationsLocationsLogScopes({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            description: desiredDescription,
            resourceNames: [...desiredResources],
          },
        });
      }

      return toAttrs(current, organization, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* logging
        .deleteOrganizationsLocationsLogScopes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
