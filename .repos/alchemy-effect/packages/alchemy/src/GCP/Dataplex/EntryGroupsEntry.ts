import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  DataplexNotResolved,
  MAX_NAME_LENGTH,
  collectPages,
  expandParent,
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryQuota,
  rfc1035,
  userLabels,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type EntrySource = {
  /** Name of the resource in the source system. */
  resource?: string;
  /** Name of the source system. */
  system?: string;
  /** Platform containing the source system. */
  platform?: string;
  /** User-friendly display name. */
  displayName?: string;
  /** Description of the data resource. */
  description?: string;
  /**
   * User-defined source labels. Alchemy ownership labels are merged in
   * automatically — Entries have no top-level labels field.
   */
  labels?: Record<string, string>;
  /** Ancestor entries in the source system. */
  ancestors?: Array<{ name?: string; type?: string }>;
  /** Time the resource was created in the source system. */
  createTime?: string;
  /** Time the resource was last updated in the source system. */
  updateTime?: string;
};

export type EntryGroupsEntryProps = {
  /**
   * Parent Entry Group. Full name
   * `projects/{project}/locations/{location}/entryGroups/{entryGroup}`
   * or the entry-group id (combined with `location`). Immutable —
   * changing it replaces the entry.
   */
  entryGroup: string;
  /**
   * Entry id (the `{entry}` segment of
   * `.../entryGroups/{entryGroup}/entries/{entry}`). May contain slashes
   * (up to 4000 characters). If omitted, a unique name is generated from
   * the stack, stage, and logical id. Immutable — changing it replaces
   * the entry.
   */
  entryId?: string;
  /**
   * Region used when `entryGroup` is a bare id. Immutable — changing it
   * replaces the entry.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Entry type resource name
   * `projects/{project}/locations/{location}/entryTypes/{entryType}`.
   * Immutable — changing it replaces the entry.
   */
  entryType: string;
  /**
   * Parent entry resource name. Immutable — changing it replaces the
   * entry.
   */
  parentEntry?: string;
  /**
   * Fully qualified name used by an external system.
   */
  fullyQualifiedName?: string;
  /**
   * Aspects attached to the entry, keyed by
   * `{project}.{location}.{aspectType}` (or with `@{path}`).
   */
  aspects?: dataplex.GoogleCloudDataplexV1AspectMap;
  /**
   * Source-system metadata. Labels on `entrySource` receive Alchemy
   * ownership stamps.
   */
  entrySource?: EntrySource;
  /**
   * Convenience labels merged into `entrySource.labels`.
   */
  labels?: Record<string, string>;
};

