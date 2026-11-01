import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
  listOrganizations,
  normalizeLocation,
  organizationParent,
  parseResourceName,
  ResourceNotResolved,
  resolveOrganization,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

export type OrganizationsSecurityProfileGroupProps = {
  /**
   * Security profile group id. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the group.
   */
  securityProfileGroupId?: string;
  /**
   * Organization id or `organizations/{organization}`. If omitted,
   * Alchemy uses `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager parent. Immutable — changing it replaces the group.
   */
  organization?: string;
  /**
   * Location. Profile groups live in `global`. Immutable — changing it
   * replaces the group.
   * @default "global"
   */
  location?: string;
  /**
   * Threat-prevention SecurityProfile resource name.
   */
  threatPreventionProfile?: string;
  /**
   * URL-filtering SecurityProfile resource name.
   */
  urlFilteringProfile?: string;
  /**
   * Custom-mirroring SecurityProfile resource name.
   */
  customMirroringProfile?: string;
  /**
   * Custom-intercept SecurityProfile resource name.
   */
  customInterceptProfile?: string;
  /**
   * Human-readable description (max 2048 characters).
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OrganizationsSecurityProfileGroup = Resource<
  "GCP.NetworkSecurity.OrganizationsSecurityProfileGroup",
  OrganizationsSecurityProfileGroupProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/securityProfileGroups/{securityProfileGroup}`. */
    name: string;
    /** Security profile group id (last path segment). */
    securityProfileGroupId: string;
    /** Organization id. */
    organization: string;
    /** Location id. */
    location: string;
    /** Threat-prevention profile name, if set. */
    threatPreventionProfile: string | undefined;
    /** URL-filtering profile name, if set. */
    urlFilteringProfile: string | undefined;
    /** Custom-mirroring profile name, if set. */
    customMirroringProfile: string | undefined;
    /** Custom-intercept profile name, if set. */
    customInterceptProfile: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Data-path identifier. */
    dataPathId: string | undefined;
    /** Server-computed checksum. */
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
 * An organization-scoped group of Network Security profiles.
 *
 * Changing `securityProfileGroupId`, `organization`, or `location`
 * replaces the group. Profile references, description, and labels update
 * in place.
 *
 * ### Creating a Security Profile Group
 * **Example:** Empty group
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.OrganizationsSecurityProfileGroup(
 *   "Profiles",
 *   {},
 * );
 * ```
 *
 * **Example:** Attach a threat-prevention profile
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.OrganizationsSecurityProfileGroup(
 *   "Profiles",
 *   {
 *     threatPreventionProfile: profile.name,
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const OrganizationsSecurityProfileGroup =
  Resource<OrganizationsSecurityProfileGroup>(
    "GCP.NetworkSecurity.OrganizationsSecurityProfileGroup",
  );

const resourceName = (
  organization: string,
  location: string,
  securityProfileGroupId: string,
) =>
  `organizations/${organization}/locations/${location}/securityProfileGroups/${securityProfileGroupId}`;

const toAttrs = (group: networksecurity.SecurityProfileGroup) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    securityProfileGroupId: parsed.id,
    organization: parsed.parentId,
    location: parsed.location,
    threatPreventionProfile: group.threatPreventionProfile,
    urlFilteringProfile: group.urlFilteringProfile,
    customMirroringProfile: group.customMirroringProfile,
    customInterceptProfile: group.customInterceptProfile,
    description: group.description,
    labels: userLabels(group.labels),
    dataPathId: group.dataPathId,
    etag: group.etag,
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getOrganizationsLocationsSecurityProfileGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (organization: string) =>
  networksecurity.listOrganizationsLocationsSecurityProfileGroups
    .pages({
      parent: organizationParent(organization, "-"),
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
      Stream.map(toAttrs),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const OrganizationsSecurityProfileGroupProvider = () =>
  Provider.succeed(OrganizationsSecurityProfileGroup, {
    stables: [
      "name",
      "securityProfileGroupId",
      "organization",
      "location",
      "dataPathId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.securityProfileGroupId ?? output?.securityProfileGroupId;
      const nextId = news.securityProfileGroupId ?? previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization ?? previousOrg;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousOrg !== undefined &&
          nextOrg !== undefined &&
          nextOrg !== previousOrg) ||
        previousLocation !== nextLocation;
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousOrg === nextOrg &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const securityProfileGroupId = yield* toPhysicalId(
        id,
        olds?.securityProfileGroupId,
        output?.securityProfileGroupId,
        "secprofilegroup",
      );
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      ).pipe(
        Effect.catchTag("GCP.NetworkSecurity.OrganizationRequired", () =>
          Effect.succeed(output?.organization ?? ""),
        ),
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        (organization.length > 0
          ? resourceName(organization, location, securityProfileGroupId)
          : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const orgs = yield* listOrganizations(env.project);
        const listed: OrganizationsSecurityProfileGroup["Attributes"][] = [];
        for (const organization of orgs) {
          listed.push(...(yield* listOwned(organization)));
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const securityProfileGroupId = yield* toPhysicalId(
        id,
        news.securityProfileGroupId,
        output?.securityProfileGroupId,
        "secprofilegroup",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(organization, location, securityProfileGroupId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createOrganizationsLocationsSecurityProfileGroups({
            parent: organizationParent(organization, location),
            securityProfileGroupId,
            body: {
              description: news.description,
              labels: desiredLabels,
              threatPreventionProfile: news.threatPreventionProfile,
              urlFilteringProfile: news.urlFilteringProfile,
              customMirroringProfile: news.customMirroringProfile,
              customInterceptProfile: news.customInterceptProfile,
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
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const threatChanged =
        (current.threatPreventionProfile ?? "") !==
        (news.threatPreventionProfile ?? "");
      const urlChanged =
        (current.urlFilteringProfile ?? "") !==
        (news.urlFilteringProfile ?? "");
      const mirrorChanged =
        (current.customMirroringProfile ?? "") !==
        (news.customMirroringProfile ?? "");
      const interceptChanged =
        (current.customInterceptProfile ?? "") !==
        (news.customInterceptProfile ?? "");

      if (
        labelsChanged ||
        descriptionChanged ||
        threatChanged ||
        urlChanged ||
        mirrorChanged ||
        interceptChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          threatChanged ? "threatPreventionProfile" : undefined,
          urlChanged ? "urlFilteringProfile" : undefined,
          mirrorChanged ? "customMirroringProfile" : undefined,
          interceptChanged ? "customInterceptProfile" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchOrganizationsLocationsSecurityProfileGroups(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                threatPreventionProfile: news.threatPreventionProfile,
                urlFilteringProfile: news.urlFilteringProfile,
                customMirroringProfile: news.customMirroringProfile,
                customInterceptProfile: news.customInterceptProfile,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteOrganizationsLocationsSecurityProfileGroups({
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
