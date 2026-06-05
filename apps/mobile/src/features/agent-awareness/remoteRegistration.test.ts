/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { beforeEach, vi } from "vitest";
import { describe, expect, it } from "@effect/vitest";
import Constants from "expo-constants";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import type { ManagedRelayClient } from "@t3tools/client-runtime";

import type { EnvironmentId } from "@t3tools/contracts";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import type { SavedRemoteConnection } from "../../lib/connection";
import { mobileCryptoLayer } from "../cloud/dpop";
import { mobileManagedRelayClientLayer } from "../cloud/managedRelayLayer";
import { makeRelayDeviceRegistrationRequest } from "./registrationPayload";
import {
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
  mobileRuntime: {
    runPromise: <A, E>(operation: Effect.Effect<A, E>) =>
      Effect.runPromise(
        operation.pipe(
          Effect.provide(
            mobileManagedRelayClientLayer("https://relay.example.test").pipe(
              Layer.provide(Layer.mergeAll(FetchHttpClient.layer, mobileCryptoLayer)),
            ),
          ),
        ),
      ),
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

const runRegistrationEffect = <A, E>(effect: Effect.Effect<A, E, ManagedRelayClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        mobileManagedRelayClientLayer("https://relay.example.test").pipe(
          Layer.provide(Layer.mergeAll(FetchHttpClient.layer, mobileCryptoLayer)),
        ),
      ),
    ),
  );

async function waitForFetchCalls(
  fetchMock: ReturnType<typeof vi.fn>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (fetchMock.mock.calls.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("makeRelayDeviceRegistrationRequest", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("__DEV__", false);
    secureStore.clear();
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

  it("registers at most one listener while a Live Activity push token is pending", async () => {
    registerAgentAwarenessConnection(savedConnection());
    const addPushTokenListener = vi.fn();
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve(null)),
      addPushTokenListener,
    };

    await expect(
      runRegistrationEffect(registerLiveActivityPushToken({ activity: activity as never })),
    ).resolves.toBe(false);
    await expect(
      runRegistrationEffect(registerLiveActivityPushToken({ activity: activity as never })),
    ).resolves.toBe(false);

    expect(activity.getPushToken).toHaveBeenCalledTimes(2);
    expect(addPushTokenListener).toHaveBeenCalledTimes(1);
  });

  it("reports Live Activity token registration as skipped when relay auth is unavailable", async () => {
    registerAgentAwarenessConnection(savedConnection());
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
    };

    await expect(
      runRegistrationEffect(registerLiveActivityPushToken({ activity: activity as never })),
    ).resolves.toBe(false);
  });

  it("registers APNS-started Live Activities for relay updates without mutating them locally", async () => {
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
      start: vi.fn(),
      update: vi.fn(),
      end: vi.fn(),
    };
    widgetMocks.getInstances.mockReturnValue([activity] as never);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    await runRegistrationEffect(refreshActiveLiveActivityRemoteRegistration());

    expect(activity.getPushToken).toHaveBeenCalled();
    expect(activity.start).not.toHaveBeenCalled();
    expect(activity.update).not.toHaveBeenCalled();
    expect(activity.end).not.toHaveBeenCalled();
  });

  it("refreshes APNs registration for connected environments after settings changes", async () => {
    registerAgentAwarenessConnection(savedConnection());
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(Notifications.getDevicePushTokenAsync).mockClear();

    await runRegistrationEffect(refreshAgentAwarenessRegistration());

    expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
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
      yield* Effect.promise(() => waitForFetchCalls(fetchMock, 2));

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
    });
  });

  it("only registers again when the authenticated identity changes", () => {
    expect(shouldRegisterAgentAwarenessDeviceForProvider(null, "user-a")).toBe(true);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", "user-a")).toBe(false);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", "user-b")).toBe(true);
    expect(shouldRegisterAgentAwarenessDeviceForProvider("user-a", undefined)).toBe(true);
  });

  it("registers rotated APNs tokens without rereading the native token", async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(Notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
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
        yield* Effect.promise(() => waitForFetchCalls(fetchMock, 2));
        fetchMock.mockClear();

        unregisterAgentAwarenessConnection(savedConnection().environmentId);

        expect(fetchMock).not.toHaveBeenCalled();
      });
    },
  );
});
