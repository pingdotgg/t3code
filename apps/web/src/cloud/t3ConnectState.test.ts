import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isDesktopOwnBackend, resolveT3ConnectTurnOn } from "./t3ConnectState";

const base = { environmentId: EnvironmentId.make("studio"), label: "Studio" };
const canLink = {
  desktopApp: true,
  cloudConfigured: true,
  canReadRelay: true,
  canWriteRelay: true,
  connectDenial: undefined,
};

describe("resolveT3ConnectTurnOn", () => {
  it.each([
    [
      "this desktop's backend",
      new PrimaryConnectionTarget({
        ...base,
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      }),
      true,
      "here",
    ],
    // A WSL backend answers on its distro's address, not loopback.
    [
      "this desktop's WSL backend",
      new PrimaryConnectionTarget({
        ...base,
        httpBaseUrl: "http://172.28.16.5:3773",
        wsBaseUrl: "ws://172.28.16.5:3773",
      }),
      true,
      "here",
    ],
    [
      "a second WSL backend",
      new BearerConnectionTarget({ ...base, connectionId: "local:wsl-ubuntu" }),
      false,
      "here",
    ],
    [
      "a machine saved by its LAN address",
      new BearerConnectionTarget({ ...base, connectionId: "saved-192.168.1.20" }),
      true,
      "on-host",
    ],
    [
      "a browser's own server",
      new PrimaryConnectionTarget({
        ...base,
        httpBaseUrl: "http://192.168.1.20:3773",
        wsBaseUrl: "ws://192.168.1.20:3773",
      }),
      false,
      "on-host",
    ],
  ] as const)("on %s: %s", (_, target, primaryIsDesktopManaged, kind) => {
    expect(
      resolveT3ConnectTurnOn({
        ...canLink,
        ownBackend: isDesktopOwnBackend(target, primaryIsDesktopManaged),
      }).kind,
    ).toBe(kind);
  });

  it("needs the desktop app and both relay permissions, and names a policy that refuses", () => {
    const own = { ...canLink, ownBackend: true };
    expect(resolveT3ConnectTurnOn({ ...own, desktopApp: false }).kind).toBe("on-host");
    expect(resolveT3ConnectTurnOn({ ...own, canWriteRelay: false }).kind).toBe("on-host");
    expect(resolveT3ConnectTurnOn({ ...own, connectDenial: "Off by policy." })).toEqual({
      kind: "policy",
      reason: "Off by policy.",
    });
  });
});
