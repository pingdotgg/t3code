import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
  TailnetConnectionCredential,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  PullRequestRoutingPermissions,
  pullRequestRoutingConnectionKey,
  makePullRequestRoutingPermissions,
} from "./pullRequestRoutingPermissions.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const TAILNET_SESSION = new TailnetConnectionCredential({
  signInBaseUrl: "http://100.88.1.2:3773/",
  accessToken: "tailnet-access-token",
  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  dpopThumbprint: "thumbprint-1",
});

function bearerRoute(
  connectionId: string,
  httpBaseUrl: string,
  extra: Partial<Pick<BearerConnectionProfile, "learned" | "authorization" | "network">> = {},
) {
  const target = new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Studio",
    connectionId,
  });
  const profile = new BearerConnectionProfile({
    connectionId,
    environmentId: ENVIRONMENT_ID,
    label: "Studio",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    ...extra,
  });
  return { target, profile, entry: catalogEntry(target, Option.some(profile)) };
}

const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile, enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly profileStore?: ConnectionProfileStore.ConnectionProfileStore["Service"];
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly signInTailnet?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["signInTailnet"];
  readonly authorizeTailnet?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeTailnet"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
  readonly descriptorProtocolVersion?: number | null | undefined;
  readonly tailnetSignIn?: boolean;
  readonly surface?: "web" | "desktop" | "mobile";
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeDpop:
      options?.authorizeDpop ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized relay environment",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: "dpop-access-token",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        })),
    authorizeDpopHttp: () => Effect.die("unused"),
    renewDpopBeforeExpiry: () => Effect.die("unused"),
    signInTailnet: options?.signInTailnet ?? (() => Effect.die("unused")),
    authorizeTailnet: options?.authorizeTailnet ?? (() => Effect.die("unused")),
    authorizeTailnetHttp: () => Effect.die("unused"),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare:
      options?.prepareSsh ??
      (() =>
        Effect.succeed({
          bootstrap: {
            target: SSH_TARGET,
            httpBaseUrl: "http://127.0.0.1:4010",
            wsBaseUrl: "ws://127.0.0.1:4010",
            pairingToken: null,
          },
          bearerToken: "ssh-bearer",
        })),
    disconnect: () => Effect.void,
  });

  const layerDependencies = Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient((() =>
      Promise.resolve(
        Response.json({
          environmentId: ENVIRONMENT_ID,
          label: "Compatible environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          ...(options?.descriptorProtocolVersion === undefined
            ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
            : options.descriptorProtocolVersion === null
              ? {}
              : { orchestrationProtocolVersion: options.descriptorProtocolVersion }),
          capabilities: {
            repositoryIdentity: true,
            ...(options?.tailnetSignIn === true ? { tailnetSignIn: true } : {}),
          },
        }),
      )) satisfies typeof fetch),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      options?.profileStore ?? profileStore,
    ),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: {
          label: "Test Client",
          deviceType: "desktop",
          surface: options?.surface ?? "web",
        },
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  // Merged so a test can read back what the resolver stored.
  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provideMerge(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("blocks an old host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ descriptorProtocolVersion: null });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("Update T3 Code on Compatible environment");
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl:
          "ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("offers the saved SSH token on each connect and saves the one it gets back", () =>
    Effect.gen(function* () {
      const offeredTokens = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["ssh-1", new BearerConnectionCredential({ token: "revoked-token" })]],
        // The host accepts only the token it paired last; anything else pairs again.
        prepareSsh: (input) =>
          Ref.update(offeredTokens, (tokens) => [...tokens, input.bearerToken]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "paired-token",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* broker.prepare(entry);
      const second = yield* broker.prepare(entry);

      expect(yield* Ref.get(offeredTokens)).toEqual(["revoked-token", "paired-token"]);
      expect(first.httpAuthorization).toMatchObject({ token: "paired-token" });
      expect(second.httpAuthorization).toMatchObject({ token: "paired-token" });
    }),
  );

  it.effect.each(["unchanged", "changed", "revocation-failed"] as const)(
    "handles %s SSH routing consent before saving or authorizing",
    (scenario) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const entry = catalogEntry(target, Option.some(profile));
        const preparedTarget =
          scenario === "unchanged"
            ? SSH_TARGET
            : { ...SSH_TARGET, hostname: "replacement.example.test" };
        const failure = new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not persist routing consent.",
        });
        const permissions = yield* makePullRequestRoutingPermissions({
          read: Effect.succeed([
            {
              environmentId: ENVIRONMENT_ID,
              connectionKey: pullRequestRoutingConnectionKey(entry)!,
              permission: "read-write",
            },
          ]),
          write: () =>
            Effect.sync(() => {
              calls.push("revoke");
            }).pipe(
              Effect.andThen(scenario === "revocation-failed" ? Effect.fail(failure) : Effect.void),
            ),
        });
        let savedProfile: ConnectionProfile = profile;
        const layerBroker = yield* makeDependencies({
          profileStore: {
            get: () => Effect.sync(() => Option.some(savedProfile)),
            put: (value) =>
              Effect.sync(() => {
                calls.push("profile");
                savedProfile = value;
              }),
            remove: () => Effect.die("unused"),
          },
          prepareSsh: () =>
            Effect.succeed({
              bootstrap: {
                target: preparedTarget,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          authorizeBearer: (input) =>
            Effect.sync(() => {
              calls.push("authorize");
              return {
                environmentId: input.expectedEnvironmentId,
                label: "SSH",
                httpBaseUrl: input.httpBaseUrl,
                socketUrl: "ws://127.0.0.1:4010/ws?wsTicket=ssh",
                httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
              };
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const prepare = broker
          .prepare(entry)
          .pipe(Effect.provideService(PullRequestRoutingPermissions, permissions));
        if (scenario === "revocation-failed") {
          expect(yield* Effect.flip(prepare)).toBe(failure);
          expect(savedProfile).toBe(profile);
          expect(calls).toEqual(["revoke"]);
        } else {
          expect((yield* prepare).socketUrl).toContain("wsTicket=ssh");
          expect(savedProfile).toMatchObject({ target: preparedTarget });
          expect(calls).toEqual(
            scenario === "unchanged"
              ? ["profile", "authorize"]
              : ["revoke", "profile", "authorize"],
          );
        }
        expect(yield* permissions.get(entry)).toBe(scenario === "changed" ? "off" : "read-write");
      }),
  );
  it.effect("uses a Tailscale session only on the host's Tailscale routes", () =>
    Effect.gen(function* () {
      const authorized = yield* Ref.make<ReadonlyArray<string>>([]);
      const layerBroker = yield* makeDependencies({
        credentials: [["pinned", TAILNET_SESSION]],
        surface: "mobile",
        authorizeTailnet: (input) =>
          Ref.update(authorized, (current) => [...current, input.endpoint.httpBaseUrl]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Studio",
              httpBaseUrl: input.endpoint.httpBaseUrl,
              socketUrl: "ws://studio/ws",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: TAILNET_SESSION.accessToken,
                expiresAtEpochMs: TAILNET_SESSION.expiresAtEpochMs,
                tailnetCredentialId: input.credentialId,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const lan = bearerRoute(
        `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@pinned`,
        "http://192.168.1.10:3773/",
        { learned: true, authorization: "tailnet" },
      );
      const serve = bearerRoute(
        `learned:${ENVIRONMENT_ID}:https://studio.tail1234.ts.net@pinned`,
        "https://studio.tail1234.ts.net/",
        { learned: true, authorization: "tailnet", network: "tailscale" },
      );

      expect(yield* Effect.flip(broker.prepare(lan.entry))).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
      });
      const prepared = yield* broker.prepare(serve.entry);

      expect(prepared.httpAuthorization).toMatchObject({ tailnetCredentialId: "pinned" });
      expect(yield* Ref.get(authorized)).toEqual(["https://studio.tail1234.ts.net/"]);
    }),
  );

  it.effect("switches a paired tailnet route to Tailscale sign-in when its session ends", () =>
    Effect.gen(function* () {
      const ended = new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment credential is invalid.",
        hop: "server",
      });
      const paired = bearerRoute("paired", "http://100.88.1.2:3773/");
      const ticketRequests = yield* Ref.make(0);
      const profileWriteFailed = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "Could not save the connection profile.",
      });
      const profileWrites = yield* Ref.make(0);
      const savedProfiles = new Map<string, ConnectionProfile>();
      const dependencies = (surface: "web" | "mobile") =>
        makeDependencies({
          credentials: [["paired", new BearerConnectionCredential({ token: "expired" })]],
          profileStore: {
            get: (connectionId) =>
              Effect.sync(() => Option.fromNullishOr(savedProfiles.get(connectionId))),
            put: (profile) =>
              Ref.updateAndGet(profileWrites, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Effect.fail(profileWriteFailed)
                    : Effect.sync(() => void savedProfiles.set(profile.connectionId, profile)),
                ),
              ),
            remove: () => Effect.die("unused"),
          },
          surface,
          tailnetSignIn: true,
          authorizeBearer: () => Effect.fail(ended),
          signInTailnet: () => Effect.succeed(TAILNET_SESSION),
          authorizeTailnet: (input) =>
            Ref.updateAndGet(ticketRequests, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.fail(
                      new ConnectionTransientError({
                        reason: "network",
                        detail: "The ticket request failed.",
                      }),
                    )
                  : Effect.succeed({
                      environmentId: input.expectedEnvironmentId,
                      label: "Studio",
                      httpBaseUrl: input.endpoint.httpBaseUrl,
                      socketUrl: "ws://100.88.1.2:3773/ws",
                      httpAuthorization: {
                        _tag: "Dpop" as const,
                        accessToken: TAILNET_SESSION.accessToken,
                        expiresAtEpochMs: TAILNET_SESSION.expiresAtEpochMs,
                        tailnetCredentialId: input.credentialId,
                      },
                    }),
              ),
            ),
        });

      // Browsers cannot sign in through Tailscale, so the old session's error stands.
      const web = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(yield* dependencies("web")),
      );
      expect(yield* Effect.flip(web.prepare(paired.entry))).toBe(ended);

      const layerMobile = yield* dependencies("mobile");
      const { prepared, profile, credential } = yield* Effect.gen(function* () {
        const broker = yield* ConnectionResolver.ConnectionResolver;
        // A failed profile write keeps the old session, so the retry signs in again.
        expect(yield* Effect.flip(broker.prepare(paired.entry))).toBe(profileWriteFailed);
        // The first connect after sign-in fails, and the retry still holds the old profile.
        expect(yield* Effect.flip(broker.prepare(paired.entry))).toMatchObject({
          _tag: "ConnectionTransientError",
        });
        const prepared = yield* broker.prepare(paired.entry);
        const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
        const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
        return {
          prepared,
          profile: yield* profiles.get("paired"),
          credential: yield* credentials.get("paired"),
        };
      }).pipe(Effect.provide(layerMobile));

      expect(prepared.httpAuthorization).toMatchObject({ tailnetCredentialId: "paired" });
      expect(Option.getOrThrow(credential)).toBe(TAILNET_SESSION);
      expect(Option.getOrThrow(profile)).toMatchObject({
        httpBaseUrl: "http://100.88.1.2:3773/",
        authorization: "tailnet",
        network: "tailscale",
      });
    }),
  );

  it.effect("switches a Serve pairing to Tailscale sign-in at its direct Tailscale route", () =>
    Effect.gen(function* () {
      const ended = new ConnectionBlockedError({
        reason: "authentication",
        detail: "The environment credential is invalid.",
        hop: "server",
      });
      const signIns = yield* Ref.make<ReadonlyArray<string>>([]);
      const authorized = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([]);
      const serve = bearerRoute("serve", "https://studio.tail1234.ts.net/");
      const direct = bearerRoute(
        `learned:${ENVIRONMENT_ID}:http://100.88.1.2:3773@serve`,
        "http://100.88.1.2:3773/",
        { learned: true, network: "tailscale" },
      );
      const lan = bearerRoute(
        `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@serve`,
        "http://192.168.1.10:3773/",
        { learned: true },
      );
      const layer = yield* makeDependencies({
        credentials: [["serve", new BearerConnectionCredential({ token: "expired" })]],
        surface: "mobile",
        tailnetSignIn: true,
        authorizeBearer: () => Effect.fail(ended),
        signInTailnet: (input) =>
          Ref.update(signIns, (urls) => [...urls, input.httpBaseUrl]).pipe(
            Effect.as(TAILNET_SESSION),
          ),
        authorizeTailnet: (input) =>
          Ref.update(authorized, (calls) => [
            ...calls,
            [input.credentialId, input.endpoint.httpBaseUrl] as const,
          ]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Studio",
              httpBaseUrl: input.endpoint.httpBaseUrl,
              socketUrl: "ws://studio/ws",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: TAILNET_SESSION.accessToken,
                expiresAtEpochMs: TAILNET_SESSION.expiresAtEpochMs,
                tailnetCredentialId: input.credentialId,
              },
            }),
          ),
      });

      const credential = yield* Effect.gen(function* () {
        const broker = yield* ConnectionResolver.ConnectionResolver;
        // Serve and LAN routes hide who the device is, so neither signs in.
        expect(yield* Effect.flip(broker.prepare(serve.entry))).toBe(ended);
        expect(yield* Effect.flip(broker.prepare(lan.entry))).toBe(ended);
        yield* broker.prepare(direct.entry);
        yield* broker.prepare(serve.entry);
        const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
        return yield* credentials.get("serve");
      }).pipe(Effect.provide(layer));

      expect(yield* Ref.get(signIns)).toEqual(["http://100.88.1.2:3773/"]);
      expect(Option.getOrThrow(credential)).toBe(TAILNET_SESSION);
      expect(yield* Ref.get(authorized)).toEqual([
        ["serve", "http://100.88.1.2:3773/"],
        ["serve", "https://studio.tail1234.ts.net/"],
      ]);
    }),
  );
});
