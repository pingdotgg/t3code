import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldIncludeProviderUpdateEnvironment } from "./ProviderUpdateLaunchNotification.environments";

const environmentId = EnvironmentId.make("environment");

describe("provider update environments", () => {
  it("keeps the primary and desktop-local backends while they start", () => {
    expect(
      shouldIncludeProviderUpdateEnvironment({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Primary",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        connectionPhase: "connecting",
        hasServerConfig: false,
        operateAccess: "pending",
      }),
    ).toBe(true);

    expect(
      shouldIncludeProviderUpdateEnvironment({
        target: new BearerConnectionTarget({
          environmentId,
          label: "WSL",
          connectionId: "local:wsl:ubuntu",
        }),
        connectionPhase: "connecting",
        hasServerConfig: false,
        operateAccess: "pending",
      }),
    ).toBe(true);
  });

  it("includes a connected T3 Connect environment with a live config", () => {
    expect(
      shouldIncludeProviderUpdateEnvironment({
        target: new RelayConnectionTarget({ environmentId, label: "Permafrost" }),
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toBe(true);
  });

  it("excludes a remote this client may only read, so no Update button can be rejected", () => {
    const target = new RelayConnectionTarget({ environmentId, label: "Permafrost" });
    for (const operateAccess of ["denied", "pending"] as const) {
      expect(
        shouldIncludeProviderUpdateEnvironment({
          target,
          connectionPhase: "connected",
          hasServerConfig: true,
          operateAccess,
        }),
      ).toBe(false);
    }
  });

  it("excludes remote environments until they are connected and loaded", () => {
    const target = new RelayConnectionTarget({ environmentId, label: "Permafrost" });

    expect(
      shouldIncludeProviderUpdateEnvironment({
        target,
        connectionPhase: "reconnecting",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toBe(false);
    expect(
      shouldIncludeProviderUpdateEnvironment({
        target,
        connectionPhase: "connected",
        hasServerConfig: false,
        operateAccess: "granted",
      }),
    ).toBe(false);
  });
});