export type EntryGroupsEntry = Resource<
  "GCP.Dataplex.EntryGroupsEntry",
  EntryGroupsEntryProps,
  {
    /** Full resource name. */
    name: string;
    /** Entry id (path after `/entries/`). */
    entryId: string;
    /** Parent entry group resource name. */
    entryGroup: string;
    /** Parent entry group id. */
    entryGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Entry type resource name. */
    entryType: string | undefined;
    /** Parent entry resource name. */
    parentEntry: string | undefined;
    /** Fully qualified name. */
    fullyQualifiedName: string | undefined;
    /** Aspects attached to the entry. */
    aspects: dataplex.GoogleCloudDataplexV1AspectMap | undefined;
    /** Source-system metadata. */
    entrySource: EntrySource | undefined;
    /** User labels from `entrySource` (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex Universal Catalog Entry — a metadata record for a data
 * resource.
 *
 * Entries have no top-level labels field, so Alchemy stamps ownership
 * into `entrySource.labels`. Changing `entryId`, `entryGroup`,
 * `location`, `entryType`, or `parentEntry` replaces the entry. FQN,
 * aspects, and source metadata update in place.
 *
 * ### Creating an Entry
 * **Example:** Entry in a group
 * ```typescript
 * const entry = yield* GCP.Dataplex.EntryGroupsEntry("Orders", {
 *   entryGroup: group.name,
 *   entryType:
 *     "projects/dataplex-types/locations/global/entryTypes/generic",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Entry
 * **Example:** Fully qualified name and labels
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const entry = yield* GCP.Dataplex.EntryGroupsEntry("Orders", {
 *   entryGroup: group.name,
 *   entryType:
 *     "projects/dataplex-types/locations/global/entryTypes/generic",
 *   fullyQualifiedName: "app.orders",
 *   labels: { env: "prod", team: "data" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const EntryGroupsEntry = Resource<EntryGroupsEntry>(
  "GCP.Dataplex.EntryGroupsEntry",
);

const resolveParent = (
  project: string,
  entryGroup: string,
  location: string | undefined,
  defaultLocation: string,
) => {
  const parent = expandParent(
    entryGroup,
    project,
    normalizeLocation(location, defaultLocation),
    "entryGroups",
  );
  const parsed = parseName(`${parent}/entries/_`, "entries");
  return {
    parent: parsed.parent,
    location: parsed.location,
    project: parsed.project || project,
    entryGroupId: lastSegment(parsed.parent),
  };
};

const resourceName = (parent: string, entryId: string) =>
  `${parent}/entries/${entryId}`;

const toEntryId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      "entry",
    );
  });

const sourceLabels = (
  news: EntryGroupsEntryProps,
  ownership: Record<string, string>,
) => ({
  ...toLabels(news.entrySource?.labels),
  ...toLabels(news.labels),
  ...ownership,
});

const toSource = (
  source: dataplex.GoogleCloudDataplexV1EntrySource | undefined,
): EntrySource | undefined => {
  if (source === undefined) return undefined;
  return {
    resource: source.resource,
    system: source.system,
    platform: source.platform,
    displayName: source.displayName,
    description: source.description,
    labels: userLabels(source.labels),
    ancestors: source.ancestors,
    createTime: source.createTime,
    updateTime: source.updateTime,
  };
};

const toAttrs = (
  entry: dataplex.GoogleCloudDataplexV1Entry,
  project: string,
) => {
  const name = entry.name ?? "";
  const parsed = parseName(name, "entries");
  const group = parseName(parsed.parent, "entryGroups");
  return {
    name,
    entryId: parsed.id,
    entryGroup: parsed.parent,
    entryGroupId: group.id,
    project: parsed.project || project,
    location: parsed.location,
    entryType: entry.entryType,
    parentEntry: entry.parentEntry,
    fullyQualifiedName: entry.fullyQualifiedName,
    aspects: entry.aspects,
    entrySource: toSource(entry.entrySource),
    labels: userLabels(entry.entrySource?.labels),
    createTime: entry.createTime,
    updateTime: entry.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(
    dataplex.getProjectsLocationsEntryGroupsEntries({ name, view: "ALL" }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listEntriesUnder = (parent: string, project: string) =>
  collectPages(
    dataplex.listProjectsLocationsEntryGroupsEntries.pages({
      parent,
      pageSize: 100,
    }),
    (page) => page.entries,
  ).pipe(
    Effect.map((items) =>
      items
        .filter((item) => hasAlchemyLabelMap(item.entrySource?.labels))
        .map((item) => toAttrs(item, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const EntryGroupsEntryProvider = () =>
  Provider.succeed(EntryGroupsEntry, {
    stables: [
      "name",
      "entryId",
      "entryGroup",
      "entryGroupId",
      "project",
      "location",
      "entryType",
      "parentEntry",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = olds?.entryType ?? output?.entryType ?? "";
      const nextType = news.entryType ?? previousType;
      const previousParentEntry =
        olds?.parentEntry ?? output?.parentEntry ?? "";
      const nextParentEntry = news.parentEntry ?? previousParentEntry;
      return replaceOnIdentity({
        previousId: olds?.entryId ?? output?.entryId,
        nextId: news.entryId ?? olds?.entryId ?? output?.entryId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.entryGroup ?? output?.entryGroup,
        nextParent: news.entryGroup ?? olds?.entryGroup ?? output?.entryGroup,
        extra:
          nextType !== previousType || nextParentEntry !== previousParentEntry,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        olds?.entryGroup ?? output?.entryGroup ?? "",
        olds?.location ?? output?.location,
        env.region,
      );
      const entryId = yield* toEntryId(id, olds?.entryId, output?.entryId);
      const name = output?.name ?? resourceName(resolved.parent, entryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(
        id,
        tagRecord(existing.entrySource?.labels),
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const groups = yield* listAtLocation(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              dataplex.listProjectsLocationsEntryGroups.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.entryGroups,
            ).pipe(
              Effect.map((items) =>
                items.filter((item) => hasAlchemyLabelMap(item.labels)),
              ),
            ),
        );
        const nested = yield* Effect.forEach(
          groups,
          (group) =>
            group.name
              ? listEntriesUnder(group.name, env.project)
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return nested.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        news.entryGroup,
        news.location ?? output?.location,
        env.region,
      );
      const entryId = yield* toEntryId(id, news.entryId, output?.entryId);
      const name = resourceName(resolved.parent, entryId);
      const ownership = yield* createInternalLabels(id);
      const desiredSourceLabels = sourceLabels(news, ownership);
      const desiredSource: dataplex.GoogleCloudDataplexV1EntrySource = {
        resource: news.entrySource?.resource,
        system: news.entrySource?.system,
        platform: news.entrySource?.platform,
        displayName: news.entrySource?.displayName,
        description: news.entrySource?.description,
        labels: desiredSourceLabels,
        ancestors: news.entrySource?.ancestors,
        createTime: news.entrySource?.createTime,
        updateTime: news.entrySource?.updateTime,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsEntryGroupsEntries({
            parent: resolved.parent,
            entryId,
            body: {
              entryType: news.entryType,
              parentEntry: news.parentEntry,
              fullyQualifiedName: news.fullyQualifiedName,
              aspects: news.aspects,
              entrySource: desiredSource,
            },
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const observedLabels = tagRecord(current.entrySource?.labels);
      const { upsert, removed } = diffLabels(
        observedLabels,
        desiredSourceLabels,
      );
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const fqnChanged =
        (current.fullyQualifiedName ?? "") !== (news.fullyQualifiedName ?? "");
      const aspectsChanged =
        news.aspects !== undefined &&
        fingerprint(news.aspects) !== fingerprint(current.aspects);
      const sourceChanged =
        (current.entrySource?.resource ?? "") !==
          (news.entrySource?.resource ?? "") ||
        (current.entrySource?.system ?? "") !==
          (news.entrySource?.system ?? "") ||
        (current.entrySource?.platform ?? "") !==
          (news.entrySource?.platform ?? "") ||
        (current.entrySource?.displayName ?? "") !==
          (news.entrySource?.displayName ?? "") ||
        (current.entrySource?.description ?? "") !==
          (news.entrySource?.description ?? "");

      if (labelsChanged || fqnChanged || aspectsChanged || sourceChanged) {
        current = yield* retryQuota(
          dataplex.patchProjectsLocationsEntryGroupsEntries({
            name: current.name ?? name,
            updateMask: [
              fqnChanged ? "fullyQualifiedName" : undefined,
              aspectsChanged ? "aspects" : undefined,
              labelsChanged || sourceChanged ? "entrySource" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              fullyQualifiedName: news.fullyQualifiedName,
              aspects: news.aspects ?? current.aspects,
              entrySource: desiredSource,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryQuota(
        dataplex.deleteProjectsLocationsEntryGroupsEntries({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
