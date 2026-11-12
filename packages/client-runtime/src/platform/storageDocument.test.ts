import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  ConnectionProfile,
  BearerConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PersistedConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  StoredConnectionCredential,
  catalogRoutes,
  setRoutesInCatalog,
  clearConnectOnlyEnvironments,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);
const encodeCatalogDocument = Schema.encodeSync(ConnectionCatalogDocument);

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "bearer-1",
});
const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test",
});
const BEARER_CREDENTIAL = new BearerConnectionCredential({
  token: "bearer-token",
});
const LAN_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  connectionId: "lan-1",
});
const LAN_PROFILE = new BearerConnectionProfile({
  connectionId: LAN_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: LAN_TARGET.label,
  httpBaseUrl: "http://192.168.1.10:3773",
  wsBaseUrl: "ws://192.168.1.10:3773",
});
const bearerRegistration = (
  target = BEARER_TARGET,
  profile = BEARER_PROFILE,
  credential = BEARER_CREDENTIAL,
) => new BearerConnectionRegistration({ target, profile, credential });

describe("ConnectionCatalogDocument", () => {
  it.effect("persists explicit GitHub trust and forgets it when a connection is removed", () =>
    Effect.gen(function* () {
      let document = EMPTY_CONNECTION_CATALOG_DOCUMENT;
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      const storage = {
        read: Effect.sync(() => document.githubRoutingPermissions ?? []),
        write: (githubRoutingPermissions: NonNullable<typeof document.githubRoutingPermissions>) =>
          Effect.gen(function* () {
            document = yield* decodeConnectionCatalogDocument({
              ...document,
              githubRoutingPermissions,
            }).pipe(Effect.orDie);
          }),
      };
      const permissions = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* permissions.get(entry)).toBe("off");
      yield* permissions.set(entry, "read");
      const restarted = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* restarted.get(entry)).toBe("read");

      const changedEndpoint = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            ...BEARER_PROFILE,
            httpBaseUrl: "https://different.example.test",
          }),
        ),
      };
      expect(yield* restarted.get(changedEndpoint)).toBe("off");
      expect(
        yield* restarted.get({
          ...entry,
          profile: Option.some(
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              wsBaseUrl: "wss://different.example.test",
            }),
          ),
        }),
      ).toBe("off");
      yield* restarted.set(entry, "read-write");
      expect(yield* restarted.get(entry)).toBe("read-write");
      yield* restarted.forget(ENVIRONMENT_ID);
      expect(yield* restarted.get(entry)).toBe("off");
      const afterRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterRemoval.get(entry)).toBe("off");

      yield* permissions.set(entry, "read");
      document = removeConnectionFromCatalog(document, ENVIRONMENT_ID);
      const afterCatalogRemoval = yield* makePullRequestRoutingPermissions(storage);
      expect(yield* afterCatalogRemoval.get(entry)).toBe("off");
    }),
  );

  it.effect("requires explicit trust for primary and SSH connections independently", () =>
    Effect.gen(function* () {
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () => Effect.void,
      });
      const entries = [
        {
          target: new PrimaryConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Local",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
          }),
          profile: Option.none(),
          enabled: true,
        },
        {
          enabled: true,
          target: new SshConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "SSH",
            connectionId: "ssh-1",
          }),
          profile: Option.some(
            new SshConnectionProfile({
              environmentId: ENVIRONMENT_ID,
              label: "SSH",
              connectionId: "ssh-1",
              target: { alias: "work", hostname: "work.example.test", username: "maria", port: 22 },
            }),
          ),
        },
      ];
      for (const entry of entries) {
        expect(yield* permissions.get(entry)).toBe("off");
        yield* permissions.set(entry, "read");
        expect(yield* permissions.get(entry)).toBe("read");
        yield* permissions.set(entry, "off");
        expect(yield* permissions.get(entry)).toBe("off");
      }
    }),
  );

  it.effect("does not enable GitHub routing when permission persistence fails", () =>
    Effect.gen(function* () {
      const entry = { target: BEARER_TARGET, profile: Option.some(BEARER_PROFILE), enabled: true };
      expect(yield* (yield* PullRequestRoutingPermissions).get(entry)).toBe("off");
      const permissions = yield* makePullRequestRoutingPermissions({
        read: Effect.succeed([]),
        write: () =>
          Effect.fail(
            new ConnectionTransientError({
              reason: "remote-unavailable",
              detail: "storage unavailable",
            }),
          ),
      });
      yield* permissions.set(entry, "read-write").pipe(Effect.flip);
      expect(yield* permissions.get(entry)).toBe("off");
    }),
  );

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      bearerRegistration(),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("decodes a document written before the disabled list existed", () => {
    const decoded = decodeCatalogDocument({
      schemaVersion: 1,
      targets: [],
      profiles: [],
      credentials: [],
      remoteDpopTokens: [],
    });

    expect(decoded.disabledEnvironmentIds).toEqual([]);
    expect(decoded.networkMembers).toBeUndefined();
  });

  it("keeps followed network members across a save, and reads ones saved before openers", () => {
    const host = EnvironmentId.make("host");
    const networkMembers = [
      { environmentId: ENVIRONMENT_ID, label: "Laptop", via: host, opener: { kind: "host" } },
      {
        environmentId: EnvironmentId.make("box"),
        label: "Box",
        via: host,
        opener: { kind: "app", appId: "app-phone" },
      },
    ] as const;
    const encoded = encodeCatalogDocument({
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      networkMembers,
    });
    expect(decodeCatalogDocument(encoded).networkMembers).toEqual(networkMembers);

    // Earlier builds saved the app id alone; without one the member was opened app-less.
    const legacy = decodeCatalogDocument({
      ...encoded,
      networkMembers: [
        { environmentId: ENVIRONMENT_ID, label: "Laptop", via: host },
        { environmentId: "box", label: "Box", via: host, appId: "app-phone", openedAs: "app-old" },
      ],
    });
    expect(legacy.networkMembers).toEqual(networkMembers);
  });

  it("switches a saved environment off and back on without touching its records", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    const disabled = setConnectionEnabledInCatalog(registered, ENVIRONMENT_ID, false);
    expect(disabled.disabledEnvironmentIds).toEqual([ENVIRONMENT_ID]);
    expect(disabled.targets).toEqual(registered.targets);
    expect(disabled.credentials).toEqual(registered.credentials);
    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, false).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);

    expect(
      setConnectionEnabledInCatalog(disabled, ENVIRONMENT_ID, true).disabledEnvironmentIds,
    ).toEqual([]);
    expect(
      registerConnectionInCatalog(
        disabled,
        new BearerConnectionRegistration({
          target: BEARER_TARGET,
          profile: BEARER_PROFILE,
          credential: BEARER_CREDENTIAL,
        }),
      ).disabledEnvironmentIds,
    ).toEqual([ENVIRONMENT_ID]);
    expect(removeConnectionFromCatalog(disabled, ENVIRONMENT_ID).disabledEnvironmentIds).toEqual(
      [],
    );
  });

  it("persists the normalized SSH profile and its paired token beside its target", () => {
    const target = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "SSH",
      connectionId: "ssh-1",
    });
    const profile = new SshConnectionProfile({
      connectionId: target.connectionId,
      environmentId: target.environmentId,
      label: target.label,
      target: {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      },
    });
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new SshConnectionRegistration({ target, profile, credential: BEARER_CREDENTIAL }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([
      { connectionId: target.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    // Removing the route forgets its token too.
    expect(removeConnectionFromCatalog(document, ENVIRONMENT_ID).credentials).toEqual([]);
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      bearerRegistration(),
    );
    const withLan = registerConnectionInCatalog(
      withBearer,
      bearerRegistration(LAN_TARGET, LAN_PROFILE),
      [LAN_TARGET, BEARER_TARGET],
    );
    expect(catalogRoutes(withLan, ENVIRONMENT_ID)).toEqual([LAN_TARGET, BEARER_TARGET]);
    expect(withLan.credentials).toHaveLength(2);

    const lanOnly = setRoutesInCatalog(withLan, ENVIRONMENT_ID, [LAN_TARGET]);
    expect(lanOnly.targets).toEqual([LAN_TARGET]);
    expect(lanOnly.profiles).toEqual([LAN_PROFILE]);
    expect(lanOnly.credentials.map((value) => value.connectionId)).toEqual([
      LAN_TARGET.connectionId,
    ]);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new BearerConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
      connectionId: "other-1",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [BEARER_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [LAN_TARGET, BEARER_TARGET]).targets,
    ).toEqual([LAN_TARGET, BEARER_TARGET, other]);
  });
});

