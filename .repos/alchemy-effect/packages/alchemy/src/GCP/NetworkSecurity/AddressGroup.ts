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
  normalizeLocation,
  parseResourceName,
  projectParent,
  ResourceNotResolved,
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

export type AddressGroupType =
  | networksecurity.AddressGroupTypeEnum
  | (string & {});

export type AddressGroupPurpose =
  | networksecurity.AddressGroupPurposeItemEnum
  | (string & {});

export type AddressGroupProps = {
  /**
   * Address group id (the `{addressGroup}` segment of
   * `projects/{project}/locations/{location}/addressGroups/{addressGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must be 1-63 characters and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * group.
   */
  addressGroupId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the group. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Address type. Immutable — changing it replaces the group.
   * @default "IPV4"
   */
  type?: AddressGroupType;
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
  purpose?: AddressGroupPurpose[];
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AddressGroup = Resource<
  "GCP.NetworkSecurity.AddressGroup",
  AddressGroupProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/addressGroups/{addressGroup}`. */
    name: string;
    /** Address group id (last path segment). */
    addressGroupId: string;
    /** Project id. */
    project: string;
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
 * A Network Security address group — a named collection of IP addresses
 * or CIDR ranges used by firewall policies and Cloud Armor.
 *
 * Changing `addressGroupId`, `location`, `type`, `capacity`, or `purpose`
 * replaces the group. Description, labels, and items update in place.
 *
 * ### Creating an Address Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.AddressGroup("Allowlist", {
 *   items: ["10.0.0.1"],
 * });
 * ```
 *
 * **Example:** Named group with labels
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.AddressGroup("Allowlist", {
 *   addressGroupId: "app-allowlist",
 *   type: "IPV4",
 *   capacity: 100,
 *   items: ["10.0.0.0/24"],
 *   description: "prod allowlist",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Address Group
 * **Example:** Change items and description
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.AddressGroup("Allowlist", {
 *   addressGroupId: "app-allowlist",
 *   items: ["10.0.0.0/24", "10.1.0.1"],
 *   description: "prod allowlist v2",
 *   labels: { env: "prod", role: "allowlist" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const AddressGroup = Resource<AddressGroup>(
  "GCP.NetworkSecurity.AddressGroup",
);

const resourceName = (
  project: string,
  location: string,
  addressGroupId: string,
) =>
  `projects/${project}/locations/${location}/addressGroups/${addressGroupId}`;

const typeOf = (value: string | undefined) =>
  (value ?? DEFAULT_TYPE).toUpperCase();

const capacityOf = (value: number | undefined) => value ?? DEFAULT_CAPACITY;

const toAttrs = (group: networksecurity.AddressGroup, project: string) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    addressGroupId: parsed.id,
    project: parsed.parentId || project,
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
    .getProjectsLocationsAddressGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsAddressGroups
    .pages({
      parent: projectParent(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.addressGroups ?? [])),
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

export const AddressGroupProvider = () =>
  Provider.succeed(AddressGroup, {
    stables: [
      "name",
      "addressGroupId",
      "project",
      "location",
      "type",
      "capacity",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.addressGroupId ?? output?.addressGroupId;
      const nextId = news.addressGroupId ?? previousId;
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
        previousLocation !== nextLocation ||
        previousType !== nextType ||
        previousCapacity !== nextCapacity ||
        JSON.stringify(previousPurpose) !== JSON.stringify(nextPurpose);
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const addressGroupId = yield* toPhysicalId(
        id,
        olds?.addressGroupId,
        output?.addressGroupId,
        "addressgroup",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, addressGroupId);
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
      const addressGroupId = yield* toPhysicalId(
        id,
        news.addressGroupId,
        output?.addressGroupId,
        "addressgroup",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, addressGroupId);
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
          .createProjectsLocationsAddressGroups({
            parent: projectParent(env.project, location),
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
          yield* networksecurity.patchProjectsLocationsAddressGroups({
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

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsAddressGroups({ name: output.name })
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
