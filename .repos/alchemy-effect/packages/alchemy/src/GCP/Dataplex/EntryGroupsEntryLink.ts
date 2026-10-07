import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  RELATED_ENTRY_LINK_TYPE,
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
  toPhysicalId,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type EntryLinkReference = {
  /**
   * Referenced Entry resource name
   * `projects/{project}/locations/{location}/entryGroups/{entryGroup}/entries/{entry}`.
   * Immutable.
   */
  name: string;
  /**
   * Path in the Entry. Empty means the Entry itself. Immutable.
   */
  path?: string;
  /**
   * Reference type (`SOURCE` or `TARGET`). Immutable.
   */
  type?:
    | dataplex.GoogleCloudDataplexV1EntryLinkEntryReferenceTypeEnum
    | (string & {});
};

export type EntryGroupsEntryLinkProps = {
  /**
   * Parent Entry Group. Full name
   * `projects/{project}/locations/{location}/entryGroups/{entryGroup}`
   * or the entry-group id (combined with `location`). Immutable —
   * changing it replaces the link.
   */
  entryGroup: string;
  /**
   * Entry link id. If omitted, a unique name is generated from the
   * stack, stage, and logical id. Must be 1-63 characters, start with
   * a letter, and match `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable —
   * changing it replaces the link.
   */
  entryLinkId?: string;
  /**
   * Region used when `entryGroup` is a bare id. Immutable — changing it
   * replaces the link.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Entry link type resource name. Immutable — changing it replaces
   * the link.
   * @default "projects/dataplex-types/locations/global/entryLinkTypes/related"
   */
  entryLinkType?: string;
  /**
   * Exactly two entry references (`SOURCE` and `TARGET`). Immutable —
   * changing them replaces the link.
   */
  entryReferences: EntryLinkReference[];
  /**
   * Aspects attached to the link, keyed by
   * `{project}.{location}.{aspectType}`.
   */
  aspects?: dataplex.GoogleCloudDataplexV1AspectMap;
};

