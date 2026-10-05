import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
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
  DEFAULT_LOCATION,
  encodeOwnershipLine,
  fingerprint,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listLocations,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  sameText,
  toResourceId,
  updateMaskOf,
  retryQuota,
  waitUntilReadable,
} from "./internal.ts";

export type RedactionStrategy =
  | "REDACTION_STRATEGY_UNSPECIFIED"
  | "REDACT_WITH_SERVICE";

export type RedactionScope =
  | "REDACTION_SCOPE_UNSPECIFIED"
  | "REDACT_DISK_STORAGE";

export type RetentionStrategy =
  | "RETENTION_STRATEGY_UNSPECIFIED"
  | "REMOVE_AFTER_CONVERSATION";

export type PurgeDataType =
  | "PURGE_DATA_TYPE_UNSPECIFIED"
  | "DIALOGFLOW_HISTORY";

export type AudioFormat = "AUDIO_FORMAT_UNSPECIFIED" | "MULAW" | "MP3" | "OGG";

export type AudioExportSettings = {
  /** GCS bucket that stores exported audio. */
  gcsBucket?: string;
  /** Filename pattern for exported audio. */
  audioExportPattern?: string;
  /** Whether to redact exported audio. */
  enableAudioRedaction?: boolean;
  /** Exported audio format. */
  audioFormat?: AudioFormat | (string & {});
  /** Whether to also export synthesized TTS audio. */
  storeTtsAudio?: boolean;
};

export type InsightsExportSettings = {
  /** Whether to export conversations to Contact Center Insights. */
  enableInsightsExport?: boolean;
};

export type SecuritySettingProps = {
  /**
   * Security settings id (the `{securitySettings}` segment of
   * `projects/{project}/locations/{location}/securitySettings/{id}`).
   * Server-assigned on create. Immutable — changing it replaces the
   * settings.
   */
  securitySettingsId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the settings. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name. Security settings have no labels field, so
   * Alchemy stamps ownership into this field for `list` / nuke.
   */
  displayName?: string;
  /** How sensitive data is redacted. */
  redactionStrategy?: RedactionStrategy | (string & {});
  /** Which data is subject to redaction. */
  redactionScope?: RedactionScope | (string & {});
  /**
   * DLP inspect template resource name
   * `projects/{project}/locations/{location}/inspectTemplates/{template}`.
   */
  inspectTemplate?: string;
  /**
   * DLP de-identify template resource name
   * `projects/{project}/locations/{location}/deidentifyTemplates/{template}`.
   */
  deidentifyTemplate?: string;
  /** Data types purged when retention triggers. */
  purgeDataTypes?: Array<PurgeDataType | (string & {})>;
  /** Audio export configuration. */
  audioExportSettings?: AudioExportSettings;
  /** Contact Center Insights export configuration. */
  insightsExportSettings?: InsightsExportSettings;
  /**
   * Retention window in days. Mutually exclusive with
   * `retentionStrategy`.
   */
  retentionWindowDays?: number;
  /**
   * Retention strategy. Mutually exclusive with `retentionWindowDays`.
   */
  retentionStrategy?: RetentionStrategy | (string & {});
};

