import { describe, expect, it } from "vite-plus/test";

import {
  isMissingPortForwardEnvironment,
  isRejectedPortForwardAuthorization,
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

  it("explains structured environment authorization failures", () => {
    expect(portForwardAuthorizationErrorMessage({ _tag: "EnvironmentAuthInvalidError" })).toBe(
      "The environment authorization expired or was rejected after reconnecting.",
    );
    expect(portForwardAuthorizationErrorMessage({ _tag: "EnvironmentScopeRequiredError" })).toBe(
      "Port forwarding requires terminal access on this environment.",
    );
  });

  it("identifies renderers that do not own the requested environment", () => {
    expect(isMissingPortForwardEnvironment({ _tag: "EnvironmentNotRegisteredError" })).toBe(true);
    expect(isMissingPortForwardEnvironment({ _tag: "RemoteEnvironmentAuthFetchError" })).toBe(
      false,
    );
  });

  it("identifies a rejected environment credential for one reconnect attempt", () => {
    expect(isRejectedPortForwardAuthorization({ _tag: "EnvironmentAuthInvalidError" })).toBe(true);
    expect(isRejectedPortForwardAuthorization({ _tag: "EnvironmentInternalError" })).toBe(false);
  });
});
