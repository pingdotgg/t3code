/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { EnvironmentId } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import type { SavedRemoteConnection } from "../../lib/connection";
import { cryptoLayer } from "../cloud/dpop";
import { managedRelayClientLayer } from "../cloud/managedRelayLayer";
import { makeRelayDeviceRegistrationRequest } from "./registrationPayload";
import {
  AgentAwarenessOperationError,
  __resetAgentAwarenessRemoteRegistrationForTest,
  refreshActiveLiveActivityRemoteRegistration,
  refreshAgentAwarenessRegistration,
  normalizeAgentAwarenessRelayBaseUrl,
  registerAgentAwarenessConnection,
  registerLiveActivityPushToken,
  setAgentAwarenessRelayTokenProvider,
  shouldRegisterAgentAwarenessDeviceForProvider,
  unregisterAgentAwarenessConnection,
} from "./remoteRegistration";
import * as Notifications from "expo-notifications";

const secureStore = vi.hoisted(() => new Map<string, string>());
const widgetMocks = vi.hoisted(() => ({
  getInstances: vi.fn(() => []),
}));
const backgroundRuntime = vi.hoisted(() => ({
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      version: "1.0.0",
      extra: {},
    },
  },
}));

vi.mock("expo-widgets", () => ({
  addPushToStartTokenListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock("../../widgets/AgentActivity", () => ({
  default: {
    getInstances: widgetMocks.getInstances,
  },
}));

vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "ios", data: "apns-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: {
    SHA1: "SHA-1",
    SHA256: "SHA-256",
    SHA384: "SHA-384",
    SHA512: "SHA-512",
  },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  getRandomBytesAsync: (byteCount: number) =>
    Promise.resolve(new Uint8Array(NodeCrypto.randomBytes(byteCount))),
  digest: (algorithm: string, data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError("expo-crypto digest data must be a typed array."));
    }
    return Promise.resolve(
      new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer,
    );
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
    Version: "18.0",
  },
}));

vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: (operation: unknown) =>
      new Promise((resolve) => {
        backgroundRuntime.pending.push({ operation, resolve });
      }),
  },
}));

vi.mock("../../lib/storage", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({})),
}));

function proofIat(proof: string): number {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly iat: number;
  };
  return decoded.iat;
}

function savedConnection(): SavedRemoteConnection {
  return {
    environmentId: "env-1" as EnvironmentId,
    environmentLabel: "Desktop",
    pairingUrl: "https://desktop.example/pair",
    displayUrl: "https://desktop.example",
    httpBaseUrl: "https://desktop.example",
    wsBaseUrl: "wss://desktop.example/ws",
    bearerToken: "bearer-token",
  };
}

const relayTestLayer = managedRelayClientLayer("https://relay.example.test").pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cryptoLayer)),
);

const runBackgroundOperations = Effect.fn("TestRemoteRegistration.runBackgroundOperations")(
  function* () {
    let idlePasses = 0;
    for (;;) {
      yield* Effect.promise(() => Promise.resolve());
      const pending = backgroundRuntime.pending.shift();
      if (!pending) {
        idlePasses++;
        if (idlePasses >= 3) {
          return;
        }
        continue;
      }
      idlePasses = 0;
      const exit = yield* Effect.exit(
        pending.operation as Effect.Effect<unknown, unknown, ManagedRelay.ManagedRelayClient>,
      );
      yield* Effect.sync(() => {
        pending.resolve(exit);
      });
    }
  },
);

