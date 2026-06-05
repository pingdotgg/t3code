import { beforeEach, vi } from "vitest";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelayClient } from "@t3tools/client-runtime";
import { HttpClient } from "effect/unstable/http";

import type { SavedRemoteConnection } from "../../lib/connection";
import { savePreferencesPatch } from "../../lib/storage";
import { linkEnvironmentToCloud } from "../cloud/linkEnvironment";
import { setLiveActivityUpdatesEnabled } from "./liveActivityPreferences";
import { refreshAgentAwarenessRegistration } from "./remoteRegistration";

vi.mock("../../lib/storage", () => ({
  savePreferencesPatch: vi.fn(() => Promise.resolve()),
}));

vi.mock("../cloud/linkEnvironment", () => ({
  linkEnvironmentToCloud: vi.fn(() => Effect.void),
}));

vi.mock("./remoteRegistration", () => ({
  refreshAgentAwarenessRegistration: vi.fn(() => Effect.void),
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

const runWithHttpClient = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient | ManagedRelayClient>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(ManagedRelayClient, null as never),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected HTTP request")),
      ),
    ),
  );

describe("liveActivityPreferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pushes disabled Live Activity preferences to relay registrations", async () => {
    await runWithHttpClient(
      setLiveActivityUpdatesEnabled({
        enabled: false,
        clerkToken: "clerk-token",
        connections: [connection],
      }),
    );

    expect(savePreferencesPatch).toHaveBeenCalledWith({ liveActivitiesEnabled: false });
    expect(refreshAgentAwarenessRegistration).toHaveBeenCalledTimes(1);
    expect(linkEnvironmentToCloud).toHaveBeenCalledWith({
      clerkToken: "clerk-token",
      connection,
    });
  });

  it("pushes enabled Live Activity preferences to relay registrations", async () => {
    await runWithHttpClient(
      setLiveActivityUpdatesEnabled({
        enabled: true,
        clerkToken: "clerk-token",
        connections: [connection],
      }),
    );

    expect(savePreferencesPatch).toHaveBeenCalledWith({ liveActivitiesEnabled: true });
    expect(refreshAgentAwarenessRegistration).toHaveBeenCalledTimes(1);
    expect(linkEnvironmentToCloud).toHaveBeenCalledWith({
      clerkToken: "clerk-token",
      connection,
    });
  });

  it("keeps local preferences refreshable when signed out", async () => {
    await runWithHttpClient(
      setLiveActivityUpdatesEnabled({
        enabled: false,
        clerkToken: null,
        connections: [connection],
      }),
    );

    expect(savePreferencesPatch).toHaveBeenCalledWith({ liveActivitiesEnabled: false });
    expect(refreshAgentAwarenessRegistration).toHaveBeenCalledTimes(1);
    expect(linkEnvironmentToCloud).not.toHaveBeenCalled();
  });

  it("does not try to re-link managed relay connections without bearer credentials", async () => {
    const managedConnection: SavedRemoteConnection = {
      ...connection,
      bearerToken: null,
    };

    await runWithHttpClient(
      setLiveActivityUpdatesEnabled({
        enabled: true,
        clerkToken: "clerk-token",
        connections: [connection, managedConnection],
      }),
    );

    expect(linkEnvironmentToCloud).toHaveBeenCalledTimes(1);
    expect(linkEnvironmentToCloud).toHaveBeenCalledWith({
      clerkToken: "clerk-token",
      connection,
    });
  });
});
