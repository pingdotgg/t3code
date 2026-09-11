import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument as RuntimeConnectionCatalogDocument,
  type ConnectionCatalogDocument as RuntimeConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import type { PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
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
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeUnknownEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const encodeEncryptedConnectionCatalogDocumentJson = Schema.encodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const RuntimeConnectionCatalogDocumentJson = Schema.fromJsonString(
  RuntimeConnectionCatalogDocument,
);
const encodeRuntimeConnectionCatalogDocumentJson = Schema.encodeEffect(
  RuntimeConnectionCatalogDocumentJson,
);
const decodeRuntimeConnectionCatalogDocumentJson = Schema.decodeUnknownEffect(
  RuntimeConnectionCatalogDocumentJson,
);

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
]);

const DesktopConnectionCatalogStoreMigrationOperation = Schema.Literals([
  "read-legacy-registry",
  "read-legacy-secret",
  "encode-catalog",
  "persist-catalog",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedError<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedError<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Schema.TaggedError<DesktopConnectionCatalogStoreMigrationError>()(
  "DesktopConnectionCatalogStoreMigrationError",
  {
    operation: DesktopConnectionCatalogStoreMigrationOperation,
    catalogPath: Schema.String,
    environmentId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    return `Legacy desktop saved-environment migration failed during ${this.operation}${environment} into ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStorePromotionError extends Schema.TaggedError<DesktopConnectionCatalogStorePromotionError>()(
  "DesktopConnectionCatalogStorePromotionError",
  {
    operation: Schema.Literal("promote-legacy-catalog"),
    sourceCatalogPath: Schema.String,
    catalogPath: Schema.String,
    cause: Schema.instanceOf(DesktopConnectionCatalogStoreWriteError),
  },
) {
  override get message(): string {
    return `Desktop connection catalog promotion failed from ${this.sourceCatalogPath} to ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedError<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStorePromotionError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      DesktopConnectionCatalogStoreWriteError | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<EncryptedConnectionCatalogDocument>,
  DesktopConnectionCatalogStoreReadError | DesktopConnectionCatalogStoreDocumentDecodeError
> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopConnectionCatalogStoreReadError({
              catalogPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<EncryptedConnectionCatalogDocument>())
        : decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(
            Effect.map(Option.some),
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath,
                  cause,
                }),
            ),
          ),
    ),
  );

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const directory = input.path.dirname(input.catalogPath);
  const tempPath = `${input.catalogPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: input.catalogPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, input.catalogPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "replace-catalog-file",
            path: input.catalogPath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      input.fileSystem.remove(tempPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a temporary connection catalog file.", {
            tempPath,
            error,
          }),
        ),
      ),
    ),
  );
});

function connectionId(prefix: "bearer" | "ssh", environmentId: string): string {
  return `${prefix}:${environmentId}`;
}

const migrateSavedEnvironmentRecords = Effect.fn(
  "desktop.connectionCatalogStore.migrateSavedEnvironmentRecords",
)(function* (
  records: readonly PersistedSavedEnvironmentRecord[],
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironments["Service"],
  catalogPath: string,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopConnectionCatalogStoreMigrationError
> {
  const targets: Array<RuntimeConnectionCatalogDocumentType["targets"][number]> = [];
  const profiles: Array<RuntimeConnectionCatalogDocumentType["profiles"][number]> = [];
  const credentials: Array<RuntimeConnectionCatalogDocumentType["credentials"][number]> = [];

  for (const record of records) {
    if (record.relayManaged !== undefined) {
      targets.push(
        new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      );
      continue;
    }

    if (record.desktopSsh !== undefined) {
      const id = connectionId("ssh", record.environmentId);
      targets.push(
        new SshConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
          connectionId: id,
        }),
      );
      profiles.push(
        new SshConnectionProfile({
          connectionId: id,
          environmentId: record.environmentId,
          label: record.label,
          target: record.desktopSsh,
        }),
      );
      continue;
    }

    const id = connectionId("bearer", record.environmentId);
    targets.push(
      new BearerConnectionTarget({
        environmentId: record.environmentId,
        label: record.label,
        connectionId: id,
      }),
    );
    profiles.push(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
      }),
    );
    const token = yield* savedEnvironments.getSecret(record.environmentId).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-secret",
            catalogPath,
            environmentId: record.environmentId,
            cause,
          }),
      ),
    );
    if (Option.isSome(token)) {
      credentials.push({
        connectionId: id,
        credential: new BearerConnectionCredential({ token: token.value }),
      });
    }
  }

  return {
    schemaVersion: 1,
    targets,
    profiles,
    credentials,
    remoteDpopTokens: [],
  };
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const catalogPath = environment.connectionCatalogPath;
  const mutex = yield* Semaphore.make(1);
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const encryptedCatalog = Encoding.encodeBase64(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
    const suffix = (yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replace(/-/g, "");
    yield* writeDocument({
      fileSystem,
      path,
      catalogPath,
      document: { version: 1, encryptedCatalog },
      suffix,
    });
  });

  const migrateLegacyCatalog = Effect.gen(function* () {
    // Legacy saved-environment secrets belong to the official app's safeStorage
    // identity. A downstream app cannot decrypt them without a macOS Keychain
    // prompt, so it must begin with its own empty catalog instead.
    if (environment.isDownstreamDistribution) {
      return Option.none<string>();
    }
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const records = yield* savedEnvironments.getRegistry.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-registry",
            catalogPath,
            cause,
          }),
      ),
    );
    if (records.length === 0) {
      return Option.none<string>();
    }
    const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments, catalogPath);
    const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "encode-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    yield* writeCatalog(encoded).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "persist-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    return Option.some(encoded);
  });

  return DesktopConnectionCatalogStore.of({
    get: Effect.gen(function* () {
      const catalogs: Array<{ path: string; value: string }> = [];
      for (const candidate of [catalogPath, ...environment.legacyConnectionCatalogPaths]) {
        const recovered = yield* Effect.gen(function* () {
          const document = yield* readDocument(fileSystem, candidate);
          if (Option.isNone(document)) return Option.none<string>();
          if (!(yield* encryptionAvailable)) return Option.none<string>();
          const decrypted = yield* decodeSecretBytes(
            candidate,
            document.value.encryptedCatalog,
          ).pipe(
            Effect.flatMap((encrypted) =>
              safeStorage.decryptString(encrypted).pipe(
                Effect.mapError(
                  (cause) =>
                    new DesktopConnectionCatalogStoreProtectionError({
                      operation: "decrypt-catalog",
                      catalogPath: candidate,
                      cause,
                    }),
                ),
              ),
            ),
          );
          if (
            candidate !== catalogPath &&
            catalogs.some((catalog) => catalog.path === catalogPath)
          ) {
            yield* decodeRuntimeConnectionCatalogDocumentJson(decrypted).pipe(
              Effect.mapError(
                (cause) =>
                  new DesktopConnectionCatalogStoreDocumentDecodeError({
                    catalogPath: candidate,
                    cause,
                  }),
              ),
            );
          }
          return Option.some(decrypted);
        }).pipe(
          Effect.catch((cause) => {
            if (
              candidate === catalogPath ||
              !catalogs.some((catalog) => catalog.path === catalogPath)
            )
              return Effect.fail(cause);
            return Effect.logWarning(
              "Skipped unreadable legacy catalog; current saved connections remain available.",
              { catalogPath: candidate },
            ).pipe(Effect.as(Option.none<string>()));
          }),
        );
        if (Option.isSome(recovered)) catalogs.push({ path: candidate, value: recovered.value });
      }
      const first = catalogs[0];
      if (first === undefined) return yield* migrateLegacyCatalog;
      const legacyCatalogs = catalogs.filter((catalog) => catalog.path !== catalogPath);
      let decrypted = first.value;
      if (catalogs.length > 1) {
        const documents = yield* Effect.forEach(catalogs, (catalog) =>
          decodeRuntimeConnectionCatalogDocumentJson(catalog.value).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath: catalog.path,
                  cause,
                }),
            ),
          ),
        );
        // Current state wins duplicate identities; import every other channel's unique records.
        const unique = <A>(values: readonly A[], key: (value: A) => string): A[] => {
          const seen = new Set<string>();
          return values.filter((value) => {
            const id = key(value);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
        };
        const targets = unique(
          documents.flatMap((document) => document.targets),
          (target) => target.environmentId,
        );
        const connectionIds = new Set(
          targets.flatMap((target) => ("connectionId" in target ? [target.connectionId] : [])),
        );
        decrypted = yield* encodeRuntimeConnectionCatalogDocumentJson({
          schemaVersion: 1,
          targets,
          profiles: unique(
            documents
              .flatMap((d) => d.profiles)
              .filter((profile) => connectionIds.has(profile.connectionId)),
            (v) => v.connectionId,
          ),
          credentials: unique(
            documents
              .flatMap((d) => d.credentials)
              .filter((credential) => connectionIds.has(credential.connectionId)),
            (v) => v.connectionId,
          ),
          remoteDpopTokens: unique(
            documents.flatMap((d) => d.remoteDpopTokens),
            (v) => v.environmentId,
          ),
        }).pipe(
          Effect.mapError(
            (cause) => new DesktopConnectionCatalogStoreDocumentDecodeError({ catalogPath, cause }),
          ),
        );
      }
      if (legacyCatalogs.length > 0) {
        yield* writeCatalog(decrypted).pipe(
          Effect.catchTags({
            DesktopConnectionCatalogStoreWriteError: (cause) =>
              Effect.fail(
                new DesktopConnectionCatalogStorePromotionError({
                  operation: "promote-legacy-catalog",
                  sourceCatalogPath: legacyCatalogs[0]!.path,
                  catalogPath,
                  cause,
                }),
              ),
          }),
        );
        for (const catalog of legacyCatalogs) {
          yield* fileSystem.remove(catalog.path, { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not clear the promoted desktop connection catalog.", {
                catalogPath: catalog.path,
                error,
              }),
            ),
          );
        }
      }
      return Option.some(decrypted);
    }).pipe(mutex.withPermits(1), Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog: string) {
      if (!(yield* encryptionAvailable)) {
        return false;
      }
      yield* writeCatalog(catalog);
      return true;
    }, mutex.withPermits(1)),
    clear: Effect.forEach(
      [catalogPath, ...environment.legacyConnectionCatalogPaths.slice(0, 1)],
      (candidate) =>
        fileSystem.remove(candidate, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not clear the desktop connection catalog.", {
              catalogPath: candidate,
              error,
            }),
          ),
        ),
      { discard: true },
    ).pipe(mutex.withPermits(1), Effect.withSpan("desktop.connectionCatalogStore.clear")),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
