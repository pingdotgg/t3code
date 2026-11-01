import * as cnr from "@distilled.cloud/gcp/cloudnumberregistry_v1alpha";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  ResourceNotResolved,
  expandName,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceName,
  sameRef,
  sameText,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const COLLECTION = "customRanges";

export type CustomRangeAttribute = {
  /** Attribute key. */
  key?: string;
  /** Attribute value. */
  value?: string;
};

export type CustomRangeProps = {
  /**
   * Custom range id (the `{customRange}` segment of
   * `projects/{project}/locations/{location}/customRanges/{customRange}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the range.
   */
  customRangeId?: string;
  /**
   * Location of the range. Cloud Number Registry is global — `global`
   * is the only supported value. Immutable — changing it replaces the
   * range.
   * @default "global"
   */
  location?: string;
  /**
   * Parent realm. Accepts a realm id or a full resource name. Mutually
   * exclusive with `parentRange`. Immutable — changing it replaces the
   * range.
   */
  realm?: string;
  /**
   * Parent custom range. Accepts a range id or a full resource name.
   * Mutually exclusive with `realm` — the child inherits the parent's
   * realm. Immutable — changing it replaces the range.
   */
  parentRange?: string;
  /**
   * IPv4 CIDR (for example `10.0.0.0/22`). Mutually exclusive with
   * `ipv6CidrRange`. Immutable — changing it replaces the range.
   */
  ipv4CidrRange?: string;
  /**
   * IPv6 CIDR. Mutually exclusive with `ipv4CidrRange`. Immutable —
   * changing it replaces the range.
   */
  ipv6CidrRange?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Searchable attributes (`key` / `value` pairs).
   */
  attributes?: CustomRangeAttribute[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type CustomRange = Resource<
  "GCP.CloudNumberRegistry.CustomRange",
  CustomRangeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/customRanges/{customRange}`. */
    name: string;
    /** Custom range id (last path segment). */
    customRangeId: string;
    /** Project id. */
    project: string;
    /** Location id of the resource. */
    location: string;
    /** Parent realm, if this range is attached directly to a realm. */
    realm: string | undefined;
    /** Parent custom range, if this is a child range. */
    parentRange: string | undefined;
    /** Inherited registry book. */
    registryBook: string | undefined;
    /** IPv4 CIDR, if this is an IPv4 range. */
    ipv4CidrRange: string | undefined;
    /** IPv6 CIDR, if this is an IPv6 range. */
    ipv6CidrRange: string | undefined;
    /** Human-readable description. */
    description: string | undefined;
    /** Searchable attributes. */
    attributes: CustomRangeAttribute[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A user-defined Cloud Number Registry IP range. Custom ranges track
 * address space that discovery does not cover (on-prem subnets, and so
 * on) and can only be added to user-managed realms.
 *
 * `customRangeId`, `location`, `realm`, `parentRange`, and the CIDR
 * replace the resource. Description, attributes, and labels update in
 * place.
 *
 * ### Creating a Custom Range
 * **Example:** Range in a realm
 * ```typescript
 * const book = yield* GCP.CloudNumberRegistry.RegistryBook("Inventory", {});
 * const realm = yield* GCP.CloudNumberRegistry.Realm("Private", {
 *   registryBook: book.name,
 * });
 * const range = yield* GCP.CloudNumberRegistry.CustomRange("OnPrem", {
 *   realm: realm.name,
 *   ipv4CidrRange: "10.0.0.0/22",
 *   description: "on-prem campus",
 * });
 * ```
 *
 * **Example:** Child range
 * ```typescript
 * const child = yield* GCP.CloudNumberRegistry.CustomRange("Building", {
 *   parentRange: parent.name,
 *   ipv4CidrRange: "10.0.0.0/24",
 * });
 * ```
 *
 * ### Updating a Custom Range
 * **Example:** Description and labels
 * ```typescript
 * const range = yield* GCP.CloudNumberRegistry.CustomRange("OnPrem", {
 *   realm: realm.name,
 *   ipv4CidrRange: "10.0.0.0/22",
 *   description: "on-prem campus v2",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category CloudNumberRegistry
 */
export const CustomRange = Resource<CustomRange>(
  "GCP.CloudNumberRegistry.CustomRange",
);

const toAttributes = (
  attributes: readonly cnr.Attribute[] | undefined,
): CustomRangeAttribute[] =>
  (attributes ?? []).map((attribute) => ({
    key: attribute.key,
    value: attribute.value,
  }));

const toAttrs = (item: cnr.CustomRange, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    customRangeId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    realm: item.realm,
    parentRange: item.parentRange,
    registryBook: item.registryBook,
    ipv4CidrRange: item.ipv4CidrRange,
    ipv6CidrRange: item.ipv6CidrRange,
    description: item.description,
    attributes: toAttributes(item.attributes),
    labels: userLabels(item.labels),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : cnr
        .getProjectsLocationsCustomRanges({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      cnr.listProjectsLocationsCustomRanges.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.customRanges,
      (item) => item.labels,
    ),
  );

export const CustomRangeProvider = () =>
  Provider.succeed(CustomRange, {
    stables: [
      "name",
      "customRangeId",
      "project",
      "location",
      "realm",
      "parentRange",
      "registryBook",
      "ipv4CidrRange",
      "ipv6CidrRange",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousRealm = olds?.realm ?? output?.realm;
      const previousParent = olds?.parentRange ?? output?.parentRange;
      const previousV4 = olds?.ipv4CidrRange ?? output?.ipv4CidrRange;
      const nextV4 = news.ipv4CidrRange ?? previousV4;
      const previousV6 = olds?.ipv6CidrRange ?? output?.ipv6CidrRange;
      const nextV6 = news.ipv6CidrRange ?? previousV6;
      return replaceOnIdentity({
        previousId: olds?.customRangeId ?? output?.customRangeId,
        nextId:
          news.customRangeId ?? olds?.customRangeId ?? output?.customRangeId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        extra:
          (news.realm !== undefined &&
            previousRealm !== undefined &&
            !sameRef(previousRealm, news.realm)) ||
          (news.parentRange !== undefined &&
            previousParent !== undefined &&
            !sameRef(previousParent, news.parentRange)) ||
          (news.realm !== undefined && previousParent !== undefined) ||
          (news.parentRange !== undefined && previousRealm !== undefined) ||
          (previousV4 !== undefined &&
            nextV4 !== undefined &&
            previousV4 !== nextV4) ||
          (previousV6 !== undefined &&
            nextV6 !== undefined &&
            previousV6 !== nextV6),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const customRangeId = yield* toPhysicalId(
        id,
        olds?.customRangeId,
        output?.customRangeId,
        "range",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, customRangeId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const customRangeId = yield* toPhysicalId(
        id,
        news.customRangeId,
        output?.customRangeId,
        "range",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        customRangeId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const realm =
        news.parentRange === undefined && news.realm !== undefined
          ? expandName(news.realm, env.project, location, "realms")
          : undefined;
      const parentRange =
        news.parentRange !== undefined
          ? expandName(news.parentRange, env.project, location, COLLECTION)
          : undefined;
      const attributes = news.attributes;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* cnr
          .createProjectsLocationsCustomRanges({
            parent: parentOf(env.project, location),
            customRangeId,
            body: {
              realm,
              parentRange,
              ipv4CidrRange: news.ipv4CidrRange,
              ipv6CidrRange: news.ipv6CidrRange,
              description: news.description,
              attributes,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
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
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.description, news.description) && "description",
        attributes !== undefined &&
          fingerprint(toAttributes(current.attributes)) !==
            fingerprint(attributes) &&
          "attributes",
      ]);

      if (mask.length > 0) {
        const operation = yield* cnr.patchProjectsLocationsCustomRanges({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            name: current.name ?? name,
            labels: desiredLabels,
            description: news.description,
            attributes,
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
      const operation = yield* cnr
        .deleteProjectsLocationsCustomRanges({
          name: output.name,
          force: true,
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
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
