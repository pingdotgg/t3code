import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  DlpNotResolved,
  encodeDescription,
  fingerprint,
  hasOwnershipMarker,
  lastSegment,
  locationParentsOf,
  organizationLocationParent,
  normalizeLocation,
  organizationIdOf,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOn,
  resolveOrganization,
  sameText,
  toPhysicalId,
  tryResolveOrganization,
  updateMaskOf,
  waitForStoredInfoTypeReady,
} from "./internal.ts";

export type StoredInfoTypeConfig = dlp.GooglePrivacyDlpV2StoredInfoTypeConfig;
export type StoredInfoTypeVersion = dlp.GooglePrivacyDlpV2StoredInfoTypeVersion;

export type OrganizationsLocationsStoredInfoTypeProps = {
  /**
   * Stored infoType id (the `{storedInfoType}` segment of
   * `organizations/{organization}/locations/{location}/storedInfoTypes/{storedInfoType}`).
   * If omitted, a unique id is generated. Letters, digits, hyphens, and
   * underscores; max 100 characters. Immutable — changing it replaces
   * the infoType.
   */
  storedInfoTypeId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the infoType.
   */
  organization?: string;
  /**
   * Processing location (`us-central1`, `global`, `us`, …). Immutable —
   * changing it replaces the infoType.
   * @default "global"
   */
  location?: string;
  /**
   * Dictionary, regex, or large-custom-dictionary configuration. Stored
   * infoTypes have no labels field, so Alchemy ownership is stored in
   * `config.description` as a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  config: StoredInfoTypeConfig;
};

export type OrganizationsLocationsStoredInfoType = Resource<
  "GCP.DLP.OrganizationsLocationsStoredInfoType",
  OrganizationsLocationsStoredInfoTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Stored infoType id (last path segment). */
    storedInfoTypeId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** User display name from the current version. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Current version configuration with ownership stripped from description. */
    config: StoredInfoTypeConfig | undefined;
    /** Current version state (`PENDING`, `READY`, `FAILED`, …). */
    state: string | undefined;
    /** Current version. */
    currentVersion: StoredInfoTypeVersion | undefined;
    /** Pending versions, if any. */
    pendingVersions: StoredInfoTypeVersion[];
  },
  never,
  Providers
>;

/**
 * An organization-scoped Sensitive Data Protection stored infoType
 * (custom dictionary or regex detector).
 *
 * Stored infoTypes have no labels field — Alchemy stamps ownership into
 * `config.description` so `list` / nuke can find them. Id, organization,
 * and location are identity. Config updates create a new version.
 *
 * ### Creating a Stored InfoType
 * **Example:** Word-list dictionary
 * ```typescript
 * const infoType = yield* GCP.DLP.OrganizationsLocationsStoredInfoType(
 *   "EmployeeIds",
 *   {
 *     location: "us-central1",
 *     config: {
 *       displayName: "employee-ids",
 *       dictionary: { wordList: { words: ["E12345", "E67890"] } },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationsLocationsStoredInfoType =
  Resource<OrganizationsLocationsStoredInfoType>(
    "GCP.DLP.OrganizationsLocationsStoredInfoType",
  );

const resourceName = (
  organization: string,
  location: string,
  storedInfoTypeId: string,
) =>
  `${organizationLocationParent(organization, location)}/storedInfoTypes/${storedInfoTypeId}`;

const versionConfig = (
  infoType: dlp.GooglePrivacyDlpV2StoredInfoType,
): StoredInfoTypeConfig | undefined =>
  infoType.currentVersion?.config ?? infoType.pendingVersions?.[0]?.config;

const ownershipText = (infoType: dlp.GooglePrivacyDlpV2StoredInfoType) =>
  versionConfig(infoType)?.description;

const toAttrs = (
  infoType: dlp.GooglePrivacyDlpV2StoredInfoType,
  organization: string,
  project: string,
) => {
  const name = infoType.name ?? "";
  const parsed = parseName(name, "storedInfoTypes");
  const config = versionConfig(infoType);
  const ownership = parseOwnership(config?.description);
  return {
    name,
    storedInfoTypeId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location || DEFAULT_LOCATION,
    project,
    displayName: config?.displayName,
    description: ownership.text,
    config:
      config === undefined
        ? undefined
        : { ...config, description: ownership.text },
    state:
      infoType.currentVersion?.state ?? infoType.pendingVersions?.[0]?.state,
    currentVersion: infoType.currentVersion,
    pendingVersions: infoType.pendingVersions ?? [],
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getOrganizationsLocationsStoredInfoTypes({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, organization: string, project: string) =>
  dlp.listOrganizationsLocationsStoredInfoTypes
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.storedInfoTypes ?? [])),
      Stream.filter((infoType) => hasOwnershipMarker(ownershipText(infoType))),
      Stream.map((infoType) => toAttrs(infoType, organization, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const desiredConfig = (
  ownership: Record<string, string>,
  config: StoredInfoTypeConfig,
): StoredInfoTypeConfig => ({
  ...config,
  description: encodeDescription(ownership, config.description),
});

const configForCompare = (config: StoredInfoTypeConfig | undefined) => {
  if (config === undefined) return undefined;
  const { description: _, ...rest } = config;
  return { ...rest, description: parseOwnership(config.description).text };
};

export const OrganizationsLocationsStoredInfoTypeProvider = () =>
  Provider.succeed(OrganizationsLocationsStoredInfoType, {
    stables: [
      "name",
      "storedInfoTypeId",
      "organization",
      "organizationId",
      "location",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return (
        replaceOn(
          olds?.storedInfoTypeId ?? output?.storedInfoTypeId,
          news.storedInfoTypeId,
        ) ??
        replaceOn(
          olds?.organization ?? output?.organization,
          news.organization,
        ) ??
        replaceOn(previousLocation, nextLocation)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const storedInfoTypeId = yield* toPhysicalId(
        id,
        olds?.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const name =
        output?.name ?? resourceName(organization, location, storedInfoTypeId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const pages = yield* Effect.forEach(
          locationParentsOf(organization, env.region),
          (parent) => listAt(parent, organization, env.project),
          { concurrency: 3 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const storedInfoTypeId = yield* toPhysicalId(
        id,
        news.storedInfoTypeId,
        output?.storedInfoTypeId,
      );
      const parent = organizationLocationParent(organization, location);
      const name = resourceName(organization, location, storedInfoTypeId);
      const ownership = yield* createInternalLabels(id);
      const config = desiredConfig(ownership, news.config);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsLocationsStoredInfoTypes({
            parent,
            body: {
              storedInfoTypeId,
              config,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DlpNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observed = versionConfig(current);
      const displayChanged = !sameText(
        observed?.displayName,
        config.displayName,
      );
      const descriptionChanged = !sameText(
        observed?.description,
        config.description,
      );
      const bodyChanged =
        fingerprint(configForCompare(observed)) !==
        fingerprint(configForCompare(config));
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        descriptionChanged ? "description" : undefined,
        bodyChanged ? "dictionary,regex,largeCustomDictionary" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* dlp.patchOrganizationsLocationsStoredInfoTypes({
          name: currentName,
          body: {
            updateMask,
            config,
          },
        });
      }

      const readyName = current.name ?? name;
      current = yield* waitForStoredInfoTypeReady(
        readyName,
        getByName(readyName),
      );
      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsLocationsStoredInfoTypes({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
