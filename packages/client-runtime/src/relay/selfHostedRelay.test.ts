import { describe, expect, it } from "vite-plus/test";

import {
  discoverSelfHostedRelay,
  encodeSelfHostedRelay,
  parseStoredSelfHostedRelay,
} from "./selfHostedRelay.ts";

const OIDC = { issuer: "https://sso.example.com", clientId: "t3-code" };

const replying = (reply: () => Response) => {
  const requests: Array<string> = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return reply();
  }) as typeof fetch;
  return { requests, fetchImpl };
};

describe("discoverSelfHostedRelay", () => {
  it("reads the sign-in provider from the relay, accepting a bare host name", async () => {
    const { requests, fetchImpl } = replying(() =>
      Response.json({ oidc: OIDC, managedTunnels: false }),
    );
    await expect(discoverSelfHostedRelay(" relay.example.com/ ", fetchImpl)).resolves.toEqual({
      relayUrl: "https://relay.example.com",
      oidcIssuer: OIDC.issuer,
      oidcClientId: OIDC.clientId,
      managedTunnels: false,
    });
    expect(requests).toEqual(["https://relay.example.com/.well-known/t3-relay"]);
  });

  it.each([
    ["http://relay.example.com", () => Response.json({ oidc: OIDC, managedTunnels: false })],
    ["relay.example.com", () => new Response("not found", { status: 404 })],
    ["relay.example.com", () => Response.json({ oidc: { issuer: OIDC.issuer } })],
    ["relay.example.com", () => Response.json({ oidc: null, managedTunnels: true })],
  ])("rejects %s when the relay cannot be used", async (address, reply) => {
    const { fetchImpl } = replying(reply);
    await expect(discoverSelfHostedRelay(address, fetchImpl)).rejects.toThrow();
  });
});

describe("parseStoredSelfHostedRelay", () => {
  it("round-trips a stored relay and ignores anything else", () => {
    const relay = {
      relayUrl: "https://relay.example.com",
      oidcIssuer: OIDC.issuer,
      oidcClientId: OIDC.clientId,
      managedTunnels: false,
    };
    expect(parseStoredSelfHostedRelay(encodeSelfHostedRelay(relay))).toEqual(relay);
    expect(parseStoredSelfHostedRelay(null)).toBeNull();
    expect(parseStoredSelfHostedRelay("{")).toBeNull();
    expect(
      parseStoredSelfHostedRelay(
        encodeSelfHostedRelay({ ...relay, relayUrl: "http://relay.example.com" }),
      ),
    ).toBeNull();
  });
});
