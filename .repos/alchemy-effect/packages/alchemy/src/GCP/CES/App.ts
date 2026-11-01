import * as ces from "@distilled.cloud/gcp/ces_v1";
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
  encodeOwnership,
  hasAlchemyLabelMap,
  hasOwnershipMarker,
  listApps,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  ownedByAlchemyLabels,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userMetadata,
  waitForVisible,
  waitUntilGone,
} from "./internal.ts";
import { waitForDeleteOperation, waitForOperation } from "./operations.ts";

export type AppProps = {
  /**
   * App id (the `{app}` segment of
   * `projects/{project}/locations/{location}/apps/{app}`). If omitted, a
   * unique name is generated. Immutable — changing it replaces the app.
   */
  appId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * app. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Human-readable name. Required by the API; Alchemy falls back to the
   * generated app id.
   */
  displayName?: string;
  /**
   * Human-readable description. Apps have no labels field, so Alchemy
   * stamps ownership into `description` and `metadata`.
   */
  description?: string;
  /**
   * Free-form metadata. Alchemy ownership keys (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in automatically.
   */
  metadata?: Record<string, string>;
  /**
   * Instructions shared by every agent in the app.
   */
  globalInstruction?: string;
  /**
   * Tool execution mode (`PARALLEL`, `SEQUENTIAL`).
   */
  toolExecutionMode?: string;
  /**
   * IANA time zone (e.g. `America/Los_Angeles`). Maps onto
   * `timeZoneSettings.timeZone`.
   */
  timeZone?: string;
  /**
   * Full time-zone settings. Wins over `timeZone` when both are set.
   */
  timeZoneSettings?: ces.TimeZoneSettings;
  /**
   * Default LLM model id.
   */
  model?: string;
  /**
   * Default LLM temperature.
   */
  temperature?: number;
  /**
   * Full model settings. Wins over `model` / `temperature` when set.
   */
  modelSettings?: ces.ModelSettings;
  /**
   * Root agent resource name
   * `projects/{project}/locations/{location}/apps/{app}/agents/{agent}`.
   */
  rootAgent?: string;
  /**
   * Guardrail resource names attached to the app.
   */
  guardrails?: string[];
  /**
   * When true, mutations to app resources are rejected.
   * @default false
   */
  locked?: boolean;
  /**
   * When true, the app is pinned in the app list.
   * @default false
   */
  pinned?: boolean;
  /**
   * Default channel profile for the app.
   */
  defaultChannelProfile?: ces.ChannelProfile;
  /**
   * Language settings.
   */
  languageSettings?: ces.LanguageSettings;
};

