import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLegacySecretKey from "../app/DesktopLegacySecretKey.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

type PersistedSavedEnvironmentDesktopSsh = NonNullable<
  PersistedSavedEnvironmentRecord["desktopSsh"]
>;

interface PersistedSavedEnvironmentStorageRecord extends Omit<
  PersistedSavedEnvironmentRecord,
  "desktopSsh"
> {
  readonly desktopSsh?: PersistedSavedEnvironmentDesktopSsh;
  readonly encryptedBearerToken?: string;
}

interface SavedEnvironmentRegistryDocument {
  readonly version: number;
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
}

interface SavedEnvironmentRegistryStorageDocument {
  readonly version?: number;
  readonly records?: readonly PersistedSavedEnvironmentStorageRecord[];
}

const DesktopSshTargetSchema = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});

const PersistedSavedEnvironmentStorageRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshTargetSchema),
  relayManaged: Schema.optionalKey(Schema.Struct({ relayUrl: Schema.String })),
  encryptedBearerToken: Schema.optionalKey(Schema.String),
});

const SavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  records: Schema.optionalKey(Schema.Array(PersistedSavedEnvironmentStorageRecordSchema)),
});

const SavedEnvironmentRegistryDocumentJson = fromLenientJson(
  SavedEnvironmentRegistryDocumentSchema,
);
const decodeSavedEnvironmentRegistryDocumentJson = Schema.decodeEffect(
  SavedEnvironmentRegistryDocumentJson,
);
const encodeSavedEnvironmentRegistryDocumentJson = Schema.encodeEffect(
  SavedEnvironmentRegistryDocumentJson,
);

const DesktopSavedEnvironmentSecretProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "decrypt-secret",
  "backup-secret",
  "persist-secret",
]);

