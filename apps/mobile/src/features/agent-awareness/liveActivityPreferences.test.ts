import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import type { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";

import type { SavedRemoteConnection } from "../../lib/connection";
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

const updateEnvironment = vi.fn<
  (
    id: EnvironmentId,
    enabled: boolean,
  ) => Effect.Effect<"updated" | "unlinked" | "unsupported", CloudEnvironmentLinkError>
>(() => Effect.succeed("updated"));

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

  it.effect("restores only the device preference when an environment update fails", () => {
    const otherConnection = { ...connection, environmentId: "env-2" as EnvironmentId };
    updateEnvironment.mockImplementationOnce(() =>
      Effect.fail(new CloudEnvironmentLinkError({ message: "environment update failed" })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          updateEnvironment,
          enabled: false,
          previousEnabled: true,
          clerkToken: "clerk-token",
          connections: [connection, otherConnection],
          canConfigureEnvironment: () => false,
          canUpdateEnvironment: () => true,
        }),
      );

      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(
          expect.objectContaining({ updatedEnvironments: [otherConnection.environmentLabel] }),
        ),
      );
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(1, {
        liveActivitiesEnabled: false,
      });
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenNthCalledWith(2, {
        liveActivitiesEnabled: true,
      });
      expect(updateEnvironment).toHaveBeenCalledTimes(2);
      expect(updateEnvironment).toHaveBeenCalledWith(connection.environmentId, false);
      expect(updateEnvironment).toHaveBeenCalledWith(otherConnection.environmentId, false);
      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("reports a relay preference committed before environment configuration fails", () => {
    const failure = new CloudEnvironmentLinkError({
      message: "environment configuration failed",
      relayLinkCommitted: true,
    });
    updateEnvironment.mockReturnValueOnce(Effect.succeed("unlinked"));
    vi.mocked(linkEnvironmentToCloudWithPreference).mockReturnValueOnce(Effect.fail(failure));

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          updateEnvironment,
          enabled: true,
          previousEnabled: false,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => true,
          canUpdateEnvironment: () => true,
        }),
      );

      expect(Exit.findErrorOption(exit)).toEqual(
        Option.some(
          expect.objectContaining({
            updatedEnvironments: [connection.environmentLabel],
            cause: failure,
          }),
        ),
      );
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenLastCalledWith({
        liveActivitiesEnabled: false,
      });
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("only creates missing links when the session can configure Connect", () => {
    updateEnvironment.mockReturnValueOnce(Effect.succeed("unlinked" as const));
    const readOnlyConnection: SavedRemoteConnection = {
      ...connection,
      environmentId: "read-only" as EnvironmentId,
    };

    return Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        updateEnvironment,
        enabled: true,
        previousEnabled: false,
        clerkToken: "clerk-token",
        connections: [readOnlyConnection, connection],
        canUpdateEnvironment: (environmentId) => environmentId === connection.environmentId,
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
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("reports older environments whose preferences could not be updated", () =>
    Effect.gen(function* () {
      const dpopConnection: SavedRemoteConnection = {
        ...connection,
        bearerToken: null,
        authenticationMethod: "dpop",
      };
      updateEnvironment.mockReturnValueOnce(Effect.succeed("unsupported"));
      const partial = yield* setLiveActivityUpdatesEnabled({
        updateEnvironment,
        enabled: false,
        previousEnabled: true,
        clerkToken: "clerk-token",
        connections: [dpopConnection],
        canConfigureEnvironment: () => false,
        canUpdateEnvironment: () => true,
      });
      expect(partial).toBe(true);
      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layerTest)),
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
        updateEnvironment,
        enabled: false,
        previousEnabled: true,
        clerkToken: "clerk-token",
        connections: [connection],
        canConfigureEnvironment: () => canConfigureEnvironment,
        canUpdateEnvironment: () => canConfigureEnvironment,
      });

      expect(linkEnvironmentToCloudWithPreference).not.toHaveBeenCalled();
      expect(updateEnvironment).not.toHaveBeenCalled();
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layerTest));
  });
});
