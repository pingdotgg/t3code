import {
  DEFAULT_SERVER_SETTINGS,
  ModelSelection,
  ProjectId,
  ProjectScript,
  keepUnknownOverrideKeys,
  ProjectSettingsOverrides,
  type ProviderInstanceConfig,
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
  type ManagedPolicySummary,
  globalIdleCompaction,
  isSecretReference,
  type SecretReference,
  withIdleCompaction,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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
  fallbackTextGenerationModelSelection,
  isModelSelectionProviderEnabled,
} from "@t3tools/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import { secretProviderDefinitions } from "./secrets/secretProviderDefinitions.ts";
import {
  readSecretFieldValues,
  sourceControlHostSecretName,
} from "./sourceControl/sourceControlHostSecrets.ts";

import {
  mapSettingsSecrets,
  mapSettingsSecretValues,
  SECRET_REDACTED,
  type SettingsSecret,
} from "./settingsSecrets.ts";
import type { LegacyProjectSettingsRow } from "./serverSettings.ts";
import { ATOMIC_SETTINGS_KEYS, ServerSettingsService, applyProviderInstanceMutation, decodeLegacyProviderSettingsJsonExit, decodePersistedServerSettingsExit, decodeSettingsFileJsonExit, encodeServerSettingsJson, ensureProviderInstanceMutationAllowed, ensureSecretProviderWritesAllowed, foldLegacyProjectSettings, foldProviderInstanceEnabledFlags, migrateLegacyProviderSettings, migrateLegacySourceControlSettings, normalizeServerSettings, resolveTextGenerationProvider, stripDefaultServerSettings, textDecoder, textEncoder, withEchoedSecretReferences } from "./serverSettings.ts";