export type SecuritySetting = Resource<
  "GCP.Dialogflow.SecuritySetting",
  SecuritySettingProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/securitySettings/{id}`. */
    name: string;
    /** Security settings id (last path segment). */
    securitySettingsId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Redaction strategy. */
    redactionStrategy: string | undefined;
    /** Redaction scope. */
    redactionScope: string | undefined;
    /** DLP inspect template. */
    inspectTemplate: string | undefined;
    /** DLP de-identify template. */
    deidentifyTemplate: string | undefined;
    /** Data types purged on retention. */
    purgeDataTypes: string[];
    /** Audio export configuration. */
    audioExportSettings: AudioExportSettings | undefined;
    /** Insights export configuration. */
    insightsExportSettings: InsightsExportSettings | undefined;
    /** Retention window in days. */
    retentionWindowDays: number | undefined;
    /** Retention strategy. */
    retentionStrategy: string | undefined;
  },
  never,
  Providers
>;

/**
 * Dialogflow CX security settings for data redaction and retention.
 *
 * Security settings live at a location (not under an agent) and have no
 * labels field — Alchemy stamps ownership into `displayName` so `list` /
 * nuke can find them. Location and id are immutable. Display name,
 * redaction, DLP templates, purge types, export settings, and retention
 * update in place.
 *
 * ### Creating Security Settings
 * **Example:** Remove data after each conversation
 * ```typescript
 * const settings = yield* GCP.Dialogflow.SecuritySetting("Retention", {
 *   location: "us-central1",
 *   displayName: "session-only",
 *   retentionStrategy: "REMOVE_AFTER_CONVERSATION",
 * });
 * ```
 *
 * ### Updating Security Settings
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Switch to a 30-day window
 * ```typescript
 * const settings = yield* GCP.Dialogflow.SecuritySetting("Retention", {
 *   location: "us-central1",
 *   displayName: "thirty-days",
 *   retentionWindowDays: 30,
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const SecuritySetting = Resource<SecuritySetting>(
  "GCP.Dialogflow.SecuritySetting",
);

export class SecuritySettingNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.SecuritySettingNotResolved",
)<{
  name: string;
}> {}

const resourceName = (
  project: string,
  location: string,
  securitySettingsId: string,
) =>
  `${locationParent(project, location)}/securitySettings/${securitySettingsId}`;

const audioOf = (
  settings:
    | dialogflow.GoogleCloudDialogflowCxV3SecuritySettingsAudioExportSettings
    | undefined,
): AudioExportSettings | undefined => {
  if (settings === undefined) return undefined;
  return {
    gcsBucket: settings.gcsBucket,
    audioExportPattern: settings.audioExportPattern,
    enableAudioRedaction: settings.enableAudioRedaction,
    audioFormat: settings.audioFormat,
    storeTtsAudio: settings.storeTtsAudio,
  };
};

const insightsOf = (
  settings:
    | dialogflow.GoogleCloudDialogflowCxV3SecuritySettingsInsightsExportSettings
    | undefined,
): InsightsExportSettings | undefined => {
  if (settings === undefined) return undefined;
  return { enableInsightsExport: settings.enableInsightsExport };
};

const toAttrs = (
  settings: dialogflow.GoogleCloudDialogflowCxV3SecuritySettings,
  project: string,
) => {
  const name = settings.name ?? "";
  return {
    name,
    securitySettingsId: lastSegment(name),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: parseOwnership(settings.displayName).text,
    redactionStrategy: settings.redactionStrategy,
    redactionScope: settings.redactionScope,
    inspectTemplate: settings.inspectTemplate,
    deidentifyTemplate: settings.deidentifyTemplate,
    purgeDataTypes: [...(settings.purgeDataTypes ?? [])],
    audioExportSettings: audioOf(settings.audioExportSettings),
    insightsExportSettings: insightsOf(settings.insightsExportSettings),
    retentionWindowDays: settings.retentionWindowDays,
    retentionStrategy: settings.retentionStrategy,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsSecuritySettings({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsSecuritySettings
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.securitySettings ?? []),
      ),
      Stream.filter((settings) => hasOwnershipMarker(settings.displayName)),
      Stream.map((settings) => toAttrs(settings, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsSecuritySettings
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.securitySettings ?? []),
      ),
      Stream.filter((settings) => settings.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const SecuritySettingProvider = () =>
  Provider.succeed(SecuritySetting, {
    stables: ["name", "securitySettingsId", "location", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.securitySettingsId ?? output?.securitySettingsId;
      if (
        previousId !== undefined &&
        news.securitySettingsId !== undefined &&
        news.securitySettingsId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const securitySettingsId = yield* toResourceId(
        id,
        olds?.securitySettingsId,
        output?.securitySettingsId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, securitySettingsId);
      let existing = yield* getByName(name);
      if (existing === undefined && output?.name === undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDisplayName(
          locationParent(env.project, location),
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listAt(locationParent(env.project, location), env.project),
          { concurrency: 2 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const parent = locationParent(env.project, location);
      const securitySettingsId = yield* toResourceId(
        id,
        news.securitySettingsId,
        output?.securitySettingsId,
      );
      const name =
        output?.name ?? resourceName(env.project, location, securitySettingsId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const body: dialogflow.GoogleCloudDialogflowCxV3SecuritySettings = {
        displayName,
        redactionStrategy: news.redactionStrategy,
        redactionScope: news.redactionScope,
        inspectTemplate: news.inspectTemplate,
        deidentifyTemplate: news.deidentifyTemplate,
        purgeDataTypes: news.purgeDataTypes,
        audioExportSettings: news.audioExportSettings,
        insightsExportSettings: news.insightsExportSettings,
        retentionWindowDays: news.retentionWindowDays,
        retentionStrategy:
          news.retentionWindowDays === undefined
            ? news.retentionStrategy
            : undefined,
      };

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsSecuritySettings({
            parent,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(parent, displayName),
            ),
          );
        current =
          created?.name !== undefined
            ? yield* waitUntilReadable(created.name, getByName)
            : created;
      }

      if (current === undefined) {
        return yield* new SecuritySettingNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const strategyChanged = !sameText(
        current.redactionStrategy,
        news.redactionStrategy,
      );
      const scopeChanged = !sameText(
        current.redactionScope,
        news.redactionScope,
      );
      const inspectChanged = !sameText(
        current.inspectTemplate,
        news.inspectTemplate,
      );
      const deidentifyChanged = !sameText(
        current.deidentifyTemplate,
        news.deidentifyTemplate,
      );
      const purgeChanged =
        fingerprint(current.purgeDataTypes) !==
        fingerprint(news.purgeDataTypes);
      const audioChanged =
        fingerprint(audioOf(current.audioExportSettings)) !==
        fingerprint(news.audioExportSettings);
      const insightsChanged =
        fingerprint(insightsOf(current.insightsExportSettings)) !==
        fingerprint(news.insightsExportSettings);
      const windowChanged =
        (current.retentionWindowDays ?? 0) !== (news.retentionWindowDays ?? 0);
      const retentionStrategyChanged = !sameText(
        current.retentionStrategy,
        body.retentionStrategy,
      );

      if (
        displayChanged ||
        strategyChanged ||
        scopeChanged ||
        inspectChanged ||
        deidentifyChanged ||
        purgeChanged ||
        audioChanged ||
        insightsChanged ||
        windowChanged ||
        retentionStrategyChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsSecuritySettings({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            strategyChanged ? "redaction_strategy" : undefined,
            scopeChanged ? "redaction_scope" : undefined,
            inspectChanged ? "inspect_template" : undefined,
            deidentifyChanged ? "deidentify_template" : undefined,
            purgeChanged ? "purge_data_types" : undefined,
            audioChanged ? "audio_export_settings" : undefined,
            insightsChanged ? "insights_export_settings" : undefined,
            windowChanged ? "retention_window_days" : undefined,
            retentionStrategyChanged ? "retention_strategy" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsSecuritySettings({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
