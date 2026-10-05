import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  toResourcePath,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "securityProfileGroups";

export type SecurityProfileGroupProps = {
  /**
   * SecurityProfileGroup id (the `{securityProfileGroup}` segment of
   * `projects/{project}/locations/{location}/securityProfileGroups/{securityProfileGroup}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, letters, numbers, hyphens, and
   * underscores, and must not start with a number. Immutable — changing
   * it replaces the group.
   */
  securityProfileGroupId?: string;
  /**
   * Location. Security profile groups live in `global`. Immutable —
   * changing it replaces the group.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 2048 characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * SecurityProfile resource name with ThreatPrevention configuration.
   */
  threatPreventionProfile?: string;
  /**
   * SecurityProfile resource name with UrlFiltering configuration.
   */
  urlFilteringProfile?: string;
  /**
   * SecurityProfile resource name with CustomMirroring configuration.
   */
  customMirroringProfile?: string;
  /**
   * SecurityProfile resource name with CustomIntercept configuration.
   */
  customInterceptProfile?: string;
};

export type SecurityProfileGroup = Resource<
  "GCP.NetworkSecurity.SecurityProfileGroup",
  SecurityProfileGroupProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/securityProfileGroups/{securityProfileGroup}`. */
    name: string;
    /** SecurityProfileGroup id (last path segment). */
    securityProfileGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. Typically `"global"`. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Threat-prevention profile name, if set. */
    threatPreventionProfile: string | undefined;
    /** URL-filtering profile name, if set. */
    urlFilteringProfile: string | undefined;
    /** Custom mirroring profile name, if set. */
    customMirroringProfile: string | undefined;
    /** Custom intercept profile name, if set. */
    customInterceptProfile: string | undefined;
    /** Data-path identifier unique within `{container, location}`. */
    dataPathId: string | undefined;
    /** Server-computed checksum used on update and delete. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security SecurityProfileGroup — a named bundle of
 * SecurityProfile references applied together by firewall policy rules.
 *
 * Changing `securityProfileGroupId` or `location` replaces the group.
 * Description, labels, and profile references update in place.
 *
 * ### Creating a SecurityProfileGroup
 * **Example:** Empty group
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.SecurityProfileGroup("Ngfw", {});
 * ```
 *
 * **Example:** Group bound to a threat-prevention profile
 * ```typescript
 * const profile = yield* GCP.NetworkSecurity.SecurityProfile("Threat", {
 *   type: "THREAT_PREVENTION",
 * });
 * const group = yield* GCP.NetworkSecurity.SecurityProfileGroup("Ngfw", {
 *   securityProfileGroupId: "app-ngfw",
 *   description: "prod ngfw",
 *   labels: { env: "prod" },
 *   threatPreventionProfile: profile.name,
 * });
 * ```
 *
 * ### Updating a SecurityProfileGroup
 * **Example:** Attach a profile and change labels
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.SecurityProfileGroup("Ngfw", {
 *   securityProfileGroupId: "app-ngfw",
 *   description: "prod ngfw v2",
 *   labels: { env: "prod", role: "ngfw" },
 *   threatPreventionProfile: profile.name,
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const SecurityProfileGroup = Resource<SecurityProfileGroup>(
  "GCP.NetworkSecurity.SecurityProfileGroup",
);

export class SecurityProfileGroupNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.SecurityProfileGroupNotResolved",
)<{
  name: string;
}> {}

export class SecurityProfileGroupStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.SecurityProfileGroupStillExists",
)<{
  name: string;
}> {}

const refOf = (value: string | undefined) => {
  if (value === undefined || value.length === 0) return undefined;
  return toResourcePath(value);
};

const toAttrs = (
  group: networksecurity.SecurityProfileGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    securityProfileGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    description: group.description,
    labels: userLabels(group.labels),
    threatPreventionProfile: group.threatPreventionProfile,
    urlFilteringProfile: group.urlFilteringProfile,
    customMirroringProfile: group.customMirroringProfile,
    customInterceptProfile: group.customInterceptProfile,
    dataPathId: group.dataPathId,
    etag: group.etag,
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsSecurityProfileGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group
        ? Effect.succeed(group)
        : Effect.fail(new SecurityProfileGroupNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.SecurityProfileGroupNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((group) =>
      group === undefined
        ? Effect.void
        : Effect.fail(new SecurityProfileGroupStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.SecurityProfileGroupStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsSecurityProfileGroups
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.securityProfileGroups ?? []),
      ),
      Stream.filter((group) =>
        Object.keys(group.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((group) => toAttrs(group, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const SecurityProfileGroupProvider = () =>
  Provider.succeed(SecurityProfileGroup, {
    stables: [
      "name",
      "securityProfileGroupId",
      "project",
      "location",
      "dataPathId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.securityProfileGroupId ?? output?.securityProfileGroupId;
      const nextId = news.securityProfileGroupId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const securityProfileGroupId = yield* toId(
        id,
        olds?.securityProfileGroupId,
        output?.securityProfileGroupId,
        "secgroup",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, securityProfileGroupId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const securityProfileGroupId = yield* toId(
        id,
        news.securityProfileGroupId,
        output?.securityProfileGroupId,
        "secgroup",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        securityProfileGroupId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const threatPreventionProfile = refOf(news.threatPreventionProfile);
      const urlFilteringProfile = refOf(news.urlFilteringProfile);
      const customMirroringProfile = refOf(news.customMirroringProfile);
      const customInterceptProfile = refOf(news.customInterceptProfile);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsSecurityProfileGroups({
            parent: parentOf(env.project, location),
            securityProfileGroupId,
            body: {
              description: news.description,
              labels: desiredLabels,
              threatPreventionProfile,
              urlFilteringProfile,
              customMirroringProfile,
              customInterceptProfile,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new SecurityProfileGroupNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const threatChanged =
        (current.threatPreventionProfile ?? "") !==
        (threatPreventionProfile ?? "");
      const urlChanged =
        (current.urlFilteringProfile ?? "") !== (urlFilteringProfile ?? "");
      const mirroringChanged =
        (current.customMirroringProfile ?? "") !==
        (customMirroringProfile ?? "");
      const interceptChanged =
        (current.customInterceptProfile ?? "") !==
        (customInterceptProfile ?? "");

      if (
        labelsChanged ||
        descriptionChanged ||
        threatChanged ||
        urlChanged ||
        mirroringChanged ||
        interceptChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          threatChanged ? "threatPreventionProfile" : undefined,
          urlChanged ? "urlFilteringProfile" : undefined,
          mirroringChanged ? "customMirroringProfile" : undefined,
          interceptChanged ? "customInterceptProfile" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation =
          yield* networksecurity.patchProjectsLocationsSecurityProfileGroups({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              threatPreventionProfile,
              urlFilteringProfile,
              customMirroringProfile,
              customInterceptProfile,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsSecurityProfileGroups({
          name: output.name,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
