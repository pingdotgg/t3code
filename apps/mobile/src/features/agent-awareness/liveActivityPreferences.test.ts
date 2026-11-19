import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import type { SavedRemoteConnection } from "../../lib/connection";
import * as MobilePreferences from "../../persistence/mobile-preferences";
import * as MobileStorage from "../../persistence/mobile-storage";
import {
  CloudEnvironmentLinkError,
  linkEnvironmentToCloudWithPreference,
} from "../cloud/linkEnvironment";
import { setLiveActivityUpdatesEnabled } from "./liveActivityPreferences";
import { updateAgentAwarenessRegistrationPreferences } from "./remoteRegistration";

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: {} },
}));

vi.mock("expo-device", () => ({}));

vi.mock("../cloud/linkEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloud/linkEnvironment")>()),
  linkEnvironmentToCloudWithPreference: vi.fn(() => Effect.void),
}));

vi.mock("./remoteRegistration", () => ({
  updateAgentAwarenessRegistrationPreferences: vi.fn(() => Effect.void),
}));

const connection: SavedRemoteConnection = {
  environmentId: "env-1" as EnvironmentId,
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example.test/",
  displayUrl: "https://desktop.example.test/",
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
  bearerToken: "local-bearer",
};

const layerTest = Layer.mergeAll(
  Layer.succeed(ManagedRelay.ManagedRelayClient, null as never),
  Layer.succeed(MobilePreferences.MobilePreferencesStore, null as never),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected HTTP request")),
  ),
  Layer.succeed(
    MobileStorage.MobileStorage,
    MobileStorage.MobileStorage.of({
      loadOrCreateAgentAwarenessDeviceId: Effect.succeed("device-1"),
      loadAgentAwarenessDeviceId: Effect.succeed("device-1"),
      loadAgentAwarenessRegistrationRecord: Effect.succeed(null),
      saveAgentAwarenessRegistrationRecord: () => Effect.void,
      clearAgentAwarenessRegistrationRecord: Effect.void,
      loadRecentThreadShortcuts: Effect.succeed([]),
      saveRecentThreadShortcuts: () => Effect.void,
    }),
  ),
);

describe("liveActivityPreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.effect("restores relay preferences when an environment update fails", () => {
    vi.mocked(linkEnvironmentToCloudWithPreference).mockImplementationOnce(() =>
      Effect.fail(new CloudEnvironmentLinkError({ message: "environment update failed" })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          enabled: false,
          previousEnabled: true,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => true,
          saveLocalPreference: () => Effect.void,
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(1, {
        liveActivitiesEnabled: false,
      });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(2, {
        liveActivitiesEnabled: true,
      });
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenNthCalledWith(1, {
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: false,
      });
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenNthCalledWith(2, {
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: true,
      });
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("reverts the relay update when the local preference save fails", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: false,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => true,
          saveLocalPreference: () =>
            Effect.fail(
              new MobilePreferences.MobilePreferencesSaveError({
                cause: new Error("secure storage unavailable"),
              }),
            ),
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(
        vi
          .mocked(updateAgentAwarenessRegistrationPreferences)
          .mock.calls.map(([preferences]) => preferences.liveActivitiesEnabled),
      ).toEqual([true, false]);
      expect(
        vi
          .mocked(linkEnvironmentToCloudWithPreference)
          .mock.calls.map(([link]) => link.liveActivitiesEnabled),
      ).toEqual([true, false]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports success only after the local preference save commits", () =>
    Effect.gen(function* () {
      const saveStarted = yield* Deferred.make<void>();
      const saveCommitted = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: false,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => true,
          saveLocalPreference: () =>
            Deferred.succeed(saveStarted, undefined).pipe(
              Effect.andThen(Deferred.await(saveCommitted)),
            ),
        }),
      );

      yield* Deferred.await(saveStarted);
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledTimes(1);
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(saveCommitted, undefined);
      yield* Fiber.join(fiber);
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("only re-links environments with relay access when enabling updates", () => {
    const readOnlyConnection: SavedRemoteConnection = {
      ...connection,
      environmentId: "read-only" as EnvironmentId,
    };

    return Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        enabled: true,
        previousEnabled: false,
        clerkToken: "clerk-token",
        connections: [readOnlyConnection, connection],
        canConfigureEnvironment: (environmentId) => environmentId === connection.environmentId,
        saveLocalPreference: () => Effect.void,
      });

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: true,
      });
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledExactlyOnceWith({
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: true,
      });
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("checks current relay access after updating the device registration", () => {
    let canConfigureEnvironment = true;
    vi.mocked(updateAgentAwarenessRegistrationPreferences).mockImplementationOnce(() =>
      Effect.sync(() => {
        canConfigureEnvironment = false;
      }),
    );

    return Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        enabled: false,
        previousEnabled: true,
        clerkToken: "clerk-token",
        connections: [connection],
        canConfigureEnvironment: () => canConfigureEnvironment,
        saveLocalPreference: () => Effect.void,
      });

      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerTest));
  });
});
