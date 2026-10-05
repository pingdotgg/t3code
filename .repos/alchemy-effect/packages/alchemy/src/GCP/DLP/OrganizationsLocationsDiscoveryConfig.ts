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
  encodeDisplayName,
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
} from "./internal.ts";

export type DiscoveryTarget = dlp.GooglePrivacyDlpV2DiscoveryTarget;
export type OrgConfig = dlp.GooglePrivacyDlpV2OrgConfig;
export type ProcessingLocation = dlp.GooglePrivacyDlpV2ProcessingLocation;
export type OtherCloudDiscoveryStartingLocation =
  dlp.GooglePrivacyDlpV2OtherCloudDiscoveryStartingLocation;
export type DiscoveryConfigStatus =
  | dlp.GooglePrivacyDlpV2DiscoveryConfigStatusEnum
  | (string & {});

export type OrganizationsLocationsDiscoveryConfigProps = {
  /**
   * Config id (the `{discoveryConfig}` segment of
   * `organizations/{organization}/locations/{location}/discoveryConfigs/{discoveryConfig}`).
   * If omitted, a unique id is generated. Letters, digits, hyphens, and
   * underscores; max 100 characters. Immutable — changing it replaces
   * the config.
   */
  configId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the config.
   */
  organization?: string;
  /**
   * Processing location (`us-central1`, `global`, `us`, …). Immutable —
   * changing it replaces the config.
   * @default "global"
   */
  location?: string;
  /**
   * Display name (max 100 characters). Discovery configs have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
  /**
   * Config status. Prefer `PAUSED` unless the org should be scanned.
   * @default "PAUSED"
   */
  status?: DiscoveryConfigStatus;
  /**
   * Organization scan location and the project that runs discovery.
   * Required for organization-parented configs.
   */
  orgConfig: OrgConfig;
  /**
   * Targets that decide what to scan and how often.
   */
  targets: DiscoveryTarget[];
  /**
   * Inspect templates used for profile generation.
   */
  inspectTemplates?: string[];
  /**
   * Processing location configuration.
   */
  processingLocation?: ProcessingLocation;
  /**
   * Starting location when scanning other clouds.
   */
  otherCloudStartingLocation?: OtherCloudDiscoveryStartingLocation;
};