export type App = Resource<
  "GCP.CES.App",
  AppProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/apps/{app}`. */
    name: string;
    /** App id (last path segment). */
    appId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** User metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** Shared agent instructions. */
    globalInstruction: string | undefined;
    /** Tool execution mode. */
    toolExecutionMode: string | undefined;
    /** IANA time zone. */
    timeZone: string | undefined;
    /** Default model settings. */
    modelSettings: ces.ModelSettings | undefined;
    /** Root agent resource name. */
    rootAgent: string | undefined;
    /** Guardrail resource names. */
    guardrails: string[] | undefined;
    /** Whether the app is locked. */
    locked: boolean;
    /** Whether the app is pinned. */
    pinned: boolean;
    /** Default channel profile. */
    defaultChannelProfile: ces.ChannelProfile | undefined;
    /** Language settings. */
    languageSettings: ces.LanguageSettings | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-assigned etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Customer Engagement Suite (CES) app — the top-level container for
 * agents, tools, toolsets, guardrails, examples, versions, and
 * deployments.
 *
 * App create and delete are long-running operations. Location and app id
 * are immutable. CES apps have no labels API, so Alchemy stamps
 * ownership into `metadata` and `description` so `list` / nuke can find
 * them.
 *
 * ### Creating an App
 * **Example:** Generated name
 * ```typescript
 * const app = yield* GCP.CES.App("Support", {
 *   displayName: "support",
 * });
 * ```
 *
 * **Example:** Named app with a time zone and model
 * ```typescript
 * const app = yield* GCP.CES.App("Support", {
 *   appId: "support-desk",
 *   location: "us-central1",
 *   displayName: "Support desk",
 *   timeZone: "America/Los_Angeles",
 *   model: "gemini-2.0-flash",
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const App = Resource<App>("GCP.CES.App");

export class AppNotResolved extends Data.TaggedError("GCP.CES.AppNotResolved")<{
  name: string;
}> {}

const resourceName = (project: string, location: string, appId: string) =>
  `${locationParent(project, location)}/apps/${appId}`;

const timeZoneSettingsOf = (news: AppProps): ces.TimeZoneSettings | undefined =>
  news.timeZoneSettings ??
  (news.timeZone !== undefined ? { timeZone: news.timeZone } : undefined);

const modelSettingsOf = (news: AppProps): ces.ModelSettings | undefined =>
  news.modelSettings ??
  (news.model !== undefined || news.temperature !== undefined
    ? { model: news.model, temperature: news.temperature }
    : undefined);

const toAttrs = (app: ces.App, project: string, region: string) => {
  const name = app.name ?? "";
  const parsed = parseResourceName(name, "apps", region);
  return {
    name,
    appId: parsed.id,
    location: parsed.location,
    project: parsed.project || project,
    displayName: app.displayName,
    description: parseOwnership(app.description).text,
    metadata: userMetadata(app.metadata),
    globalInstruction: app.globalInstruction,
    toolExecutionMode: app.toolExecutionMode,
    timeZone: app.timeZoneSettings?.timeZone,
    modelSettings: app.modelSettings,
    rootAgent: app.rootAgent,
    guardrails: app.guardrails,
    locked: app.locked === true,
    pinned: app.pinned === true,
    defaultChannelProfile: app.defaultChannelProfile,
    languageSettings: app.languageSettings,
    createTime: app.createTime,
    updateTime: app.updateTime,
    etag: app.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsApps({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isOwnedApp = (app: ces.App) =>
  hasAlchemyLabelMap(app.metadata) ||
  hasOwnershipMarker(app.description) ||
  hasOwnershipMarker(app.displayName);

export const AppProvider = () =>
  Provider.succeed(App, {
    stables: ["name", "appId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = normalizeLocation(news.location, env.region);
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation, env.region) !== nextLocation
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.appId ?? output?.appId,
        nextId: news.appId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const appId =
        olds?.appId ??
        output?.appId ??
        (output?.name
          ? parseResourceName(output.name, "apps", env.region).id
          : "");
      const name =
        output?.name ??
        (appId.length > 0 ? resourceName(env.project, location, appId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const labeled = yield* ownedByAlchemyLabels(id, existing.metadata);
      const described = yield* ownedByAlchemy(id, existing.description);
      return labeled || described ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apps = yield* listApps(locationParent(env.project, env.region));
        return apps
          .filter(isOwnedApp)
          .map((app) => toAttrs(app, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const appId = yield* toPhysicalId(id, news.appId, output?.appId);
      const name = output?.name ?? resourceName(env.project, location, appId);
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const metadata = { ...news.metadata, ...ownership };
      const displayName = news.displayName ?? appId;
      const timeZoneSettings = timeZoneSettingsOf(news);
      const modelSettings = modelSettingsOf(news);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsApps({
            parent,
            appId,
            body: {
              displayName,
              description,
              metadata,
              globalInstruction: news.globalInstruction,
              toolExecutionMode: news.toolExecutionMode,
              timeZoneSettings,
              modelSettings,
              rootAgent: news.rootAgent,
              guardrails: news.guardrails,
              locked: news.locked,
              pinned: news.pinned,
              defaultChannelProfile: news.defaultChannelProfile,
              languageSettings: news.languageSettings,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitForVisible(getByName(name));
      }

      if (current === undefined) {
        return yield* new AppNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const metadataChanged = !sameJson(current.metadata, metadata);
      const instructionChanged = !sameText(
        current.globalInstruction,
        news.globalInstruction,
      );
      const modeChanged = !sameText(
        current.toolExecutionMode,
        news.toolExecutionMode,
      );
      const zoneChanged = !sameJson(current.timeZoneSettings, timeZoneSettings);
      const modelChanged = !sameJson(current.modelSettings, modelSettings);
      const rootChanged = !sameText(current.rootAgent, news.rootAgent);
      const guardrailsChanged = !sameJson(current.guardrails, news.guardrails);
      const lockedChanged =
        (current.locked === true) !== (news.locked === true);
      const pinnedChanged =
        (current.pinned === true) !== (news.pinned === true);
      const channelChanged = !sameJson(
        current.defaultChannelProfile,
        news.defaultChannelProfile,
      );
      const languageChanged = !sameJson(
        current.languageSettings,
        news.languageSettings,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        metadataChanged ||
        instructionChanged ||
        modeChanged ||
        zoneChanged ||
        modelChanged ||
        rootChanged ||
        guardrailsChanged ||
        lockedChanged ||
        pinnedChanged ||
        channelChanged ||
        languageChanged
      ) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsApps({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              metadataChanged ? "metadata" : undefined,
              instructionChanged ? "global_instruction" : undefined,
              modeChanged ? "tool_execution_mode" : undefined,
              zoneChanged ? "time_zone_settings" : undefined,
              modelChanged ? "model_settings" : undefined,
              rootChanged ? "root_agent" : undefined,
              guardrailsChanged ? "guardrails" : undefined,
              lockedChanged ? "locked" : undefined,
              pinnedChanged ? "pinned" : undefined,
              channelChanged ? "default_channel_profile" : undefined,
              languageChanged ? "language_settings" : undefined,
            ),
            body: {
              displayName,
              description,
              metadata,
              globalInstruction: news.globalInstruction,
              toolExecutionMode: news.toolExecutionMode,
              timeZoneSettings,
              modelSettings,
              rootAgent: news.rootAgent,
              guardrails: news.guardrails,
              locked: news.locked,
              pinned: news.pinned,
              defaultChannelProfile: news.defaultChannelProfile,
              languageSettings: news.languageSettings,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const deleted = yield* retryTransient(
        ces.deleteProjectsLocationsApps({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (deleted !== undefined) {
        yield* waitForDeleteOperation(deleted);
      }
      yield* waitUntilGone(getByName(output.name));
    }),
  });
