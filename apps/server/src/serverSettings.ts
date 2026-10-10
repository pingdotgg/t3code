/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  ProjectSettingsOverrides,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type UsageLimitSourceConfig,
  type ProviderInstanceMutation,
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ResponseStreamingMode,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@t3tools/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  applyServerSettingsPatch,
  deriveLegacyProjectOverrides,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

export { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Fold the legacy in-config `enabled` flag into the envelope-level
 * `ProviderInstanceConfig.enabled` and strip it from the config blob, so
 * explicit provider instances carry exactly one enabled flag. Old settings
 * files can hold both flags with conflicting values; an explicit false on
 * either side wins so a user's disable is never silently undone. Runs on
 * every load and update — the file converges on the next write.
 */
const foldProviderInstanceEnabledFlags = (settings: ServerSettings): ServerSettings => {
  let changed = false;
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const config = instance.config;
    // Only fold boolean flags: a malformed `enabled` (e.g. `"false"`) must
    // stay in the blob so driver schema validation flags it instead of the
    // fold silently repairing the config.
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      typeof (config as { readonly enabled?: unknown }).enabled !== "boolean"
    ) {
      providerInstances[instanceId] = instance;
      continue;
    }
    const { enabled: configEnabled, ...restConfig } = config as Record<string, unknown> & {
      readonly enabled: boolean;
    };
    const resolved =
      instance.enabled === false || configEnabled === false
        ? false
        : (instance.enabled ?? configEnabled);
    changed = true;
    providerInstances[instanceId] = {
      ...instance,
      enabled: resolved,
      config: restConfig,
    } satisfies ProviderInstanceConfig;
  }
  if (!changed) {
    return settings;
  }
  return {
    ...settings,
    providerInstances: providerInstances as ServerSettings["providerInstances"],
  };
};

const normalizeServerSettings = (
  settings: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.map(foldProviderInstanceEnabledFlags),
    Effect.map((next) => ({ ...next, ...deriveLegacyProjectOverrides(next) })),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath: "<memory>",
          operation: "normalize",
          cause,
        }),
    ),
  );

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

/**
 * On disk a hub key or Bitbucket token is replaced by this marker and the
 * real value lives in the secret store, mirroring provider environment
 * secrets. A client that sends the marker back means "keep what you have".
 */
const SECRET_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

function usageLimitSourceSecretName(sourceId: string): string {
  return `usage-limit-source-${Buffer.from(sourceId, "utf8").toString("base64url")}`;
}

const BITBUCKET_SECRET_NAMES = {
  accessToken: "bitbucket-access-token",
  apiToken: "bitbucket-api-token",
} as const;
const BITBUCKET_SECRET_FIELDS = ["accessToken", "apiToken"] as const;

/** Hosts are case-insensitive; a patch can arrive before decoding lowercased its keys. */
function gitHubTokenSecretName(host: string): string {
  return `github-token-${Buffer.from(host.trim().toLowerCase(), "utf8").toString("base64url")}`;
}

const redactSecret = (value: string) => (value.length > 0 ? SECRET_REDACTED : "");

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
): ProviderInstanceEnvironmentVariable {
  if (!variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.environment
        ? {
            ...instance,
            environment: instance.environment.map(redactProviderEnvironmentVariable),
          }
        : instance,
    ]),
  );
  // The hub key is a bearer secret; clients only need to know one is set.
  const usageLimitSources = Object.fromEntries(
    Object.entries(settings.usageLimitSources).map(([id, source]) => [
      id,
      {
        ...source,
        managementKey: redactSecret(source.managementKey),
      },
    ]),
  );
  const bitbucket = {
    ...settings.bitbucket,
    accessToken: redactSecret(settings.bitbucket.accessToken),
    apiToken: redactSecret(settings.bitbucket.apiToken),
  };
  const github = {
    ...settings.github,
    tokens: Object.fromEntries(
      Object.entries(settings.github.tokens).map(([host, token]) => [host, redactSecret(token)]),
    ),
  };
  return { ...settings, providerInstances, usageLimitSources, bitbucket, github };
}

export function applyProviderInstanceMutation(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
): ServerSettings {
  const providerInstances = { ...settings.providerInstances };
  if (mutation.operation === "upsert" || mutation.operation === "create") {
    providerInstances[mutation.instanceId] = mutation.instance;
  } else {
    delete providerInstances[mutation.instanceId];
  }
  return { ...settings, providerInstances };
}