export type OrganizationsLocationsDiscoveryConfig = Resource<
  "GCP.DLP.OrganizationsLocationsDiscoveryConfig",
  OrganizationsLocationsDiscoveryConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Config status. */
    status: string;
    /** Organization scan configuration. */
    orgConfig: OrgConfig | undefined;
    /** Discovery targets. */
    targets: DiscoveryTarget[];
    /** Inspect templates. */
    inspectTemplates: string[];
    /** Processing location, if set. */
    processingLocation: ProcessingLocation | undefined;
    /** Other-cloud starting location, if set. */
    otherCloudStartingLocation: OtherCloudDiscoveryStartingLocation | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 last-run timestamp. */
    lastRunTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Sensitive Data Protection discovery config that
 * scans storage and builds data profiles.
 *
 * Discovery configs have no labels field — Alchemy stamps ownership into
 * the display name so `list` / nuke can find them. Config id, organization,
 * and location are identity. Status, targets, and org config update in
 * place. Keep `status` as `PAUSED` unless the organization should be
 * scanned.
 *
 * ### Creating a Discovery Config
 * **Example:** Paused BigQuery catch-all
 * ```typescript
 * const config = yield* GCP.DLP.OrganizationsLocationsDiscoveryConfig(
 *   "OrgProfiles",
 *   {
 *     status: "PAUSED",
 *     orgConfig: {
 *       projectId: "my-project",
 *       location: { organizationId: "123456789" },
 *     },
 *     targets: [
 *       {
 *         bigQueryTarget: {
 *           filter: { otherTables: {} },
 *           disabled: {},
 *         },
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationsLocationsDiscoveryConfig =
  Resource<OrganizationsLocationsDiscoveryConfig>(
    "GCP.DLP.OrganizationsLocationsDiscoveryConfig",
  );

const DEFAULT_STATUS = "PAUSED" satisfies DiscoveryConfigStatus;

const resourceName = (
  organization: string,
  location: string,
  configId: string,
) =>
  `${organizationLocationParent(organization, location)}/discoveryConfigs/${configId}`;

const toAttrs = (
  config: dlp.GooglePrivacyDlpV2DiscoveryConfig,
  organization: string,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name, "discoveryConfigs");
  const ownership = parseOwnership(config.displayName);
  return {
    name,
    configId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location || DEFAULT_LOCATION,
    project,
    displayName: ownership.text,
    status: config.status ?? DEFAULT_STATUS,
    orgConfig: config.orgConfig,
    targets: config.targets ?? [],
    inspectTemplates: config.inspectTemplates ?? [],
    processingLocation: config.processingLocation,
    otherCloudStartingLocation: config.otherCloudStartingLocation,
    createTime: config.createTime,
    updateTime: config.updateTime,
    lastRunTime: config.lastRunTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getOrganizationsLocationsDiscoveryConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, organization: string, project: string) =>
  dlp.listOrganizationsLocationsDiscoveryConfigs
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.discoveryConfigs ?? []),
      ),
      Stream.filter((config) => hasOwnershipMarker(config.displayName)),
      Stream.map((config) => toAttrs(config, organization, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const statusOf = (value: string | undefined) => value ?? DEFAULT_STATUS;

export const OrganizationsLocationsDiscoveryConfigProvider = () =>
  Provider.succeed(OrganizationsLocationsDiscoveryConfig, {
    stables: [
      "name",
      "configId",
      "organization",
      "organizationId",
      "location",
      "project",
      "createTime",
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
        replaceOn(olds?.configId ?? output?.configId, news.configId) ??
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
      const configId = yield* toPhysicalId(
        id,
        olds?.configId,
        output?.configId,
      );
      const name =
        output?.name ?? resourceName(organization, location, configId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
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
      const configId = yield* toPhysicalId(id, news.configId, output?.configId);
      const parent = organizationLocationParent(organization, location);
      const name = resourceName(organization, location, configId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeDisplayName(ownership, news.displayName);
      const status = statusOf(news.status);
      const orgConfig = news.orgConfig;
      const targets = news.targets;
      const inspectTemplates = news.inspectTemplates;
      const processingLocation = news.processingLocation;
      const otherCloudStartingLocation = news.otherCloudStartingLocation;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsLocationsDiscoveryConfigs({
            parent,
            body: {
              configId,
              discoveryConfig: {
                displayName,
                status,
                orgConfig,
                targets,
                inspectTemplates,
                processingLocation,
                otherCloudStartingLocation,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DlpNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.status, status);
      const orgChanged =
        fingerprint(current.orgConfig) !== fingerprint(orgConfig);
      const targetsChanged =
        fingerprint(current.targets) !== fingerprint(targets);
      const templatesChanged =
        fingerprint(current.inspectTemplates) !== fingerprint(inspectTemplates);
      const processingChanged =
        fingerprint(current.processingLocation) !==
        fingerprint(processingLocation);
      const otherChanged =
        fingerprint(current.otherCloudStartingLocation) !==
        fingerprint(otherCloudStartingLocation);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        statusChanged ? "status" : undefined,
        orgChanged ? "orgConfig" : undefined,
        targetsChanged ? "targets" : undefined,
        templatesChanged ? "inspectTemplates" : undefined,
        processingChanged ? "processingLocation" : undefined,
        otherChanged ? "otherCloudStartingLocation" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* dlp.patchOrganizationsLocationsDiscoveryConfigs({
          name: currentName,
          body: {
            updateMask,
            discoveryConfig: {
              displayName,
              status,
              orgConfig,
              targets,
              inspectTemplates,
              processingLocation,
              otherCloudStartingLocation,
            },
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsLocationsDiscoveryConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
