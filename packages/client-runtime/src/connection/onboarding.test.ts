import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionProfile,
  type ConnectionRegistration,
  PrimaryConnectionRegistration,
} from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  PrimaryConnectionTarget,
} from "./model.ts";
import * as Onboarding from "./onboarding.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly failExchange?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly exchangeGate?: { readonly reached: () => void; readonly release: Promise<void> };
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/t3/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      if (options?.failExchange === true) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-pairing-test",
            },
            { status: 401 },
          ),
        );
      }
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const requestedScope = new URLSearchParams(body).get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      const granted = Response.json({
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: sessionScopes.join(" "),
      });
      const gate = options?.exchangeGate;
      if (gate === undefined) return Promise.resolve(granted);
      gate.reached();
      return gate.release.then(() => granted);
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

function layerPairingOnboarding(
  options?: Parameters<typeof layerPairingHttp>[1],
  calls: Array<{ readonly url: string; readonly init: RequestInit }> = [],
  saved?: {
    readonly targets: ReadonlyArray<BearerConnectionTarget>;
    readonly profiles: ReadonlyArray<BearerConnectionProfile>;
    readonly credentials: ReadonlyMap<string, BearerConnectionCredential>;
    readonly registered: Array<ConnectionRegistration>;
    readonly savedProfiles?: Array<ConnectionProfile>;
  },
) {
  const dependencies = Layer.mergeAll(
    layerClientPresentation,
    layerPairingHttp(calls, options),
    Layer.mock(Persistence.ConnectionTargetStore)({
      list: Effect.succeed(saved?.targets ?? []),
      listDisabled: Effect.succeed([]),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      register: (registration) => Effect.sync(() => saved?.registered.push(registration)),
      setEnabled: () => Effect.void,
    }),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({
      put: (profile) => Effect.sync(() => saved?.savedProfiles?.push(profile)),
      get: (connectionId) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            saved?.profiles.find((profile) => profile.connectionId === connectionId),
          ),
        ),
    }),
    Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({
      get: (connectionId) =>
        Effect.succeed(Option.fromUndefinedOr(saved?.credentials.get(connectionId))),
      put: () => Effect.void,
    }),
    Layer.mock(ClientCapabilities.SshEnvironmentGateway)({}),
    Layer.succeed(
      Connectivity.Connectivity,
      Connectivity.Connectivity.of({ status: Effect.succeed("online"), changes: Stream.never }),
    ),
    Layer.mock(ConnectionDriver.ConnectionDriver)({ connect: () => Effect.never }),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
    ),
  );
  return Onboarding.layer.pipe(
    Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
  );
}

const PAIRED_ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const PAIRING_INPUT = { host: "remote.example.test", pairingCode: "pairing-token" };
const PAIRED_PROFILE = new BearerConnectionProfile({
  connectionId: "bearer:environment-paired:https://remote.example.test",
  environmentId: PAIRED_ENVIRONMENT_ID,
  label: "Paired environment",
  httpBaseUrl: "https://remote.example.test/",
  wsBaseUrl: "wss://remote.example.test/",
});
const UNSUPPORTED_ERROR = new ConnectionBlockedError({
  reason: "unsupported",
  detail: "The saved server used an incompatible orchestration protocol.",
});

