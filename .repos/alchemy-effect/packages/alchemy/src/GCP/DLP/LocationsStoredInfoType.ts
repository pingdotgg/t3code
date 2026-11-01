import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  replaceOnIdentity,
  toResourceId,
  updateMaskOf,
  waitForStoredInfoTypeReady,
} from "./internal.ts";

type StoredInfoTypeRegex = dlp.GooglePrivacyDlpV2Regex;
type StoredInfoTypeDictionary = dlp.GooglePrivacyDlpV2Dictionary;
type StoredInfoTypeLargeCustomDictionary =
  dlp.GooglePrivacyDlpV2LargeCustomDictionaryConfig;

export type LocationsStoredInfoTypeProps = {
  /**
   * StoredInfoType id (the `{storedInfoType}` segment of
   * `projects/{project}/locations/{location}/storedInfoTypes/{storedInfoType}`).
   * If omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * stored info type.
   */
  storedInfoTypeId?: string;
  /**
   * Processing location (`us-central1`, `global`, …). Immutable —
   * changing it replaces the stored info type.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Stored info types
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Regular-expression detector. Use this or `dictionary` /
   * `largeCustomDictionary`.
   */
  regex?: StoredInfoTypeRegex;
  /**
   * Small word-list dictionary detector.
   */
  dictionary?: StoredInfoTypeDictionary;
  /**
   * Large custom dictionary built from Cloud Storage or BigQuery.
   */
  largeCustomDictionary?: StoredInfoTypeLargeCustomDictionary;
};

export type LocationsStoredInfoType = Resource<
  "GCP.DLP.LocationsStoredInfoType",
  LocationsStoredInfoTypeProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/storedInfoTypes/{id}`. */
    name: string;
    /** StoredInfoType id (last path segment). */
    storedInfoTypeId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Regular-expression detector, if set. */
    regex: StoredInfoTypeRegex | undefined;
    /** Word-list dictionary detector, if set. */
    dictionary: StoredInfoTypeDictionary | undefined;
    /** Large custom dictionary, if set. */
    largeCustomDictionary: StoredInfoTypeLargeCustomDictionary | undefined;
    /** Current version state (`READY`, `PENDING`, …). */
    state: string | undefined;
    /** RFC3339 creation timestamp of the current version. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A regional Cloud DLP stored info type
 * (`projects.locations.storedInfoTypes`).
 *
 * Stored info types have no labels field, so Alchemy stamps ownership
 * into the config description for `list` / nuke. Location and id are
 * identity — changing them replaces the resource. Display name,
 * description, and detector config update in place (a new version).
 *
 * ### Creating a Stored Info Type
 * **Example:** Regional regex detector
 * ```typescript
 * const infoType = yield* GCP.DLP.LocationsStoredInfoType("Badge", {
 *   displayName: "badge numbers",
 *   description: "employee badges",
 *   regex: { pattern: "EMP[0-9]{6}" },
 * });
 * ```
 *
 * ### Updating a Stored Info Type
 * **Example:** Change the pattern
 * ```typescript
 * const infoType = yield* GCP.DLP.LocationsStoredInfoType("Badge", {
 *   displayName: "badge numbers",
 *   description: "employee badges v2",
 *   regex: { pattern: "EMP[0-9]{8}" },
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const LocationsStoredInfoType = Resource<LocationsStoredInfoType>(
  "GCP.DLP.LocationsStoredInfoType",
);

export class LocationsStoredInfoTypeNotResolved extends Data.TaggedError(
  "GCP.DLP.LocationsStoredInfoTypeNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  storedInfoTypeId: string,
) => `${locationParent(project, location)}/storedInfoTypes/${storedInfoTypeId}`;

const configOf = (
  props: LocationsStoredInfoTypeProps,
  description: string,
): dlp.GooglePrivacyDlpV2StoredInfoTypeConfig => ({
  displayName: props.displayName,
  description,
  regex: props.regex,
  dictionary: props.dictionary,
  largeCustomDictionary: props.largeCustomDictionary,
});

const toAttrs = (
  stored: dlp.GooglePrivacyDlpV2StoredInfoType,
  project: string,
  region: string,
) => {
  const name = stored.name ?? "";
  const config = stored.currentVersion?.config;
  const parsed = parseOwnership(config?.description);
  return {
    name,
    storedInfoTypeId: lastSegment(name),
    location: locationOf(name, region),
    project,
    displayName: config?.displayName,
    description: parsed.text,
    regex: config?.regex,
    dictionary: config?.dictionary,
    largeCustomDictionary: config?.largeCustomDictionary,
    state: stored.currentVersion?.state,
    createTime: stored.currentVersion?.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsLocationsStoredInfoTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const LocationsStoredInfoTypeProvider = () =>
  Provider.succeed(LocationsStoredInfoType, {
    stables: ["name", "storedInfoTypeId", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.storedInfoTypeId ?? output?.storedInfoTypeId;
      const idChanged =
        previousId !== undefined &&
        news.storedInfoTypeId !== undefined &&
        news.storedInfoTypeId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        normalizeLocation(news.location ?? previousLocation, env.region) !==
          normalizeLocation(previousLocation, env.region);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const storedInfoTypeId = yield* toResourceId(
        id,
        olds?.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, storedInfoTypeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(
        id,
        existing.currentVersion?.config?.description,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsLocationsStoredInfoTypes.pages({
            parent: locationParent(env.project, env.region),
            pageSize: 100,
          }),
          (page) => page.storedInfoTypes,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2StoredInfoType[]),
          ),
        );
        return items
          .filter((stored) =>
            hasOwnershipMarker(stored.currentVersion?.config?.description),
          )
          .map((stored) => toAttrs(stored, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const storedInfoTypeId = yield* toResourceId(
        id,
        news.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name = resourceName(env.project, location, storedInfoTypeId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const config = configOf(news, description);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsStoredInfoTypes({
            parent: locationParent(env.project, location),
            body: {
              storedInfoTypeId,
              config,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsStoredInfoTypeNotResolved({ name });
      }

      const observed = current.currentVersion?.config;
      const displayChanged = !jsonEqual(
        observed?.displayName,
        news.displayName,
      );
      const descriptionChanged = (observed?.description ?? "") !== description;
      const regexChanged = !jsonEqual(observed?.regex, news.regex);
      const dictionaryChanged = !jsonEqual(
        observed?.dictionary,
        news.dictionary,
      );
      const largeChanged = !jsonEqual(
        observed?.largeCustomDictionary,
        news.largeCustomDictionary,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        regexChanged ||
        dictionaryChanged ||
        largeChanged
      ) {
        current = yield* dlp
          .patchProjectsLocationsStoredInfoTypes({
            name: current.name ?? name,
            body: {
              config,
              updateMask: updateMaskOf(
                displayChanged ? "displayName" : undefined,
                descriptionChanged ? "description" : undefined,
                regexChanged ? "regex" : undefined,
                dictionaryChanged ? "dictionary" : undefined,
                largeChanged ? "largeCustomDictionary" : undefined,
              ),
            },
          })
          .pipe();
      }

      const readyName = current.name ?? name;
      current = yield* waitForStoredInfoTypeReady(
        readyName,
        getByName(readyName),
      );
      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsLocationsStoredInfoTypes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