export class DesktopSavedEnvironmentsReadError extends Schema.TaggedError<DesktopSavedEnvironmentsReadError>()(
  "DesktopSavedEnvironmentsReadError",
  {
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read desktop saved environments at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentsDocumentDecodeError extends Schema.TaggedError<DesktopSavedEnvironmentsDocumentDecodeError>()(
  "DesktopSavedEnvironmentsDocumentDecodeError",
  {
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode desktop saved environments at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentSecretDecodeError extends Schema.TaggedError<DesktopSavedEnvironmentSecretDecodeError>()(
  "DesktopSavedEnvironmentSecretDecodeError",
  {
    environmentId: Schema.String,
    registryPath: Schema.String,
    field: Schema.Literal("encryptedBearerToken"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.field} for environment ${this.environmentId} at ${this.registryPath}.`;
  }
}

export class DesktopSavedEnvironmentSecretProtectionError extends Schema.TaggedError<DesktopSavedEnvironmentSecretProtectionError>()(
  "DesktopSavedEnvironmentSecretProtectionError",
  {
    operation: DesktopSavedEnvironmentSecretProtectionOperation,
    environmentId: Schema.String,
    registryPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop saved-environment secret protection failed during ${this.operation} for environment ${this.environmentId} at ${this.registryPath}.`;
  }
}

export type DesktopSavedEnvironmentsReadRegistryError =
  | DesktopSavedEnvironmentsReadError
  | DesktopSavedEnvironmentsDocumentDecodeError;

export type DesktopSavedEnvironmentsGetSecretError =
  | DesktopSavedEnvironmentsReadRegistryError
  | DesktopSavedEnvironmentSecretDecodeError
  | DesktopSavedEnvironmentSecretProtectionError;

export class DesktopSavedEnvironments extends Context.Service<
  DesktopSavedEnvironments,
  {
    readonly getRegistry: Effect.Effect<
      readonly PersistedSavedEnvironmentRecord[],
      DesktopSavedEnvironmentsReadRegistryError
    >;

    readonly getSecret: (
      environmentId: string,
    ) => Effect.Effect<Option.Option<string>, DesktopSavedEnvironmentsGetSecretError>;
  }
>()("@t3tools/desktop/settings/DesktopSavedEnvironments") {}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  return {
    ...nextRecord,
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
    ...(record.relayManaged ? { relayManaged: record.relayManaged } : {}),
  };
}

function normalizeSavedEnvironmentRegistryDocument(
  document: SavedEnvironmentRegistryStorageDocument,
): SavedEnvironmentRegistryDocument {
  return {
    version: document.version ?? 1,
    records: document.records ?? [],
  };
}

function readRegistryDocument(
  fileSystem: FileSystem.FileSystem,
  registryPath: string,
): Effect.Effect<SavedEnvironmentRegistryDocument, DesktopSavedEnvironmentsReadRegistryError> {
  return fileSystem.readFileString(registryPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopSavedEnvironmentsReadError({
              registryPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed({ version: 1, records: [] })
        : decodeSavedEnvironmentRegistryDocumentJson(raw).pipe(
            Effect.map(normalizeSavedEnvironmentRegistryDocument),
            Effect.mapError(
              (cause) =>
                new DesktopSavedEnvironmentsDocumentDecodeError({
                  registryPath,
                  cause,
                }),
            ),
          ),
    ),
  );
}

function decodeSecretBytes(
  environmentId: string,
  registryPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopSavedEnvironmentSecretDecodeError> {
  return Effect.fromResult(Base64.decode(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSavedEnvironmentSecretDecodeError({
          environmentId,
          registryPath,
          field: "encryptedBearerToken",
          cause,
        }),
    ),
  );
}

const writeRegistryDocument = Effect.fn("desktop.savedEnvironments.writeRegistryDocument")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly registryPath: string;
    readonly document: SavedEnvironmentRegistryDocument;
  }) {
    const encoded = yield* encodeSavedEnvironmentRegistryDocumentJson(input.document);
    const temporaryPath = `${input.registryPath}.${process.pid}.pre-ominax.tmp`;
    yield* input.fileSystem.writeFileString(temporaryPath, `${encoded}\n`);
    yield* input.fileSystem
      .rename(temporaryPath, input.registryPath)
      .pipe(
        Effect.ensuring(
          input.fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
        ),
      );
  },
);

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const legacySecretKey = yield* DesktopLegacySecretKey.DesktopLegacySecretKey;

  return DesktopSavedEnvironments.of({
    getRegistry: readRegistryDocument(fileSystem, environment.savedEnvironmentRegistryPath).pipe(
      Effect.map((document) =>
        document.records.map((record) => toPersistedSavedEnvironmentRecord(record)),
      ),
      Effect.withSpan("desktop.savedEnvironments.getRegistry"),
    ),

    getSecret: Effect.fn("desktop.savedEnvironments.getSecret")(function* (environmentId) {
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      const encoded = Option.fromNullishOr(
        document.records.find((record) => record.environmentId === environmentId)
          ?.encryptedBearerToken,
      );
      if (Option.isNone(encoded)) {
        return Option.none<string>();
      }
      const encryptionAvailable = yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSavedEnvironmentSecretProtectionError({
              operation: "check-encryption-availability",
              environmentId,
              registryPath: environment.savedEnvironmentRegistryPath,
              cause,
            }),
        ),
      );
      if (!encryptionAvailable) {
        return Option.none<string>();
      }

      const secretBytes = yield* decodeSecretBytes(
        environmentId,
        environment.savedEnvironmentRegistryPath,
        encoded.value,
      );
      const currentResult = yield* Effect.exit(
        safeStorage.decryptString(secretBytes).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopSavedEnvironmentSecretProtectionError({
                operation: "decrypt-secret",
                environmentId,
                registryPath: environment.savedEnvironmentRegistryPath,
                cause,
              }),
          ),
        ),
      );
      if (Exit.isSuccess(currentResult)) return Option.some(currentResult.value);

      if (
        !environment.isDevelopment &&
        (environment.platform === "darwin" || environment.platform === "linux")
      ) {
        const legacyResult = yield* legacySecretKey.decrypt(secretBytes);
        if (Option.isSome(legacyResult)) {
          const backupPath = `${environment.savedEnvironmentRegistryPath}.pre-ominax`;
          const backupExists = yield* fileSystem.readFile(backupPath).pipe(Effect.option);
          if (Option.isNone(backupExists)) {
            const original = yield* fileSystem
              .readFile(environment.savedEnvironmentRegistryPath)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new DesktopSavedEnvironmentSecretProtectionError({
                      operation: "backup-secret",
                      environmentId,
                      registryPath: environment.savedEnvironmentRegistryPath,
                      cause,
                    }),
                ),
              );
            yield* fileSystem.writeFile(backupPath, original, { flag: "wx" }).pipe(
              Effect.catchIf(
                (cause) => cause.reason._tag === "AlreadyExists",
                () => Effect.void,
              ),
              Effect.mapError(
                (cause) =>
                  new DesktopSavedEnvironmentSecretProtectionError({
                    operation: "backup-secret",
                    environmentId,
                    registryPath: environment.savedEnvironmentRegistryPath,
                    cause,
                  }),
              ),
            );
          }

          const encrypted = yield* safeStorage.encryptString(legacyResult.value).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopSavedEnvironmentSecretProtectionError({
                  operation: "persist-secret",
                  environmentId,
                  registryPath: environment.savedEnvironmentRegistryPath,
                  cause,
                }),
            ),
          );
          const nextDocument: SavedEnvironmentRegistryDocument = {
            ...document,
            records: document.records.map((record) =>
              record.environmentId === environmentId
                ? { ...record, encryptedBearerToken: Base64.encode(encrypted) }
                : record,
            ),
          };
          yield* writeRegistryDocument({
            fileSystem,
            registryPath: environment.savedEnvironmentRegistryPath,
            document: nextDocument,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopSavedEnvironmentSecretProtectionError({
                  operation: "persist-secret",
                  environmentId,
                  registryPath: environment.savedEnvironmentRegistryPath,
                  cause,
                }),
            ),
          );
          return Option.some(legacyResult.value);
        }
      }

      return yield* Effect.failCause(currentResult.cause);
    }),
  });
});

export const layer = Layer.effect(DesktopSavedEnvironments, make);
