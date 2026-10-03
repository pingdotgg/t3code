import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
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
import {
  ConnectionOnboarding,
  layer as onboardingLayer,
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const CLIENT_PRESENTATION_LAYER = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
    scopes: AuthStandardClientScopes,
  }),
);

function pairingHttpLayer(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly failExchange?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
  },
) {
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
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return remoteHttpClientLayer(fetchFn);
}

function pairingOnboardingLayer(options?: Parameters<typeof pairingHttpLayer>[1]) {
  const dependencies = Layer.mergeAll(
    CLIENT_PRESENTATION_LAYER,
    pairingHttpLayer([], options),
    Layer.mock(Persistence.ConnectionTargetStore)({
      list: Effect.succeed([]),
      listDisabled: Effect.succeed([]),
    }),
    Layer.mock(Persistence.ConnectionRegistrationStore)({
      register: () => Effect.void,
      setEnabled: () => Effect.void,
    }),
    Layer.mock(Persistence.EnvironmentCacheStore)({}),
    Layer.mock(ConnectionProfileStore.ConnectionProfileStore)({}),
    Layer.mock(ConnectionCredentialStore.ConnectionCredentialStore)({}),
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
  return onboardingLayer.pipe(
    Layer.provideMerge(EnvironmentRegistry.layer.pipe(Layer.provideMerge(dependencies))),
  );
}

const PAIRED_ENVIRONMENT_ID = EnvironmentId.make("environment-paired");
const PAIRING_INPUT = { host: "remote.example.test", pairingCode: "pairing-token" };
const PAIRED_PROFILE = new BearerConnectionProfile({
  connectionId: "bearer:environment-paired",
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
    // Keep the endpoint unchanged: registration alone must retain the stale reason.
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
      }).pipe(Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired",
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
      expect(tokenParams.get("scope")).toBe(AuthStandardClientScopes.join(" "));
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
    }),
  );

  it.effect("turns a switched-off environment back on when it is paired again", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding;
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
    }).pipe(Effect.provide(pairingOnboardingLayer())),
  );

  it.effect(
    "re-pairs an outdated self-updatable environment so its connection can be rechecked",
    () =>
      Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const onboarding = yield* ConnectionOnboarding;
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
          pairingOnboardingLayer({
            protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
            selfUpdate: true,
          }),
        ),
      ),
  );

  it.effect("registers an enabled environment on first-time pairing", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding;
      expect((yield* SubscriptionRef.get(registry.entries)).size).toBe(0);

      const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      const entries = yield* SubscriptionRef.get(registry.entries);
      const entry = entries.get(environmentId);
      expect(entries.size).toBe(1);
      expect(entry?.enabled).toBe(true);
      expect(entry?.unsupportedReason).toBeUndefined();
      expect(entry?.profile).toEqual(Option.some(PAIRED_PROFILE));
    }).pipe(Effect.provide(pairingOnboardingLayer())),
  );

  it.effect("leaves a platform-managed environment untouched when its id is paired", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding;
      yield* registry.registerPlatform(
        new PrimaryConnectionRegistration({
          target: new PrimaryConnectionTarget({
            environmentId: PAIRED_ENVIRONMENT_ID,
            label: "Host environment",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
          }),
        }),
      );
      yield* registry.setCompatibility(PAIRED_ENVIRONMENT_ID, UNSUPPORTED_ERROR);
      const before = yield* SubscriptionRef.get(registry.entries);
      expect(before.get(PAIRED_ENVIRONMENT_ID)?.enabled).toBe(false);

      const environmentId = yield* onboarding.registerPairing(PAIRING_INPUT);

      expect(environmentId).toBe(PAIRED_ENVIRONMENT_ID);
      const after = yield* SubscriptionRef.get(registry.entries);
      expect(after).toEqual(before);
      expect(after.get(PAIRED_ENVIRONMENT_ID)?.unsupportedReason).toBe(UNSUPPORTED_ERROR.message);
    }).pipe(Effect.provide(pairingOnboardingLayer())),
  );

  it.effect("leaves a switched-off environment unchanged when the pairing exchange fails", () =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const onboarding = yield* ConnectionOnboarding;
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
    }).pipe(Effect.provide(pairingOnboardingLayer({ failExchange: true }))),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("pairs an outdated server so it can be updated from this client", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, {
              protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
              selfUpdate: true,
            }),
          ),
        ),
      );
      expect(registration.target.environmentId).toBe("environment-paired");
      expect(calls.map((call) => call.url)).toContain("https://remote.example.test/oauth/token");
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
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }),
          ),
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
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
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
          connectionId: "ssh:environment-ssh",
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: "ssh:environment-ssh",
          target,
        },
      });
    }),
  );
});
