import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  isRelayManagedConnection,
  authClientMetadata,
  redactPairingCredential,
  toStableSavedRemoteConnection,
} from "./connection";

vi.mock("./runtime", () => ({
  runtime: {
    runPromise: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

describe("mobile remote connection records", () => {
  it("identifies mobile token exchanges for authorized-client presentation", () => {
    expect(authClientMetadata()).toEqual({
      label: "T3 Code Mobile",
      deviceType: "mobile",
      os: "iOS",
    });
  });

  it("removes one-time bootstrap credentials before persisting pairing URLs", () => {
    expect(redactPairingCredential("https://desktop.example/#token=bootstrap-token")).toBe(
      "https://desktop.example/",
    );
    expect(redactPairingCredential("https://desktop.example/?token=bootstrap-token")).toBe(
      "https://desktop.example/",
    );
  });

  it("removes hosted pairing credentials while keeping the advertised host", () => {
    expect(
      redactPairingCredential(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.example&token=bootstrap-token&label=Desktop",
      ),
    ).toBe("https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.example&label=Desktop");
  });

  it("recognizes explicitly managed relay connections", () => {
    expect(isRelayManagedConnection({ relayManaged: true })).toBe(true);
  });

  it("keeps existing DPoP tunnel records read-only after upgrading", () => {
    expect(isRelayManagedConnection({ authenticationMethod: "dpop" })).toBe(true);
    expect(isRelayManagedConnection({ authenticationMethod: "bearer" })).toBe(false);
  });

  it("drops short-lived managed environment credentials from stable records", () => {
    const connection = {
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

    expect(toStableSavedRemoteConnection(connection)).not.toHaveProperty("dpopAccessToken");
  });
});