export type EntryGroupsEntryLink = Resource<
  "GCP.Dataplex.EntryGroupsEntryLink",
  EntryGroupsEntryLinkProps,
  {
    /** Full resource name. */
    name: string;
    /** Entry link id (last path segment). */
    entryLinkId: string;
    /** Parent entry group resource name. */
    entryGroup: string;
    /** Parent entry group id. */
    entryGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Entry link type resource name. */
    entryLinkType: string | undefined;
    /** Referenced entries. */
    entryReferences: EntryLinkReference[];
    /** Aspects attached to the link. */
    aspects: dataplex.GoogleCloudDataplexV1AspectMap | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex Entry Link between two Catalog Entries.
 *
 * Entry links have no labels field. `list` finds links by looking up
 * entries in alchemy-labeled entry groups. Changing `entryLinkId`,
 * `entryGroup`, `location`, `entryLinkType`, or `entryReferences`
 * replaces the link. Aspects update in place.
 *
 * ### Creating an Entry Link
 * **Example:** Related entries
 * ```typescript
 * const link = yield* GCP.Dataplex.EntryGroupsEntryLink("Related", {
 *   entryGroup: group.name,
 *   entryReferences: [
 *     { name: left.name, type: "SOURCE" },
 *     { name: right.name, type: "TARGET" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const EntryGroupsEntryLink = Resource<EntryGroupsEntryLink>(
  "GCP.Dataplex.EntryGroupsEntryLink",
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
  const parsed = parseName(`${parent}/entryLinks/_`, "entryLinks");
  return {
    parent: parsed.parent,
    location: parsed.location,
    project: parsed.project || project,
    entryGroupId: lastSegment(parsed.parent),
  };
};

const resourceName = (parent: string, entryLinkId: string) =>
  `${parent}/entryLinks/${entryLinkId}`;

const linkTypeOf = (value: string | undefined) =>
  value && value.length > 0 ? value : RELATED_ENTRY_LINK_TYPE;

const refsOf = (
  refs:
    | readonly dataplex.GoogleCloudDataplexV1EntryLinkEntryReference[]
    | readonly EntryLinkReference[]
    | undefined,
): EntryLinkReference[] =>
  (refs ?? []).flatMap((ref) =>
    ref.name === undefined
      ? []
      : [
          {
            name: ref.name,
            path: ref.path,
            type: ref.type,
          },
        ],
  );

const refsKey = (refs: readonly EntryLinkReference[] | undefined) =>
  fingerprint(
    refsOf(refs)
      .map((ref) => ({
        name: ref.name,
        path: ref.path ?? "",
        type: (ref.type ?? "").toUpperCase(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

const toAttrs = (
  link: dataplex.GoogleCloudDataplexV1EntryLink,
  project: string,
) => {
  const name = link.name ?? "";
  const parsed = parseName(name, "entryLinks");
  const group = parseName(parsed.parent, "entryGroups");
  return {
    name,
    entryLinkId: parsed.id,
    entryGroup: parsed.parent,
    entryGroupId: group.id,
    project: parsed.project || project,
    location: parsed.location,
    entryLinkType: link.entryLinkType,
    entryReferences: refsOf(link.entryReferences),
    aspects: link.aspects,
    createTime: link.createTime,
    updateTime: link.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsEntryGroupsEntryLinks({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const getGroup = (name: string) =>
  dataplex
    .getProjectsLocationsEntryGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const lookupLinks = (locationParent: string, entry: string, project: string) =>
  collectPages(
    dataplex.lookupEntryLinksProjectsLocations.pages({
      name: locationParent,
      entry,
      pageSize: 10,
    }),
    (page) => page.entryLinks,
  ).pipe(
    Effect.map((items) => items.map((item) => toAttrs(item, project))),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const EntryGroupsEntryLinkProvider = () =>
  Provider.succeed(EntryGroupsEntryLink, {
    stables: [
      "name",
      "entryLinkId",
      "entryGroup",
      "entryGroupId",
      "project",
      "location",
      "entryLinkType",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = linkTypeOf(
        olds?.entryLinkType ?? output?.entryLinkType,
      );
      const nextType = linkTypeOf(news.entryLinkType ?? previousType);
      const previousRefs = refsKey(
        olds?.entryReferences ?? output?.entryReferences,
      );
      const nextRefs = refsKey(news.entryReferences ?? olds?.entryReferences);
      return replaceOnIdentity({
        previousId: olds?.entryLinkId ?? output?.entryLinkId,
        nextId: news.entryLinkId ?? olds?.entryLinkId ?? output?.entryLinkId,
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
        extra: nextType !== previousType || nextRefs !== previousRefs,
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
      const entryLinkId = yield* toPhysicalId(
        id,
        olds?.entryLinkId,
        output?.entryLinkId,
        "entrylink",
      );
      const name = output?.name ?? resourceName(resolved.parent, entryLinkId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const group = yield* getGroup(attrs.entryGroup);
      if (group === undefined) return Unowned(attrs);
      return hasAlchemyLabelMap(group.labels) ? attrs : Unowned(attrs);
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
        const seen = new Set<string>();
        const found: ReturnType<typeof toAttrs>[] = [];
        yield* Effect.forEach(
          groups,
          (group) =>
            Effect.gen(function* () {
              if (group.name === undefined) return;
              const entries = yield* collectPages(
                dataplex.listProjectsLocationsEntryGroupsEntries.pages({
                  parent: group.name,
                  pageSize: 100,
                }),
                (page) => page.entries,
              ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
              const locationParent = `projects/${env.project}/locations/${parseName(group.name, "entryGroups").location}`;
              const pages = yield* Effect.forEach(
                entries,
                (entry) =>
                  entry.name
                    ? lookupLinks(locationParent, entry.name, env.project)
                    : Effect.succeed([]),
                { concurrency: 4 },
              );
              for (const link of pages.flat()) {
                if (seen.has(link.name)) continue;
                seen.add(link.name);
                found.push(link);
              }
            }),
          { concurrency: 2 },
        );
        return found;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        news.entryGroup,
        news.location ?? output?.location,
        env.region,
      );
      const entryLinkId = yield* toPhysicalId(
        id,
        news.entryLinkId,
        output?.entryLinkId,
        "entrylink",
      );
      const name = resourceName(resolved.parent, entryLinkId);
      const entryLinkType = linkTypeOf(news.entryLinkType);
      const entryReferences = refsOf(news.entryReferences);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsEntryGroupsEntryLinks({
            parent: resolved.parent,
            entryLinkId,
            body: {
              entryLinkType,
              entryReferences,
              aspects: news.aspects,
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

      const aspectsChanged =
        news.aspects !== undefined &&
        fingerprint(news.aspects) !== fingerprint(current.aspects);

      if (aspectsChanged) {
        current = yield* retryQuota(
          dataplex.patchProjectsLocationsEntryGroupsEntryLinks({
            name: current.name ?? name,
            body: {
              name: current.name ?? name,
              aspects: news.aspects,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryQuota(
        dataplex.deleteProjectsLocationsEntryGroupsEntryLinks({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