// The document as 8b1b2e0507, the last build with T3 Connect, requires it. Its targets and
// profiles were supersets of today's, so only the top-level fields need copying here.
const PreviousBuildCatalogDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  targets: Schema.Array(PersistedConnectionTarget),
  profiles: Schema.Array(ConnectionProfile),
  credentials: Schema.Array(StoredConnectionCredential),
  remoteDpopTokens: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      accessToken: Schema.String,
      expiresAtEpochMs: Schema.Number,
    }),
  ),
});
const decodePreviousBuildCatalog = Schema.decodeUnknownSync(PreviousBuildCatalogDocument);

describe("ConnectionCatalogDocument T3 Connect migration", () => {
  const encode = Schema.encodeSync(ConnectionCatalogDocument);
  const OFFICE_ID = EnvironmentId.make("environment-office");
  const LEARNED_CONNECT_ID = `learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773`;
  // A document written by a build with T3 Connect: a relay route beside a direct one, an
  // address learned through the relay that used its token, and an environment only on Connect.
  const legacyDocument = () => {
    const direct = encode(
      registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, bearerRegistration()),
    );
    return {
      ...direct,
      targets: [
        ...direct.targets,
        { _tag: "RelayConnectionTarget", environmentId: ENVIRONMENT_ID, label: "Remote" },
        {
          _tag: "BearerConnectionTarget",
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          connectionId: LEARNED_CONNECT_ID,
        },
        { _tag: "RelayConnectionTarget", environmentId: OFFICE_ID, label: "Office" },
      ],
      profiles: [
        ...direct.profiles,
        {
          _tag: "BearerConnectionProfile",
          connectionId: LEARNED_CONNECT_ID,
          environmentId: ENVIRONMENT_ID,
          label: "Remote",
          httpBaseUrl: "http://10.0.0.42:3773",
          wsBaseUrl: "ws://10.0.0.42:3773",
          learned: true,
          authorization: "t3-connect",
        },
      ],
      disabledEnvironmentIds: [OFFICE_ID],
      githubRoutingPermissions: [],
      remoteDpopTokens: [
        {
          environmentId: OFFICE_ID,
          accessToken: "relay-minted-token",
          expiresAtEpochMs: 1_000_000,
        },
      ],
    };
  };

  it("drops T3 Connect routes and tokens and keeps direct routes and their tokens", () => {
    const decoded = decodeCatalogDocument(legacyDocument());

    expect(decoded.targets).toEqual([BEARER_TARGET]);
    expect(decoded.profiles).toEqual([BEARER_PROFILE]);
    expect(decoded.credentials).toEqual([
      { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    expect(decoded.disabledEnvironmentIds).toEqual([]);
    expect(decoded).not.toHaveProperty("remoteDpopTokens");
  });

  it("writes a document the previous build still reads, keeping direct routes and their tokens", () => {
    const upgraded = clearConnectOnlyEnvironments(decodeCatalogDocument(legacyDocument()));

    const rolledBack = decodePreviousBuildCatalog(encode(upgraded));

    expect(rolledBack.targets).toEqual([BEARER_TARGET]);
    expect(rolledBack.profiles).toEqual([BEARER_PROFILE]);
    expect(rolledBack.credentials).toEqual([
      { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
    ]);
    expect(rolledBack.remoteDpopTokens).toEqual([]);
  });

  it("records an environment reached only through T3 Connect once, until shown or re-paired", () => {
    const decoded = decodeCatalogDocument(legacyDocument());
    expect(decoded.connectOnlyEnvironments).toEqual([
      { environmentId: OFFICE_ID, label: "Office" },
    ]);
    expect(decodeCatalogDocument(encode(decoded))).toEqual(decoded);

    expect(clearConnectOnlyEnvironments(decoded)).not.toHaveProperty("connectOnlyEnvironments");
    const office = new BearerConnectionTarget({
      environmentId: OFFICE_ID,
      label: "Office",
      connectionId: "office-1",
    });
    const repaired = registerConnectionInCatalog(
      decoded,
      bearerRegistration(
        office,
        new BearerConnectionProfile({
          ...BEARER_PROFILE,
          environmentId: OFFICE_ID,
          label: office.label,
          connectionId: office.connectionId,
        }),
      ),
    );
    expect(repaired).not.toHaveProperty("connectOnlyEnvironments");
  });
});
