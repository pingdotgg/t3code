/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import Constants from "expo-constants";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivitySnapshotResponse } from "@t3tools/contracts/relay";
import { verifyDpopProof } from "@t3tools/shared/dpop";
import type { SavedRemoteConnection } from "../../lib/connection";
import { cryptoLayer } from "../cloud/dpop";
import { managedRelayClientLayer } from "../cloud/managedRelayLayer";
import {
  clearAgentAwarenessRegistrationRecord,
  loadAgentAwarenessRegistrationRecord,
  loadOrCreateAgentAwarenessDeviceId,
  loadPreferences,
  saveAgentAwarenessRegistrationRecord,
} from "../../persistence/imperative";
import type { Preferences } from "../../persistence/mobile-preferences";
import { makeRelayDeviceRegistrationRequest, resolveApsEnvironment } from "./registrationPayload";
import {
  AgentAwarenessOperationError,
  __resetAgentAwarenessRemoteRegistrationForTest,
  armAgentAwarenessLiveActivityForLocalWork,
  getAgentAwarenessRegistrationStatus,
  mergeAgentAwarenessRegistrationPreferences,
  refreshActiveLiveActivityRemoteRegistration,
  refreshAgentAwarenessRegistration,
  registerAgentAwarenessConnection,
  registerLiveActivityPushToken,
  releaseAgentAwarenessRelayTokenProvider,
  setAgentAwarenessRelayTokenProvider,
  shouldRegisterAgentAwarenessDeviceForProvider,
  unregisterAgentAwarenessConnection,
} from "./remoteRegistration";
import { publishAgentActivityWidget } from "../../widgets/AgentActivity";
import * as Notifications from "expo-notifications";

const secureStore = vi.hoisted(() => new Map<string, string>());
const widgetMocks = vi.hoisted(() => ({
  getInstances: vi.fn(() => []),
  start: vi.fn(() => ({})),
}));
const environmentConfigsMock = vi.hoisted(() => ({
  configs: new Map<
    string,
    { environment: { capabilities: { agentActivityPublishing?: boolean } } }
  >(),
}));
const backgroundRuntime = vi.hoisted(() => ({
  pending: [] as Array<{
    readonly operation: unknown;
    readonly resolve: (exit: Exit.Exit<unknown, unknown>) => void;
  }>,
}));
const appStateMock = vi.hoisted(() => ({
  listeners: [] as Array<(state: string) => void>,
}));
const registrationRecordStore = vi.hoisted(() => ({
  current: null as {
    readonly identity: string;
    readonly signature: string;
    readonly pushToStartToken?: string;
  } | null,
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
    start: widgetMocks.start,
  },
  publishAgentActivityWidget: vi.fn(),
}));

// The state modules pull the whole connection stack (and native expo modules)
// into the import graph; the arming gate only needs the configs map.
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => environmentConfigsMock.configs,
  },
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environmentServerConfigsAtom"),
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
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appStateMock.listeners.push(listener);
      return {
        remove: () => {
          const index = appStateMock.listeners.indexOf(listener);
          if (index >= 0) {
            appStateMock.listeners.splice(index, 1);
          }
        },
      };
    },
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

vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({ liveActivitiesEnabled: false })),
  loadAgentAwarenessRegistrationRecord: vi.fn(() =>
    Promise.resolve(registrationRecordStore.current),
  ),
  saveAgentAwarenessRegistrationRecord: vi.fn((record: { identity: string; signature: string }) => {
    registrationRecordStore.current = record;
    return Promise.resolve();
  }),
  clearAgentAwarenessRegistrationRecord: vi.fn(() => {
    registrationRecordStore.current = null;
    return Promise.resolve();
  }),
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

const activeAgentActivitySnapshot = {
  aggregate: {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: 1,
    updatedAt: "2026-05-25T13:07:00.000Z",
    activities: [
      {
        environmentId: "env-1" as EnvironmentId,
        threadId: "thread-1" as ThreadId,
        projectTitle: "Project",
        threadTitle: "Thread",
        modelTitle: "gpt-5.4",
        phase: "running" as const,
        status: "Working",
        updatedAt: "2026-05-25T13:07:00.000Z",
        deepLink: "/threads/env-1/thread-1",
      },
    ],
  },
} satisfies RelayAgentActivitySnapshotResponse;

