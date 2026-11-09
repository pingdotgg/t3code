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
  reachability: reachable,
  tunnelHostname: "prod-a1.t3coderelay.com",
};

const open = {
  cloudConfigured: true,
  signedIn: true,
  connected: true,
  approvalCodes: true,
  canReadRelay: true,
  linkState: tunnel,
  linkStateError: null,
  relayEndpoint: undefined,
  checking: false,
} satisfies Parameters<typeof resolveMcpGate>[0];

describe("resolveMcpGate", () => {
  it("opens on a reachable T3 Connect tunnel, at its MCP URL", () => {
    expect(resolveMcpGate(open)).toEqual({
      kind: "open",
      mcpUrl: "https://prod-a1.t3coderelay.com/mcp",
    });
    // A saved machine's tunnel address from T3 Connect counts too.
    expect(
      resolveMcpGate({
        ...open,
        linkState: { ...tunnel, tunnelHostname: undefined },
        relayEndpoint: {
          httpBaseUrl: "https://prod-b2.t3coderelay.com",
          wsBaseUrl: "wss://prod-b2.t3coderelay.com",
          providerKind: "cloudflare_tunnel",
        },
      }),
    ).toEqual({ kind: "open", mcpUrl: "https://prod-b2.t3coderelay.com/mcp" });
  });

  it.each([
    ["no T3 Connect sign-in", { signedIn: false }, "sign-in"],
    ["no permission to read T3 Connect", { canReadRelay: false }, "no-relay-read"],
    ["a server without approval codes", { approvalCodes: false }, "update"],
    ["no tunnel", { linkState: { ...tunnel, managedTunnelActive: false } }, "turn-on"],
    ["a removed link", { linkState: { ...tunnel, linkRevoked: true } }, "turn-on"],
    [
      "a publish-only link's local address",
      {
        linkState: { ...tunnel, tunnelHostname: undefined },
        relayEndpoint: {
          httpBaseUrl: "http://127.0.0.1:3773",
          wsBaseUrl: "ws://127.0.0.1:3773",
          providerKind: "manual",
        },
      },
      "turn-on",
    ],
    [
      "an offline tunnel",
      {
        linkState: {
          ...tunnel,
          reachability: {
            status: "unreachable",
            checkedAt: "2026-11-08T00:00:00.000Z",
            cause: "no_connector",
            reason: "Cloudflare has no live connection from this machine for the tunnel.",
            hint: null,
            fix: "Restart T3 Code.",
          },
        },
      },
      "offline",
    ],
    ["a tunnel not checked yet", { linkState: { ...tunnel, reachability: undefined } }, "offline"],
    [
      "a tunnel without an address",
      { linkState: { ...tunnel, tunnelHostname: undefined } },
      "offline",
    ],
  ] as const)("stays closed with %s", (_, override, kind) => {
    expect(resolveMcpGate({ ...open, ...override }).kind).toBe(kind);
  });

  it("names a build without T3 Connect before asking anyone to sign in", () => {
    expect(resolveMcpGate({ ...open, cloudConfigured: false, signedIn: false }).kind).toBe(
      "unavailable",
    );
  });
});
