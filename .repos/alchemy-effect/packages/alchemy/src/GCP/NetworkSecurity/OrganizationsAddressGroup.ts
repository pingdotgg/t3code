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
  sameStringList,
  sortedStrings,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./operations.ts";

const DEFAULT_TYPE = "IPV4" satisfies networksecurity.AddressGroupTypeEnum;
const DEFAULT_CAPACITY = 100;

export type OrganizationsAddressGroupType =
  | networksecurity.AddressGroupTypeEnum
  | (string & {});

export type OrganizationsAddressGroupPurpose =
  | networksecurity.AddressGroupPurposeItemEnum
  | (string & {});

export type OrganizationsAddressGroupProps = {
  /**
   * Address group id (the `{addressGroup}` segment of
   * `organizations/{organization}/locations/{location}/addressGroups/{addressGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the group.
   */
  addressGroupId?: string;
  /**
   * Organization id or `organizations/{organization}`. If omitted, Alchemy
   * uses `GOOGLE_ORGANIZATION_ID` or the project's Resource Manager
   * parent. Immutable — changing it replaces the group.
   */
  organization?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the group.
   * @default "global"
   */
  location?: string;
  /**
   * Address type. Immutable — changing it replaces the group.
   * @default "IPV4"
   */
  type?: OrganizationsAddressGroupType;
  /**
   * Maximum number of items. Immutable — changing it replaces the group.
   * @default 100
   */
  capacity?: number;
  /**
   * IP addresses or CIDR ranges stored in the group.
   */
  items?: string[];
  /**
   * Supported purposes (`DEFAULT`, `CLOUD_ARMOR`). Immutable — changing
   * them replaces the group.
   */
  purpose?: OrganizationsAddressGroupPurpose[];
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OrganizationsAddressGroup = Resource<
  "GCP.NetworkSecurity.OrganizationsAddressGroup",
  OrganizationsAddressGroupProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/addressGroups/{addressGroup}`. */
    name: string;
    /** Address group id (last path segment). */
    addressGroupId: string;
    /** Organization id. */
    organization: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Address type (`IPV4` or `IPV6`). */
    type: string;
    /** Maximum number of items. */
    capacity: number;
    /** IP addresses or CIDR ranges. */
    items: string[];
    /** Supported purposes. */
    purpose: string[];
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-defined URL for this resource. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Network Security address group.
 *
 * Changing `addressGroupId`, `organization`, `location`, `type`,
 * `capacity`, or `purpose` replaces the group. Description, labels, and
 * items update in place.
 *
 * ### Creating an Organization Address Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.OrganizationsAddressGroup(
 *   "OrgAllowlist",
 *   { items: ["10.0.0.1"] },
 * );
 * ```
 *
 * **Example:** Named group
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.OrganizationsAddressGroup(
 *   "OrgAllowlist",
 *   {
 *     addressGroupId: "org-allowlist",
 *     organization: "123456789",
 *     type: "IPV4",
 *     items: ["10.0.0.0/24"],
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const OrganizationsAddressGroup = Resource<OrganizationsAddressGroup>(
  "GCP.NetworkSecurity.OrganizationsAddressGroup",
);

const resourceName = (
  organization: string,
  location: string,
  addressGroupId: string,
) =>
  `organizations/${organization}/locations/${location}/addressGroups/${addressGroupId}`;

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const capacityOf = (value: number | undefined) => value ?? DEFAULT_CAPACITY;

const toAttrs = (group: networksecurity.AddressGroup) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    addressGroupId: parsed.id,
    organization: parsed.parentId,
    location: parsed.location,
    type: group.type ?? DEFAULT_TYPE,
    capacity: group.capacity ?? DEFAULT_CAPACITY,
    items: group.items ?? [],
    purpose: (group.purpose ?? []) as string[],
    description: group.description,
    labels: userLabels(group.labels),
    selfLink: group.selfLink,
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getOrganizationsLocationsAddressGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (organization: string) =>
  networksecurity.listOrganizationsLocationsAddressGroups
    .pages({
      parent: organizationParent(organization, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.addressGroups ?? [])),
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

export const OrganizationsAddressGroupProvider = () =>
  Provider.succeed(OrganizationsAddressGroup, {
    stables: [
      "name",
      "addressGroupId",
      "organization",
      "location",
      "type",
      "capacity",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.addressGroupId ?? output?.addressGroupId;
      const nextId = news.addressGroupId ?? previousId;
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization ?? previousOrg;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousType = typeOf(olds?.type ?? output?.type);
      const nextType = typeOf(news.type ?? olds?.type ?? output?.type);
      const previousCapacity = capacityOf(olds?.capacity ?? output?.capacity);
      const nextCapacity = capacityOf(
        news.capacity ?? olds?.capacity ?? output?.capacity,
      );
      const previousPurpose = sortedStrings(olds?.purpose ?? output?.purpose);
      const nextPurpose = sortedStrings(
        news.purpose ?? olds?.purpose ?? output?.purpose,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        (previousOrg !== undefined &&
          nextOrg !== undefined &&
          nextOrg !== previousOrg) ||
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousCapacity !== nextCapacity ||
        JSON.stringify(previousPurpose) !== JSON.stringify(nextPurpose);
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
      const addressGroupId = yield* toPhysicalId(
        id,
        olds?.addressGroupId,
        output?.addressGroupId,
        "addressgroup",
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
          ? resourceName(organization, location, addressGroupId)
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
        const listed: OrganizationsAddressGroup["Attributes"][] = [];
        for (const organization of orgs) {
          listed.push(...(yield* listOwned(organization)));
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const addressGroupId = yield* toPhysicalId(
        id,
        news.addressGroupId,
        output?.addressGroupId,
        "addressgroup",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(organization, location, addressGroupId);
      const type = typeOf(news.type);
      const capacity = capacityOf(news.capacity);
      const items = news.items ?? [];
      const purpose = news.purpose;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createOrganizationsLocationsAddressGroups({
            parent: organizationParent(organization, location),
            addressGroupId,
            body: {
              type,
              capacity,
              items,
              purpose,
              description: news.description,
              labels: desiredLabels,
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
      const itemsChanged = !sameStringList(current.items, items);

      if (labelsChanged || descriptionChanged || itemsChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
          itemsChanged ? "items" : undefined,
        ].filter((field): field is string => field !== undefined);

        const operation =
          yield* networksecurity.patchOrganizationsLocationsAddressGroups({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              items,
            },
          });
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
        .deleteOrganizationsLocationsAddressGroups({ name: output.name })
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
