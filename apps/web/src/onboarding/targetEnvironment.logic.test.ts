import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isOnboardingRelayEnvironment,
  resolveOnboardingTargetEnvironment,
} from "./targetEnvironment.logic";

const primaryEnvironment = {
  environmentId: EnvironmentId.make("primary"),
  connection: { phase: "connected" },
  entry: {
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("primary"),
      label: "This computer",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
    }),
  },
  label: "This computer",
} as const;

const olderRelay = {
  environmentId: EnvironmentId.make("older-remote"),
  connection: { phase: "connected" },
  entry: {
    target: new RelayConnectionTarget({
      environmentId: EnvironmentId.make("older-remote"),
      label: "Older computer",
    }),
  },
  label: "Older computer",
} as const;

const newerRelay = {
  environmentId: EnvironmentId.make("newer-relay"),
  connection: { phase: "connected" },
  entry: {
    target: new RelayConnectionTarget({
      environmentId: EnvironmentId.make("newer-relay"),
      label: "New computer",
    }),
  },
  label: "New computer",
} as const;

const pairedRemote = {
  environmentId: EnvironmentId.make("paired-remote"),
  connection: { phase: "connected" },
  entry: {
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make("paired-remote"),
      label: "Direct computer",
      connectionId: "paired-remote",
    }),
  },
  label: "Direct computer",
} as const;

const sshEnvironment = {
  environmentId: EnvironmentId.make("ssh-remote"),
  connection: { phase: "connected" },
  entry: {
    target: new SshConnectionTarget({
      environmentId: EnvironmentId.make("ssh-remote"),
      label: "SSH computer",
      connectionId: "ssh-remote",
    }),
  },
  label: "SSH computer",
} as const;

const desktopLocalEnvironment = {
  environmentId: EnvironmentId.make("desktop-local-wsl"),
  connection: { phase: "connected" },
  entry: {
    target: new BearerConnectionTarget({
      environmentId: EnvironmentId.make("desktop-local-wsl"),
      label: "WSL",
      connectionId: "local:wsl:Ubuntu",
    }),
  },
  label: "WSL",
} as const;

describe("resolveOnboardingTargetEnvironment", () => {
  it("waits for the exact paired machine instead of using an older connected machine", () => {
    const pendingPairedRemote = { ...pairedRemote, connection: { phase: "connecting" } };

    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRelay, pendingPairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBeNull();
  });

  it("uses the exact paired machine once it connects", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRelay, pairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBe(pairedRemote);
  });

  it("waits for a newly paired machine that has not appeared in the catalog", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRelay],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBeNull();
  });

  it("uses the primary machine for local onboarding", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "local",
        environments: [primaryEnvironment, olderRelay],
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
        environments: [offlinePrimary, olderRelay],
        primaryEnvironment: offlinePrimary,
        pairedEnvironmentId: null,
      }),
    ).toBeNull();
  });

  it("uses the newest connected remote when no exact machine was selected", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [primaryEnvironment, olderRelay, newerRelay],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(newerRelay);
  });

  it("ignores direct, SSH, and desktop-managed connections in Connect mode", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [
          primaryEnvironment,
          olderRelay,
          pairedRemote,
          sshEnvironment,
          desktopLocalEnvironment,
        ],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(olderRelay);
  });

  it("uses the primary computer when no relay connection exists", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [primaryEnvironment, pairedRemote, sshEnvironment, desktopLocalEnvironment],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(primaryEnvironment);
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

describe("isOnboardingRelayEnvironment", () => {
  it("includes only T3 Connect relay targets", () => {
    expect(
      [olderRelay, pairedRemote, sshEnvironment, desktopLocalEnvironment].filter(
        isOnboardingRelayEnvironment,
      ),
    ).toEqual([olderRelay]);
  });
});
