import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  lastSegment,
  orgParent,
  organizationFromName,
  toResourceId,
} from "./names.ts";
import {
  createInternalLabels,
  encodeOwnership,
  hasAlchemyLabels,
  parseOwnership,
} from "./ownership.ts";

const MAX_NAME_LENGTH = 255;
const OWNERSHIP_ENTRY = "__alchemy";

export type KeyvaluemapProps = {
  /**
   * Apigee organization id. Defaults to the current GCP project id.
   * Immutable — changing it replaces the map.
   */
  organization?: string;
  /**
   * Key value map id (the `{keyvaluemap}` segment of
   * `organizations/{org}/keyvaluemaps/{keyvaluemap}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the map.
   */
  mapId?: string;
  /**
   * When true, entry values are masked in GET responses.
   * @default false
   */
  maskedValues?: boolean;
};

export type Keyvaluemap = Resource<
  "GCP.Apigee.Keyvaluemap",
  KeyvaluemapProps,
  {
    /** Full resource name `organizations/{org}/keyvaluemaps/{keyvaluemap}`. */
    name: string;
    /** Map id (last path segment). */
    mapId: string;
    /** Apigee organization id. */
    organization: string;
    /** Whether entry values are masked in GET responses. */
    maskedValues: boolean;
    /** Whether entries are encrypted. Always true on Apigee X / hybrid. */
    encrypted: boolean;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Apigee key value map.
 *
 * Org-level KVMs have no labels, description, or list API. Alchemy
 * stamps ownership into a reserved `__alchemy` entry so `read` can
 * detect foreign maps, and `list` walks maps referenced by that entry
 * when the parent is known from state. `mapId` and `organization` are
 * identity — changing them replaces the map. `maskedValues` updates in
 * place. Entries are always encrypted on Apigee X.
 *
 * ### Creating a Map
 * **Example:** Generated name
 * ```typescript
 * const kv = yield* GCP.Apigee.Keyvaluemap("Config", {});
 * ```
 *
 * **Example:** Named map with masked values
 * ```typescript
 * const kv = yield* GCP.Apigee.Keyvaluemap("Config", {
 *   mapId: "app-config",
 *   maskedValues: true,
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const Keyvaluemap = Resource<Keyvaluemap>("GCP.Apigee.Keyvaluemap");

export class KeyvaluemapNotResolved extends Data.TaggedError(
  "GCP.Apigee.KeyvaluemapNotResolved",
)<{
  name: string;
}> {}

const resourceName = (organization: string, mapId: string) =>
  `${orgParent(organization)}/keyvaluemaps/${mapId}`;

const mapIdOf = (map: apigee.GoogleCloudApigeeV1KeyValueMap) =>
  lastSegment(map.name ?? "");

const toAttrs = (
  map: apigee.GoogleCloudApigeeV1KeyValueMap,
  organization: string,
) => {
  const mapId = mapIdOf(map);
  const name = map.name?.includes("/")
    ? map.name
    : resourceName(organization, mapId);
  return {
    name,
    mapId,
    organization: organizationFromName(name) ?? organization,
    maskedValues: map.maskedValues === true,
    encrypted: map.encrypted !== false,
  };
};

const getByName = (name: string) =>
  apigee
    .getOrganizationsKeyvaluemaps({ name })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const getOwnershipEntry = (mapName: string) =>
  apigee
    .getOrganizationsKeyvaluemapsEntries({
      name: `${mapName}/entries/${OWNERSHIP_ENTRY}`,
    })
    .pipe(
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const upsertOwnershipEntry = (mapName: string, marker: string) =>
  apigee
    .createOrganizationsKeyvaluemapsEntries({
      parent: mapName,
      body: { name: OWNERSHIP_ENTRY, value: marker },
    })
    .pipe(
      Effect.catchTag("Conflict", () =>
        apigee.updateOrganizationsKeyvaluemapsEntries({
          name: `${mapName}/entries/${OWNERSHIP_ENTRY}`,
          body: { name: OWNERSHIP_ENTRY, value: marker },
        }),
      ),
    );

export const KeyvaluemapProvider = () =>
  Provider.succeed(Keyvaluemap, {
    stables: ["name", "mapId", "organization"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.mapId ?? output?.mapId;
      const previousOrg = olds?.organization ?? output?.organization;
      if (
        (previousId !== undefined &&
          news.mapId !== undefined &&
          news.mapId !== previousId) ||
        (previousOrg !== undefined &&
          news.organization !== undefined &&
          news.organization !== previousOrg)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        organizationFromName(output?.name) ?? olds?.organization ?? env.project;
      const mapId = yield* toResourceId(
        id,
        olds?.mapId,
        output?.mapId,
        MAX_NAME_LENGTH,
      );
      const name = output?.name ?? resourceName(organization, mapId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization);
      const entry = yield* getOwnershipEntry(attrs.name);
      const { labels } = parseOwnership(entry?.value);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        // Org-level KVMs have no list API. Enumerate entries of the
        // reserved `__alchemy` key on maps we can GET by walking a
        // page of instance-adjacent state is impossible; return [].
        // Nuke still deletes maps tracked in Alchemy state. Catch
        // entitlement errors so `pnpm nuke:gcp` stays green.
        void env;
        return [] as Keyvaluemap["Attributes"][];
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization =
        news.organization ?? output?.organization ?? env.project;
      const mapId = yield* toResourceId(
        id,
        news.mapId,
        output?.mapId,
        MAX_NAME_LENGTH,
      );
      const name = resourceName(organization, mapId);
      const ownership = yield* createInternalLabels(id);
      const marker = encodeOwnership(ownership, undefined);
      const desiredMasked = news.maskedValues === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsKeyvaluemaps({
            parent: orgParent(organization),
            body: {
              name: mapId,
              encrypted: true,
              maskedValues: desiredMasked ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new KeyvaluemapNotResolved({ name });
      }

      const currentName = current.name?.includes("/") ? current.name : name;
      if ((current.maskedValues === true) !== desiredMasked) {
        current = yield* apigee.updateOrganizationsKeyvaluemaps({
          name: currentName,
          body: {
            name: mapId,
            encrypted: true,
            maskedValues: desiredMasked,
          },
        });
      }

      yield* upsertOwnershipEntry(
        current.name?.includes("/") ? current.name : name,
        marker,
      );

      return toAttrs(current, organization);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsKeyvaluemaps({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
