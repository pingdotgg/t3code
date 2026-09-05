import { EnvironmentId, type DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
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

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
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

  const dependencies = Layer.mergeAll(
    Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
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
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
        scopes: [],
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(dependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const brokerLayer = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
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
          "ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("authorizes a desktop primary environment with its platform bearer token", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<{ token: string; method: string }>>([]);
      const brokerLayer = yield* makeDependencies({
        primaryBearerToken: "desktop-bearer",
        authorizeBearer: (input) =>
          Ref.update(bearerInputs, (values) => [
            ...values,
            { token: input.bearerToken, method: input.connectionMethod },
          ]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Primary",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "ws://127.0.0.1:3777/ws?wsTicket=desktop",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toMatchObject({
        socketUrl: "ws://127.0.0.1:3777/ws?wsTicket=desktop",
        httpAuthorization: { _tag: "Bearer", token: "desktop-bearer" },
        target,
      });
      expect(yield* Ref.get(bearerInputs)).toEqual([{ token: "desktop-bearer", method: "direct" }]);
    }),
  );

  it.effect("uses the registered bearer profile without re-reading the profile store", () =>
    Effect.gen(function* () {
      const bearerInputs = yield* Ref.make<ReadonlyArray<{ token: string; method: string }>>([]);
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
          Ref.update(bearerInputs, (values) => [
            ...values,
            { token: input.bearerToken, method: input.connectionMethod },
          ]).pipe(
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
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(
        (yield* broker.prepare(catalogEntry(target, Option.some(profile)))).socketUrl,
      ).toContain("wsTicket=ticket");
      expect(yield* Ref.get(bearerInputs)).toEqual([{ token: "secret-bearer", method: "direct" }]);
    }),
  );

  it.effect("prepares relay connections with the authorized endpoint and credentials", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const brokerLayer = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Authorized relay environment",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
        httpAuthorization: {
          _tag: "Dpop",
          accessToken: "dpop-access-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        },
        target,
      });
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
          Effect.succeed({
            environmentId: input.expectedEnvironmentId,
            label: "Cloud",
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            socketUrl: "wss://environment.example.test/ws?wsTicket=dpop",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "dpop-access-token",
              expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            },
          }).pipe(Effect.withSpan("test.remote.authorizeDpop")),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

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
      const connectionMethods = yield* Ref.make<ReadonlyArray<string>>([]);
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
        authorizeBearer: (input) =>
          Ref.update(connectionMethods, (methods) => [...methods, input.connectionMethod]).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "SSH",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=bearer",
              httpAuthorization: {
                _tag: "Bearer" as const,
                token: input.bearerToken,
              },
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));

      expect(
        (yield* broker.prepare(catalogEntry(target, Option.some(profile)))).socketUrl,
      ).toContain("wsTicket=bearer");
      expect(yield* Ref.get(preparedTargets)).toEqual([SSH_TARGET]);
      expect(yield* Ref.get(connectionMethods)).toEqual(["ssh"]);
    }),
  );

  it.effect("preserves relay authorization failure classification and trace details", () =>
    Effect.gen(function* () {
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Cloud",
      });
      const authorizationError = new ConnectionTransientError({
        reason: "timeout",
        detail: "Relay environment connection timed out.",
        traceId: "relay-trace",
      });
      const brokerLayer = yield* makeDependencies({
        authorizeDpop: () => Effect.fail(authorizationError),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(brokerLayer));
      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toBe(authorizationError);
    }),
  );
});
