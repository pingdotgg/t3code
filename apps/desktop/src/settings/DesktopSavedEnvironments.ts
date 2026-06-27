import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
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

const DesktopSavedEnvironmentsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-registry",
  "create-directory",
  "write-temporary-file",
  "replace-registry-file",
]);

const DesktopSavedEnvironmentSecretProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-secret",
  "decrypt-secret",
]);

export class DesktopSavedEnvironmentsWriteError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentsWriteError>()(
  "DesktopSavedEnvironmentsWriteError",
  {
    operation: DesktopSavedEnvironmentsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop saved-environment write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopSavedEnvironmentsReadError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentsReadError>()(
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

export class DesktopSavedEnvironmentsDocumentDecodeError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentsDocumentDecodeError>()(
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

export class DesktopSavedEnvironmentSecretDecodeError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentSecretDecodeError>()(
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

export class DesktopSavedEnvironmentSecretProtectionError extends Schema.TaggedErrorClass<DesktopSavedEnvironmentSecretProtectionError>()(
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

export type DesktopSavedEnvironmentsMutationError =
  | DesktopSavedEnvironmentsReadRegistryError
  | DesktopSavedEnvironmentsWriteError;

export type DesktopSavedEnvironmentsGetSecretError =
  | DesktopSavedEnvironmentsReadRegistryError
  | DesktopSavedEnvironmentSecretDecodeError
  | DesktopSavedEnvironmentSecretProtectionError;

export type DesktopSavedEnvironmentsSetSecretError =
  | DesktopSavedEnvironmentsMutationError
  | DesktopSavedEnvironmentSecretProtectionError;

export class DesktopSavedEnvironments extends Context.Service<
  DesktopSavedEnvironments,
  {
    readonly getRegistry: Effect.Effect<
      readonly PersistedSavedEnvironmentRecord[],
      DesktopSavedEnvironmentsReadRegistryError
    >;
    readonly setRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Effect.Effect<void, DesktopSavedEnvironmentsMutationError>;
    readonly removeEnvironment: (
      environmentId: string,
    ) => Effect.Effect<void, DesktopSavedEnvironmentsMutationError>;
    readonly getSecret: (
      environmentId: string,
    ) => Effect.Effect<Option.Option<string>, DesktopSavedEnvironmentsGetSecretError>;
    readonly setSecret: (input: {
      readonly environmentId: string;
      readonly secret: string;
    }) => Effect.Effect<boolean, DesktopSavedEnvironmentsSetSecretError>;
    readonly removeSecret: (
      environmentId: string,
    ) => Effect.Effect<void, DesktopSavedEnvironmentsMutationError>;
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

function toSavedEnvironmentStorageRecord(
  record: PersistedSavedEnvironmentRecord | PersistedSavedEnvironmentStorageRecord,
  encryptedBearerToken: Option.Option<string>,
): PersistedSavedEnvironmentStorageRecord {
  const nextRecord = {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
  const metadata = {
    ...(record.desktopSsh ? { desktopSsh: record.desktopSsh } : {}),
    ...(record.relayManaged ? { relayManaged: record.relayManaged } : {}),
  };
  return Option.match(encryptedBearerToken, {
    onNone: () => ({ ...nextRecord, ...metadata }),
    onSome: (value) => ({ ...nextRecord, ...metadata, encryptedBearerToken: value }),
  });
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

const writeRegistryDocument = Effect.fn("desktop.savedEnvironments.writeRegistryDocument")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly registryPath: string;
    readonly document: SavedEnvironmentRegistryDocument;
    readonly suffix: string;
  }): Effect.fn.Return<void, DesktopSavedEnvironmentsWriteError> {
    const directory = input.path.dirname(input.registryPath);
    const tempPath = `${input.registryPath}.${process.pid}.${input.suffix}.tmp`;
    const encoded = yield* encodeSavedEnvironmentRegistryDocumentJson(input.document).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "encode-registry",
            path: input.registryPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "create-directory",
            path: directory,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, input.registryPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "replace-registry-file",
            path: input.registryPath,
            cause,
          }),
      ),
    );
  },
);

function preserveExistingSecrets(
  currentDocument: SavedEnvironmentRegistryDocument,
  records: readonly PersistedSavedEnvironmentRecord[],
): SavedEnvironmentRegistryDocument {
  const encryptedBearerTokenById = new Map(
    currentDocument.records.flatMap((record) =>
      record.encryptedBearerToken
        ? [[record.environmentId, record.encryptedBearerToken] as const]
        : [],
    ),
  );

  return {
    version: currentDocument.version,
    records: records.map((record) => {
      const encryptedBearerToken = encryptedBearerTokenById.get(record.environmentId);
      return toSavedEnvironmentStorageRecord(record, Option.fromNullishOr(encryptedBearerToken));
    }),
  };
}

function decodeSecretBytes(
  environmentId: string,
  registryPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopSavedEnvironmentSecretDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
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

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;

  const writeDocument = (document: SavedEnvironmentRegistryDocument) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => uuid.replace(/-/g, "")),
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "create-temporary-file-name",
            path: environment.savedEnvironmentRegistryPath,
            cause,
          }),
      ),
      Effect.flatMap((suffix) =>
        writeRegistryDocument({
          fileSystem,
          path,
          registryPath: environment.savedEnvironmentRegistryPath,
          document,
          suffix,
        }),
      ),
    );

  return DesktopSavedEnvironments.of({
    getRegistry: readRegistryDocument(fileSystem, environment.savedEnvironmentRegistryPath).pipe(
      Effect.map((document) =>
        document.records.map((record) => toPersistedSavedEnvironmentRecord(record)),
      ),
      Effect.withSpan("desktop.savedEnvironments.getRegistry"),
    ),
    setRegistry: Effect.fn("desktop.savedEnvironments.setRegistry")(function* (records) {
      const currentDocument = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      yield* writeDocument(preserveExistingSecrets(currentDocument, records));
    }),
    removeEnvironment: Effect.fn("desktop.savedEnvironments.removeEnvironment")(
      function* (environmentId) {
        yield* Effect.annotateCurrentSpan({ environmentId });
        const document = yield* readRegistryDocument(
          fileSystem,
          environment.savedEnvironmentRegistryPath,
        );
        if (!document.records.some((record) => record.environmentId === environmentId)) {
          return;
        }

        yield* writeDocument({
          version: document.version,
          records: document.records.filter((record) => record.environmentId !== environmentId),
        });
      },
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
      return Option.some(
        yield* safeStorage.decryptString(secretBytes).pipe(
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
    }),
    setSecret: Effect.fn("desktop.savedEnvironments.setSecret")(function* (input) {
      const { environmentId, secret } = input;
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );

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
        return false;
      }

      const encryptedBearerToken = Encoding.encodeBase64(
        yield* safeStorage.encryptString(secret).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopSavedEnvironmentSecretProtectionError({
                operation: "encrypt-secret",
                environmentId,
                registryPath: environment.savedEnvironmentRegistryPath,
                cause,
              }),
          ),
        ),
      );
      let found = false;
      const nextDocument: SavedEnvironmentRegistryDocument = {
        version: document.version,
        records: document.records.map((record) => {
          if (record.environmentId !== environmentId) {
            return record;
          }

          found = true;
          return toSavedEnvironmentStorageRecord(record, Option.some(encryptedBearerToken));
        }),
      };

      if (found) {
        yield* writeDocument(nextDocument);
      }
      return found;
    }),
    removeSecret: Effect.fn("desktop.savedEnvironments.removeSecret")(function* (environmentId) {
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      if (
        !document.records.some(
          (record) =>
            record.environmentId === environmentId && record.encryptedBearerToken !== undefined,
        )
      ) {
        return;
      }

      yield* writeDocument({
        version: document.version,
        records: document.records.map((record) => {
          if (record.environmentId !== environmentId) {
            return record;
          }
          return toPersistedSavedEnvironmentRecord(record);
        }),
      });
    }),
  });
});

