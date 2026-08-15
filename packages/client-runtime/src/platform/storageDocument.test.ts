import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

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
  RelayConnectionTarget,
  SshConnectionTarget,
} from "../connection/model.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  activateConnectionInCatalog,
  registerConnectionInCatalog,
  replaceEnvironmentConnectionInCatalog,
  removeConnectionFromCatalog,
} from "./storageDocument.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

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
  it("registers a bearer connection as one catalog mutation", () => {
    const document = registerConnectionInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );

    expect(document.targets).toEqual([BEARER_TARGET]);
    expect(document.profiles).toEqual([BEARER_PROFILE]);
    expect(document.credentials).toEqual([
      {
        connectionId: BEARER_TARGET.connectionId,
        credential: BEARER_CREDENTIAL,
      },
    ]);
  });

  it("retains multiple bearer routes to the same environment", () => {
    const secondTarget = new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote on office Wi-Fi",
      connectionId: "bearer-2",
    });
    const secondProfile = new BearerConnectionProfile({
      connectionId: secondTarget.connectionId,
      environmentId: ENVIRONMENT_ID,
      label: secondTarget.label,
      httpBaseUrl: "http://192.168.50.10:3773",
      wsBaseUrl: "ws://192.168.50.10:3773",
    });
    const secondCredential = new BearerConnectionCredential({ token: "bearer-token-2" });
    const first = registerConnectionInCatalog(
      { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, remoteDpopTokens: [REMOTE_TOKEN] },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const both = registerConnectionInCatalog(
      first,
      new BearerConnectionRegistration({
        target: secondTarget,
        profile: secondProfile,
        credential: secondCredential,
      }),
    );

    expect(both.targets).toEqual([BEARER_TARGET, secondTarget]);
    expect(both.profiles).toEqual([BEARER_PROFILE, secondProfile]);
    expect(both.credentials).toEqual([
      { connectionId: BEARER_TARGET.connectionId, credential: BEARER_CREDENTIAL },
      { connectionId: secondTarget.connectionId, credential: secondCredential },
    ]);

    const firstActive = activateConnectionInCatalog(both, BEARER_TARGET);
    expect(firstActive.targets).toEqual([secondTarget, BEARER_TARGET]);

    const remaining = removeConnectionFromCatalog(firstActive, BEARER_TARGET);
    expect(remaining.targets).toEqual([secondTarget]);
    expect(remaining.profiles).toEqual([secondProfile]);
    expect(remaining.credentials).toEqual([
      { connectionId: secondTarget.connectionId, credential: secondCredential },
    ]);
    expect(remaining.remoteDpopTokens).toEqual([REMOTE_TOKEN]);

    expect(removeConnectionFromCatalog(remaining, secondTarget)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("supports clients that retain one route per environment", () => {
    const replacementTarget = new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote on another network",
      connectionId: "bearer-replacement",
    });
    const replacementProfile = new BearerConnectionProfile({
      connectionId: replacementTarget.connectionId,
      environmentId: ENVIRONMENT_ID,
      label: replacementTarget.label,
      httpBaseUrl: "http://192.168.50.10:3773",
      wsBaseUrl: "ws://192.168.50.10:3773",
    });
    const first = registerConnectionInCatalog(
      { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, remoteDpopTokens: [REMOTE_TOKEN] },
      new BearerConnectionRegistration({
        target: BEARER_TARGET,
        profile: BEARER_PROFILE,
        credential: BEARER_CREDENTIAL,
      }),
    );
    const replaced = replaceEnvironmentConnectionInCatalog(
      first,
      new BearerConnectionRegistration({
        target: replacementTarget,
        profile: replacementProfile,
        credential: new BearerConnectionCredential({ token: "replacement-token" }),
      }),
    );

    expect(replaced.targets).toEqual([replacementTarget]);
    expect(replaced.profiles).toEqual([replacementProfile]);
    expect(replaced.credentials).toHaveLength(1);
    expect(replaced.remoteDpopTokens).toEqual([REMOTE_TOKEN]);
  });

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

    expect(removeConnectionFromCatalog(registered, BEARER_TARGET)).toEqual(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
  });

  it("persists the normalized SSH profile beside its target", () => {
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
      new SshConnectionRegistration({ target, profile }),
    );

    expect(document.targets).toEqual([target]);
    expect(document.profiles).toEqual([profile]);
    expect(document.credentials).toEqual([]);
  });
});
