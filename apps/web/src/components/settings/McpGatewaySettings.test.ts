import { describe, expect, it } from "vite-plus/test";

import {
  MCP_GATEWAY_BASELINE_SCOPES,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
} from "../../mcpGatewayState";
import type { McpGatewayRelayPreview } from "@t3tools/contracts";

import {
  mcpGrantCeilings,
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
  const preview = (serverId: string, fields: Partial<McpGatewayRelayPreview>) => ({
    serverId,
    preview: { grants: {}, refusals: {}, ...fields },
  });
  const all = [...MCP_GATEWAY_CONFIGURABLE_SCOPES];

  it.each([
    ["no server answered", [], undefined, undefined],
    [
      "a server relays everything",
      [preview("laptop", { grants: { [macbook]: all } })],
      undefined,
      undefined,
    ],
    [
      "a server refuses it, in its own words",
      [preview("laptop", { refusals: { [macbook]: "Revoked." } })],
      [],
      "Revoked.",
    ],
    [
      "a server caps it at reading",
      [preview("laptop", { grants: { [macbook]: ["read"] }, limit: "Only reads." })],
      ["read"],
      "Only reads.",
    ],
    [
      "another server relays what one refuses",
      [
        preview("laptop", { refusals: { [macbook]: "Revoked." } }),
        preview("studio", { grants: { [macbook]: all } }),
      ],
      undefined,
      undefined,
    ],
    // A server's answer about itself is not what other servers relay.
    [
      "only the machine itself answered",
      [preview(macbook, { refusals: { [macbook]: "No." } })],
      undefined,
      undefined,
    ],
  ] as const)("shows what servers relay when %s", (_label, previews, scopes, reason) => {
    const ceiling = mcpGrantCeilings(previews, [macbook])[macbook];
    expect(ceiling?.scopes).toEqual(scopes);
    expect(ceiling?.reason).toEqual(reason);
  });
});
