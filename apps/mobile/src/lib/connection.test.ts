import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import {
  isRelayManagedConnection,
  redactPairingCredential,
  toStableSavedRemoteConnection,
} from "./connection";
import { authClientMetadata } from "./authClientMetadata";

const mobilePlatform = vi.hoisted(() => ({ OS: "ios" as "ios" | "android" }));
const mobileDevice = vi.hoisted(() => ({
  osVersion: "18.4.1",
  modelName: "iPhone 15 Pro",
}));

vi.mock("./runtime", () => ({
  runtime: {
    runPromise: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: mobilePlatform,
}));

vi.mock("expo-device", () => mobileDevice);

describe("mobile remote connection records", () => {
  afterEach(() => {
    mobilePlatform.OS = "ios";
    mobileDevice.osVersion = "18.4.1";
    mobileDevice.modelName = "iPhone 15 Pro";
  });

  it("identifies mobile token exchanges for authorized-client presentation", () => {
    expect(authClientMetadata()).toEqual({
      label: "T3 Code Mobile",
      deviceType: "mobile",
      os: "iOS",
      osMajorVersion: 18,
      deviceModel: "iPhone 15 Pro",
      surface: "mobile",
    });
  });

  it("includes only the Android major version and hardware model", () => {
    mobilePlatform.OS = "android";
    mobileDevice.osVersion = "15.2.1";
    mobileDevice.modelName = "Pixel 9";

    expect(authClientMetadata()).toMatchObject({
      os: "Android",
      osMajorVersion: 15,
      deviceModel: "Pixel 9",
    });
  });

  it("includes the mobile app version when the client provides it", () => {
    expect(authClientMetadata("1.2.3")).toMatchObject({
      surface: "mobile",
      appVersion: "1.2.3",
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
