import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import { discoveredMachineAction, tailnetSignInBaseUrl } from "./tailnet.ts";

const STUDIO = EnvironmentId.make("environment-studio");

function savedAt(httpBaseUrl: string): ConnectionCatalogEntry {
  const target = new BearerConnectionTarget({
    environmentId: STUDIO,
    label: "studio",
    connectionId: "saved",
  });
  return {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: "saved",
        environmentId: STUDIO,
        label: "studio",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
    enabled: true,
  };
}

describe("tailnetSignInBaseUrl", () => {
  it.each([
    ["studio", "http://studio:3773/"],
    ["Studio.tail1234.ts.net", "http://studio.tail1234.ts.net:3773/"],
    ["100.88.1.2", "http://100.88.1.2:3773/"],
    ["100.88.1.2:4000", "http://100.88.1.2:4000/"],
    ["100.88.1.2:80", "http://100.88.1.2:80/"],
    // The `t3 up` QR holds a plain URL with no secret.
    ["http://100.88.1.2:3773", "http://100.88.1.2:3773/"],
    // A saved address with no port is on port 80, so parsing it again keeps it there.
    ["http://100.88.1.2/", "http://100.88.1.2:80/"],
    [" studio:3773 ", "http://studio:3773/"],
  ])("signs in at %s", (input, expected) => {
    expect(tailnetSignInBaseUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "192.168.1.10",
    "backend.example.com",
    "localhost",
    // Serve arrives from loopback, so sign-in over HTTPS is refused.
    "https://studio.tail1234.ts.net",
    "http://100.88.1.2:3773/#token=PAIRCODE",
    "http://100.88.1.2:3773/pair?token=PAIRCODE",
  ])("leaves %j to the pairing-code flow", (input) => {
    expect(tailnetSignInBaseUrl(input)).toBeNull();
  });
});

describe("discoveredMachineAction", () => {
  const machine = {
    environmentId: STUDIO,
    tailnetIpv4: "100.88.1.2",
    magicDnsName: "studio.tail1234.ts.net",
  };

  it("adds a new machine and never adds one the user removed", () => {
    expect(discoveredMachineAction({ machine, entries: new Map(), dismissed: new Set() })).toEqual({
      _tag: "Add",
    });
    expect(
      discoveredMachineAction({ machine, entries: new Map(), dismissed: new Set([STUDIO]) }),
    ).toEqual({ _tag: "Skip" });
  });

  it.each(["192.168.1.10", "100.63.0.1", "100.064.1.2", "studio"])(
    "never signs in at %j, which a host reported as its tailnet address",
    (tailnetIpv4) => {
      expect(
        discoveredMachineAction({
          machine: { ...machine, tailnetIpv4 },
          entries: new Map(),
          dismissed: new Set(),
        }),
      ).toEqual({ _tag: "Skip" });
    },
  );

  it("warns when a saved machine answers at an address it was not saved with", () => {
    const entries = (entry: ConnectionCatalogEntry) => new Map([[STUDIO, entry]]);
    const dismissed = new Set<EnvironmentId>();
    expect(
      discoveredMachineAction({
        machine,
        entries: entries(savedAt("http://100.88.1.2:3773/")),
        dismissed,
      }),
    ).toEqual({ _tag: "Skip" });
    expect(
      discoveredMachineAction({
        machine,
        entries: entries(savedAt("http://studio:3773/")),
        dismissed,
      }),
    ).toEqual({ _tag: "Skip" });
    expect(
      discoveredMachineAction({
        machine,
        entries: entries(savedAt("http://192.168.1.10:3773/")),
        dismissed,
      }),
    ).toEqual({ _tag: "Conflict", label: "studio" });
    // A T3 Connect machine has no direct address to compare.
    expect(
      discoveredMachineAction({
        machine,
        entries: entries({
          target: new RelayConnectionTarget({ environmentId: STUDIO, label: "studio" }),
          profile: Option.none(),
          enabled: true,
        }),
        dismissed,
      }),
    ).toEqual({ _tag: "Skip" });
  });
});
