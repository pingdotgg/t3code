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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeEffect(
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

export class DesktopConnectionCatalogStoreWriteError extends Data.TaggedError(
  "DesktopConnectionCatalogStoreWriteError",
)<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to write desktop connection catalog: ${this.cause.message}`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Data.TaggedError(
  "DesktopConnectionCatalogStoreDecodeError",
)<{
  readonly cause: Encoding.EncodingError;
}> {
  override get message() {
    return "Failed to decode the desktop connection catalog.";
  }
}

export class DesktopConnectionCatalogStoreReadError extends Data.TaggedError(
  "DesktopConnectionCatalogStoreReadError",
)<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to read desktop connection catalog: ${this.cause.message}`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Data.TaggedError(
  "DesktopConnectionCatalogStoreMigrationError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Failed to migrate legacy desktop saved environments.";
  }
}

export interface DesktopConnectionCatalogStoreShape {
  readonly get: Effect.Effect<
    Option.Option<string>,
    | DesktopConnectionCatalogStoreReadError
    | DesktopConnectionCatalogStoreDecodeError
    | DesktopConnectionCatalogStoreMigrationError
    | ElectronSafeStorage.ElectronSafeStorageAvailabilityError
    | ElectronSafeStorage.ElectronSafeStorageDecryptError
  >;
  readonly set: (
    catalog: string,
  ) => Effect.Effect<
    boolean,
    | DesktopConnectionCatalogStoreWriteError
    | ElectronSafeStorage.ElectronSafeStorageAvailabilityError
    | ElectronSafeStorage.ElectronSafeStorageEncryptError
  >;
  readonly clear: Effect.Effect<void>;
}

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  DesktopConnectionCatalogStoreShape
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError((cause) => new DesktopConnectionCatalogStoreDecodeError({ cause })),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<EncryptedConnectionCatalogDocument>,
  PlatformError.PlatformError | Schema.SchemaError
> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeed<string | null>(null) : Effect.fail(error),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<EncryptedConnectionCatalogDocument>())
        : decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(Effect.map(Option.some)),
    ),
  );

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const directory = input.path.dirname(input.catalogPath);
  const tempPath = `${input.catalogPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document);
  yield* input.fileSystem.makeDirectory(directory, { recursive: true });
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
    yield* input.fileSystem.rename(tempPath, input.catalogPath);
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
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironmentsShape,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopSavedEnvironments.DesktopSavedEnvironmentsGetSecretError
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
    const token = yield* savedEnvironments.getSecret(record.environmentId);
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

export const layer = Layer.effect(
  DesktopConnectionCatalogStore,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
    const crypto = yield* Crypto.Crypto;
    const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
    const catalogPath = path.join(environment.stateDir, "connection-catalog.json");

    const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
      catalog: string,
    ) {
      const encryptedCatalog = Encoding.encodeBase64(yield* safeStorage.encryptString(catalog));
      const suffix = (yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => new DesktopConnectionCatalogStoreWriteError({ cause })),
      )).replace(/-/g, "");
      yield* writeDocument({
        fileSystem,
        path,
        catalogPath,
        document: { version: 1, encryptedCatalog },
        suffix,
      }).pipe(Effect.mapError((cause) => new DesktopConnectionCatalogStoreWriteError({ cause })));
    });

    const migrateLegacyCatalog = Effect.gen(function* () {
      if (!(yield* safeStorage.isEncryptionAvailable)) {
        return Option.none<string>();
      }
      const records = yield* savedEnvironments.getRegistry;
      if (records.length === 0) {
        return Option.none<string>();
      }
      const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments);
      const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog);
      yield* writeCatalog(encoded);
      return Option.some(encoded);
    }).pipe(Effect.mapError((cause) => new DesktopConnectionCatalogStoreMigrationError({ cause })));

    return DesktopConnectionCatalogStore.of({
      get: Effect.gen(function* () {
        const document = yield* readDocument(fileSystem, catalogPath).pipe(
          Effect.mapError((cause) => new DesktopConnectionCatalogStoreReadError({ cause })),
        );
        if (Option.isNone(document)) {
          return yield* migrateLegacyCatalog;
        }
        if (!(yield* safeStorage.isEncryptionAvailable)) {
          return Option.none<string>();
        }
        const decrypted = yield* decodeSecretBytes(document.value.encryptedCatalog).pipe(
          Effect.flatMap(safeStorage.decryptString),
        );
        return Option.some(decrypted);
      }).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
      set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
        if (!(yield* safeStorage.isEncryptionAvailable)) {
          return false;
        }
        yield* writeCatalog(catalog);
        return true;
      }),
      clear: fileSystem.remove(catalogPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not clear the desktop connection catalog.", {
            catalogPath,
            error,
          }),
        ),
        Effect.withSpan("desktop.connectionCatalogStore.clear"),
      ),
    });
  }),
);
