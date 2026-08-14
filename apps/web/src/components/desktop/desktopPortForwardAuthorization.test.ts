import { describe, expect, it } from "vite-plus/test";

import {
  isMissingPortForwardEnvironment,
  portForwardAuthorizationErrorMessage,
} from "./desktopPortForwardAuthorization";

describe("desktop port-forward authorization", () => {
  it("never sends an empty IPC error", () => {
    expect(portForwardAuthorizationErrorMessage(new Error(""))).toBe(
      "The environment could not authorize this connection.",
    );
    expect(portForwardAuthorizationErrorMessage("   ")).toBe(
      "The environment could not authorize this connection.",
    );
  });

  it("preserves a typed authorization failure message", () => {
    expect(
      portForwardAuthorizationErrorMessage({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        message: "Remote environment returned status 404.",
      }),
    ).toBe("Remote environment returned status 404.");
  });

  it("identifies renderers that do not own the requested environment", () => {
    expect(isMissingPortForwardEnvironment({ _tag: "EnvironmentNotRegisteredError" })).toBe(true);
    expect(isMissingPortForwardEnvironment({ _tag: "RemoteEnvironmentAuthFetchError" })).toBe(
      false,
    );
  });
});
