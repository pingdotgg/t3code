import { describe, expect, it } from "@effect/vitest";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";

import * as NetAddress from "effect/net/NetAddress";

import { loopbackUrlHostForAddress } from "../startupAccess.ts";
import {
  isAllowedEndpointOrigin,
  linkProofScopes,
  parseManagedEndpointLocalOrigin,
} from "./linkChecks.ts";

describe("parseManagedEndpointLocalOrigin", () => {
  it.each([
    {
      input: "http://127.0.0.1:80",
      httpBaseUrl: "http://127.0.0.1",
      wsBaseUrl: "ws://127.0.0.1",
      port: 80,
    },
    {
      input: "https://127.0.0.1:443",
      httpBaseUrl: "https://127.0.0.1",
      wsBaseUrl: "wss://127.0.0.1",
      port: 443,
    },
  ])("accepts an explicit default port in $input", ({ input, httpBaseUrl, wsBaseUrl, port }) => {
    expect(parseManagedEndpointLocalOrigin(input)).toEqual({
      httpBaseUrl,
      wsBaseUrl,
      origin: { localHttpHost: "127.0.0.1", localHttpPort: port },
    });
  });

  it.each([
    "ftp://127.0.0.1:3773",
    "http://user:password@127.0.0.1:3773",
    "http://127.0.0.1:3773/api",
    "http://127.0.0.1:3773?mode=test",
    "http://127.0.0.1:3773#fragment",
  ])("rejects non-origin URL %s", (input) => {
    expect(() => parseManagedEndpointLocalOrigin(input)).toThrow("Invalid local origin");
  });

  it.each(["0.0.0.0", "::", "127.0.0.1", "100.101.102.103", "192.168.1.42"])(
    "builds an allowed managed tunnel origin for a server bound to %s",
    (ip) => {
      const address = NetAddress.inetAddressFromIpStringUnsafe(ip, 3773);
      const parsed = parseManagedEndpointLocalOrigin(
        `http://${loopbackUrlHostForAddress(address)}:${address.port}`,
      );
      expect(
        isAllowedEndpointOrigin({ origin: parsed.origin, requestUrl: parsed.httpBaseUrl }),
      ).toBe(true);
    },
  );

  it.each([
    ["http://192.168.1.42:3773", "http://127.0.0.1:3773", undefined],
    ["http://192.168.1.42:3773", "http://192.168.1.43:3773", undefined],
    ["http://example.com:3773", "http://example.com:3773", undefined],
    // A server bound to every interface tunnels to loopback, not the address a client used.
    ["http://192.168.1.42:3773", "http://192.168.1.42:3773", "127.0.0.1"],
  ])("rejects origin %s for request %s on server host %s", (origin, requestUrl, serverHost) => {
    expect(
      isAllowedEndpointOrigin({
        origin: parseManagedEndpointLocalOrigin(origin).origin,
        requestUrl,
        allowNonLoopbackRequestHost: true,
        ...(serverHost === undefined ? {} : { serverHost }),
      }),
    ).toBe(false);
  });
});

describe("link proof provider kinds", () => {
  const proofRequest = (
    providerKind: RelayLinkProofRequest["endpoint"]["providerKind"],
  ): RelayLinkProofRequest => ({
    challenge: "challenge",
    relayIssuer: "https://relay.example.test",
    endpoint: {
      httpBaseUrl: "http://127.0.0.1:7331",
      wsBaseUrl: "ws://127.0.0.1:7331",
      providerKind,
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 7331 },
  });

  it("only claims the managed-tunnel scope for tunnel links", () => {
    expect(linkProofScopes(proofRequest("cloudflare_tunnel"))).toEqual([
      "agent_activity_notifications",
      "managed_tunnels",
    ]);
    expect(linkProofScopes(proofRequest("manual"))).toEqual(["agent_activity_notifications"]);
  });
});