function ensureProviderInstanceMutationAllowed(
  settings: ServerSettings,
  mutation: ProviderInstanceMutation,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> {
  if (
    mutation.operation === "create" &&
    settings.providerInstances[mutation.instanceId] !== undefined
  ) {
    return Effect.fail(
      new ServerSettingsError({
        settingsPath,
        operation: "create-provider-instance",
        providerInstanceId: mutation.instanceId,
      }),
    );
  }
  return Effect.void;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Apply a patch and one provider-instance mutation against the same latest settings snapshot. */
    readonly updateProviderInstance: (
      mutation: ProviderInstanceMutation,
      patch?: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Run an effect against a settings snapshot while settings writes are paused. */
    readonly withSettingsSnapshot: <A, E, R>(
      use: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ServerSettingsError, R>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Acquire a settings change subscription synchronously in the current
     * fiber. Use this before reading a snapshot when changes between the
     * snapshot and a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("t3/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
      overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
      ...(providerHealthRefreshInterval !== undefined
        ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);
    const writeSemaphore = yield* Semaphore.make(1);
    const getSettings = Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider));

    const updateTestSettings = (
      update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
    ): Effect.Effect<ServerSettings, ServerSettingsError> =>
      writeSemaphore.withPermits(1)(
        Ref.get(currentSettingsRef).pipe(
          Effect.flatMap(update),
          Effect.flatMap(normalizeServerSettings),
          Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
          Effect.map(resolveTextGenerationProvider),
        ),
      );

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings,
      updateSettings: (patch) =>
        updateTestSettings((currentSettings) =>
          Effect.succeed(applyServerSettingsPatch(currentSettings, patch)),
        ),
      updateProviderInstance: (mutation, patch = {}) =>
        updateTestSettings((currentSettings) =>
          Effect.gen(function* () {
            yield* ensureProviderInstanceMutationAllowed(
              currentSettings,
              mutation,
              "test settings",
            );
            const patched = applyServerSettingsPatch(currentSettings, patch);
            return applyProviderInstanceMutation(patched, mutation);
          }),
        ),
      withSettingsSnapshot: (use) =>
        writeSemaphore.withPermits(1)(getSettings.pipe(Effect.flatMap(use))),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

// Migrate saved token delivery without accepting it in settings writes or
// letting one retired value reset the rest of the environment's settings.
const PersistedResponseStreamingMode = Schema.Union([
  ResponseStreamingMode,
  Schema.Literal("token"),
]).pipe(
  Schema.decodeTo(
    ResponseStreamingMode,
    SchemaTransformation.transform({
      decode: (mode) => (mode === "token" ? "paragraph" : mode),
      encode: (mode) => mode,
    }),
  ),
);
const ServerSettingsJson = fromLenientJson(
  Schema.Struct({
    ...ServerSettings.fields,
    responseStreamingMode: PersistedResponseStreamingMode.pipe(
      Schema.withDecodingDefault(Effect.succeed("paragraph" as const)),
    ),
    projectSettingsOverrides: Schema.Record(
      ProjectId,
      Schema.Struct({
        ...ProjectSettingsOverrides.fields,
        responseStreamingMode: Schema.optionalKey(PersistedResponseStreamingMode),
      }),
    ).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }),
);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);
/**
 * The retired `providers.<kind>` map, read without its old schemas. Before
 * `providerInstances` existed each built-in driver had one blob there; it
 * now only feeds `migrateLegacyProviderSettings`.
 */
const LegacyProviderSettingsJson = fromLenientJson(
  Schema.Struct({
    providers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeLegacyProviderSettingsJsonExit = Schema.decodeUnknownExit(LegacyProviderSettingsJson);

// Drivers that start disabled, so a session in the history means the user
// turned them on before the instance kept an explicit flag.
const HISTORY_RESTORED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set(
  ["cursor", "grok", "opencode"].map((driver) => ProviderDriverKind.make(driver)),
);

/**
 * Move each customized legacy `providers.<kind>` blob into the driver's
 * default `providerInstances` slot. An explicit instance already in that slot
 * wins. Blobs that match a fresh install (empty, or only an `enabled` flag
 * equal to the driver default) carry nothing and are dropped.
 *
 * A cursor/grok/opencode slot without an `enabled` flag is enabled when
 * provider history shows the driver was used, which is how those drivers
 * were opted into before they had an explicit flag. Callers run this only
 * while the settings file still has the retired map, so it happens once.
 */
function migrateLegacyProviderSettings(
  settings: ServerSettings,
  legacyProviders: Readonly<Record<string, unknown>>,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  // History rows are raw SQL text; compare them as strings.
  const usedProviders = new Set<string>(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set<string>(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );

  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances) as Array<
    [ProviderInstanceId, ProviderInstanceConfig]
  >) {
    providerInstances[instanceId] =
      instance.enabled === undefined &&
      HISTORY_RESTORED_DRIVERS.has(instance.driver) &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance;
  }

  // History restores a never-configured cursor/grok/opencode slot too.
  const legacyEntries = new Map(Object.entries(legacyProviders));
  for (const driver of HISTORY_RESTORED_DRIVERS) {
    if (!legacyEntries.has(driver)) legacyEntries.set(driver, {});
  }
  for (const [kind, blob] of legacyEntries) {
    if (!isProviderDriverKind(kind) || blob === null || typeof blob !== "object") continue;
    if (Array.isArray(blob)) continue;
    const driver = kind;
    const instanceId = defaultInstanceIdForDriver(driver);
    if (Object.hasOwn(providerInstances, instanceId)) continue;

    const { enabled: rawEnabled, ...config } = blob as Record<string, unknown>;
    const explicitEnabled = typeof rawEnabled === "boolean" ? rawEnabled : undefined;
    const enabled =
      explicitEnabled ??
      (HISTORY_RESTORED_DRIVERS.has(driver) && usedProviders.has(driver) ? true : undefined);
    const driverDefault = resolveProviderInstanceEnabled({ driver, config: {} });
    if (Object.keys(config).length === 0 && (enabled === undefined || enabled === driverDefault)) {
      continue;
    }
    providerInstances[instanceId] = {
      driver,
      ...(enabled === undefined ? {} : { enabled }),
      config,
    } satisfies ProviderInstanceConfig;
  }

  return {
    ...settings,
    providerInstances,
  };
}

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

const TEXT_GENERATION_FALLBACK_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "muse",
  "pi",
  "opencode",
  "antigravity",
].map((driver) => ProviderDriverKind.make(driver));

/** ACP Registry instances reject every application text-generation operation. */
function selectionSupportsTextGeneration(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  return settings.providerInstances[selection.instanceId]?.driver !== ACP_REGISTRY_DRIVER;
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection) &&
    selectionSupportsTextGeneration(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  // The built-in default instances in preference order. A slot without an
  // explicit instance uses its driver's default enabled state.
  const fallback = TEXT_GENERATION_FALLBACK_DRIVERS.find((driver) =>
    resolveProviderInstanceEnabled(
      settings.providerInstances[defaultInstanceIdForDriver(driver)] ?? { driver, config: {} },
    ),
  );
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "textGenerationModelSelection",
  "pullRequestMergeMethod",
  "environmentIcon",
]);

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const decodeProjectScriptsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ProjectScript)),
);
const decodeModelSelectionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.NullOr(ModelSelection)),
);

