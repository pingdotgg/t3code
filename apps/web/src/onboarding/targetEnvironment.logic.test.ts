import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveOnboardingTargetEnvironment } from "./targetEnvironment.logic";

const primaryEnvironment = {
  environmentId: EnvironmentId.make("primary"),
  connection: { phase: "connected" },
  entry: { target: { _tag: "PrimaryConnectionTarget" } },
  label: "This computer",
} as const;

const olderRemote = {
  environmentId: EnvironmentId.make("older-remote"),
  connection: { phase: "connected" },
  entry: { target: { _tag: "BearerConnectionTarget" } },
  label: "Older computer",
} as const;

const pairedRemote = {
  environmentId: EnvironmentId.make("paired-remote"),
  connection: { phase: "connected" },
  entry: { target: { _tag: "BearerConnectionTarget" } },
  label: "New computer",
} as const;

describe("resolveOnboardingTargetEnvironment", () => {
  it("waits for the exact paired machine instead of using an older connected machine", () => {
    const pendingPairedRemote = { ...pairedRemote, connection: { phase: "connecting" } };

    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRemote, pendingPairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBeNull();
  });

  it("uses the exact paired machine once it connects", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRemote, pairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBe(pairedRemote);
  });

  it("waits for a newly paired machine that has not appeared in the catalog", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBeNull();
  });

  it("uses the primary machine for local onboarding", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "local",
        environments: [primaryEnvironment, olderRemote],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(primaryEnvironment);
  });

  it("does not substitute a remote machine when the local primary is offline", () => {
    const offlinePrimary = { ...primaryEnvironment, connection: { phase: "disconnected" } };

    expect(
      resolveOnboardingTargetEnvironment({
        mode: "local",
        environments: [offlinePrimary, olderRemote],
        primaryEnvironment: offlinePrimary,
        pairedEnvironmentId: null,
      }),
    ).toBeNull();
  });

  it("uses the newest connected remote when no exact machine was selected", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [primaryEnvironment, olderRemote, pairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(pairedRemote);
  });

  it("falls back to the connected primary when no remote is available", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [primaryEnvironment],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(primaryEnvironment);
  });
});
