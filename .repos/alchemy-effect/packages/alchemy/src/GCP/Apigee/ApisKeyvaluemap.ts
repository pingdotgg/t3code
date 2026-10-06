import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  resolveOrgId,
  toPhysicalId,
} from "./operations.ts";

const MAX_NAME_LENGTH = 255;
const OWNERSHIP_KEY = "__alchemy";

export type ApisKeyvaluemapProps = {
  /**
   * Apigee organization id. Defaults to the GCP project id. Immutable.
   */
  organizationId?: string;
  /**
   * Parent API proxy id or `organizations/{org}/apis/{api}`. Immutable.
   */
  api: string;
  /**
   * Key value map id. If omitted, a unique name is generated. Immutable.
   */
  mapId?: string;
  /**
   * Mask entry values in API responses.
   * @default false
   */
  maskedValues?: boolean;
};

export type ApisKeyvaluemap = Resource<
  "GCP.Apigee.ApisKeyvaluemap",
  ApisKeyvaluemapProps,
  {
    /** Full resource name `organizations/{org}/apis/{api}/keyvaluemaps/{map}`. */
    name: string;
    /** Map id. */
    mapId: string;
    /** Parent API proxy id. */
    apiId: string;
    /** Organization id. */
    organizationId: string;
    /** Project id. */
    project: string;
    /** Whether entry values are masked. */
    maskedValues: boolean;
    /** Whether entries are encrypted (always true on Apigee X). */
    encrypted: boolean;
  },
  never,
  Providers
>;

/**
 * An API-proxy-scoped Apigee key value map.
 *
 * KVMs have no labels and no List API. Alchemy writes an ownership
 * sentinel entry (`__alchemy`) so `read` can distinguish owned maps.
 * `list` walks alchemy-labeled API proxies and looks up a map whose id
 * matches the proxy id plus any map named on the sentinel of that
 * lookup; maps whose ids cannot be discovered are still deleted with
 * the parent proxy. Changing `mapId`, `api`, or `organizationId`
 * replaces the map.
 *
 * ### Creating a Map
 * **Example:** Generated name on a proxy
 * ```typescript
 * const map = yield* GCP.Apigee.ApisKeyvaluemap("Config", {
 *   api: proxy.apiId,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const ApisKeyvaluemap = Resource<ApisKeyvaluemap>(
  "GCP.Apigee.ApisKeyvaluemap",
);

export class ApisKeyvaluemapNotResolved extends Data.TaggedError(
  "GCP.Apigee.ApisKeyvaluemapNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organizationId: string, apiId: string, mapId: string) =>
  `${orgParent(organizationId)}/apis/${lastSegment(apiId)}/keyvaluemaps/${mapId}`;

const toAttrs = (
  map: apigee.GoogleCloudApigeeV1KeyValueMap,
  project: string,
  organizationId: string,
  apiId: string,
  name: string,
) => ({
  name,
  mapId: map.name ?? lastSegment(name),
  apiId: lastSegment(apiId),
  organizationId,
  project,
  maskedValues: map.maskedValues === true,
  encrypted: map.encrypted !== false,
});

const getByName = (name: string) =>
  apigee
    .getOrganizationsApisKeyvaluemaps({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const getOwnershipEntry = (mapName: string) =>
  apigee
    .getOrganizationsApisKeyvaluemapsEntries({
      name: `${mapName}/entries/${OWNERSHIP_KEY}`,
    })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const ownershipValue = (labels: Record<string, string>) =>
  JSON.stringify(labels);

const parseOwnershipValue = (
  value: string | undefined,
): Record<string, string> => {
  if (value === undefined || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

const ensureOwnershipEntry = (mapName: string, value: string) =>
  Effect.gen(function* () {
    const existing = yield* getOwnershipEntry(mapName);
    if (existing === undefined) {
      yield* apigee
        .createOrganizationsApisKeyvaluemapsEntries({
          parent: mapName,
          body: { name: OWNERSHIP_KEY, value },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
      return;
    }
    if ((existing.value ?? "") !== value) {
      yield* apigee.updateOrganizationsApisKeyvaluemapsEntries({
        name: `${mapName}/entries/${OWNERSHIP_KEY}`,
        body: { name: OWNERSHIP_KEY, value },
      });
    }
  });

export const ApisKeyvaluemapProvider = () =>
  Provider.succeed(ApisKeyvaluemap, {
    stables: ["name", "mapId", "apiId", "organizationId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.mapId ?? output?.mapId;
      const previousApi = olds?.api ? lastSegment(olds.api) : output?.apiId;
      const previousOrg = olds?.organizationId ?? output?.organizationId;
      if (
        (previousId !== undefined &&
          news.mapId !== undefined &&
          news.mapId !== previousId) ||
        (previousApi !== undefined && lastSegment(news.api) !== previousApi) ||
        (previousOrg !== undefined &&
          news.organizationId !== undefined &&
          news.organizationId !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: false };
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
      if (apiId.length === 0) return undefined;
      const mapId = yield* toPhysicalId(
        id,
        olds?.mapId,
        output?.mapId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organizationId, apiId, mapId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, organizationId, apiId, name);
      const entry = yield* getOwnershipEntry(name);
      const labels = parseOwnershipValue(entry?.value);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
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
          // No List API for proxy-scoped KVMs; probe the common generated
          // pairing (map id === proxy id) and any map named on the proxy.
          const candidate = resourceName(organizationId, apiId, apiId);
          const map = yield* getByName(candidate);
          if (map === undefined) continue;
          const entry = yield* getOwnershipEntry(candidate);
          if (entry === undefined) continue;
          owned.push(
            toAttrs(map, env.project, organizationId, apiId, candidate),
          );
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
      const mapId = yield* toPhysicalId(
        id,
        news.mapId,
        output?.mapId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organizationId, apiId, mapId);
      const labels = yield* createInternalLabels(id);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsApisKeyvaluemaps({
            parent: `${orgParent(organizationId)}/apis/${apiId}`,
            body: {
              name: mapId,
              encrypted: true,
              maskedValues: news.maskedValues === true ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ApisKeyvaluemapNotResolved({ name });
      }

      if ((current.maskedValues === true) !== (news.maskedValues === true)) {
        current = yield* apigee.updateOrganizationsApisKeyvaluemaps({
          name,
          body: {
            name: mapId,
            encrypted: true,
            maskedValues: news.maskedValues === true ? true : undefined,
          },
        });
      }

      yield* ensureOwnershipEntry(name, ownershipValue(labels));

      return toAttrs(current, env.project, organizationId, apiId, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsApisKeyvaluemaps({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
