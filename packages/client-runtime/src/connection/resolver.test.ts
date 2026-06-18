import { EnvironmentId, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { RelayEnvironmentConnectScope } from "@t3tools/contracts/relay";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";

import {
  ManagedRelayClient,
  ManagedRelayClientError,
  ManagedRelayRequestTimeoutError,
} from "../relay/managedRelay.ts";
import { ConnectionResolver } from "./resolver.ts";
import { connectionResolverLayer } from "./resolver.ts";
import {
  CloudSession,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "../platform/capabilities.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  ConnectionCredentialStore,
  ConnectionProfileStore,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
  providerKind: "cloudflare_tunnel" as const,
};
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
  return { target, profile };
}

function unsupported<A>(name: string): Effect.Effect<A> {
  return Effect.die(new Error(`Unexpected relay call: ${name}`));
}

function collectingTracer(spans: Array<string>): Tracer.Tracer {
  return Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        spans.push(span.name);
      };
      return span;
    },
  });
}

function relayClient(connectEnvironment: ManagedRelayClient["Service"]["connectEnvironment"]) {
  return ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: () => unsupported("listEnvironments"),
    listDevices: () => unsupported("listDevices"),
    createEnvironmentLinkChallenge: () => unsupported("createEnvironmentLinkChallenge"),
    linkEnvironment: () => unsupported("linkEnvironment"),
    unlinkEnvironment: () => unsupported("unlinkEnvironment"),
    getEnvironmentStatus: () => unsupported("getEnvironmentStatus"),
    connectEnvironment,
    registerDevice: () => unsupported("registerDevice"),
    unregisterDevice: () => unsupported("unregisterDevice"),
    registerLiveActivity: () => unsupported("registerLiveActivity"),
    resetTokenCache: Effect.void,
  });
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly connectEnvironment?: ManagedRelayClient["Service"]["connectEnvironment"];
  readonly authorizeBearer?: RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly prepareSsh?: SshEnvironmentGateway["Service"]["prepare"];
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.of({
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
        input.obtainBootstrap.pipe(
          Effect.as({
            environmentId: input.expectedEnvironmentId,
            label: "Authorized relay environment",
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "dpop-access-token",
            },
          }),
        )),
  });
  const ssh = SshEnvironmentGateway.of({
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

  const dependencies = Layer.mergeAll(
    Layer.succeed(ConnectionProfileStore, profileStore),
    Layer.succeed(ConnectionCredentialStore, credentialStore),
    Layer.succeed(CloudSession, CloudSession.of({ clerkToken: Effect.succeed("clerk-session") })),
    Layer.succeed(
      RelayDeviceIdentity,
      RelayDeviceIdentity.of({ deviceId: Effect.succeed(Option.some("device-1")) }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization, remote),
    Layer.succeed(SshEnvironmentGateway, ssh),
    Layer.succeed(
      ManagedRelayClient,
      relayClient(
        options?.connectEnvironment ??
          ((input) =>
            Effect.succeed({
              environmentId: input.environmentId,
              endpoint: ENDPOINT,
              credential: "relay-bootstrap",
              expiresAt: "2026-06-06T00:00:00.000Z",
            })),
      ),
    ),
  );

  return Effect.succeed(connectionResolverLayer.pipe(Layer.provide(dependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const brokerLayer = yield* makeDependencies();
      const broker = yield* ConnectionResolver.pipe(Effect.provide(brokerLayer));
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
        socketUrl: "ws://127.0.0.1:3777/ws",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("uses the registered bearer profile without re-reading the profile store", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<string>>([]);
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Saved",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Saved",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      const brokerLayer = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "secret-bearer" })]],
        authorizeBearer: (input) =>
          Ref.update(bearerInputs, (values) => [...values, input.bearerToken]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Saved",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(
        (yield* broker.prepare(catalogEntry(target, Option.some(profile)))).socketUrl,
      ).toContain("wsTicket=ticket");
      expect(yield* Ref.get(bearerInputs)).toEqual(["secret-bearer"]);
    }),
  );

  it.effect("brokers relay credentials with the current cloud session and device identity", () =>
    Effect.gen(function* () {
      const relayInputs = yield* Ref.make<
        ReadonlyArray<{
          readonly clerkToken: string;
          readonly scopes: ReadonlyArray<string>;
          readonly deviceId?: string;
        }>
      >([]);
      const bootstrapCredentials = yield* Ref.make<ReadonlyArray<string>>([]);
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies({
        connectEnvironment: (input) =>
          Ref.update(relayInputs, (values) => [
            ...values,
            {
              clerkToken: input.clerkToken,
              scopes: input.scopes,
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            },
          ]).pipe(
            Effect.as({
              environmentId: input.environmentId,
              endpoint: ENDPOINT,
              credential: "relay-bootstrap",
              expiresAt: "2026-06-06T00:00:00.000Z",
            }),
          ),
        authorizeDpop: (input) =>
          input.obtainBootstrap.pipe(
            Effect.tap((bootstrap) =>
              Ref.update(bootstrapCredentials, (values) => [...values, bootstrap.credential]),
            ),
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Cloud",
              httpBaseUrl: ENDPOINT.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=dpop",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "dpop-access-token",
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect((yield* broker.prepare(catalogEntry(target))).socketUrl).toContain("wsTicket=dpop");
      expect(yield* Ref.get(relayInputs)).toEqual([
        {
          clerkToken: "clerk-session",
          scopes: [RelayEnvironmentConnectScope],
          deviceId: "device-1",
        },
      ]);
      expect(yield* Ref.get(bootstrapCredentials)).toEqual(["relay-bootstrap"]);
    }),
  );

  it.effect("exports the complete relay authorization flow through the product tracer", () =>
    Effect.gen(function* () {
      const userSpans: Array<string> = [];
      const productSpans: Array<string> = [];
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies({
        authorizeDpop: (input) =>
          input.obtainBootstrap.pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Cloud",
              httpBaseUrl: ENDPOINT.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=dpop",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "dpop-access-token",
              },
            }),
            Effect.withSpan("test.remote.authorizeDpop"),
          ),
      });
      const broker = yield* ConnectionResolver.pipe(Effect.provide(brokerLayer));

      yield* broker
        .prepare(catalogEntry(target))
        .pipe(
          Effect.provideService(RelayClientTracer, Option.some(collectingTracer(productSpans))),
          Effect.withTracer(collectingTracer(userSpans)),
        );

      expect(productSpans).toContain("clientRuntime.connection.broker.relay");
      expect(productSpans).toContain("test.remote.authorizeDpop");
      expect(userSpans).toContain("clientRuntime.connection.broker.prepare");
      expect(userSpans).not.toContain("test.remote.authorizeDpop");
    }),
  );

  it.effect("delegates SSH launch to the platform gateway before remote authorization", () =>
    Effect.gen(function* () {
      const preparedTargets = yield* Ref.make<ReadonlyArray<DesktopSshEnvironmentTarget>>([]);
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
      const brokerLayer = yield* makeDependencies({
        prepareSsh: (input) =>
          Ref.update(preparedTargets, (values) => [...values, input.target]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(
        (yield* broker.prepare(catalogEntry(target, Option.some(profile)))).socketUrl,
      ).toContain("wsTicket=bearer");
      expect(yield* Ref.get(preparedTargets)).toEqual([SSH_TARGET]);
    }),
  );

  it.effect("classifies relay request timeouts as retryable connection failures", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies({
        connectEnvironment: () =>
          Effect.fail(
            new ManagedRelayClientError({
              message: "Relay timed out.",
              cause: new ManagedRelayRequestTimeoutError({
                message: "Relay timed out.",
              }),
            }),
          ),
      });
      const broker = yield* ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "timeout" });
    }),
  );
});
