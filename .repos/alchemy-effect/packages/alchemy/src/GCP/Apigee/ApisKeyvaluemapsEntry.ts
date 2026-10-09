import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;
const OWNERSHIP_KEY = "__alchemy";

export type ApisKeyvaluemapsEntryProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * Parent API proxy id. Immutable.
   */
  api: string;
  /**
   * Parent key value map id. Immutable.
   */
  map: string;
  /**
   * Entry key. If omitted, a unique name is generated. Immutable.
   */
  entryId?: string;
  /**
   * Value stored for this key.
   */
  value: string;
};

export type ApisKeyvaluemapsEntry = Resource<
  "GCP.Apigee.ApisKeyvaluemapsEntry",
  ApisKeyvaluemapsEntryProps,
  {
    /** Full resource name `.../keyvaluemaps/{map}/entries/{entry}`. */
    name: string;
    /** Entry key. */
    entryId: string;
    /** Parent map id. */
    mapId: string;
    /** Parent API proxy id. */
    apiId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Stored value. */
    value: string;
  },
  never,
  Providers
>;

/**
 * A key/value entry in an API-proxy-scoped Apigee key value map.
 *
 * Entries have no labels. Alchemy treats entries inside a map that
 * carries the `__alchemy` sentinel as owned so `list` / nuke can find
 * them. Changing `entryId`, `map`, `api`, or `organizationId` replaces
 * the entry. The reserved key `__alchemy` is used for map ownership and
 * is not a user entry.
 *
 * ### Creating an Entry
 * **Example:** Put a config value
 * ```typescript
 * const entry = yield* GCP.Apigee.ApisKeyvaluemapsEntry("Timeout", {
 *   api: proxy.apiId,
 *   map: map.mapId,
 *   entryId: "timeout-ms",
 *   value: "5000",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const ApisKeyvaluemapsEntry = Resource<ApisKeyvaluemapsEntry>(
  "GCP.Apigee.ApisKeyvaluemapsEntry",
);

export class ApisKeyvaluemapsEntryNotResolved extends Data.TaggedError(
  "GCP.Apigee.ApisKeyvaluemapsEntryNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  organizationId: string,
  apiId: string,
  mapId: string,
  entryId: string,
) =>
  `${orgParent(organizationId)}/apis/${lastSegment(apiId)}/keyvaluemaps/${lastSegment(mapId)}/entries/${entryId}`;

const mapName = (organizationId: string, apiId: string, mapId: string) =>
  `${orgParent(organizationId)}/apis/${lastSegment(apiId)}/keyvaluemaps/${lastSegment(mapId)}`;

const toAttrs = (
  entry: apigee.GoogleCloudApigeeV1KeyValueEntry,
  project: string,
  organizationId: string,
  apiId: string,
  mapId: string,
  name: string,
) => ({
  name,
  entryId: lastSegment(entry.name ?? name),
  mapId: lastSegment(mapId),
  apiId: lastSegment(apiId),
  organizationId,
  project,
  value: entry.value ?? "",
});

const getByName = (name: string) =>
  apigee
    .getOrganizationsApisKeyvaluemapsEntries({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const mapIsOwned = (parent: string) =>
  apigee
    .getOrganizationsApisKeyvaluemapsEntries({
      name: `${parent}/entries/${OWNERSHIP_KEY}`,
    })
    .pipe(
      Effect.map(() => true),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(false),
      ),
    );

export const ApisKeyvaluemapsEntryProvider = () =>
  Provider.succeed(ApisKeyvaluemapsEntry, {
    stables: ["name", "entryId", "mapId", "apiId", "organizationId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.entryId ?? output?.entryId;
      const previousMap = olds?.map ? lastSegment(olds.map) : output?.mapId;
      const previousApi = olds?.api ? lastSegment(olds.api) : output?.apiId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.entryId !== undefined &&
          news.entryId !== previousId) ||
        (previousMap !== undefined && lastSegment(news.map) !== previousMap) ||
        (previousApi !== undefined && lastSegment(news.api) !== previousApi) ||
        (previousOrg !== undefined &&
          news.organizationId !== undefined &&
          news.organizationId !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        olds?.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const apiId = lastSegment(olds?.api ?? output?.apiId ?? "");
      const mapId = lastSegment(olds?.map ?? output?.mapId ?? "");
      if (apiId.length === 0 || mapId.length === 0) return undefined;
      const entryId = yield* toPhysicalId(
        id,
        olds?.entryId,
        output?.entryId,
        MAX_NAME_LENGTH,
      );
      const name =
        output?.name ?? resourceName(organizationId, apiId, mapId, entryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        organizationId,
        apiId,
        mapId,
        name,
      );
      const owned = yield* mapIsOwned(mapName(organizationId, apiId, mapId));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organizationId = yield* resolveOrgId(env.project);
        const page = yield* apigee
          .listOrganizationsApis({
            parent: orgParent(organizationId),
            includeMetaData: true,
          })
          .pipe(
            Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
              Effect.succeed({ proxies: [] }),
            ),
          );
        const owned = [];
        for (const proxy of page.proxies ?? []) {
          if (
            !Object.keys(proxy.labels ?? {}).some((key) =>
              key.startsWith("alchemy-"),
            )
          ) {
            continue;
          }
          const apiId = lastSegment(proxy.name ?? "");
          if (apiId.length === 0) continue;
          const parent = mapName(organizationId, apiId, apiId);
          if (!(yield* mapIsOwned(parent))) continue;
          const entries = yield* apigee.listOrganizationsApisKeyvaluemapsEntries
            .pages({
              parent,
              pageSize: 100,
            })
            .pipe(
              Stream.flatMap((item) =>
                Stream.fromIterable(item.keyValueEntries ?? []),
              ),
              Stream.filter(
                (entry) => lastSegment(entry.name ?? "") !== OWNERSHIP_KEY,
              ),
              Stream.map((entry) => {
                const name =
                  entry.name ??
                  resourceName(
                    organizationId,
                    apiId,
                    apiId,
                    lastSegment(entry.name ?? ""),
                  );
                return toAttrs(
                  entry,
                  env.project,
                  organizationId,
                  apiId,
                  apiId,
                  name.includes("/")
                    ? name
                    : resourceName(organizationId, apiId, apiId, name),
                );
              }),
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
                Effect.succeed([]),
              ),
            );
          owned.push(...entries);
        }
        return owned;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organizationId =
        news.organizationId ??
        output?.organizationId ??
        (yield* resolveOrgId(env.project));
      const apiId = lastSegment(news.api);
      const mapId = lastSegment(news.map);
      const entryId = yield* toPhysicalId(
        id,
        news.entryId,
        output?.entryId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, apiId, mapId, entryId);
      const parent = mapName(organizationId, apiId, mapId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsApisKeyvaluemapsEntries({
            parent,
            body: { name: entryId, value: news.value },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApisKeyvaluemapsEntryNotResolved({ name });
      }

      if ((current.value ?? "") !== news.value) {
        current = yield* apigee.updateOrganizationsApisKeyvaluemapsEntries({
          name,
          body: { name: entryId, value: news.value },
        });
      }

      return toAttrs(current, env.project, organizationId, apiId, mapId, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.entryId === OWNERSHIP_KEY) return;
      yield* apigee
        .deleteOrganizationsApisKeyvaluemapsEntries({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