export const layer = Layer.effect(DesktopSavedEnvironments, make);

export const layerTest = (input?: {
  readonly records?: readonly PersistedSavedEnvironmentRecord[];
  readonly secrets?: ReadonlyMap<string, string>;
}) =>
  Layer.effect(
    DesktopSavedEnvironments,
    Effect.gen(function* () {
      const recordsRef = yield* Ref.make(input?.records ?? []);
      const secretsRef = yield* Ref.make(new Map(input?.secrets ?? []));

      return DesktopSavedEnvironments.of({
        getRegistry: Ref.get(recordsRef),
        setRegistry: (records) => Ref.set(recordsRef, records),
        removeEnvironment: (environmentId) =>
          Ref.update(recordsRef, (records) =>
            records.filter((record) => record.environmentId !== environmentId),
          ).pipe(
            Effect.andThen(
              Ref.update(secretsRef, (secrets) => {
                const nextSecrets = new Map(secrets);
                nextSecrets.delete(environmentId);
                return nextSecrets;
              }),
            ),
          ),
        getSecret: (environmentId) =>
          Ref.get(secretsRef).pipe(
            Effect.map((secrets) => Option.fromNullishOr(secrets.get(environmentId))),
          ),
        setSecret: ({ environmentId, secret }) =>
          Ref.get(recordsRef).pipe(
            Effect.flatMap((records) => {
              if (!records.some((record) => record.environmentId === environmentId)) {
                return Effect.succeed(false);
              }
              return Ref.update(secretsRef, (secrets) => {
                const nextSecrets = new Map(secrets);
                nextSecrets.set(environmentId, secret);
                return nextSecrets;
              }).pipe(Effect.as(true));
            }),
          ),
        removeSecret: (environmentId) =>
          Ref.update(secretsRef, (secrets) => {
            const nextSecrets = new Map(secrets);
            nextSecrets.delete(environmentId);
            return nextSecrets;
          }),
      });
    }),
  );