const registerSwitchedOffEnvironment = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const registration = new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: PAIRED_ENVIRONMENT_ID,
      connectionId: PAIRED_PROFILE.connectionId,
      label: "Old label",
    }),
    profile: new BearerConnectionProfile({ ...PAIRED_PROFILE, label: "Old label" }),
    credential: new BearerConnectionCredential({ token: "old-token" }),
  });
  yield* registry.register(registration);
  yield* registry.setEnabled(PAIRED_ENVIRONMENT_ID, false);
  yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
  const entries = yield* SubscriptionRef.get(registry.entries);
  expect(entries.get(PAIRED_ENVIRONMENT_ID)).toEqual({
    target: registration.target,
    profile: Option.some(registration.profile),
    enabled: false,
    unsupportedReason: UNSUPPORTED_ERROR.message,
  });
  return entries;
});

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  it.effect("turns a switched-off environment back on when it is paired again", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      const entries = yield* SubscriptionRef.get(registry.entries);
      const entry = entries.get(environmentId);
      expect(entries.size).toBe(1);
      expect(entry?.enabled).toBe(true);
      expect(entry?.unsupportedReason).toBeUndefined();
      expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      expect(entry?.target).toEqual(
        new BearerConnectionTarget({
          environmentId,
          connectionId: PAIRED_PROFILE.connectionId,
          label: PAIRED_PROFILE.label,
        }),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("refuses a pairing link that claims a saved environment from a new address", () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      expect(calls.map((call) => call.url)).toEqual([
        "https://attacker.example.test/.well-known/t3/environment",
      ]);
    }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)));
  });

  it.effect("refuses a new address when the environment is saved during the exchange", () => {
    let reached!: () => void;
    let release!: () => void;
    const exchangeReached = new Promise<void>((resolve) => (reached = resolve));
    const exchangeGate = {
      reached: () => reached(),
      release: new Promise<void>((resolve) => (release = resolve)),
    };
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const pairing = yield* onboarding
        .registerPairing({ host: "attacker.example.test", pairingCode: "pairing-token" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => exchangeReached);
      const before = yield* registerSwitchedOffEnvironment;
      release();

      const outcome = yield* Fiber.join(pairing);

      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConnectionBlockedError", reason: "configuration" },
      });
      expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
    }).pipe(Effect.provide(layerPairingOnboarding({ exchangeGate })));
  });

  it.effect("adds a new address as a route when pairing targets that environment", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* registerSwitchedOffEnvironment;

      yield* onboarding.registerPairing({
        host: "lan.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: PAIRED_ENVIRONMENT_ID,
      });

      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      expect(entry === undefined ? [] : connectionRoutes(entry).map(routeHttpBaseUrl)).toEqual(
        expect.arrayContaining(["https://remote.example.test/", "https://lan.example.test/"]),
      );
    }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect(
    "re-pairs an outdated self-updatable environment so its connection can be rechecked",
    () =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registerSwitchedOffEnvironment;
        yield* registry.setCompatibility(
          PAIRED_ENVIRONMENT_ID,
          new ConnectionBlockedError({
            reason: "unsupported",
            detail: "The saved server needs an update.",
            serverUpdateRequired: true,
          }),
        );
        expect(
          (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID),
        ).toMatchObject({
          enabled: false,
          serverUpdateRequired: true,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
        expect(entry?.enabled).toBe(true);
        expect(entry?.unsupportedReason).toBeUndefined();
        expect(entry?.serverUpdateRequired).toBeUndefined();
        expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({
            protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
            selfUpdate: true,
          }),
        ),
      ),
  );

  it.effect.each([
    {
      kind: "primary",
      registration: new PrimaryConnectionRegistration({
        target: new PrimaryConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Host environment",
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
        }),
      }),
    },
    {
      kind: "bearer",
      registration: new BearerConnectionRegistration({
        target: new BearerConnectionTarget({
          environmentId: PAIRED_ENVIRONMENT_ID,
          connectionId: "platform:wsl",
          label: "WSL",
        }),
        profile: new BearerConnectionProfile({
          ...PAIRED_PROFILE,
          connectionId: "platform:wsl",
          label: "WSL",
          httpBaseUrl: "http://127.0.0.1:4000",
          wsBaseUrl: "ws://127.0.0.1:4000",
        }),
        credential: new BearerConnectionCredential({ token: "platform-token" }),
      }),
    },
  ] as const)(
    "leaves a platform-managed $kind environment untouched when its id is paired",
    ({ registration }) =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        yield* registry.reconcilePlatform([registration]);
        yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
        const before = yield* SubscriptionRef.get(registry.entries);
        expect(before.get(PAIRED_ENVIRONMENT_ID)).toMatchObject({
          enabled: true,
          unsupportedReason: UNSUPPORTED_ERROR.message,
        });

        const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

        expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
        expect(yield* SubscriptionRef.get(registry.entries)).toEqual(before);
      }).pipe(Effect.provide(layerPairingOnboarding())),
  );

  it.effect("leaves a switched-off environment unchanged when the pairing exchange fails", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = yield* registerSwitchedOffEnvironment;

      const error = yield* onboarding.registerPairing(PAIRING_INPUT).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "authentication",
        traceId: "trace-pairing-test",
      });
      const after = yield* SubscriptionRef.get(registry.entries);
      expect(after).toEqual(before);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.enabled).toBe(false);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.unsupportedReason).toBe(UNSUPPORTED_ERROR.message);
    }).pipe(Effect.provide(layerPairingOnboarding({ failExchange: true }))),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );
  it.effect.each([
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "default", scopes: AuthStandardClientScopes },
  ] as const)("preserves the $label grant when pairing a remote environment", ({ scopes }) =>
    Effect.gen(function* () {
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      });

      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: registration.profile.httpBaseUrl,
        bearerToken: registration.credential.token,
      });

      expect(session.authenticated).toBe(true);
      expect(session.scopes).toEqual(scopes);
    }).pipe(Effect.provide(layerPairingOnboarding({ grantScopes: scopes }))),
  );

  it.effect("refuses to add a route that reaches a different machine, keeping the code", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
      }).pipe(Effect.provide(layerPairingOnboarding(undefined, calls)), Effect.flip);
      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("different machine");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          layerPairingOnboarding({ protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }, calls),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(layerPairingOnboarding({ failDescriptor: true }, calls)), Effect.flip);

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );

  it.effect("edits the paired address, not one the server reported, with the paired token", () => {
    const pairedTarget = new BearerConnectionTarget({
      environmentId: PAIRED_ENVIRONMENT_ID,
      connectionId: PAIRED_PROFILE.connectionId,
      label: PAIRED_PROFILE.label,
    });
    const learnedId = `learned:${PAIRED_ENVIRONMENT_ID}:http://100.101.102.103:3773@${PAIRED_PROFILE.connectionId}`;
    const learnedTarget = new BearerConnectionTarget({ ...pairedTarget, connectionId: learnedId });
    const learnedProfile = new BearerConnectionProfile({
      connectionId: learnedId,
      environmentId: PAIRED_ENVIRONMENT_ID,
      label: PAIRED_PROFILE.label,
      httpBaseUrl: "http://100.101.102.103:3773/",
      wsBaseUrl: "ws://100.101.102.103:3773/",
      learned: true,
      network: "tailscale",
    });
    const registered: Array<ConnectionRegistration> = [];
    const savedProfiles: Array<ConnectionProfile> = [];
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      const before = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      // The reported address sorts ahead of the paired one.
      expect(before?.target).toEqual(learnedTarget);

      yield* onboarding.updateBearer({
        environmentId: PAIRED_ENVIRONMENT_ID,
        label: "Renamed environment",
        httpBaseUrl: "https://renamed.example.test",
      });

      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      const routes = entry === undefined ? [] : connectionRoutes(entry);
      expect(routes.map((route) => route.target)).toEqual([
        new BearerConnectionTarget({ ...learnedTarget, label: "Renamed environment" }),
        new BearerConnectionTarget({ ...pairedTarget, label: "Renamed environment" }),
      ]);
      // The environment shows its first route's name, which is the learned one.
      expect(entry?.target.label).toBe("Renamed environment");
      expect(routes[1]?.profile).toEqual(
        Option.some(
          new BearerConnectionProfile({
            ...PAIRED_PROFILE,
            label: "Renamed environment",
            httpBaseUrl: "https://renamed.example.test/",
            wsBaseUrl: "wss://renamed.example.test/",
          }),
        ),
      );
      expect(registered).toMatchObject([
        {
          target: { connectionId: PAIRED_PROFILE.connectionId },
          credential: { token: "paired-token" },
        },
      ]);
      // Persisted routes carry targets only, so the relabeled learned profile is saved separately.
      expect(savedProfiles).toEqual([
        new BearerConnectionProfile({ ...learnedProfile, label: "Renamed environment" }),
      ]);
    }).pipe(
      Effect.provide(
        layerPairingOnboarding(undefined, [], {
          targets: [learnedTarget, pairedTarget],
          profiles: [learnedProfile, PAIRED_PROFILE],
          credentials: new Map([
            [
              PAIRED_PROFILE.connectionId,
              new BearerConnectionCredential({ token: "paired-token" }),
            ],
          ]),
          registered,
          savedProfiles,
        }),
      ),
    );
  });

  it.effect(
    "keeps the paired address when a label edit submits the learned address unchanged",
    () => {
      const pairedTarget = new BearerConnectionTarget({
        environmentId: PAIRED_ENVIRONMENT_ID,
        connectionId: PAIRED_PROFILE.connectionId,
        label: PAIRED_PROFILE.label,
      });
      const learnedId = `learned:${PAIRED_ENVIRONMENT_ID}:http://192.168.1.10:3773@${PAIRED_PROFILE.connectionId}`;
      const learnedProfile = new BearerConnectionProfile({
        connectionId: learnedId,
        environmentId: PAIRED_ENVIRONMENT_ID,
        label: PAIRED_PROFILE.label,
        httpBaseUrl: "http://192.168.1.10:3773/",
        wsBaseUrl: "ws://192.168.1.10:3773/",
        learned: true,
      });
      return Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* Onboarding.ConnectionOnboarding;
        // The form pre-fills the address in use, which is the learned one.
        yield* onboarding.updateBearer({
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: "Renamed environment",
          httpBaseUrl: "http://192.168.1.10:3773",
        });

        const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
        const paired = (entry === undefined ? [] : connectionRoutes(entry)).find(
          (route) => connectionRouteId(route.target) === PAIRED_PROFILE.connectionId,
        );
        expect(Option.getOrNull(paired?.profile ?? Option.none())).toMatchObject({
          label: "Renamed environment",
          httpBaseUrl: PAIRED_PROFILE.httpBaseUrl,
        });
      }).pipe(
        Effect.provide(
          layerPairingOnboarding(undefined, [], {
            targets: [
              new BearerConnectionTarget({ ...pairedTarget, connectionId: learnedId }),
              pairedTarget,
            ],
            profiles: [learnedProfile, PAIRED_PROFILE],
            credentials: new Map([
              [
                PAIRED_PROFILE.connectionId,
                new BearerConnectionCredential({ token: "paired-token" }),
              ],
            ]),
            registered: [],
            savedProfiles: [],
          }),
        ),
      );
    },
  );

  it.effect("moves the paired address to a different learned address the user typed", () => {
    const pairedTarget = new BearerConnectionTarget({
      environmentId: PAIRED_ENVIRONMENT_ID,
      connectionId: PAIRED_PROFILE.connectionId,
      label: PAIRED_PROFILE.label,
    });
    const learnedRoute = (origin: string) => {
      const connectionId = `learned:${PAIRED_ENVIRONMENT_ID}:${origin}@${PAIRED_PROFILE.connectionId}`;
      return {
        target: new BearerConnectionTarget({ ...pairedTarget, connectionId }),
        profile: new BearerConnectionProfile({
          connectionId,
          environmentId: PAIRED_ENVIRONMENT_ID,
          label: PAIRED_PROFILE.label,
          httpBaseUrl: `${origin}/`,
          wsBaseUrl: `${origin.replace(/^http:/, "ws:")}/`,
          learned: true,
        }),
      };
    };
    const shown = learnedRoute("http://192.168.1.10:3773");
    const other = learnedRoute("http://10.0.0.5:3773");
    return Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* Onboarding.ConnectionOnboarding;
      yield* onboarding.updateBearer({
        environmentId: PAIRED_ENVIRONMENT_ID,
        label: PAIRED_PROFILE.label,
        httpBaseUrl: "http://10.0.0.5:3773",
      });

      const entry = (yield* SubscriptionRef.get(registry.entries)).get(PAIRED_ENVIRONMENT_ID);
      const paired = (entry === undefined ? [] : connectionRoutes(entry)).find(
        (route) => connectionRouteId(route.target) === PAIRED_PROFILE.connectionId,
      );
      expect(Option.getOrNull(paired?.profile ?? Option.none())).toMatchObject({
        httpBaseUrl: "http://10.0.0.5:3773/",
      });
    }).pipe(
      Effect.provide(
        layerPairingOnboarding(undefined, [], {
          targets: [shown.target, other.target, pairedTarget],
          profiles: [shown.profile, other.profile, PAIRED_PROFILE],
          credentials: new Map([
            [
              PAIRED_PROFILE.connectionId,
              new BearerConnectionCredential({ token: "paired-token" }),
            ],
          ]),
          registered: [],
          savedProfiles: [],
        }),
      ),
    );
  });

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
        // Saved so the first connect reuses this pairing instead of adding another.
        credential: { token: "bearer-token" },
      });
    }),
  );
});
