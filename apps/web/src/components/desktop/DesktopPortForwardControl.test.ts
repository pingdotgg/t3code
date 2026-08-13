import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePortForwardEnvironmentId } from "./DesktopPortForwardControl";

const development = "development" as EnvironmentId;
const emaildev = "emaildev" as EnvironmentId;

describe("resolvePortForwardEnvironmentId", () => {
  it("follows the active thread when its environment changes", () => {
    expect(
      resolvePortForwardEnvironmentId({
        connectedEnvironmentIds: [development, emaildev],
        preferredEnvironmentId: emaildev,
        selection: {
          contextEnvironmentId: development,
          environmentId: development,
        },
      }),
    ).toBe(emaildev);
  });

  it("preserves an explicit selection within the current thread", () => {
    expect(
      resolvePortForwardEnvironmentId({
        connectedEnvironmentIds: [development, emaildev],
        preferredEnvironmentId: emaildev,
        selection: {
          contextEnvironmentId: emaildev,
          environmentId: development,
        },
      }),
    ).toBe(development);
  });

  it("falls back when the preferred environment is disconnected", () => {
    expect(
      resolvePortForwardEnvironmentId({
        connectedEnvironmentIds: [development],
        preferredEnvironmentId: emaildev,
        selection: {
          contextEnvironmentId: emaildev,
          environmentId: emaildev,
        },
      }),
    ).toBe(development);
  });
});
