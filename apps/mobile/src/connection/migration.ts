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
  connections: Schema.optionalKey(Schema.Array(LegacySavedRemoteConnection)),
});
const decodeLegacyConnectionDocument = Schema.decodeUnknownEffect(LegacyConnectionDocument);

export class LegacyConnectionMigrationError extends Schema.TaggedErrorClass<LegacyConnectionMigrationError>()(
  "LegacyConnectionMigrationError",
  {
    stage: Schema.Literals(["parse", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.stage} the legacy mobile connection catalog.`;
  }
}

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

export const migrateLegacyConnectionCatalog = Effect.fn(
  "mobile.connectionMigration.migrateCatalog",
)(function* (raw: string) {
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new LegacyConnectionMigrationError({ stage: "parse", cause }),
  });
  const legacy = yield* decodeLegacyConnectionDocument(parsed).pipe(
    Effect.mapError((cause) => new LegacyConnectionMigrationError({ stage: "decode", cause })),
  );

  return (legacy.connections ?? []).reduce(migrateConnection, EMPTY_CONNECTION_CATALOG_DOCUMENT);
});
