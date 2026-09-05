import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import type { SavedRemoteConnection } from "../../lib/connection";
import { MobileStorage } from "../../persistence/mobile-storage";
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

const testLayer = Layer.mergeAll(
  Layer.succeed(ManagedRelay.ManagedRelayClient, null as never),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected HTTP request")),
  ),
  Layer.succeed(
    MobileStorage,
    MobileStorage.of({
      loadSavedConnections: Effect.succeed([]),
      saveConnection: () => Effect.void,
      clearSavedConnection: () => Effect.void,
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

  it.effect("pushes disabled Live Activity preferences to relay registrations", () =>
    Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        enabled: false,
        previousEnabled: true,
        clerkToken: "clerk-token",
        connections: [connection],
        canConfigureEnvironment: () => true,
      });

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: false,
      });
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledWith({
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: false,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("pushes enabled Live Activity preferences to relay registrations", () =>
    Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        enabled: true,
        previousEnabled: false,
        clerkToken: "clerk-token",
        connections: [connection],
        canConfigureEnvironment: () => true,
      });

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: true,
      });
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledWith({
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: true,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps local preferences refreshable when signed out", () =>
    Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        enabled: false,
        previousEnabled: true,
        clerkToken: null,
        connections: [connection],
        canConfigureEnvironment: () => true,
      });

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: false,
      });
      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not try to re-link managed relay connections without bearer credentials", () => {
    const managedConnection: SavedRemoteConnection = {
      ...connection,
      bearerToken: null,
    };

    return Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        enabled: true,
        previousEnabled: false,
        clerkToken: "clerk-token",
        connections: [connection, managedConnection],
        canConfigureEnvironment: () => true,
      });

      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledTimes(1);
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledWith({
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: true,
      });
    }).pipe(Effect.provide(testLayer));
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
    }).pipe(Effect.provide(testLayer));
  });

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
      });

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: true,
      });
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledExactlyOnceWith({
        clerkToken: "clerk-token",
        connection,
        liveActivitiesEnabled: true,
      });
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("keeps device updates independently switchable without relay access", () =>
    Effect.gen(function* () {
      for (const enabled of [false, true]) {
        yield* setLiveActivityUpdatesEnabled({
          enabled,
          previousEnabled: !enabled,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => false,
        });
      }

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(1, {
        liveActivitiesEnabled: false,
      });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(2, {
        liveActivitiesEnabled: true,
      });
      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
    }).pipe(Effect.provide(testLayer)),
  );

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
      });

      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("does not retry environment changes after relay access is revoked", () => {
    let canConfigureEnvironment = true;
    vi.mocked(linkEnvironmentToCloudWithPreference).mockImplementationOnce(() =>
      Effect.sync(() => {
        canConfigureEnvironment = false;
      }).pipe(
        Effect.andThen(
          Effect.fail(new CloudEnvironmentLinkError({ message: "relay access revoked" })),
        ),
      ),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          enabled: false,
          previousEnabled: true,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => canConfigureEnvironment,
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(linkEnvironmentToCloudWithPreference).toHaveBeenCalledTimes(1);
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(2, {
        liveActivitiesEnabled: true,
      });
    }).pipe(Effect.provide(testLayer));
  });
});
