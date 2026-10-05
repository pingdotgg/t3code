import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  parentOf,
  parseResourceName,
  siteSearchEngineParent,
  matchesUriPattern,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type CollectionsDataStoresSiteSearchEngineTargetSiteProps = {
  /**
   * Parent data store resource name (must use `PUBLIC_WEBSITE` content
   * config). Immutable — changing it replaces the target site.
   */
  dataStore: string;
  /**
   * User-provided URI pattern used to generate the crawl pattern. Required.
   */
  providedUriPattern: string;
  /**
   * Whether the site is included or excluded.
   * @default "INCLUDE"
   */
  type?: "TYPE_UNSPECIFIED" | "INCLUDE" | "EXCLUDE" | (string & {});
  /**
   * Exact-match URI pattern generation. Immutable after create.
   * @default false
   */
  exactMatch?: boolean;
};

export type CollectionsDataStoresSiteSearchEngineTargetSite = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSite",
  CollectionsDataStoresSiteSearchEngineTargetSiteProps,
  {
    /** Full resource name. */
    name: string;
    /** System-generated target site id. */
    targetSiteId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided URI pattern. */
    providedUriPattern: string;
    /** Generated URI pattern. */
    generatedUriPattern: string | undefined;
    /** Include or exclude. */
    type: string | undefined;
    /** Exact-match flag. */
    exactMatch: boolean;
    /** Indexing status. */
    indexingStatus: string | undefined;
    /** Root domain of the provided URI pattern. */
    rootDomainUri: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine target site on a collection data store site-search
 * engine.
 *
 * Its id is assigned by the API, so only a recorded resource can be read
 * back. Parent data store and `exactMatch` are immutable. Type updates in
 * place. The target site id is assigned by the API.
 *
 * ### Creating a Target Site
 * **Example:** Include a site
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Web", {
 *   contentConfig: "PUBLIC_WEBSITE",
 * });
 * const site = yield* GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSite(
 *   "Docs",
 *   {
 *     dataStore: store.name,
 *     providedUriPattern: "https://example.com/docs/",
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresSiteSearchEngineTargetSite =
  Resource<CollectionsDataStoresSiteSearchEngineTargetSite>(
    "GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSite",
  );

export class CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved",
)<{
  name: string;
}> {}

export class CollectionsDataStoresSiteSearchEngineTargetSiteStillExists extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSiteStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  site: discoveryengine.GoogleCloudDiscoveryengineV1TargetSite,
  project: string,
  pattern?: string,
) => {
  const name = site.name ?? "";
  const parsed = parseResourceName(name, "targetSites");
  return {
    name,
    targetSiteId: parsed.id,
    dataStore: parentOf(name, "siteSearchEngine"),
    project: parsed.project || project,
    location: parsed.location,
    providedUriPattern:
      site.providedUriPattern ?? pattern ?? site.generatedUriPattern ?? "",
    generatedUriPattern: site.generatedUriPattern,
    type: site.type,
    exactMatch: site.exactMatch === true,
    indexingStatus: site.indexingStatus,
    rootDomainUri: site.rootDomainUri,
    updateTime: site.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites({
          name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites
    .pages({ parent, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.targetSites ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

/** Target sites are identified by their URI pattern within a data store. */
const findByPattern = (dataStore: string, pattern: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const sites = yield* listAtParent(siteSearchEngineParent(dataStore));
    return sites.find((site) => matchesUriPattern(site, pattern));
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((site) =>
      site
        ? Effect.succeed(site)
        : Effect.fail(
            new CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved({
              name,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((site) =>
      site === undefined
        ? Effect.void
        : Effect.fail(
            new CollectionsDataStoresSiteSearchEngineTargetSiteStillExists({
              name,
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.DiscoveryEngine.CollectionsDataStoresSiteSearchEngineTargetSiteStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const CollectionsDataStoresSiteSearchEngineTargetSiteProvider = () =>
  Provider.succeed(CollectionsDataStoresSiteSearchEngineTargetSite, {
    stables: [
      "name",
      "targetSiteId",
      "dataStore",
      "project",
      "location",
      "exactMatch",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousExact = olds?.exactMatch ?? output?.exactMatch ?? false;
      const nextExact = news.exactMatch ?? previousExact;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        previousExact !== nextExact
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataStore = olds?.dataStore ?? output?.dataStore;
      const pattern = olds?.providedUriPattern ?? output?.providedUriPattern;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : dataStore !== undefined && pattern !== undefined
            ? yield* findByPattern(dataStore, pattern)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, pattern);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const providedUriPattern = news.providedUriPattern;
      const type = news.type ?? "INCLUDE";
      const exactMatch = news.exactMatch === true;
      const parent = siteSearchEngineParent(news.dataStore);

      let current = yield* findByPattern(
        news.dataStore,
        providedUriPattern,
        output?.name,
      );

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
            {
              parent,
              body: {
                providedUriPattern,
                type,
                exactMatch: exactMatch ? true : undefined,
              },
            },
          )
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* findByPattern(news.dataStore, providedUriPattern);
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresSiteSearchEngineTargetSiteNotResolved(
          { name: output?.name ?? `${parent}/targetSites/-` },
        );
      }

      const resource = current.name ?? "";
      const typeChanged = (current.type ?? "INCLUDE") !== type;
      const patternChanged = !matchesUriPattern(current, providedUriPattern);

      if (typeChanged || patternChanged) {
        const patched =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
            {
              name: resource,
              body: {
                name: resource,
                providedUriPattern,
                type,
                exactMatch: current.exactMatch,
              },
            },
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilExists(resource);
      }

      return toAttrs(current, env.project, providedUriPattern);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresSiteSearchEngineTargetSites(
          { name: output.name },
        )
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