export const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const {
    settings: managed,
    providers: managedProviders,
    summary: managedPolicy,
  } = yield* ManagedPolicy.ManagedPolicy;
  // Locks are laid over every settings value that leaves this service, never persisted.
  const toEffective = (settings: ServerSettings) =>
    resolveTextGenerationProvider(
      managedProviders.applyLimits(managed.applyLocks(settings)),
      managedProviders.isDriverAllowed,
    );
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

  // The file before this write, parsed; only read when policy defaults need it.
  const readStoredSettings = Effect.gen(function* () {
    if (!(yield* readConfigExists)) return undefined;
    const parsed = decodeSettingsFileJsonExit(yield* readRawConfig);
    return Exit.isSuccess(parsed) ? parsed.value : undefined;
  });

  const writeSettingsAtomically = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const stripped = stripDefaultServerSettings(settings, managed.defaults) ?? {};
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        managed.keepStored === undefined
          ? stripped
          : managed.keepStored(stripped, settings, yield* readStoredSettings, (key) =>
              ATOMIC_SETTINGS_KEYS.has(key),
            ),
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

  const moveInlineSettingsSecrets = Effect.fn("serverSettings.moveInlineSettingsSecrets")(
    function* (settings: ServerSettings) {
      const pending: SettingsSecret[] = [];
      mapSettingsSecrets(settings, (secret) => {
        if (secret.kind === "field" && !secret.redacted && secret.value.length > 0) {
          pending.push(secret);
        }
        return secret;
      });
      const moved = new Set<string>();
      for (const secret of pending) {
        const stored = yield* secretStore
          .set(secret.secretName, textEncoder.encode(secret.value))
          .pipe(
            Effect.as(true),
            Effect.catch(() =>
              Effect.logWarning("failed to move a settings secret into the secret store").pipe(
                Effect.as(false),
              ),
            ),
          );
        if (stored) moved.add(secret.secretName);
      }
      if (moved.size === 0) return settings;
      return mapSettingsSecrets(settings, (secret) =>
        moved.has(secret.secretName) ? { value: "", redacted: true } : secret,
      );
    },
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    let settings = managed.defaults;
    let legacyProviders: Readonly<Record<string, unknown>> | undefined;
    let legacySourceControl: Parameters<typeof migrateLegacySourceControlSettings>[1] = {};
    let parseFailure = Option.none<unknown>();

    if (yield* readConfigExists) {
      const raw = yield* readRawConfig;
      const parsed = decodeSettingsFileJsonExit(raw);
      const decoded = Exit.isFailure(parsed)
        ? parsed
        : decodePersistedServerSettingsExit(managed.withDefaults(parsed.value));
      const legacySettings = decodeLegacyProviderSettingsJsonExit(raw);
      if (legacySettings._tag === "Success") {
        legacyProviders = legacySettings.value.providers;
        legacySourceControl = {
          bitbucket: legacySettings.value.bitbucket,
          github: legacySettings.value.github,
        };
      }
      if (decoded._tag === "Failure" || legacySettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : legacySettings;
        // The file may hold an opt-out we can no longer read; never resume threads on a guess.
        settings = { ...managed.defaults, continueThreadsAfterServerUpdate: false };
        if (failure._tag === "Failure") {
          parseFailure = Option.some(Cause.squash(failure.cause));
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
    // Settings saved by a server that kept the mode in `compactIdleThreads` move
    // it to `idleCompaction`, so that switch goes to clients as a boolean. The
    // defaults gain the field too, which tells clients this server reads modes.
    settings = withIdleCompaction(settings, globalIdleCompaction(settings));

    // A file that failed to decode must stay on disk for the user to repair.
    const settingsFileTrusted = Option.isNone(parseFailure);
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
      NodeSqliteClient.readOnly,
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
            NodeSqliteClient.readOnly,
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
    // Remove retired keys only after copying secrets and writing the new file; failures retry on next load.
    const legacySecretsCopied = yield* Effect.forEach(
      settingsFileTrusted
        ? migrateLegacySourceControlSettings(folded, legacySourceControl).secretMoves
        : [],
      (move) =>
        secretStore.get(move.from).pipe(
          Effect.flatMap((secret) =>
            Option.isNone(secret) ? Effect.void : secretStore.set(move.to, secret.value),
          ),
          Effect.as(true),
          Effect.catch(() =>
            Effect.logWarning("failed to copy a source control secret to its new name", {
              secretName: move.to,
            }).pipe(Effect.as(false)),
          ),
        ),
    ).pipe(Effect.map((copied) => copied.every(Boolean)));
    const hasLegacySourceControl =
      settingsFileTrusted &&
      legacySecretsCopied &&
      (legacySourceControl.bitbucket !== undefined || legacySourceControl.github !== undefined);
    const sourceControlMigration = hasLegacySourceControl
      ? migrateLegacySourceControlSettings(folded, legacySourceControl)
      : { settings: folded, secretMoves: [] };
    const migrated = settingsFileTrusted
      ? yield* moveInlineSettingsSecrets(sourceControlMigration.settings)
      : folded;
    if (
      migrated !== loaded ||
      (settingsFileTrusted && legacyProviders !== undefined) ||
      hasLegacySourceControl
    ) {
      yield* writeSettingsAtomically(migrated);
      for (const move of sourceControlMigration.secretMoves) {
        yield* secretStore.remove(move.from).pipe(Effect.ignore);
      }
    }
    return { settings: migrated, parseFailure };
  });

  const settingsCache = yield* Cache.makeWith((_key: typeof cacheKey) => loadSettingsFromDisk, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey).pipe(
    Effect.map((loaded) => loaded.settings),
  );
  const reloadSettings = Cache.invalidate(settingsCache, cacheKey).pipe(
    Effect.andThen(Cache.get(settingsCache, cacheKey)),
  );

  const materializeSettingsSecrets = Effect.fn("serverSettings.materializeSettingsSecrets")(
    function* (settings: ServerSettings): Effect.fn.Return<ServerSettings, ServerSettingsError> {
      const storedSecrets = new Map<string, string>();
      const pending = new Map<string, SettingsSecret>();
      mapSettingsSecrets(settings, (secret) => {
        if (secret.sensitive && secret.redacted) pending.set(secret.secretName, secret);
        return secret;
      });
      for (const secret of pending.values()) {
        const value = yield* secretStore.get(secret.secretName).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSettingsError({
                settingsPath,
                operation: "read-secret",
                providerInstanceId: secret.providerInstanceId,
                environmentVariable: secret.environmentVariable,
                cause,
              }),
          ),
        );
        storedSecrets.set(
          secret.secretName,
          Option.isSome(value) ? textDecoder.decode(value.value) : "",
        );
      }
      return mapSettingsSecrets(settings, (secret) => ({
        value:
          secret.sensitive && secret.redacted
            ? (storedSecrets.get(secret.secretName) ?? "")
            : secret.value,
        redacted: secret.sensitive && secret.kind === "environment" && secret.redacted,
      }));
    },
  );

  // Background sweeps read settings every few seconds; reading secret files each time is wasted.
  // Every secret write rewrites the settings file, so a new cached object implies fresh secrets.
  // A read that overlaps a secret write may see files a rollback then restores, so it is not kept.
  let materialized: { readonly source: ServerSettings; readonly value: ServerSettings } | null =
    null;
  let secretWriteGeneration = 0;
  const invalidateMaterialized = Effect.sync(() => {
    secretWriteGeneration++;
    materialized = null;
  });
  const getMaterializedSettings = getSettingsFromCache.pipe(
    Effect.flatMap((source) => {
      if (materialized?.source === source) return Effect.succeed(materialized.value);
      const generation = secretWriteGeneration;
      return materializeSettingsSecrets(source).pipe(
        Effect.map(toEffective),
        Effect.tap((value) =>
          Effect.sync(() => {
            if (generation === secretWriteGeneration) materialized = { source, value };
          }),
        ),
      );
    }),
  );

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeSettingsSecrets(settings).pipe(
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize settings secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(toEffective),
    );

  type SecretChange = {
    readonly secretName: string;
    readonly providerInstanceId?: string;
    readonly environmentVariable?: string;
  } & (
    | { readonly kind: "write"; readonly value: Uint8Array }
    | { readonly kind: "remove"; readonly operation: "remove-secret" | "remove-stale-secret" }
  );

  const persistSettingsSecrets = (current: ServerSettings, next: ServerSettings) =>
    Effect.sync(() => {
      const previous = new Map<string, SettingsSecret>();
      mapSettingsSecrets(current, (secret) => {
        previous.set(secret.secretName, secret);
        return secret;
      });
      const changes: SecretChange[] = [];
      const nextSecretNames = new Set<string>();
      const settings = mapSettingsSecrets(withEchoedSecretReferences(current, next), (secret) => {
        const metadata = {
          secretName: secret.secretName,
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        };
        if (!secret.sensitive) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: secret.value, redacted: false };
        }
        const old = previous.get(secret.secretName);
        const inlineValue =
          old?.sensitive && !old.redacted && old.value.length > 0 ? old.value : undefined;
        const value = secret.redacted ? inlineValue : secret.value;
        if (value === undefined) {
          nextSecretNames.add(secret.secretName);
          return { value: "", redacted: true };
        }
        if (value.length === 0) {
          changes.push({ ...metadata, kind: "remove", operation: "remove-secret" });
          return { value: "", redacted: false };
        }
        nextSecretNames.add(secret.secretName);
        changes.push({ ...metadata, kind: "write", value: textEncoder.encode(value) });
        return { value: "", redacted: true };
      });
      for (const secret of previous.values()) {
        if (!secret.sensitive || nextSecretNames.has(secret.secretName)) continue;
        if (changes.some((change) => change.secretName === secret.secretName)) continue;
        changes.push({
          kind: "remove",
          secretName: secret.secretName,
          operation: "remove-stale-secret",
          ...(secret.providerInstanceId !== undefined
            ? { providerInstanceId: secret.providerInstanceId }
            : {}),
          ...(secret.environmentVariable !== undefined
            ? { environmentVariable: secret.environmentVariable }
            : {}),
        });
      }
      return { settings, changes };
    });

  const rollbackSettingsSecretWrites = (
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
            Effect.logWarning("failed to roll back settings secret", {
              providerInstanceId: write.providerInstanceId,
              environmentVariable: write.environmentVariable,
              cause,
            }),
          ),
        ),
      { discard: true },
    );

  const applySettingsSecretChanges = (changes: ReadonlyArray<SecretChange>) => {
    const applied: Array<{
      readonly secretName: string;
      readonly previousValue: Option.Option<Uint8Array>;
      readonly providerInstanceId?: string;
      readonly environmentVariable?: string;
    }> = [];
    const rollback = Effect.suspend(() => rollbackSettingsSecretWrites(applied));
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
    patch: ServerSettingsPatch,
    update: (current: ServerSettings) => Effect.Effect<ServerSettings, ServerSettingsError>,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const { settings: current, parseFailure } = yield* reloadSettings;
        if (Option.isSome(parseFailure)) {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "read-file",
            cause: parseFailure.value,
          });
        }
        const updated = yield* update(current);
        // Vet before secrets: a variable the policy hides from clients is not one they removed.
        const vetted = managed.vetWrite(current, yield* normalizeServerSettings(updated), patch);
        if (vetted._tag === "Locked") {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "write-managed-setting",
            managedSetting: vetted.path,
            managedBy: managedPolicy?.organization,
          });
        }
        const vettedProviders = managedProviders.vetWrite(current, vetted.settings);
        if (vettedProviders._tag === "Locked") {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "write-managed-setting",
            managedSetting: vettedProviders.path,
            managedBy: managedPolicy?.organization,
          });
        }
        if (vettedProviders._tag === "Disallowed") {
          return yield* new ServerSettingsError({
            settingsPath,
            operation: "use-disallowed-provider",
            providerInstanceId: vettedProviders.instanceId,
            providerLabel: vettedProviders.label,
            managedBy: managedPolicy?.organization,
          });
        }
        const persisted = yield* persistSettingsSecrets(current, vettedProviders.settings);
        const next = yield* normalizeServerSettings(persisted.settings);
        const materializedNext = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            yield* invalidateMaterialized;
            const rollbackSecretChanges = yield* applySettingsSecretChanges(persisted.changes);
            const materializedExit = yield* Effect.exit(materializeSettingsSecrets(next));
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
          }).pipe(Effect.ensuring(invalidateMaterialized)),
        );
        yield* Cache.set(settingsCache, cacheKey, { settings: next, parseFailure: Option.none() });
        const resolved = toEffective(materializedNext);
        materialized = { source: next, value: resolved };
        yield* emitChange(next);
        return resolved;
      }),
    );

  const withSettingsSnapshot: ServerSettingsService["Service"]["withSettingsSnapshot"] = (use) =>
    writeSemaphore.withPermits(1)(getMaterializedSettings.pipe(Effect.flatMap(use)));

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const { settings } = yield* reloadSettings;
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

    // Watch symlink targets' directories for rewrites; re-resolve link changes to follow repointing.
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

    // Saves emit multiple events; fs.watch may fire before content is flushed.
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
      yield* reloadSettings;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    managedPolicy,
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getMaterializedSettings,
    updateSettings: (patch) =>
      updateAndPersistSettings(patch, (current) =>
        ensureSecretProviderWritesAllowed(patch, settingsPath).pipe(
          Effect.as(applyServerSettingsPatch(current, patch)),
        ),
      ),
    updateProviderInstance: (mutation, patch = {}) =>
      updateAndPersistSettings(patch, (current) =>
        Effect.gen(function* () {
          yield* ensureSecretProviderWritesAllowed(patch, settingsPath);
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