function snapshotRelayLayer(
  getAgentActivitySnapshot: () => Effect.Effect<RelayAgentActivitySnapshotResponse> = () =>
    Effect.succeed(activeAgentActivitySnapshot),
) {
  Constants.expoConfig!.extra = {
    relay: {
      url: "https://relay.example.test/",
    },
  };
  return Layer.succeed(
    ManagedRelay.ManagedRelayClient,
    ManagedRelay.ManagedRelayClient.of({
      relayUrl: "https://relay.example.test",
      listEnvironments: () => Effect.die("unused"),
      listDevices: () => Effect.die("unused"),
      createEnvironmentLinkChallenge: () => Effect.die("unused"),
      linkEnvironment: () => Effect.die("unused"),
      unlinkEnvironment: () => Effect.die("unused"),
      getEnvironmentStatus: () => Effect.die("unused"),
      connectEnvironment: () => Effect.die("unused"),
      registerDevice: () => Effect.die("unused"),
      unregisterDevice: () => Effect.die("unused"),
      registerLiveActivity: () => Effect.succeed({ ok: true }),
      getAgentActivitySnapshot,
      resetTokenCache: Effect.void,
    }),
  );
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
    appStateMock.listeners.length = 0;
    registrationRecordStore.current = null;
    vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(clearAgentAwarenessRegistrationRecord).mockClear();
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockResolvedValue("device-1");
    vi.mocked(loadPreferences).mockReset();
    vi.mocked(loadPreferences).mockResolvedValue({ liveActivitiesEnabled: false } as Preferences);
    widgetMocks.getInstances.mockReset();
    widgetMocks.getInstances.mockReturnValue([]);
    widgetMocks.start.mockReset();
    widgetMocks.start.mockReturnValue({});
    environmentConfigsMock.configs.clear();
    vi.mocked(publishAgentActivityWidget).mockClear();
  });

  it.each(["sign-out", "account switch"])(
    "does not restore local-work widget data after %s during preference loading",
    async (transition) => {
      let finishPreferences!: (preferences: Preferences) => void;
      const preferences = new Promise<Preferences>((resolve) => {
        finishPreferences = resolve;
      });
      vi.mocked(loadPreferences).mockReturnValueOnce(preferences);
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");
      environmentConfigsMock.configs.set("env-1", {
        environment: { capabilities: { agentActivityPublishing: true } },
      });

      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: "env-1" as EnvironmentId,
        threadTitle: "Previous account thread",
        projectTitle: "Previous account project",
      });
      expect(loadPreferences).toHaveBeenCalledTimes(1);
      // Register the same catch/then depth after the production continuation.
      // Its receipt settles after the already-registered preference callback,
      // without a timer, polling, or executing queued relay operations.
      const preferenceCallbackDrained = preferences.catch(() => null).then(() => undefined);

      setAgentAwarenessRelayTokenProvider(null);
      if (transition === "account switch") {
        setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-b"), "user-b");
      }
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({ activeCount: 0, activities: [] }),
      );
      finishPreferences({ liveActivitiesEnabled: true } as Preferences);
      await preferenceCallbackDrained;

      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({ activeCount: 0, activities: [] }),
      );
      expect(widgetMocks.start).not.toHaveBeenCalled();
    },
  );

  it("still arms local work after a same-account token refresh during preference loading", async () => {
    let finishPreferences!: (preferences: Preferences) => void;
    const preferences = new Promise<Preferences>((resolve) => {
      finishPreferences = resolve;
    });
    vi.mocked(loadPreferences).mockReturnValueOnce(preferences);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"), "user-a");
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Current account thread",
      projectTitle: "Current account project",
    });
    const preferenceCallbackDrained = preferences.catch(() => null).then(() => undefined);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("refreshed-token-user-a"), "user-a");
    finishPreferences({ liveActivitiesEnabled: true } as Preferences);
    await preferenceCallbackDrained;

    expect(widgetMocks.start).toHaveBeenCalledTimes(1);
    expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activeCount: 1,
        activities: [expect.objectContaining({ threadTitle: "Current account thread" })],
      }),
    );
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

  it("registers the app's APNs routing so the relay targets the right bundle", () => {
    expect(
      makeRelayDeviceRegistrationRequest({
        deviceId: "device-1",
        label: "Julius's iPhone",
        iosMajorVersion: 18,
        appVersion: "1.0.0",
        bundleId: "com.t3tools.t3code.preview",
        apsEnvironment: resolveApsEnvironment("preview"),
        notificationsEnabled: true,
        preferences: {},
      }),
    ).toMatchObject({
      bundleId: "com.t3tools.t3code.preview",
      apsEnvironment: "production",
    });
  });

  it("routes development builds to the APNs sandbox", () => {
    expect(resolveApsEnvironment("development")).toBe("sandbox");
    expect(resolveApsEnvironment("preview")).toBe("production");
    expect(resolveApsEnvironment("production")).toBe("production");
    expect(resolveApsEnvironment(undefined)).toBe("production");
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

  it("overrides persisted preferences for an in-flight registration", () => {
    expect(
      mergeAgentAwarenessRegistrationPreferences(
        { liveActivitiesEnabled: false, baseFontSize: 18 },
        { liveActivitiesEnabled: true },
      ),
    ).toEqual({ liveActivitiesEnabled: true, baseFontSize: 18 });
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

  it.effect("refreshes the widget after a delayed Live Activity push token registers", () => {
    let onPushToken: ((event: { pushToken: string }) => void) | undefined;
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve(null)),
      addPushTokenListener: vi.fn((listener: (event: { pushToken: string }) => void) => {
        onPushToken = listener;
        return { remove: vi.fn() };
      }),
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(false);
      expect(onPushToken).toBeDefined();

      onPushToken?.({ pushToken: "delayed-activity-token" });
      yield* runBackgroundOperations();

      expect(publishAgentActivityWidget).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCount: 1,
          subtitle: "Agent work in progress",
        }),
      );
    }).pipe(Effect.provide(snapshotRelayLayer()));
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

  it.effect("publishes the home-screen widget when a Live Activity is already armed", () => {
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

      expect(publishAgentActivityWidget).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCount: 1,
          subtitle: "Agent work in progress",
          activities: [expect.objectContaining({ status: "Working" })],
        }),
      );
      expect(widgetMocks.start).not.toHaveBeenCalled();
      expect(activity.start).not.toHaveBeenCalled();
    }).pipe(Effect.provide(snapshotRelayLayer()));
  });

  it.effect("publishes the home-screen widget when Live Activities are disabled", () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshActiveLiveActivityRemoteRegistration();

      expect(publishAgentActivityWidget).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCount: 1,
          subtitle: "Agent work in progress",
        }),
      );
      expect(widgetMocks.start).not.toHaveBeenCalled();
    }).pipe(Effect.provide(snapshotRelayLayer()));
  });

  it.effect(
    "re-registers active Live Activity tokens when the app returns to the foreground",
    () => {
      const activity = {
        getPushToken: vi.fn(() => Promise.resolve("activity-token")),
        addPushTokenListener: vi.fn(),
      };
      widgetMocks.getInstances.mockReturnValue([activity] as never);
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

      return Effect.gen(function* () {
        yield* runBackgroundOperations();
        activity.getPushToken.mockClear();

        expect(appStateMock.listeners).toHaveLength(1);
        for (const listener of appStateMock.listeners) {
          listener("background");
        }
        yield* runBackgroundOperations();
        expect(activity.getPushToken).not.toHaveBeenCalled();

        for (const listener of appStateMock.listeners) {
          listener("active");
        }
        yield* runBackgroundOperations();
        expect(activity.getPushToken).toHaveBeenCalled();
      }).pipe(Effect.provide(relayTestLayer));
    },
  );

  it("ends local Live Activities and clears the home-screen widget on cloud sign-out", () => {
    const end = vi.fn(() => Promise.resolve());
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
      end,
    };
    widgetMocks.getInstances.mockReturnValue([activity] as never);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    expect(appStateMock.listeners).toHaveLength(1);

    setAgentAwarenessRelayTokenProvider(null);

    expect(end).toHaveBeenCalledWith("immediate");
    expect(publishAgentActivityWidget).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "T3 Code",
        subtitle: "No active agents",
        activeCount: 0,
        activities: [],
      }),
    );
    expect(appStateMock.listeners).toHaveLength(0);
  });

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

      const deviceCall = fetchMock.mock.calls.find((call) => {
        const request = call[0];
        const url = request instanceof Request ? request.url : String(request);
        return url === "https://relay.example.test/v1/mobile/devices";
      });
      expect(deviceCall).toBeDefined();
      const [request, init] = deviceCall as unknown as [unknown, RequestInit | undefined];
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
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("marks registration failed when device registration cannot complete", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValueOnce(
      new Error("registration failed"),
    );
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      // Drive the registration directly so the assertion does not depend on the
      // background queue draining; refreshAgentAwarenessRegistration swallows the
      // error but must record the failed status so the settings toggles cannot
      // read as enabled.
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("failed");
    }).pipe(Effect.provide(relayTestLayer));
  });

  it("clears registration status on cloud sign-out", () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    setAgentAwarenessRelayTokenProvider(null);
    expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    expect(clearAgentAwarenessRegistrationRecord).toHaveBeenCalled();
  });

  it("releases the provider without ending activities or clearing the registration", () => {
    const end = vi.fn(() => Promise.resolve());
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
      end,
    };
    widgetMocks.getInstances.mockReturnValue([activity] as never);
    registrationRecordStore.current = { identity: "", signature: "sig" };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    expect(appStateMock.listeners).toHaveLength(1);

    releaseAgentAwarenessRelayTokenProvider();

    expect(appStateMock.listeners).toHaveLength(0);
    expect(end).not.toHaveBeenCalled();
    expect(clearAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    expect(registrationRecordStore.current).not.toBeNull();
  });

  it.effect("resets a pending status to unknown when relay config is missing", () => {
    // No relay url configured: registration can neither run nor ever succeed,
    // so the status must not stick at "pending".
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("unknown");
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("keeps a registered status when a later refresh fails", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* runBackgroundOperations();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");

      // The relay still holds the accepted registration; a transient refresh
      // failure must not flip the settings toggles off.
      vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockRejectedValueOnce(
        new Error("transient failure"),
      );
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("does not re-register the same account when nothing has changed", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).toHaveBeenCalledTimes(1);
      expect(registrationRecordStore.current).not.toBeNull();

      // Second attempt with an identical payload must skip the relay entirely,
      // so no new registration record is written.
      vi.mocked(saveAgentAwarenessRegistrationRecord).mockClear();
      yield* refreshAgentAwarenessRegistration();
      expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
      expect(saveAgentAwarenessRegistrationRecord).not.toHaveBeenCalled();
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("dedupes rapid activity-token re-registrations within the replay window", () => {
    // Fetch counts are unreliable here (the module-level relay layer captures
    // the first test's fetch), so assert on the flow's own seams: a real
    // registration attempt loads the device id, a deduped one short-circuits
    // before it.
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
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
    };
    widgetMocks.getInstances.mockReturnValue([activity] as never);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      // Drains the sign-in refresh, which registers the activity token.
      yield* runBackgroundOperations();
      expect(activity.getPushToken).toHaveBeenCalled();

      // A burst refresh (foreground / connection update seconds later) must
      // dedupe: it reads the token but never proceeds to a registration
      // attempt (which would load the device id first).
      vi.mocked(loadOrCreateAgentAwarenessDeviceId).mockClear();
      yield* refreshActiveLiveActivityRemoteRegistration();
      expect(loadOrCreateAgentAwarenessDeviceId).not.toHaveBeenCalled();
    }).pipe(Effect.provide(relayTestLayer));
  });

  it.effect("re-registers when the stored account identity differs", () => {
    Constants.expoConfig!.extra = {
      relay: {
        url: "https://relay.example.test/",
      },
    };
    registrationRecordStore.current = { identity: "someone-else", signature: "stale" };
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

    return Effect.gen(function* () {
      yield* refreshAgentAwarenessRegistration();
      expect(saveAgentAwarenessRegistrationRecord).toHaveBeenCalledTimes(1);
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
      // Device registration retries after the first auth miss, and the
      // home-screen widget refresh independently reads the relay token.
      expect(tokenProvider).toHaveBeenCalledTimes(3);
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

  it("skips the Live Activity seed when the environment reports publishing disabled", async () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: false } },
    });

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(widgetMocks.start).not.toHaveBeenCalled();
  });

  it("seeds the Live Activity for publishing and pre-capability environments", async () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    environmentConfigsMock.configs.set("env-publishing", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });

    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-publishing" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(widgetMocks.start).toHaveBeenCalledTimes(1);

    // An environment without the capability may run an older server that
    // still publishes; only an explicit false skips the seed.
    widgetMocks.start.mockClear();
    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-pre-capability" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(widgetMocks.start).toHaveBeenCalledTimes(1);
  });
  it.effect("refreshes the home-screen widget after arming local agent work", () => {
    const activity = {
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
    };
    widgetMocks.start.mockReturnValueOnce(activity);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    backgroundRuntime.pending.length = 0;
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });
    const preferences = Promise.resolve({
      liveActivitiesEnabled: true,
    } as Preferences);
    vi.mocked(loadPreferences).mockReturnValueOnce(preferences);

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    const preferenceCallbackDrained = preferences.catch(() => null).then(() => undefined);

    return Effect.gen(function* () {
      yield* Effect.promise(() => preferenceCallbackDrained);
      yield* runBackgroundOperations();

      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeCount: 1,
          subtitle: "Agent work in progress",
          activities: [expect.objectContaining({ status: "Working" })],
        }),
      );
    }).pipe(Effect.provide(snapshotRelayLayer()));
  });

  it.effect("refreshes the home-screen widget when local Live Activities are disabled", () => {
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    backgroundRuntime.pending.length = 0;
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });
    const preferences = Promise.resolve({
      liveActivitiesEnabled: false,
    } as Preferences);
    vi.mocked(loadPreferences).mockReturnValueOnce(preferences);

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    const preferenceCallbackDrained = preferences.catch(() => null).then(() => undefined);

    return Effect.gen(function* () {
      yield* Effect.promise(() => preferenceCallbackDrained);
      yield* runBackgroundOperations();

      expect(widgetMocks.start).not.toHaveBeenCalled();
      expect(publishAgentActivityWidget).toHaveBeenCalledTimes(1);
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeCount: 1,
          activities: [expect.objectContaining({ status: "Working" })],
        }),
      );
    }).pipe(Effect.provide(snapshotRelayLayer()));
  });

  it.effect("refreshes the home-screen widget when a local Live Activity is already armed", () => {
    widgetMocks.getInstances.mockReturnValueOnce([{}] as never);
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    backgroundRuntime.pending.length = 0;
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });
    const preferences = Promise.resolve({
      liveActivitiesEnabled: true,
    } as Preferences);
    vi.mocked(loadPreferences).mockReturnValueOnce(preferences);

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    const preferenceCallbackDrained = preferences.catch(() => null).then(() => undefined);

    return Effect.gen(function* () {
      yield* Effect.promise(() => preferenceCallbackDrained);
      yield* runBackgroundOperations();

      expect(widgetMocks.start).not.toHaveBeenCalled();
      expect(publishAgentActivityWidget).toHaveBeenCalledTimes(1);
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeCount: 1,
          activities: [expect.objectContaining({ status: "Working" })],
        }),
      );
    }).pipe(Effect.provide(snapshotRelayLayer()));
  });

  it.effect("refreshes the home-screen widget when local Live Activity arming fails", () => {
    widgetMocks.start.mockImplementationOnce(() => {
      throw new Error("start failed");
    });
    setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
    backgroundRuntime.pending.length = 0;
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });
    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });

    return Effect.gen(function* () {
      yield* runBackgroundOperations();

      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeCount: 1,
          subtitle: "Agent work in progress",
          activities: [expect.objectContaining({ status: "Working" })],
        }),
      );
    }).pipe(Effect.provide(snapshotRelayLayer()));
  });

  it.effect("discards an older widget snapshot when a newer refresh finishes first", () =>
    Effect.gen(function* () {
      const firstReadStarted = yield* Deferred.make<void>();
      const finishFirstRead = yield* Deferred.make<void>();
      const olderSnapshot = {
        aggregate: {
          ...activeAgentActivitySnapshot.aggregate,
          updatedAt: "2026-05-25T13:06:00.000Z",
          activities: [
            {
              ...activeAgentActivitySnapshot.aggregate.activities[0],
              status: "Older status",
              updatedAt: "2026-05-25T13:06:00.000Z",
            },
          ],
        },
      } satisfies RelayAgentActivitySnapshotResponse;
      let readCount = 0;
      const layer = snapshotRelayLayer(() => {
        readCount++;
        if (readCount === 1) {
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishFirstRead)),
            Effect.as(olderSnapshot),
          );
        }
        return Effect.succeed(activeAgentActivitySnapshot);
      });
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      backgroundRuntime.pending.length = 0;

      const olderRefresh = yield* refreshActiveLiveActivityRemoteRegistration().pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(firstReadStarted);
      yield* refreshActiveLiveActivityRemoteRegistration().pipe(Effect.provide(layer));
      yield* Deferred.succeed(finishFirstRead, undefined);
      yield* Fiber.join(olderRefresh);

      expect(publishAgentActivityWidget).toHaveBeenCalledTimes(1);
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activities: [expect.objectContaining({ status: "Working" })],
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not overwrite a local work seed with an in-flight widget snapshot", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const finishRead = yield* Deferred.make<void>();
      const layer = snapshotRelayLayer(() =>
        Deferred.succeed(readStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishRead)),
          Effect.as({ aggregate: null }),
        ),
      );
      const activity = {
        getPushToken: vi.fn(() => Promise.resolve("activity-token")),
        addPushTokenListener: vi.fn(),
      };
      widgetMocks.getInstances
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValue([activity] as never);
      widgetMocks.start.mockReturnValueOnce(activity);
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      environmentConfigsMock.configs.set("env-1", {
        environment: { capabilities: { agentActivityPublishing: true } },
      });
      const preferences = Promise.resolve({
        liveActivitiesEnabled: true,
      } as Preferences);
      vi.mocked(loadPreferences).mockReturnValue(preferences);

      const refresh = yield* refreshActiveLiveActivityRemoteRegistration().pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(readStarted);

      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: "env-1" as EnvironmentId,
        threadTitle: "Fix the flaky test",
        projectTitle: "t3code",
      });
      const preferenceCallbackDrained = preferences.catch(() => null).then(() => undefined);
      yield* Effect.promise(() => preferenceCallbackDrained);

      yield* Deferred.succeed(finishRead, undefined);
      yield* Fiber.join(refresh);

      expect(publishAgentActivityWidget).toHaveBeenCalledTimes(1);
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          activeCount: 1,
          subtitle: "Agent work in progress",
          activities: [expect.objectContaining({ status: "Connecting" })],
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not prime a Live Activity after cloud sign-out", () =>
    Effect.gen(function* () {
      let preferencesStarted!: () => void;
      let finishPreferences!: (preferences: Preferences) => void;
      const started = new Promise<void>((resolve) => {
        preferencesStarted = resolve;
      });
      const preferences = new Promise<Preferences>((resolve) => {
        finishPreferences = resolve;
      });
      vi.mocked(loadPreferences).mockImplementationOnce(() => {
        preferencesStarted();
        return preferences;
      });
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

      const refresh = yield* refreshActiveLiveActivityRemoteRegistration().pipe(
        Effect.provide(snapshotRelayLayer()),
        Effect.forkChild,
      );
      yield* Effect.promise(() => started);

      setAgentAwarenessRelayTokenProvider(null);
      finishPreferences({ liveActivitiesEnabled: true } as Preferences);
      yield* Fiber.join(refresh);

      expect(widgetMocks.start).not.toHaveBeenCalled();
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subtitle: "No active agents",
          activeCount: 0,
          activities: [],
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not prime from a snapshot that became idle while preferences loaded", () =>
    Effect.gen(function* () {
      let preferencesStarted!: () => void;
      let finishPreferences!: (preferences: Preferences) => void;
      const started = new Promise<void>((resolve) => {
        preferencesStarted = resolve;
      });
      const preferences = new Promise<Preferences>((resolve) => {
        finishPreferences = resolve;
      });
      vi.mocked(loadPreferences).mockImplementationOnce(() => {
        preferencesStarted();
        return preferences;
      });
      let readCount = 0;
      const layer = snapshotRelayLayer(() => {
        readCount++;
        return Effect.succeed(readCount === 1 ? activeAgentActivitySnapshot : { aggregate: null });
      });
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));

      const refresh = yield* refreshActiveLiveActivityRemoteRegistration().pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Effect.promise(() => started);

      finishPreferences({ liveActivitiesEnabled: true } as Preferences);
      yield* Fiber.join(refresh);

      expect(readCount).toBe(2);
      expect(widgetMocks.start).not.toHaveBeenCalled();
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subtitle: "No active agents",
          activeCount: 0,
          activities: [],
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not restore an in-flight widget snapshot after cloud sign-out", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const finishRead = yield* Deferred.make<void>();
      const layer = snapshotRelayLayer(() =>
        Deferred.succeed(readStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishRead)),
          Effect.as(activeAgentActivitySnapshot),
        ),
      );
      setAgentAwarenessRelayTokenProvider(() => Promise.resolve("clerk-token-user-a"));
      backgroundRuntime.pending.length = 0;

      const refresh = yield* refreshActiveLiveActivityRemoteRegistration().pipe(
        Effect.provide(layer),
        Effect.forkChild,
      );
      yield* Deferred.await(readStarted);
      setAgentAwarenessRelayTokenProvider(null);
      yield* Deferred.succeed(finishRead, undefined);
      yield* Fiber.join(refresh);

      expect(publishAgentActivityWidget).toHaveBeenCalledTimes(1);
      expect(publishAgentActivityWidget).toHaveBeenLastCalledWith(
        expect.objectContaining({
          subtitle: "No active agents",
          activeCount: 0,
          activities: [],
        }),
      );
    }).pipe(Effect.scoped),
  );
});
