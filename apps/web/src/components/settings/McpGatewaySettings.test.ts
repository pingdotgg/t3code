import { describe, expect, it } from "vite-plus/test";

import { MCP_GATEWAY_BASELINE_SCOPES } from "../../mcpGatewayState";
import type { TailnetDevicesSnapshot } from "@t3tools/contracts";

import {
  mcpGrantCeiling,
  toggleMcpGatewayGrantForAll,
  updateMcpGatewayGrant,
} from "./McpGatewaySettings";

const primary = "a534b83f-a352-44d8-aedc-c4230c179390";
const macbook = "2549ba75-2a91-4554-8baa-88e6ae0efa48";
const environments = [
  { environmentId: primary, label: "Primary", connectionState: "connected" },
  { environmentId: macbook, label: "JJ’s MacBook", connectionState: "connected" },
];

describe("MCP environment grants", () => {
  it("preserves explicit lifecycle and control grants when enabling the remaining machines", () => {
    const existing = { [primary]: ["read", "control", "lifecycle"] as const };
    const next = toggleMcpGatewayGrantForAll(existing, environments);
    expect(next[primary]).toEqual(existing[primary]);
    expect(next[macbook]).toEqual(MCP_GATEWAY_BASELINE_SCOPES);
  });

  it("keeps ordinary enable and select-all least privilege", () => {
    expect(toggleMcpGatewayGrantForAll({}, environments)[primary]).toEqual([
      "read",
      "create",
      "send",
    ]);
    expect(updateMcpGatewayGrant({}, primary, "admin", true)).toEqual({ [primary]: ["admin"] });
  });

  it("updates scopes by exact registry id without changing other environment grants", () => {
    const grants = { [primary]: ["read", "create", "send"] as const, [macbook]: ["read"] as const };
    expect(updateMcpGatewayGrant(grants, macbook, "send", true)).toEqual({
      [primary]: ["read", "create", "send"],
      [macbook]: ["read", "send"],
    });
    expect(updateMcpGatewayGrant({ [macbook]: ["read"] }, macbook, "read", false)).toEqual({});
  });

  it("select all turns every visible machine on, then back off", () => {
    const once = toggleMcpGatewayGrantForAll({}, environments);
    expect(once[primary]).toEqual(["read", "create", "send"]);
    expect(once[macbook]).toEqual(["read", "create", "send"]);
    expect(toggleMcpGatewayGrantForAll(once, environments)).toEqual({});
  });

  it("select all is safe on an empty machine list", () => {
    expect(toggleMcpGatewayGrantForAll({ "gone-env": ["read"] }, [])).toEqual({
      "gone-env": ["read"],
    });
  });

  it("select all does not grant machines outside the visible list", () => {
    const next = toggleMcpGatewayGrantForAll(
      { [primary]: ["read"], "hidden-env": ["read"] },
      environments,
    );
    expect(next["hidden-env"]).toEqual(["read"]);
    expect(next[primary]).toContain("read");
  });
});

describe("MCP grant ceiling", () => {
  const snapshot = (fields: object) =>
    ({
      selfMember: { access: "full-access" },
      callerAppId: null,
      apps: [],
      ...fields,
    }) as unknown as TailnetDevicesSnapshot;

  it.each([
    ["a machine in no network", { selfMember: null }, undefined],
    ["a session paired by code", {}, undefined],
    ["a revoked machine", { selfMember: { access: "revoked" } }, []],
    [
      "a full-access app",
      { callerAppId: "phone", apps: [{ appId: "phone", access: "full-access" }] },
      undefined,
    ],
    [
      "a read-only app",
      { callerAppId: "phone", apps: [{ appId: "phone", access: "read-only" }] },
      ["read"],
    ],
    ["an app the roster dropped", { callerAppId: "phone", apps: [] }, []],
  ])("caps %s the way the server does", (_label, fields, scopes) => {
    expect(mcpGrantCeiling(snapshot(fields))?.scopes).toEqual(scopes);
  });
});