interface LegacyProjectSettingsRow {
  readonly projectId: string;
  readonly defaultModelSelection: string | null;
  readonly defaultThreadEnvMode: string | null;
  readonly autoPull: number;
  readonly scripts: string;
}

/**
 * One-time fold of the legacy per-project fields into `projectSettingsOverrides`:
 * the three `project*Overrides` maps and the settings columns on the project
 * aggregate. Keys already present in the generic record win. Marked with
 * `projectSettingsFolded` so a later reset in the UI survives restarts.
 */
function foldLegacyProjectSettings(
  settings: ServerSettings,
  rows: ReadonlyArray<LegacyProjectSettingsRow>,
): ServerSettings {
  if (settings.projectSettingsFolded) return settings;
  // Nothing to fold yet (fresh install): leave the marker off so the file
  // stays sparse, and check again on the next load.
  if (
    rows.length === 0 &&
    Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0 &&
    Object.keys(settings.projectAutoPullOverrides).length === 0 &&
    Object.keys(settings.projectScriptOverrides).length === 0
  ) {
    return settings;
  }
  const entries: Record<string, ProjectSettingsOverrides> = {
    ...settings.projectSettingsOverrides,
  };
  const set = <K extends keyof ProjectSettingsOverrides>(
    projectId: string,
    key: K,
    value: ProjectSettingsOverrides[K] | undefined,
  ) => {
    if (value === undefined) return;
    const entry = entries[projectId] ?? {};
    if (Object.hasOwn(entry, key)) return;
    entries[projectId] = { ...entry, [key]: value };
  };
  for (const [projectId, value] of Object.entries(settings.projectAgentBrowserAccessOverrides)) {
    set(projectId, "enableAgentBrowserAccess", value);
  }
  for (const [projectId, value] of Object.entries(settings.projectAutoPullOverrides)) {
    set(projectId, "defaultAutoPull", value);
  }
  // A stored null meant "reset to machine defaults", which is now plain
  // inheritance; the project's own aggregate scripts must not resurface.
  const resetScripts = new Set<string>();
  for (const [projectId, value] of Object.entries(settings.projectScriptOverrides)) {
    if (value === null) resetScripts.add(projectId);
    else set(projectId, "defaultProjectScripts", value);
  }
  for (const row of rows) {
    const model = decodeModelSelectionJson(row.defaultModelSelection ?? "null");
    if (Option.isSome(model) && model.value !== null) {
      set(row.projectId, "defaultModelSelection", model.value);
    }
    if (row.defaultThreadEnvMode === "local" || row.defaultThreadEnvMode === "worktree") {
      set(row.projectId, "defaultThreadEnvMode", row.defaultThreadEnvMode);
    }
    if (row.autoPull === 1) set(row.projectId, "defaultAutoPull", true);
    const scripts = decodeProjectScriptsJson(row.scripts);
    if (Option.isSome(scripts) && scripts.value.length > 0 && !resetScripts.has(row.projectId)) {
      set(row.projectId, "defaultProjectScripts", scripts.value);
    }
  }
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => Object.keys(entry).length > 0),
  );
  return {
    ...settings,
    projectSettingsOverrides,
    projectSettingsFolded: true,
    ...deriveLegacyProjectOverrides({ projectSettingsOverrides }),
  };
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "check-exists",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
    ),
  );

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {},
      );

      return yield* writeFileStringAtomically({
        filePath: settingsPath,
        contents: `${sparseSettingsJson}\n`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  /**
   * Moves Bitbucket tokens hand-edited into settings.json into the secret store as they load,
   * so plaintext does not stay on disk. If the store is unavailable, the token keeps working
   * from the file and the move is retried on the next load.
   */
  const moveInlineBitbucketTokens = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const bitbucket = { ...settings.bitbucket };
      let moved = false;
      for (const field of BITBUCKET_SECRET_FIELDS) {
        const value = bitbucket[field];
        if (value.length === 0 || value === SECRET_REDACTED) continue;
        const stored = yield* secretStore
          .set(BITBUCKET_SECRET_NAMES[field], textEncoder.encode(value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a Bitbucket token into the secret store", {
                field,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!stored) continue;
        bitbucket[field] = SECRET_REDACTED;
        moved = true;
      }
      const tokens = { ...settings.github.tokens };
      for (const [host, value] of Object.entries(tokens)) {
        if (value.length === 0 || value === SECRET_REDACTED) continue;
        const stored = yield* secretStore
          .set(gitHubTokenSecretName(host), textEncoder.encode(value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a GitHub token into the secret store", {
                host,
              }).pipe(Effect.as(false)),
            ),
          );
        if (!stored) continue;
        tokens[host] = SECRET_REDACTED;
        moved = true;
      }
      return moved ? { ...settings, bitbucket, github: { ...settings.github, tokens } } : settings;
    });

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = DEFAULT_SERVER_SETTINGS;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    // A file that failed to decode must stay on disk for the user to repair;
    // the fold below only writes when it started from the file's real contents.
    let settingsFileTrusted = true;

    if (yield* readConfigExists) {
      const raw = yield* readRawConfig;
      const decoded = decodeServerSettingsJsonExit(raw);
      const legacySettings = decodeLegacyProviderSettingsJsonExit(raw);
      if (legacySettings._tag === "Success") {
        legacyProviders = legacySettings.value.providers;
      }
      if (decoded._tag === "Failure" || legacySettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : legacySettings;
        settingsFileTrusted = false;
        if (failure._tag === "Failure") {
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = decoded.value;
      }
    }

    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const legacyProjectRows =
      settings.projectSettingsFolded || !settingsFileTrusted
        ? []
        : yield* sql<LegacyProjectSettingsRow>`
          SELECT
            project_id AS "projectId",
            default_model_selection_json AS "defaultModelSelection",
            default_thread_env_mode AS "defaultThreadEnvMode",
            auto_pull AS "autoPull",
            scripts_json AS "scripts"
          FROM projection_projects
          WHERE deleted_at IS NULL
        `.pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-project-settings",
                  cause,
                }),
            ),
          );

    const loaded = foldProviderInstanceEnabledFlags(
      legacyProviders === undefined
        ? settings
        : migrateLegacyProviderSettings(settings, legacyProviders, providerHistory),
    );
    const folded = settingsFileTrusted
      ? foldLegacyProjectSettings(loaded, legacyProjectRows)
      : loaded;
    // Only rewrite a file that decoded cleanly; an untrusted one stays for the user to repair.
    const migrated = settingsFileTrusted ? yield* moveInlineBitbucketTokens(folded) : folded;
    // A file still carrying the retired `providers` map is rewritten once so
    // the migrated instances persist and the old key disappears.
    if (migrated !== loaded || (settingsFileTrusted && legacyProviders !== undefined)) {
      yield* writeSettingsAtomically(migrated);
    }
    return migrated;
  });

  // A failed read is not kept: the next read retries instead of replaying the failure.
  const settingsCache = yield* Cache.makeWith<typeof cacheKey, ServerSettings, ServerSettingsError>(
    () => loadSettingsFromDisk,
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      const usageLimitSources: Record<string, UsageLimitSourceConfig> = {};
      for (const [sourceId, source] of Object.entries(settings.usageLimitSources)) {
        if (source.managementKey !== SECRET_REDACTED) {
          usageLimitSources[sourceId] = source;
          continue;
        }
        const secret = yield* secretStore
          .get(usageLimitSourceSecretName(sourceId))
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        usageLimitSources[sourceId] = {
          ...source,
          managementKey: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
        };
      }
      const bitbucket = { ...settings.bitbucket };
      for (const field of BITBUCKET_SECRET_FIELDS) {
        if (bitbucket[field] !== SECRET_REDACTED) continue;
        const secret = yield* secretStore
          .get(BITBUCKET_SECRET_NAMES[field])
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        bitbucket[field] = Option.isSome(secret) ? textDecoder.decode(secret.value) : "";
      }
      const tokens: Record<string, string> = {};
      for (const [host, value] of Object.entries(settings.github.tokens)) {
        if (value !== SECRET_REDACTED) {
          tokens[host] = value;
          continue;
        }
        const secret = yield* secretStore
          .get(gitHubTokenSecretName(host))
          .pipe(
            Effect.mapError(
              (cause) => new ServerSettingsError({ settingsPath, operation: "read-secret", cause }),
            ),
          );
        tokens[host] = Option.isSome(secret) ? textDecoder.decode(secret.value) : "";
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
        usageLimitSources: usageLimitSources as ServerSettings["usageLimitSources"],
        bitbucket,
        github: { ...settings.github, tokens },
      };
    });

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeProviderEnvironmentSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize provider environment secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistProviderEnvironmentSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      const changes: SecretChange[] = [];

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (!variable.sensitive) {
            changes.push({
              kind: "remove",
              secretName,
              operation: "remove-secret",
              providerInstanceId: instanceId,
              environmentVariable: variable.name,
            });
            environment.push(redactProviderEnvironmentVariable(variable));
            continue;
          }

          nextSecretKeys.add(secretName);
          // Match the provider environment's last-value-wins behavior for duplicate names.
          const previous = variable.valueRedacted
            ? current.providerInstances[ProviderInstanceId.make(instanceId)]?.environment?.findLast(
                (entry) => entry.name === variable.name,
              )
            : undefined;
          const inlineValue =
            previous?.sensitive && !previous.valueRedacted && previous.value.length > 0
              ? previous.value
              : undefined;
          const value = inlineValue ?? variable.value;
          if (!variable.valueRedacted || inlineValue !== undefined) {
            if (value.length > 0) {
              changes.push({
                kind: "write",
                secretName,
                value: textEncoder.encode(value),
                providerInstanceId: instanceId,
                environmentVariable: variable.name,
              });
              environment.push({ ...variable, value: "", valueRedacted: true });
            } else {
              changes.push({
                kind: "remove",
                secretName,
                operation: "remove-secret",
                providerInstanceId: instanceId,
                environmentVariable: variable.name,
              });
              const { valueRedacted: _omit, ...rest } = variable;
              environment.push(rest);
            }
            continue;
          }

          environment.push(redactProviderEnvironmentVariable(variable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          changes.push({
            kind: "remove",
            secretName,
            operation: "remove-stale-secret",
            providerInstanceId: instanceId,
            environmentVariable: variable.name,
          });
        }
      }

      const usageLimitSources: Record<string, UsageLimitSourceConfig> = {};
      for (const [sourceId, source] of Object.entries(next.usageLimitSources)) {
        const secretName = usageLimitSourceSecretName(sourceId);
        if (source.managementKey === SECRET_REDACTED) {
          usageLimitSources[sourceId] = source;
          continue;
        }
        if (source.managementKey.length === 0) {
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          usageLimitSources[sourceId] = source;
          continue;
        }
        changes.push({
          kind: "write",
          secretName,
          value: textEncoder.encode(source.managementKey),
        });
        usageLimitSources[sourceId] = { ...source, managementKey: SECRET_REDACTED };
      }
      for (const sourceId of Object.keys(current.usageLimitSources)) {
        if (sourceId in next.usageLimitSources) continue;
        changes.push({
          kind: "remove",
          secretName: usageLimitSourceSecretName(sourceId),
          operation: "remove-stale-secret",
        });
      }

      const bitbucket = { ...next.bitbucket };
      for (const field of BITBUCKET_SECRET_FIELDS) {
        let value = bitbucket[field];
        if (value === SECRET_REDACTED) {
          // The marker keeps what is saved. A plaintext value hand-edited into settings.json
          // is not in the secret store yet, so move it there instead of dropping it.
          const inline = current.bitbucket[field];
          if (inline === SECRET_REDACTED || inline.length === 0) continue;
          value = inline;
        }
        const secretName = BITBUCKET_SECRET_NAMES[field];
        if (value.length === 0) {
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          continue;
        }
        changes.push({ kind: "write", secretName, value: textEncoder.encode(value) });
        bitbucket[field] = SECRET_REDACTED;
      }

      const tokens: Record<string, string> = {};
      for (const [rawHost, raw] of Object.entries(next.github.tokens)) {
        const host = rawHost.trim().toLowerCase();
        let value = raw;
        if (value === SECRET_REDACTED) {
          // The marker keeps what is saved; a hand-edited plaintext token moves into the store.
          const inline = current.github.tokens[host];
          if (inline === undefined || inline === SECRET_REDACTED || inline.length === 0) {
            tokens[host] = SECRET_REDACTED;
            continue;
          }
          value = inline;
        }
        const secretName = gitHubTokenSecretName(host);
        if (value.length === 0) {
          changes.push({ kind: "remove", secretName, operation: "remove-secret" });
          continue;
        }
        changes.push({ kind: "write", secretName, value: textEncoder.encode(value) });
        tokens[host] = SECRET_REDACTED;
      }
      const nextHosts = new Set(
        Object.keys(next.github.tokens).map((host) => host.trim().toLowerCase()),
      );
      for (const host of Object.keys(current.github.tokens)) {
        if (nextHosts.has(host.trim().toLowerCase())) continue;
        changes.push({
          kind: "remove",
          secretName: gitHubTokenSecretName(host),
          operation: "remove-stale-secret",
        });
      }

      return {
        settings: {
          ...next,
          providerInstances: providerInstances as ServerSettings["providerInstances"],
          usageLimitSources: usageLimitSources as ServerSettings["usageLimitSources"],
          bitbucket,
          github: { ...next.github, tokens },
        },
        changes,
      };
    });

  const rollbackProviderEnvironmentSecretWrites = (
    writes: ReadonlyArray<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }>,
  ) =>
    Effect.forEach(
      writes.toReversed(),
      (write) =>
        (Option.isSome(write.previousValue)
          ? secretStore.set(write.secretName, write.previousValue.value)
          : secretStore.remove(write.secretName)
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to roll back provider environment secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applyProviderEnvironmentSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackProviderEnvironmentSecretWrites(applied));
    return Effect.forEach(
      changes,
      (change) =>
        Effect.gen(function* () {
          const previousValue = yield* secretStore.get(change.secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "read-secret",
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
          // A store operation may mutate before reporting an error (for example chmod after rename).
          applied.push({ ...change, previousValue });
          yield* (
            change.kind === "write"
              ? secretStore.set(change.secretName, change.value)
              : secretStore.remove(change.secretName)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: change.kind === "write" ? "write-secret" : change.operation,
                  providerInstanceId: change.providerInstanceId,
                  environmentVariable: change.environmentVariable,
                  cause,
                }),
            ),
          );
        }),
      { discard: true },
    ).pipe(
      Effect.tapError(() => rollback),
      Effect.as(rollback),
    );
  };

  const updateAndPersistSettings = (
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* getSettingsFromCache;
        const updated = yield* update(current);
        const persisted = yield* persistProviderEnvironmentSecrets(current, updated);
        const next = yield* normalizeServerSettings(persisted.settings);
        const materialized = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const rollbackSecretChanges = yield* applyProviderEnvironmentSecretChanges(
              persisted.changes,
            );
            const materializedExit = yield* Effect.exit(
              materializeProviderEnvironmentSecrets(next),
            );
            if (Exit.isFailure(materializedExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(materializedExit.cause);
            }
            const writeExit = yield* Effect.exit(writeSettingsAtomically(next));
            if (Exit.isFailure(writeExit)) {
              yield* rollbackSecretChanges;
              return yield* Effect.failCause(writeExit.cause);
            }
            return materializedExit.value;
          }),
        );
        yield* Cache.set(settingsCache, cacheKey, next);
        yield* emitChange(next);
        return resolveTextGenerationProvider(materialized);
      }),
    );

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(
      getSettingsFromCache.pipe(
        Effect.flatMap(materializeProviderEnvironmentSecrets),
        Effect.map(resolveTextGenerationProvider),
        Effect.flatMap(use),
      ),
    );

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const watchFileChanges = (filePath: string) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    return fs
      .watch(directory)
      .pipe(
        Stream.filter(
          (event) =>
            event.path === fileName ||
            event.path === filePath ||
            pathService.resolve(directory, event.path) === resolvedFilePath,
        ),
      );
  };

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // A symlinked settings file is rewritten in its destination's directory,
    // which a watch on the link's directory never sees. The link is resolved
    // again whenever it changes, so repointing it moves the watch along.
    const watchLinkTarget = Effect.gen(function* () {
      const linkTargetPath = yield* resolveSymlinkTarget(settingsPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, pathService),
      );
      if (linkTargetPath === pathService.resolve(settingsPath)) {
        return Option.none<string>();
      }
      yield* fs
        .makeDirectory(pathService.dirname(linkTargetPath), { recursive: true })
        .pipe(Effect.ignore({ log: true }));
      return Option.some(linkTargetPath);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

    const initialLinkTarget = yield* watchLinkTarget;
    const linkTargetEvents = Stream.make(initialLinkTarget).pipe(
      Stream.concat(watchFileChanges(settingsPath).pipe(Stream.mapEffect(() => watchLinkTarget))),
      Stream.changes,
      Stream.switchMap(
        Option.match({
          onNone: () => Stream.empty,
          onSome: (linkTargetPath) =>
            watchFileChanges(linkTargetPath).pipe(Stream.ignore({ log: true })),
        }),
      ),
    );

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = Stream.merge(
      watchFileChanges(settingsPath),
      linkTargetEvents,
    ).pipe(Stream.debounce(Duration.millis(100)));

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeProviderEnvironmentSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      updateAndPersistSettings((current) =>
        Effect.succeed(applyServerSettingsPatch(current, patch)),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings((current) =>
        Effect.gen(function* () {
          yield* ensureProviderInstanceMutationAllowed(current, mutation, settingsPath);
          const patched = applyServerSettingsPatch(current, patch);
          return applyProviderInstanceMutation(patched, mutation);
        }),
      ),
    withSettingsSnapshot,
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
