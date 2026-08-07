import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  desktopLocalConnectionId,
  isDesktopHostedConnectionTarget,
} from "../connection/desktopLocal";
import {
  computeKeepAwake,
  isThreadShellWorking,
  KEEP_AWAKE_BATTERY_MIN_LEVEL,
} from "./desktopCaffeinate";

function shellWithSession(
  session: Partial<NonNullable<EnvironmentThreadShell["session"]>> | null,
): Pick<EnvironmentThreadShell, "session"> {
  return { session: session as EnvironmentThreadShell["session"] };
}

describe("computeKeepAwake", () => {
  const working = { enabled: true, anyLocalAgentWorking: true };

  it("stays off while the setting is disabled or no local agent is working", () => {
    expect(computeKeepAwake({ enabled: false, anyLocalAgentWorking: true, battery: null })).toBe(
      false,
    );
    expect(computeKeepAwake({ enabled: true, anyLocalAgentWorking: false, battery: null })).toBe(
      false,
    );
  });

  it("releases when discharging below the battery cutoff", () => {
    expect(computeKeepAwake({ ...working, battery: { charging: false, level: 0.09 } })).toBe(false);
  });

  it("holds at exactly the battery cutoff", () => {
    expect(
      computeKeepAwake({
        ...working,
        battery: { charging: false, level: KEEP_AWAKE_BATTERY_MIN_LEVEL },
      }),
    ).toBe(true);
  });

  it("holds while charging regardless of level", () => {
    expect(computeKeepAwake({ ...working, battery: { charging: true, level: 0.05 } })).toBe(true);
  });

  it("treats unknown battery state as OK", () => {
    expect(computeKeepAwake({ ...working, battery: null })).toBe(true);
  });
});

describe("isThreadShellWorking", () => {
  it("is idle for settled sessions and running sessions without an active turn", () => {
    expect(isThreadShellWorking(shellWithSession({ status: "running", activeTurnId: null }))).toBe(
      false,
    );
    expect(isThreadShellWorking(shellWithSession({ status: "ready" }))).toBe(false);
    expect(isThreadShellWorking(shellWithSession({ status: "idle" }))).toBe(false);
    expect(isThreadShellWorking(shellWithSession(null))).toBe(false);
  });

  it("is working for a running session with an active turn", () => {
    expect(
      isThreadShellWorking(
        shellWithSession({ status: "running", activeTurnId: TurnId.make("turn-1") }),
      ),
    ).toBe(true);
  });

  it("is working while a session is starting, before its first turn begins", () => {
    expect(isThreadShellWorking(shellWithSession({ status: "starting", activeTurnId: null }))).toBe(
      true,
    );
  });
});

describe("isDesktopHostedConnectionTarget", () => {
  it("classifies the primary local backend as desktop-hosted", () => {
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-primary"),
      httpBaseUrl: "http://127.0.0.1:3773",
      label: "This device",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });
    expect(isDesktopHostedConnectionTarget(target)).toBe(true);
  });

  it("classifies a desktop-local secondary backend as desktop-hosted", () => {
    const target = new BearerConnectionTarget({
      connectionId: desktopLocalConnectionId("wsl:Ubuntu"),
      environmentId: EnvironmentId.make("environment-wsl"),
      label: "WSL (Ubuntu)",
    });
    expect(isDesktopHostedConnectionTarget(target)).toBe(true);
  });

  it("excludes saved remote, SSH, and relay environments", () => {
    const saved = new BearerConnectionTarget({
      connectionId: "saved-remote",
      environmentId: EnvironmentId.make("environment-saved"),
      label: "Home server",
    });
    const ssh = new SshConnectionTarget({
      connectionId: "ssh:home",
      environmentId: EnvironmentId.make("environment-ssh"),
      label: "SSH (home)",
    });
    const relay = new RelayConnectionTarget({
      environmentId: EnvironmentId.make("environment-relay"),
      label: "Relay",
    });
    expect(isDesktopHostedConnectionTarget(saved)).toBe(false);
    expect(isDesktopHostedConnectionTarget(ssh)).toBe(false);
    expect(isDesktopHostedConnectionTarget(relay)).toBe(false);
  });
});
