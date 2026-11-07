import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  RelayConnectionTarget,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  type ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LegacySavedRemoteConnection = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  pairingUrl: Schema.String,
  displayUrl: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  bearerToken: Schema.NullOr(Schema.String),
  authenticationMethod: Schema.optionalKey(Schema.Literals(["bearer", "dpop"])),
  dpopAccessToken: Schema.optionalKey(Schema.String),
  relayManaged: Schema.optionalKey(Schema.Literal(true)),
});

const LegacyConnectionDocument = Schema.Struct({
  connections: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const decodeLegacyConnectionDocument = Schema.decodeUnknownEffect(LegacyConnectionDocument);
const decodeLegacySavedRemoteConnection = Schema.decodeUnknownOption(LegacySavedRemoteConnection);

export class LegacyConnectionMigrationError extends Schema.TaggedError<LegacyConnectionMigrationError>()(
  "LegacyConnectionMigrationError",
  {
    message: Schema.String,
  },
) {}

function isRelayManaged(connection: typeof LegacySavedRemoteConnection.Type): boolean {
  return connection.relayManaged === true || connection.authenticationMethod === "dpop";
}

function migrateConnection(
  document: ConnectionCatalogDocument,
  connection: typeof LegacySavedRemoteConnection.Type,
): ConnectionCatalogDocument {
  if (isRelayManaged(connection)) {
    return registerConnectionInCatalog(
      document,
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }),
      }),
    );
  }

  if (connection.bearerToken === null || connection.bearerToken.trim() === "") {
    return document;
  }

  const connectionId = `bearer:${connection.environmentId}`;
  return registerConnectionInCatalog(
    document,
    new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        httpBaseUrl: connection.httpBaseUrl,
        wsBaseUrl: connection.wsBaseUrl,
      }),
      credential: new BearerConnectionCredential({
        token: connection.bearerToken,
      }),
    }),
  );
}

const decodeLegacyCatalogJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const migrateLegacyConnectionCatalog = Effect.fn(
  "mobile.connectionMigration.migrateCatalog",
)(function* (raw: string) {
  const parsed = yield* decodeLegacyCatalogJson(raw).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyConnectionMigrationError({
          message: `Could not parse the legacy mobile connection catalog: ${String(cause)}`,
        }),
    ),
  );
  const legacy = yield* decodeLegacyConnectionDocument(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyConnectionMigrationError({
          message: `Could not decode the legacy mobile connection catalog: ${String(cause)}`,
        }),
    ),
  );

  const entries = legacy.connections ?? [];
  const connections = entries.flatMap((entry) =>
    Option.toArray(decodeLegacySavedRemoteConnection(entry)),
  );
  if (connections.length < entries.length) {
    yield* Effect.logWarning("Dropping unreadable legacy mobile connections", {
      count: entries.length - connections.length,
    });
  }
  return connections.reduce(migrateConnection, EMPTY_CONNECTION_CATALOG_DOCUMENT);
});
