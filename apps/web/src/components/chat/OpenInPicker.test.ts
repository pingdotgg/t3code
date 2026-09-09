import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./OpenInPicker";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");
  const otherEnvironmentId = EnvironmentId.make("environment-other");

  it("shows the picker for the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for desktop-local backends such as WSL", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: true,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker when a remote environment has no SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId: null,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for an unclassified non-primary local-exec environment", () => {
    expect(
      shouldShowOpenInPicker({
        environmentId: otherEnvironmentId,
        primaryEnvironmentId,
        isDesktopLocalEnvironment: false,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });
});
