import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";

import type { SavedRemoteConnection } from "../../lib/connection";
import {
  MobilePreferencesSaveError,
  MobilePreferencesStore,
} from "../../persistence/mobile-preferences";
import { MobileStorage } from "../../persistence/mobile-storage";
import { CloudEnvironmentLinkError } from "../cloud/linkEnvironment";
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

vi.mock("./remoteRegistration", () => ({
  updateAgentAwarenessRegistrationPreferences: vi.fn(() => Effect.void),
}));

const updateEnvironment = vi.fn<
  (
    id: EnvironmentId,
    enabled: boolean,
  ) => Effect.Effect<
    "updated" | "unlinked" | "unsupported" | "disconnected",
    CloudEnvironmentLinkError
  >
>(() => Effect.succeed("updated"));

const linkEnvironment = vi.fn<
  (
    id: EnvironmentId,
    input: { readonly clerkToken: string; readonly liveActivitiesEnabled: boolean },
  ) => Effect.Effect<void, CloudEnvironmentLinkError>
>(() => Effect.void);

const saveLocalPreference = vi.fn<
  (enabled: boolean) => Effect.Effect<void, MobilePreferencesSaveError>
>(() => Effect.void);

const connection: SavedRemoteConnection = {
  environmentId: "env-1" as EnvironmentId,
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example.test/",
  displayUrl: "https://desktop.example.test/",
  httpBaseUrl: "https://desktop.example.test/",
  wsBaseUrl: "wss://desktop.example.test/ws",
  bearerToken: "local-bearer",
};

const withRelayClient = Effect.provide(
  Layer.mergeAll(
    Layer.succeed(ManagedRelay.ManagedRelayClient, null as never),
    Layer.succeed(MobileStorage, null as never),
    Layer.succeed(MobilePreferencesStore, null as never),
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
          linkEnvironment,
          saveLocalPreference,
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
      expect(linkEnvironment).not.toHaveBeenCalled();
    }).pipe(withRelayClient);
  });

  it.effect("restores the device preference when the device cannot save the setting", () => {
    saveLocalPreference.mockImplementationOnce(() =>
      Effect.fail(new MobilePreferencesSaveError({ cause: new Error("storage full") })),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          updateEnvironment,
          linkEnvironment,
          saveLocalPreference,
          enabled: true,
          previousEnabled: false,
          clerkToken: "clerk-token",
          connections: [connection],
          canConfigureEnvironment: () => false,
          canUpdateEnvironment: () => true,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenLastCalledWith({
        liveActivitiesEnabled: false,
      });
    }).pipe(withRelayClient);
  });

  it.effect("reports a relay preference committed before environment configuration fails", () => {
    const failure = new CloudEnvironmentLinkError({
      message: "environment configuration failed",
      relayLinkCommitted: true,
    });
    updateEnvironment.mockReturnValueOnce(Effect.succeed("unlinked"));
    linkEnvironment.mockReturnValueOnce(Effect.fail(failure));

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        setLiveActivityUpdatesEnabled({
          updateEnvironment,
          linkEnvironment,
          saveLocalPreference,
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
    }).pipe(withRelayClient);
  });

  it.effect("only creates missing links when the session can configure Connect", () => {
    updateEnvironment.mockReturnValueOnce(Effect.succeed("unlinked" as const));
    const readOnlyConnection: SavedRemoteConnection = {
      ...connection,
      environmentId: "read-only" as EnvironmentId,
    };
    // Current mobile pairings authenticate with DPoP and carry no bearer token.
    const dpopConnection: SavedRemoteConnection = {
      ...connection,
      bearerToken: null,
      authenticationMethod: "dpop",
    };

    return Effect.gen(function* () {
      yield* setLiveActivityUpdatesEnabled({
        updateEnvironment,
        linkEnvironment,
        saveLocalPreference,
        enabled: true,
        previousEnabled: false,
        clerkToken: "clerk-token",
        connections: [readOnlyConnection, dpopConnection],
        canUpdateEnvironment: (environmentId) => environmentId === connection.environmentId,
        canConfigureEnvironment: (environmentId) => environmentId === connection.environmentId,
      });

      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledWith({
        liveActivitiesEnabled: true,
      });
      expect(linkEnvironment).toHaveBeenCalledExactlyOnceWith(connection.environmentId, {
        clerkToken: "clerk-token",
        liveActivitiesEnabled: true,
      });
    }).pipe(withRelayClient);
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
        linkEnvironment,
        saveLocalPreference,
        enabled: false,
        previousEnabled: true,
        clerkToken: "clerk-token",
        connections: [dpopConnection],
        canConfigureEnvironment: () => false,
        canUpdateEnvironment: () => true,
      });
      expect(partial).toBe(true);
      expect(linkEnvironment).not.toHaveBeenCalled();
    }).pipe(withRelayClient),
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
        linkEnvironment,
        saveLocalPreference,
        enabled: false,
        previousEnabled: true,
        clerkToken: "clerk-token",
        connections: [connection],
        canConfigureEnvironment: () => canConfigureEnvironment,
        canUpdateEnvironment: () => canConfigureEnvironment,
      });

      expect(linkEnvironment).not.toHaveBeenCalled();
      expect(updateEnvironment).not.toHaveBeenCalled();
      expect(updateAgentAwarenessRegistrationPreferences).toHaveBeenCalledTimes(1);
    }).pipe(withRelayClient);
  });
});
