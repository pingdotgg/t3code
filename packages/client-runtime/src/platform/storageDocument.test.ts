import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as TokenStore from "../authorization/tokenStore.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "../connection/catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  PullRequestRoutingPermissions,
  makePullRequestRoutingPermissions,
} from "../connection/pullRequestRoutingPermissions.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogRoutes,
  setRoutesInCatalog,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
  setConnectionEnabledInCatalog,
} from "./storageDocument.ts";

const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocument);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const decodeCatalogDocument = Schema.decodeUnknownSync(ConnectionCatalogDocument);

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
});
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
const REMOTE_TOKEN = new TokenStore.RemoteDpopAccessToken({
  environmentId: ENVIRONMENT_ID,
  label: "Remote",
  endpoint: {
    httpBaseUrl: "https://remote.example.test",
    wsBaseUrl: "wss://remote.example.test",
    providerKind: "cloudflare_tunnel",
  },
  accessToken: "dpop-token",
  expiresAtEpochMs: 1_000_000,
  dpopThumbprint: "thumbprint",
});

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
      expect(
        yield* restarted.get({ target: RELAY_TARGET, profile: Option.none(), enabled: true }),
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

  it.effect("requires explicit trust for primary, relay, and SSH connections independently", () =>
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
        { target: RELAY_TARGET, profile: Option.none(), enabled: true },
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

  it("replaces obsolete connection metadata without discarding a reusable DPoP token", () => {
    const bearer = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const relayTarget = new RelayConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
    });
    const relay = registerConnectionInCatalog(
      bearer,
      new RelayConnectionRegistration({ target: relayTarget }),
    );

    expect(relay.targets).toEqual([relayTarget]);
    expect(relay.profiles).toEqual([]);
    expect(relay.credentials).toEqual([]);
    expect(relay.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

  it("removes every catalog record owned by an explicit disconnect", () => {
    const registered = registerConnectionInCatalog(
      {
        ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
        remoteDpopTokens: [REMOTE_TOKEN],
      },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(removeConnectionFromCatalog(registered, ENVIRONMENT_ID)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("stores a DPoP token for a registered relay environment", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );

    expect(putRemoteDpopTokenInCatalog(registered, REMOTE_TOKEN)).toEqual({
      ...registered,
      remoteDpopTokens: [REMOTE_TOKEN],
    });
  });

  it("ignores a late DPoP token after the environment is removed", () => {
    const registered = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
    );
    const removed = removeConnectionFromCatalog(registered, ENVIRONMENT_ID);

    expect(putRemoteDpopTokenInCatalog(removed, REMOTE_TOKEN)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("does not store DPoP tokens for a different environment or connection kind", () => {
    const bearer = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const otherRelay = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: EnvironmentId.make("environment-2"),
          label: "Other relay",
        }),
      }),
    );

    expect(putRemoteDpopTokenInCatalog(bearer, REMOTE_TOKEN)).toBe(bearer);
    expect(putRemoteDpopTokenInCatalog(otherRelay, REMOTE_TOKEN)).toBe(otherRelay);
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

  it("a new pairing gives every paired address its login, and it outlives the new route", () => {
    const tailnet = new BearerConnectionTarget({
      ...BEARER_TARGET,
      connectionId: "bearer-tailnet",
    });
    const learned = new BearerConnectionTarget({
      ...BEARER_TARGET,
      connectionId: `learned:${ENVIRONMENT_ID}:http://100.64.0.9:3773@${BEARER_TARGET.connectionId}`,
    });
    const ssh = new SshConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
      connectionId: "ssh-1",
    });
    const other = new BearerConnectionTarget({
      ...BEARER_TARGET,
      environmentId: EnvironmentId.make("environment-2"),
      connectionId: "bearer-other",
    });
    const routes = [BEARER_TARGET, tailnet, learned, ssh, RELAY_TARGET];
    const document: ConnectionCatalogDocument = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [...routes, other],
      profiles: [BEARER_PROFILE],
      credentials: [BEARER_TARGET, tailnet, ssh, other].map(({ connectionId }) => ({
        connectionId,
        credential: BEARER_CREDENTIAL,
      })),
    };
    const paired = new BearerConnectionTarget({ ...BEARER_TARGET, connectionId: "bearer-new" });
    const fresh = new BearerConnectionCredential({ token: "fresh-token" });
    const registered = registerConnectionInCatalog(
      document,
      new BearerConnectionRegistration({
        target: paired,
        profile: new BearerConnectionProfile({
          ...BEARER_PROFILE,
          connectionId: paired.connectionId,
          httpBaseUrl: "https://new.example.test",
        }),
        credential: fresh,
      }),
      [paired, ...routes],
    );
    const removed = setRoutesInCatalog(registered, ENVIRONMENT_ID, routes);

    expect(
      new Map(removed.credentials.map((value) => [value.connectionId, value.credential])),
    ).toEqual(
      new Map([
        [BEARER_TARGET.connectionId, fresh],
        [tailnet.connectionId, fresh],
        [ssh.connectionId, BEARER_CREDENTIAL],
        [other.connectionId, BEARER_CREDENTIAL],
      ]),
    );
  });

  it("a login paired over HTTPS is not copied to a plain HTTP address", () => {
    const plainHttp = [
      ["bearer-lan", "192.168.1.10"],
      ["bearer-vpn", "100.64.1.2"],
    ] as const;
    const targets = [
      ...plainHttp.map(
        ([connectionId]) => new BearerConnectionTarget({ ...BEARER_TARGET, connectionId }),
      ),
      BEARER_TARGET,
    ];
    const fresh = new BearerConnectionCredential({ token: "fresh-token" });
    const document: ConnectionCatalogDocument = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets,
      profiles: [
        ...plainHttp.map(
          ([connectionId, host]) =>
            new BearerConnectionProfile({
              ...BEARER_PROFILE,
              connectionId,
              httpBaseUrl: `http://${host}:3773/`,
              wsBaseUrl: `ws://${host}:3773/`,
            }),
        ),
        BEARER_PROFILE,
      ],
      credentials: targets.map(({ connectionId }) => ({
        connectionId,
        credential: BEARER_CREDENTIAL,
      })),
    };
    const registered = registerConnectionInCatalog(
      document,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: fresh,
      }),
      document.targets,
    );

    expect(
      new Map(registered.credentials.map((value) => [value.connectionId, value.credential])),
    ).toEqual(
      new Map([
        ["bearer-lan", BEARER_CREDENTIAL],
        ["bearer-vpn", BEARER_CREDENTIAL],
        [BEARER_TARGET.connectionId, fresh],
      ]),
    );
  });

  it("editing a saved address does not copy its login to the other addresses", () => {
    const tailnet = new BearerConnectionTarget({
      ...BEARER_TARGET,
      connectionId: "bearer-tailnet",
    });
    const fresh = new BearerConnectionCredential({ token: "fresh-token" });
    const document: ConnectionCatalogDocument = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [BEARER_TARGET, tailnet],
      profiles: [BEARER_PROFILE],
      credentials: [
        { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
        { connectionId: tailnet.connectionId, credential: fresh },
      ],
    };
    const edited = registerConnectionInCatalog(
      document,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: new BearerConnectionProfile({ ...BEARER_PROFILE, label: "Edited" }),
        credential: BEARER_CREDENTIAL,
      }),
      document.targets,
    );

    expect(edited.credentials).toEqual(expect.arrayContaining([...document.credentials]));
  });

  it("keeps every route of an environment and drops only a removed route's records", () => {
    const withBearer = registerConnectionInCatalog(
      { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, remoteDpopTokens: [REMOTE_TOKEN] },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const withRelay = registerConnectionInCatalog(
      withBearer,
      new RelayConnectionRegistration({ target: RELAY_TARGET }),
      [BEARER_TARGET, RELAY_TARGET],
    );
    expect(catalogRoutes(withRelay, ENVIRONMENT_ID)).toEqual([BEARER_TARGET, RELAY_TARGET]);
    expect(withRelay.credentials).toHaveLength(1);

    const relayOnly = setRoutesInCatalog(withRelay, ENVIRONMENT_ID, [RELAY_TARGET]);
    expect(relayOnly.targets).toEqual([RELAY_TARGET]);
    expect(relayOnly.profiles).toEqual([]);
    expect(relayOnly.credentials).toEqual([]);
    expect(relayOnly.remoteDpopTokens).toEqual([REMOTE_TOKEN]);

    const bearerOnly = setRoutesInCatalog(withRelay, ENVIRONMENT_ID, [BEARER_TARGET]);
    expect(bearerOnly.credentials).toHaveLength(1);
    expect(bearerOnly.remoteDpopTokens).toEqual([]);
  });

  it("keeps an environment's position in the catalog when its routes change", () => {
    const other = new RelayConnectionTarget({
      environmentId: EnvironmentId.make("environment-2"),
      label: "Other",
    });
    const document = {
      ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
      targets: [RELAY_TARGET, other],
    };
    expect(
      setRoutesInCatalog(document, ENVIRONMENT_ID, [BEARER_TARGET, RELAY_TARGET]).targets,
    ).toEqual([BEARER_TARGET, RELAY_TARGET, other]);
  });
});