describe("makeRelayDeviceRegistrationRequest", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("__DEV__", false);
    secureStore.clear();
    backgroundRuntime.pending.length = 0;
    Constants.expoConfig!.extra = {};
    __resetAgentAwarenessRemoteRegistrationForTest();
    widgetMocks.getInstances.mockReset();
    widgetMocks.getInstances.mockReturnValue([]);
  });

  it("preserves disabled Live Activity preferences in relay registrations", () => {
    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        pushToken: "apns-token",
        pushToStartToken: "push-to-start-token",
        notificationsEnabled: true,
        preferences: {
          liveActivitiesEnabled: false,
        },
      }),
    ).toEqual({
      deviceId: "device-1",
      label: "Julius's iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      appVersion: "1.0.0",
      pushToken: "apns-token",
      pushToStartToken: "push-to-start-token",
      preferences: {
        liveActivitiesEnabled: false,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
  });

  it("disables push features in Personal Team relay registrations", () => {
    Constants.expoConfig!.extra = { iosPersonalTeamBuild: true };

    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        pushToken: "apns-token",
        pushToStartToken: "push-to-start-token",
        notificationsEnabled: true,
        preferences: {},
      }).preferences,
    ).toMatchObject({
      liveActivitiesEnabled: false,
      notificationsEnabled: false,
    });
  });

  it("marks notification delivery disabled when APNs permission is unavailable", () => {
    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        pushToStartToken: "push-to-start-token",
        notificationsEnabled: false,
        preferences: {
          liveActivitiesEnabled: true,
        },
      }),
    ).toEqual({
      deviceId: "device-1",
      label: "Julius's iPhone",
      platform: "ios",
      iosMajorVersion: 18,
      appVersion: "1.0.0",
      pushToStartToken: "push-to-start-token",
      preferences: {
        liveActivitiesEnabled: true,
        notificationsEnabled: false,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
  });

  it("normalizes relay base URLs for APNs registration requests", () => {
    expect(normalizeAgentAwarenessRelayBaseUrl(" https://relay.example.test/// ")).toBe(
      "https://relay.example.test",
    );
    expect(normalizeAgentAwarenessRelayBaseUrl("   ")).toBeNull();
  });

  it.effect("registers at most one listener while a Live Activity push token is pending", () => {
    registerAgentAwarenessConnection(savedConnection());
    const addPushTokenListener = vi.fn();
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve(null)),
      addPushTokenListener,
    };

    return Effect.gen(function* () {
      expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(false);
      expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(false);

      expect(activity.getPushToken).toHaveBeenCalledTimes(2);
      expect(addPushTokenListener).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("preserves Live Activity push-token lookup failures", () => {
    const cause = new Error("native token lookup failed");
    const activity = {
      getPushToken: vi.fn(() => Promise.reject(cause)),
      addPushTokenListener: vi.fn(),
    };

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        registerLiveActivityPushToken({ activity: activity as never }),
      );

      expect(error).toBeInstanceOf(AgentAwarenessOperationError);
      expect(error).toMatchObject({
        _tag: "AgentAwarenessOperationError",
        operation: "read-live-activity-push-token",
        cause,
        message: "Agent awareness operation read-live-activity-push-token failed.",
      });
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect(
    "reports Live Activity token registration as skipped when relay auth is unavailable",
    () => {
      registerAgentAwarenessConnection(savedConnection());
      const activity = {
        getPushToken: vi.fn(() => Promise.resolve("activity-token")),
        addPushTokenListener: vi.fn(),
      };

      return Effect.gen(function* () {
        expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(false);
      }).pipe(Effect.provide(relayTestLayer));
    },
  );

  it.effect(
    "registers APNS-started Live Activities for relay updates without mutating them locally",
    () => {
      const activity = {
        getPushToken: vi.fn(() => Promise.resolve("activity-token")),
        addPushTokenListener: vi.fn(),
        start: vi.fn(),
        update: vi.fn(),
        end: vi.fn(),
      };
      widgetMocks.getInstances.mockReturnValue([activity] as never);
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

      return Effect.gen(function* () {
        yield* refreshActiveLiveActivityRemoteRegistration();

        expect(activity.getPushToken).toHaveBeenCalled();
        expect(activity.start).not.toHaveBeenCalled();
        expect(activity.update).not.toHaveBeenCalled();
        expect(activity.end).not.toHaveBeenCalled();
      }).pipe(Effect.provide(relayTestLayer));
    },
  );

  it.effect("refreshes APNs registration for connected environments after settings changes", () => {
    registerAgentAwarenessConnection(savedConnection());
    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      vi.mocked(Notifications.getDevicePushTokenAsync).mockClear();

      yield* refreshAgentAwarenessRegistration();

      expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("registers the APNs device when cloud auth becomes available", () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      return Promise.resolve(
        Response.json(
          url.endsWith("/v1/client/dpop-token")
            ? {
                access_token: "relay-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 300,
                scope: "mobile:registration",
              }
            : { ok: true },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [request, init] = fetchMock.mock.calls[1] as unknown as [
        unknown,
        RequestInit | undefined,
      ];
      const url = request instanceof Request ? request.url : String(request);
      const method = request instanceof Request ? request.method : init?.method;
      const headers = request instanceof Request ? request.headers : new Headers(init?.headers);
      const dpop = headers.get("dpop");
      expect(url).toBe("https://relay.example.test/v1/mobile/devices");
      expect(method).toBe("POST");
      expect(headers.get("authorization")).toBe("DPoP relay-dpop-token");
      expect(dpop).toEqual(expect.any(String));
      if (!dpop) {
        throw new Error("Missing DPoP header.");
      }
      expect(
        verifyDpopProof({
          proof: dpop,
          method: "POST",
          url: "https://relay.example.test/v1/mobile/devices",
          expectedAccessToken: "relay-dpop-token",
          nowEpochSeconds: proofIat(dpop),
        }),
      ).toMatchObject({ ok: true });
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("coalesces simultaneous sign-in and environment connection registrations", () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      return Promise.resolve(
        Response.json(
          url.endsWith("/v1/client/dpop-token")
            ? {
                access_token: "relay-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 300,
                scope: "mobile:registration",
              }
            : { ok: true },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    vi.mocked(Notifications.getPermissionsAsync).mockClear();
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    registerAgentAwarenessConnection(savedConnection());

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(Notifications.getPermissionsAsync).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("continues queued device registration after a failed auth lookup", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    const tokenProvider = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("auth unavailable"))
      .mockResolvedValue("clerk-token-user-a");
    setAgentAwarenessRelayTokenProvider(tokenProvider);
    const tokenListener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)?.[0];
    expect(tokenListener).toBeDefined();
    tokenListener?.({ type: "ios", data: "rotated-apns-token" } as never);

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      expect(backgroundRuntime.pending).toHaveLength(0);
      expect(tokenProvider).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(relayTestLayer));
  });

  it("only registers again when the authenticated identity changes", () => {
    expect(shouldRegisterAgentAwarenessDeviceForProvider(null, "user-a")).toBe(true);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", "user-a")).toBe(false);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", "user-b")).toBe(true);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", undefined)).toBe(true);
  });

  it.effect("registers rotated APNs tokens without rereading the native token", () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request);
      return Promise.resolve(
        Response.json(
          url.endsWith("/v1/client/dpop-token")
            ? {
                access_token: "relay-dpop-token",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 300,
                scope: "mobile:registration",
              }
            : { ok: true },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };

    vi.mocked(Notifications.getDevicePushTokenAsync).mockClear();
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    const tokenListener = vi.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)?.[0];
    expect(tokenListener).toBeDefined();
    tokenListener?.({ type: "ios", data: "rotated-apns-token" } as never);

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect(
    "keeps the user-scoped relay APNs device when an environment connection is removed",
    () => {
      const fetchMock = vi.fn((request: RequestInfo | URL) => {
        const url = request instanceof Request ? request.url : String(request);
        return Promise.resolve(
          Response.json(
            url.endsWith("/v1/client/dpop-token")
              ? {
                  access_token: "relay-dpop-token",
                  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                  token_type: "DPoP",
                  expires_in: 300,
                  scope: "mobile:registration",
                }
              : { ok: true },
          ),
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      Constants.expoConfig!.extra = {
        relay: {
          url: "https://relay.example.test/",
        },
      };

      registerAgentAwarenessConnection(savedConnection());
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        fetchMock.mockClear();

        unregisterAgentAwarenessConnection(savedConnection().environmentId);

        expect(fetchMock).not.toHaveBeenCalled();
      }).pipe(Effect.provide(relayTestLayer));
    },
  );
});
