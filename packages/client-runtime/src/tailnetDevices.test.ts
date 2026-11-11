import {
  EnvironmentId,
  type NetworkMember,
  type PeerLinkSummary,
  type TailnetDevice,
  TailnetDevicesSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  canManageNetwork,
  isTailnetDevicesForbidden,
  narrowsAccess,
  networkRows,
} from "./tailnetDevices.ts";

const studio = EnvironmentId.make("env-studio");
const box = EnvironmentId.make("env-box");
const vps = EnvironmentId.make("env-vps");
const laptop = EnvironmentId.make("env-laptop");

const member = (
  environmentId: EnvironmentId,
  access: NetworkMember["access"] = "full-access",
): NetworkMember => ({
  environmentId,
  label: environmentId,
  nodeId: null,
  access,
  updatedAt: { wallMs: 1, counter: 0, node: environmentId },
});
const device = (
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<TailnetDevice> = {},
): TailnetDevice => ({
  environmentId,
  label,
  urls: [`https://${label}.ts.net`],
  status: "online",
  access: "full-access",
  member: member(environmentId),
  localLimit: null,
  outgoing: "tailnet",
  incoming: true,
  tailnetName: label,
  lastSeenAt: null,
  ...overrides,
});
const link = (environmentId: EnvironmentId, label: string): PeerLinkSummary => ({
  environmentId,
  label,
  urls: [],
  access: "approval-required",
  origin: "paired",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
  status: "reachable",
});

describe("networkRows", () => {
  it("splits members, found machines and paired links, one row per environment", () => {
    const rows = networkRows({
      devices: [
        device(studio, "Studio"),
        device(box, "Box", { access: null, member: null, outgoing: null }),
        // Seen only through a session it holds here: no address, so it cannot be added.
        device(laptop, "Laptop", { access: null, member: null, urls: [], outgoing: null }),
      ],
      links: [link(vps, "VPS"), link(studio, "studio-01")],
      savedEnvironmentIds: new Set([vps]),
    });
    expect(
      rows.members.map((row) => [row.environmentId, row.link?.label ?? null, row.savedInApp]),
    ).toEqual([[studio, "studio-01", false]]);
    expect(rows.found.map((found) => found.environmentId)).toEqual([box]);
    expect(rows.paired.map((row) => [row.environmentId, row.device, row.savedInApp])).toEqual([
      [vps, null, true],
    ]);
  });
});

// What `TailnetDevices.list` sends: a revoked member, a member it links to, a machine found on
// the tailnet but not added, and a paired link, as JSON on the wire.
const WIRE_SNAPSHOT = {
  self: { environmentId: "env-here", label: "Here", urls: ["https://here.ts.net"] },
  selfMember: {
    environmentId: "env-here",
    label: "Here",
    nodeId: "n-here",
    access: "full-access",
    updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
  },
  devices: [
    {
      environmentId: "env-box",
      label: "Box",
      urls: ["https://box.ts.net"],
      status: "revoked",
      access: "revoked",
      member: {
        environmentId: "env-box",
        label: "Box",
        nodeId: "n-box",
        access: "revoked",
        updatedAt: { wallMs: 2, counter: 0, node: "env-here" },
      },
      localLimit: null,
      outgoing: null,
      incoming: true,
      tailnetName: "box",
      lastSeenAt: null,
    },
    {
      environmentId: "env-studio",
      label: "studio-01",
      urls: ["https://studio-01.ts.net"],
      status: "online",
      access: "approval-required",
      member: {
        environmentId: "env-studio",
        label: "studio-01",
        nodeId: null,
        access: "full-access",
        updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
      },
      localLimit: "approval-required",
      outgoing: "tailnet",
      incoming: true,
      tailnetName: "studio-01",
      lastSeenAt: "2026-10-30T10:00:00.000Z",
    },
    {
      environmentId: "env-laptop",
      label: "Laptop",
      urls: ["https://laptop.ts.net"],
      status: "online",
      access: null,
      member: null,
      localLimit: null,
      outgoing: null,
      incoming: false,
      tailnetName: "laptop",
      lastSeenAt: "2026-10-30T10:00:00.000Z",
    },
    {
      environmentId: "env-vps",
      label: "VPS",
      urls: ["https://vps.example.com"],
      status: "offline",
      access: "approval-required",
      member: null,
      localLimit: null,
      outgoing: "paired",
      incoming: false,
      tailnetName: null,
      lastSeenAt: null,
    },
  ],
  apps: [
    {
      appId: "app-phone",
      label: "Phone",
      access: "full-access",
      updatedAt: { wallMs: 1, counter: 0, node: "env-here" },
    },
  ],
};

const decodeWireSnapshot = Schema.decodeSync(Schema.toCodecJson(TailnetDevicesSnapshot));

describe("networkRows over the server's snapshot", () => {
  it("keeps every listed device in its group, joined to the link it came from", () => {
    const snapshot = decodeWireSnapshot(WIRE_SNAPSHOT);
    const rows = networkRows({
      devices: snapshot.devices,
      links: [link(vps, "VPS"), link(studio, "studio-01")],
      savedEnvironmentIds: new Set([studio]),
    });
    expect(
      rows.members.map((row) => [row.environmentId, row.device.access, row.link !== null]),
    ).toEqual([
      [box, "revoked", false],
      [studio, "approval-required", true],
    ]);
    expect(rows.found.map((found) => found.environmentId)).toEqual([laptop]);
    expect(rows.paired.map((row) => [row.environmentId, row.device?.access])).toEqual([
      [vps, "approval-required"],
    ]);
    expect(canManageNetwork(snapshot)).toBe(true);
  });
});

describe("canManageNetwork", () => {
  it("lets a full-access member, or a machine starting a network, change it", () => {
    const found = device(box, "Box", { access: null, member: null });
    const joined = device(studio, "Studio");
    expect(canManageNetwork({ selfMember: null, devices: [found] })).toBe(true);
    expect(canManageNetwork({ selfMember: null, devices: [joined] })).toBe(false);
    expect(canManageNetwork({ selfMember: member(laptop), devices: [joined] })).toBe(true);
    expect(canManageNetwork({ selfMember: member(laptop, "auto"), devices: [joined] })).toBe(false);
    expect(canManageNetwork({ selfMember: member(laptop, "revoked"), devices: [] })).toBe(false);
  });
});

describe("narrowsAccess", () => {
  it("is true only for a move to less access, revoking included", () => {
    expect(narrowsAccess("full-access", "auto")).toBe(true);
    expect(narrowsAccess("read-only", "revoked")).toBe(true);
    expect(narrowsAccess("auto", "auto")).toBe(false);
    expect(narrowsAccess("read-only", "full-access")).toBe(false);
    expect(narrowsAccess("revoked", "read-only")).toBe(false);
  });
});

describe("isTailnetDevicesForbidden", () => {
  it("hides rows only when the session may not see them", () => {
    expect(isTailnetDevicesForbidden({ _tag: "EnvironmentAuthorizationError" })).toBe(true);
    expect(isTailnetDevicesForbidden({ _tag: "TailnetDevicesError", reason: "forbidden" })).toBe(
      true,
    );
    expect(isTailnetDevicesForbidden({ _tag: "TailnetDevicesError", reason: "unreachable" })).toBe(
      false,
    );
    expect(isTailnetDevicesForbidden(null)).toBe(false);
  });
});
