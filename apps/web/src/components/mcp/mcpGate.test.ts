import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveMcpGate } from "./mcpGate";

const reachable = {
  status: "reachable",
  checkedAt: "2026-11-08T00:00:00.000Z",
  readyConnections: 4,
  protocol: "quic",
} as const;

const tunnel: EnvironmentCloudLinkStateResult = {
  linked: true,
  cloudUserId: "user_1",
  relayUrl: "https://relay.example.test",
  relayIssuer: "https://relay.example.test",
  managedTunnelActive: true,
  publishAgentActivity: true,
  tunnelHostname: "prod-a1.t3coderelay.com",
};

const savedTunnel = {
  httpBaseUrl: "https://prod-b2.t3coderelay.com",
  wsBaseUrl: "wss://prod-b2.t3coderelay.com",
  providerKind: "cloudflare_tunnel",
} as const;

const open = {
  signedIn: true,
  connected: true,
  approvalCodes: true,
  canReadRelay: true,
  linkState: tunnel,
  linkStateError: null,
  thisMachine: true,
  relay: { status: "listed", endpoint: undefined },
  reachability: reachable,
} satisfies Parameters<typeof resolveMcpGate>[0];

const saved = {
  ...open,
  thisMachine: false,
  relay: { status: "listed", endpoint: savedTunnel },
} satisfies Parameters<typeof resolveMcpGate>[0];

describe("resolveMcpGate", () => {
  it("opens on a fresh reachable check, at the tunnel's MCP URL", () => {
    expect(resolveMcpGate(open)).toEqual({
      kind: "open",
      mcpUrl: "https://prod-a1.t3coderelay.com/mcp",
    });
    // A saved machine's address comes from T3 Connect, not from what it reports itself.
    expect(resolveMcpGate(saved)).toEqual({
      kind: "open",
      mcpUrl: "https://prod-b2.t3coderelay.com/mcp",
    });
    // This machine's probe outranks a stale publish-only record in that list.
    expect(
      resolveMcpGate({
        ...open,
        relay: { status: "listed", endpoint: { ...savedTunnel, providerKind: "manual" } },
      }).kind,
    ).toBe("open");
  });

  it.each([
    ["no T3 Connect sign-in", { ...open, signedIn: false }, "sign-in"],
    ["no permission to read T3 Connect", { ...open, canReadRelay: false }, "no-relay-read"],
    ["a server without approval codes", { ...open, approvalCodes: false }, "update"],
    ["no tunnel", { ...open, linkState: { ...tunnel, managedTunnelActive: false } }, "turn-on"],
    ["a removed link", { ...open, linkState: { ...tunnel, linkRevoked: true } }, "turn-on"],
    [
      "a publish-only link's local address",
      {
        ...saved,
        relay: {
          status: "listed",
          endpoint: {
            ...savedTunnel,
            httpBaseUrl: "http://127.0.0.1:3773",
            providerKind: "manual",
          },
        },
      },
      "turn-on",
    ],
    [
      "a saved machine T3 Connect does not list",
      { ...saved, relay: { status: "listed", endpoint: undefined } },
      "turn-on",
    ],
    ["T3 Connect's list still loading", { ...saved, relay: { status: "loading" } }, "checking"],
    [
      "no tunnel, before T3 Connect's list loads",
      {
        ...saved,
        linkState: { ...tunnel, managedTunnelActive: false },
        relay: { status: "loading" },
      },
      "turn-on",
    ],
    ["the check still running", { ...open, reachability: "checking" }, "checking"],
    [
      "an offline tunnel",
      {
        ...open,
        reachability: {
          status: "unreachable",
          checkedAt: "2026-11-08T00:00:00.000Z",
          cause: "no_connector",
          reason: "Cloudflare has no live connection from this machine for the tunnel.",
          hint: null,
          fix: "Restart T3 Code.",
        },
      },
      "offline",
    ],
    ["a failed check", { ...open, reachability: null }, "offline"],
    [
      "no tunnel address yet",
      { ...open, linkState: { ...tunnel, tunnelHostname: undefined } },
      "offline",
    ],
    [
      "a hostname that is not a plain DNS name",
      { ...open, linkState: { ...tunnel, tunnelHostname: "a.com;touch$IFS/tmp/x" } },
      "offline",
    ],
  ] as const)("stays closed with %s", (_, input, kind) => {
    expect(resolveMcpGate(input).kind).toBe(kind);
  });
});
