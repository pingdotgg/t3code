import { PluginId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as JsonSchema from "effect/JsonSchema";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";

// The Settings page shows the summary, so it stays readable when a patch breaks many fields.
const MAX_VALIDATION_SUMMARY_LENGTH = 1000;
const MAX_SCHEMA_REASON_LENGTH = 500;

const persistenceOperations = {
  read: "read the settings",
  write: "save the settings",
  readSecret: "read a secret setting",
  writeSecret: "save a secret setting",
} as const;

export class PluginSettingsPersistenceError extends Schema.TaggedError<PluginSettingsPersistenceError>()(
  "PluginSettingsPersistenceError",
  {
    pluginId: PluginId,
    operation: Schema.Literals(["read", "write", "readSecret", "writeSecret"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${persistenceOperations[this.operation]} of plugin ${this.pluginId}.`;
  }
}

export class PluginSettingsSchemaError extends Schema.TaggedError<PluginSettingsSchemaError>()(
  "PluginSettingsSchemaError",
  {
    pluginId: PluginId,
    /** The importer's reason, which comes from the plugin's own manifest. */
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Plugin ${this.pluginId} has a settings schema T3 Code cannot validate: ${this.reason}`;
  }
}

export class PluginSettingsValidationError extends Schema.TaggedError<PluginSettingsValidationError>()(
  "PluginSettingsValidationError",
  {
    pluginId: PluginId,
    summary: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid settings for plugin ${this.pluginId}: ${this.summary}`;
  }
}

export class PluginSettingsStore extends Context.Service<
  PluginSettingsStore,
  {
    /** Stored settings with secret values, over the schema's top-level defaults, for the plugin. */
    readonly get: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
    ) => Effect.Effect<Schema.JsonObject, PluginSettingsPersistenceError>;
    /**
     * Stored settings for clients, without defaults. A secret that has a value reads as
     * `SECRET_REDACTED`.
     */
    readonly getForClient: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
    ) => Effect.Effect<Schema.JsonObject, PluginSettingsPersistenceError>;
    /**
     * Merges `patch` over the stored settings at the top level, where `null` removes a key and
     * `SECRET_REDACTED` keeps a secret, validates the result, saves it and returns the client view.
     * Stored keys a schema with `additionalProperties: false` no longer lists are dropped first.
     */
    readonly update: (
      pluginId: PluginId,
      settingsSchema: Schema.JsonObject | undefined,
      patch: Schema.JsonObject,
    ) => Effect.Effect<
      Schema.JsonObject,
      PluginSettingsPersistenceError | PluginSettingsSchemaError | PluginSettingsValidationError
    >;
    /** The plugin view after each successful `update` of that plugin. */
    readonly changes: (pluginId: PluginId) => Stream.Stream<Schema.JsonObject>;
    readonly clear: (pluginId: PluginId) => Effect.Effect<void, PluginSettingsPersistenceError>;
  }
>()("t3/plugins/PluginSettingsStore") {}

interface StoredSettings {
  readonly values: Schema.JsonObject;
  readonly secrets: Readonly<Record<string, string>>;
}

/** The text of settings.json and of the plugin's secret entry, undefined when there is none. */
interface SavedFiles {
  readonly settings: string | undefined;
  readonly secrets: string | undefined;
}

interface SettingsChange {
  readonly pluginId: PluginId;
  readonly settings: Schema.JsonObject;
}

const SettingsJson = fromJsonStringPretty(Schema.JsonObject);
const decodeSettingsJson = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettingsJson = Schema.encodeEffect(SettingsJson);
const SecretsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeSecretsJson = Schema.decodeUnknownEffect(SecretsJson);
const encodeSecretsJson = Schema.encodeEffect(SecretsJson);
const isJson = Schema.is(Schema.Json);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Top-level string fields with `format: "t3-secret"` live in ServerSecretStore, never settings.json.
const secretFields = (settingsSchema: Schema.JsonObject | undefined): ReadonlySet<string> => {
  const properties = settingsSchema?.properties;
  if (!Predicate.isObject(properties)) return new Set();
  return new Set(
    Object.entries(properties).flatMap(([field, property]) =>
      Predicate.isObject(property) && property.type === "string" && property.format === "t3-secret"
        ? [field]
        : [],
    ),
  );
};

// Top-level `default`s, which the plugin reads for fields nobody saved. Secrets have none.
const defaultsOf = (settingsSchema: Schema.JsonObject | undefined): Schema.JsonObject => {
  const properties = settingsSchema?.properties;
  if (!Predicate.isObject(properties)) return {};
  const secrets = secretFields(settingsSchema);
  return Object.fromEntries(
    Object.entries(properties).flatMap(([field, property]) =>
      Predicate.isObject(property) && !secrets.has(field) && isJson(property.default)
        ? [[field, property.default]]
        : [],
    ),
  );
};

// Keys saved under an older schema that a closed schema no longer lists. Validating them would
// refuse every save, and the form cannot remove a key it does not show.
const keysOutside = (settingsSchema: Schema.JsonObject | undefined, values: Schema.JsonObject) => {
  const properties = settingsSchema?.properties;
  if (settingsSchema?.additionalProperties !== false || !Predicate.isObject(properties)) return [];
  return Object.keys(values).filter((key) => !Object.hasOwn(properties, key));
};

// One entry holds all of a plugin's secrets, so removal finds them in a store that can't list
// names. T3's own secret names have no `.`, so this name can't be one of them.
const secretName = (pluginId: PluginId) => `plugin.${pluginId}`;

const formatPathSegment = (segment: PropertyKey | { readonly key: PropertyKey }) => {
  const key = Predicate.isObject(segment) ? segment.key : segment;
  return typeof key === "number" ? `[${key}]` : `["${String(key)}"]`;
};

// Issues never carry input values because decoding does not set `reportInput`.
const summarizeIssue = (issue: SchemaIssue.Issue) => {
  const summary = SchemaIssue.makeFormatterStandardSchemaV1()(issue)
    .issues.map(({ path, message }) =>
      path === undefined || path.length === 0
        ? message
        : `at ${path.map(formatPathSegment).join("")}: ${message}`,
    )
    .join("; ");
  return summary.length > MAX_VALIDATION_SUMMARY_LENGTH
    ? `${summary.slice(0, MAX_VALIDATION_SUMMARY_LENGTH - 1)}…`
    : summary;
};

const compileSettingsSchema = (settingsSchema: Schema.JsonObject) =>
  Result.try(() =>
    Schema.decodeUnknownResult(
      // Imported JSON Schemas need no decoding services, which `Schema.Top` cannot express.
      Schema.make<Schema.Decoder<unknown>>(
        SchemaRepresentation.fromJsonSchemaDocument(
          JsonSchema.fromSchemaDraft2020_12(settingsSchema),
          // Plugins are trusted code, so their patterns are applied rather than rejected.
          { patterns: "apply" },
        ).ast,
      ),
      { onExcessProperty: "error", errors: "all" },
    ),
  );

const importerReason = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).slice(0, MAX_SCHEMA_REASON_LENGTH);

export const settingsSchemaProblem = (settingsSchema: Schema.JsonObject) => {
  const compiled = compileSettingsSchema(settingsSchema);
  return Result.isFailure(compiled) ? importerReason(compiled.failure) : undefined;
};

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const writeSemaphore = yield* Semaphore.make(1);
  // Sliding, so a subscriber that stops pulling drops old changes instead of blocking `update`.
  const changesPubSub = yield* PubSub.sliding<SettingsChange>(64);
  // Keyed by schema identity: a reloaded plugin brings a new manifest object.
  const validators = new WeakMap<Schema.JsonObject, ReturnType<typeof compileSettingsSchema>>();
  // Only `update` and `clear` write these files, under the write lock, so the copy stays true and
  // a hand edit shows after a restart. Text, so a plugin that mutates what it read can't change it.
  const savedFiles = new Map<PluginId, SavedFiles>();

  const settingsPath = (pluginId: PluginId) =>
    path.join(stateDir, "plugin-data", pluginId, "settings.json");

  const validatorFor = (pluginId: PluginId, settingsSchema: Schema.JsonObject) => {
    let validator = validators.get(settingsSchema);
    if (validator === undefined) {
      validator = compileSettingsSchema(settingsSchema);
      validators.set(settingsSchema, validator);
    }
    return Result.isSuccess(validator)
      ? Effect.succeed(validator.success)
      : Effect.fail(
          new PluginSettingsSchemaError({
            pluginId,
            reason: importerReason(validator.failure),
            cause: validator.failure,
          }),
        );
  };

  // The caller holds the write lock, so a read from disk can't save a copy older than a write.
  const readSavedFiles = Effect.fnUntraced(function* (pluginId: PluginId) {
    const cached = savedFiles.get(pluginId);
    if (cached !== undefined) return cached;
    const settings = yield* fileSystem.readFileString(settingsPath(pluginId)).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
      Effect.mapError(
        (cause) => new PluginSettingsPersistenceError({ pluginId, operation: "read", cause }),
      ),
    );
    const secrets = yield* secretStore.get(secretName(pluginId)).pipe(
      Effect.map((bytes) =>
        Option.getOrUndefined(Option.map(bytes, (value) => textDecoder.decode(value))),
      ),
      Effect.mapError(
        (cause) => new PluginSettingsPersistenceError({ pluginId, operation: "readSecret", cause }),
      ),
    );
    const files: SavedFiles = { settings, secrets };
    savedFiles.set(pluginId, files);
    return files;
  });

  // Shares the span of the public operation that reads.
  const load = Effect.fnUntraced(
    function* (pluginId: PluginId, fields: ReadonlySet<string>, files: SavedFiles) {
      const stored = files.settings === undefined ? {} : yield* decodeSettingsJson(files.settings);
      const values = Object.fromEntries(Object.entries(stored).filter(([key]) => !fields.has(key)));
      const saved = yield* decodeSecretsJson(files.secrets ?? "{}").pipe(
        Effect.mapError(
          (cause) =>
            new PluginSettingsPersistenceError({ pluginId, operation: "readSecret", cause }),
        ),
      );
      return {
        values,
        secrets: Object.fromEntries(Object.entries(saved).filter(([field]) => fields.has(field))),
      } satisfies StoredSettings;
    },
    (effect, pluginId) =>
      effect.pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(new PluginSettingsPersistenceError({ pluginId, operation: "read", cause })),
        }),
      ),
  );

  const loadCurrent = (pluginId: PluginId, fields: ReadonlySet<string>) => {
    const cached = savedFiles.get(pluginId);
    return (
      cached === undefined
        ? writeSemaphore.withPermits(1)(readSavedFiles(pluginId))
        : Effect.succeed(cached)
    ).pipe(Effect.flatMap((files) => load(pluginId, fields, files)));
  };

  const clientView = ({ values, secrets }: StoredSettings): Schema.JsonObject => ({
    ...values,
    ...Object.fromEntries(Object.keys(secrets).map((field) => [field, SECRET_REDACTED])),
  });

  const get = Effect.fn("PluginSettingsStore.get")(function* (
    pluginId: PluginId,
    settingsSchema: Schema.JsonObject | undefined,
  ) {
    const { values, secrets } = yield* loadCurrent(pluginId, secretFields(settingsSchema));
    return { ...defaultsOf(settingsSchema), ...values, ...secrets } satisfies Schema.JsonObject;
  });

  const getForClient = Effect.fn("PluginSettingsStore.getForClient")(function* (
    pluginId: PluginId,
    settingsSchema: Schema.JsonObject | undefined,
  ) {
    return clientView(yield* loadCurrent(pluginId, secretFields(settingsSchema)));
  });

  const update = Effect.fn("PluginSettingsStore.update")(function* (
    pluginId: PluginId,
    settingsSchema: Schema.JsonObject | undefined,
    patch: Schema.JsonObject,
  ) {
    const fields = secretFields(settingsSchema);
    const validate =
      settingsSchema === undefined ? undefined : yield* validatorFor(pluginId, settingsSchema);
    return yield* writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* load(pluginId, fields, yield* readSavedFiles(pluginId));
        const stale = keysOutside(settingsSchema, current.values);
        if (stale.length > 0) {
          yield* Effect.logWarning("dropping plugin settings its schema no longer has", {
            pluginId,
            keys: stale,
          });
        }
        const merged: Record<string, Schema.Json> = { ...current.values, ...current.secrets };
        for (const key of stale) delete merged[key];
        for (const [key, value] of Object.entries(patch)) {
          if (fields.has(key) && value === SECRET_REDACTED) continue;
          if (value === null) delete merged[key];
          else merged[key] = value;
        }

        // Checked as the plugin reads them: over the schema's defaults, and with secrets' real
        // values, so a required field that has a default or a secret passes. Defaults aren't saved.
        const validation = validate?.({ ...defaultsOf(settingsSchema), ...merged });
        if (validation !== undefined && Result.isFailure(validation)) {
          return yield* new PluginSettingsValidationError({
            pluginId,
            summary: summarizeIssue(validation.failure.issue),
          });
        }

        const next: StoredSettings = {
          values: Object.fromEntries(Object.entries(merged).filter(([key]) => !fields.has(key))),
          secrets: Object.fromEntries(
            Object.entries(merged).filter(
              (entry): entry is [string, string] =>
                fields.has(entry[0]) && typeof entry[1] === "string",
            ),
          ),
        };
        const secrets =
          Object.keys(next.secrets).length === 0
            ? undefined
            : yield* encodeSecretsJson(next.secrets).pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginSettingsPersistenceError({
                      pluginId,
                      operation: "writeSecret",
                      cause,
                    }),
                ),
              );
        const settings = yield* encodeSettingsJson(next.values).pipe(
          Effect.mapError(
            (cause) => new PluginSettingsPersistenceError({ pluginId, operation: "write", cause }),
          ),
        );
        // A write that fails partway leaves the next read to the disk.
        savedFiles.delete(pluginId);
        // Written on every save, which drops the secrets of fields the schema no longer has.
        yield* (
          secrets === undefined
            ? secretStore.remove(secretName(pluginId))
            : secretStore.set(secretName(pluginId), textEncoder.encode(secrets))
        ).pipe(
          Effect.mapError(
            (cause) =>
              new PluginSettingsPersistenceError({ pluginId, operation: "writeSecret", cause }),
          ),
        );
        yield* writeFileStringAtomically({
          filePath: settingsPath(pluginId),
          contents: settings,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) => new PluginSettingsPersistenceError({ pluginId, operation: "write", cause }),
          ),
        );
        savedFiles.set(pluginId, { settings, secrets });

        yield* PubSub.publish(changesPubSub, {
          pluginId,
          settings: { ...defaultsOf(settingsSchema), ...next.values, ...next.secrets },
        });
        return clientView(next);
      }),
    );
  });

  const changes = (pluginId: PluginId) =>
    Stream.fromPubSub(changesPubSub).pipe(
      Stream.filter((change) => change.pluginId === pluginId),
      Stream.map((change) => change.settings),
    );

  const clear: PluginSettingsStore["Service"]["clear"] = Effect.fn("PluginSettingsStore.clear")(
    (pluginId) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          savedFiles.delete(pluginId);
          yield* secretStore
            .remove(secretName(pluginId))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PluginSettingsPersistenceError({ pluginId, operation: "writeSecret", cause }),
              ),
            );
          yield* fileSystem
            .remove(path.dirname(settingsPath(pluginId)), { recursive: true, force: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PluginSettingsPersistenceError({ pluginId, operation: "write", cause }),
              ),
            );
        }),
      ),
  );

  return PluginSettingsStore.of({ get, getForClient, update, changes, clear });
});

export const layer = Layer.effect(PluginSettingsStore, make);
