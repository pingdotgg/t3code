import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
  };
});

vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("./runtime", () => ({
  mobileRuntime: {
    runPromise: vi.fn(),
  },
}));

import { loadSavedConnections, saveConnection } from "./storage";
import { toStableSavedRemoteConnection } from "./connection";

const managedConnection = {
  environmentId: EnvironmentId.make("environment-1"),
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example/",
  displayUrl: "https://desktop.example/",
  httpBaseUrl: "https://desktop.example/",
  wsBaseUrl: "wss://desktop.example/",
  bearerToken: null,
  authenticationMethod: "dpop",
  dpopAccessToken: "short-lived-token",
  relayManaged: true,
} as const;

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("persists relay-managed connections without their ephemeral access token", async () => {
    await saveConnection(managedConnection);

    const savedValue = mocks.setItemAsync.mock.calls[0]?.[1];
    expect(savedValue).toBeDefined();
    expect(JSON.parse(savedValue ?? "")).toEqual({
      connections: [toStableSavedRemoteConnection(managedConnection)],
    });
  });

  it("loads relay-managed connection metadata without a cached access token", async () => {
    await saveConnection(managedConnection);

    await expect(loadSavedConnections()).resolves.toEqual([
      toStableSavedRemoteConnection(managedConnection),
    ]);
  });
});
