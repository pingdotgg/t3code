import { describe, expect, it } from "@effect/vitest";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";

import {
  isAllowedEndpointOrigin,
  isSupportedLinkProviderKind,
  linkProofScopes,
  parseManagedEndpointLocalOrigin,
} from "./linkChecks.ts";

describe("isAllowedEndpointOrigin", () => {
  const origin = { localHttpHost: "127.0.0.1", localHttpPort: 3773 };

  it("accepts the WSL NAT request only when trusted by the server", () => {
    expect(
      isAllowedEndpointOrigin({
        origin,
        requestUrl: "http://172.24.162.233:3773/api/connect/link-proof",
        allowNonLoopbackRequestHost: true,
      }),
    ).toBe(true);
    expect(
      isAllowedEndpointOrigin({
        origin,
        requestUrl: "http://172.24.162.233:3773/api/connect/link-proof",
      }),
    ).toBe(false);
  });

  it("retains signed-origin and port checks", () => {
    expect(
      isAllowedEndpointOrigin({
        origin: { localHttpHost: "172.24.162.233", localHttpPort: 3773 },
        requestUrl: "http://172.24.162.233:3773/",
        allowNonLoopbackRequestHost: true,
      }),
    ).toBe(false);
    expect(
      isAllowedEndpointOrigin({
        origin,
        requestUrl: "http://172.24.162.233:3774/",
        allowNonLoopbackRequestHost: true,
      }),
    ).toBe(false);
  });
});

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

  it("accepts managed and manual endpoints but not t3_relay", () => {
    expect(isSupportedLinkProviderKind(proofRequest("cloudflare_tunnel"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("manual"))).toBe(true);
    expect(isSupportedLinkProviderKind(proofRequest("t3_relay"))).toBe(false);
  });

  it("only claims the managed-tunnel scope for tunnel links", () => {
    expect(linkProofScopes(proofRequest("cloudflare_tunnel"))).toEqual([
      "agent_activity_notifications",
      "managed_tunnels",
    ]);
    expect(linkProofScopes(proofRequest("manual"))).toEqual(["agent_activity_notifications"]);
  });
});
