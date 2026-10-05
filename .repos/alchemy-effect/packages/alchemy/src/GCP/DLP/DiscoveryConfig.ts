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
  DEFAULT_REGIONAL_LOCATION,
  MAX_DISPLAY_NAME_LENGTH,
  collectPages,
  encodeOwnershipLine,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOnIdentity,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

type DiscoveryTarget = dlp.GooglePrivacyDlpV2DiscoveryTarget;
type DiscoveryConfigStatus = dlp.GooglePrivacyDlpV2DiscoveryConfigStatusEnum;
type DataProfileAction = dlp.GooglePrivacyDlpV2DataProfileAction;
type ProcessingLocation = dlp.GooglePrivacyDlpV2ProcessingLocation;

export type DiscoveryConfigProps = {
  /**
   * Config id (the `{discoveryConfig}` segment of
   * `projects/{project}/locations/{location}/discoveryConfigs/{id}`). If
   * omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+` and
   * is at most 100 characters. Immutable — changing it replaces the
   * config.
   */
  configId?: string;
  /**
   * Processing location (`us`, `us-central1`, …). Immutable — changing it
   * replaces the config.
   * @default "us"
   */
  location?: string;
  /**
   * Display name (max 100 characters). Discovery configs have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
  /**
   * Config status. `PAUSED` stores the config without profiling.
   * @default "PAUSED"
   */
  status?: DiscoveryConfigStatus | (string & {});
  /**
   * Targets describing what to scan.
   */
  targets?: DiscoveryTarget[];
  /**
   * Inspect templates used for profile generation.
   */
  inspectTemplates?: string[];
  /**
   * Actions to run after scanning.
   */
  actions?: DataProfileAction[];
  /**
   * Processing location configuration.
   */
  processingLocation?: ProcessingLocation;
};

export type DiscoveryConfig = Resource<
  "GCP.DLP.DiscoveryConfig",
  DiscoveryConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Config id (last path segment). */
    configId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Config status. */
    status: string | undefined;
    /** Discovery targets. */
    targets: DiscoveryTarget[];
    /** Inspect templates. */
    inspectTemplates: string[];
    /** Actions. */
    actions: DataProfileAction[];
    /** Processing location. */
    processingLocation: ProcessingLocation | undefined;
    /** RFC3339 last-run timestamp. */
    lastRunTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A location-scoped Cloud DLP discovery config.
 *
 * Discovery configs have no labels field, so Alchemy stamps ownership
 * into the display name for `list` / nuke. Location and id are identity
 * — changing them replaces the config. Display name, status, targets,
 * and templates update in place.
 *
 * ### Creating a Discovery Config
 * **Example:** Paused Cloud Storage target
 * ```typescript
 * const template = yield* GCP.DLP.LocationsInspectTemplate("Emails", {
 *   location: "us",
 *   inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
 * });
 * const config = yield* GCP.DLP.DiscoveryConfig("Profiles", {
 *   location: "us",
 *   displayName: "paused storage",
 *   status: "PAUSED",
 *   inspectTemplates: [template.name],
 *   targets: [
 *     {
 *       cloudStorageTarget: {
 *         filter: { others: {} },
 *         disabled: {},
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const DiscoveryConfig = Resource<DiscoveryConfig>(
  "GCP.DLP.DiscoveryConfig",
);

export class DiscoveryConfigNotResolved extends Data.TaggedError(
  "GCP.DLP.DiscoveryConfigNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_STATUS: DiscoveryConfigStatus = "PAUSED";

const resourceName = (project: string, location: string, configId: string) =>
  `${locationParent(project, location)}/discoveryConfigs/${configId}`;

const toAttrs = (
  config: dlp.GooglePrivacyDlpV2DiscoveryConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseOwnership(config.displayName);
  return {
    name,
    configId: lastSegment(name),
    location: locationOf(name, DEFAULT_REGIONAL_LOCATION),
    project: projectOf(name) || project,
    displayName: parsed.text,
    status: config.status,
    targets: config.targets ?? [],
    inspectTemplates: config.inspectTemplates ?? [],
    actions: config.actions ?? [],
    processingLocation: config.processingLocation,
    lastRunTime: config.lastRunTime,
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getProjectsLocationsDiscoveryConfigs({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DiscoveryConfigProvider = () =>
  Provider.succeed(DiscoveryConfig, {
    stables: ["name", "configId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.configId ?? output?.configId;
      const idChanged =
        previousId !== undefined &&
        news.configId !== undefined &&
        news.configId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(news.location, DEFAULT_REGIONAL_LOCATION) !==
          normalizeLocation(previousLocation, DEFAULT_REGIONAL_LOCATION);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const configId = yield* toResourceId(
        id,
        olds?.configId,
        output?.configId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_REGIONAL_LOCATION,
      );
      const name =
        output?.name ?? resourceName(env.project, location, configId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsLocationsDiscoveryConfigs.pages({
            parent: locationParent(env.project, DEFAULT_REGIONAL_LOCATION),
            pageSize: 100,
          }),
          (page) => page.discoveryConfigs,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2DiscoveryConfig[]),
          ),
        );
        return items
          .filter((config) => hasOwnershipMarker(config.displayName))
          .map((config) => toAttrs(config, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_REGIONAL_LOCATION,
        DEFAULT_REGIONAL_LOCATION,
      );
      const configId = yield* toResourceId(id, news.configId, output?.configId);
      const name = resourceName(env.project, location, configId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const status = news.status ?? DEFAULT_STATUS;
      const body: dlp.GooglePrivacyDlpV2DiscoveryConfig = {
        displayName,
        status,
        targets: news.targets,
        inspectTemplates: news.inspectTemplates,
        actions: news.actions,
        processingLocation: news.processingLocation,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsDiscoveryConfigs({
            parent: locationParent(env.project, location),
            body: {
              configId,
              discoveryConfig: body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DiscoveryConfigNotResolved({ name });
      }

      const displayChanged = (current.displayName ?? "") !== displayName;
      const statusChanged = (current.status ?? "") !== status;
      const targetsChanged = !jsonEqual(current.targets, news.targets);
      const templatesChanged = !jsonEqual(
        current.inspectTemplates,
        news.inspectTemplates,
      );
      const actionsChanged = !jsonEqual(current.actions, news.actions);
      const processingChanged = !jsonEqual(
        current.processingLocation,
        news.processingLocation,
      );

      if (
        displayChanged ||
        statusChanged ||
        targetsChanged ||
        templatesChanged ||
        actionsChanged ||
        processingChanged
      ) {
        current = yield* dlp.patchProjectsLocationsDiscoveryConfigs({
          name: current.name ?? name,
          body: {
            discoveryConfig: body,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              statusChanged ? "status" : undefined,
              targetsChanged ? "targets" : undefined,
              templatesChanged ? "inspectTemplates" : undefined,
              actionsChanged ? "actions" : undefined,
              processingChanged ? "processingLocation" : undefined,
            ),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsLocationsDiscoveryConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
