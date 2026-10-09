import { describe, expect, it } from "@effect/vitest";
import type { RelayLinkProofRequest } from "@t3tools/contracts/relay";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  isSupportedLinkProviderKind,
  linkProofScopes,
  parseManagedEndpointLocalOrigin,
  linkProofRequestUrl,
  isAllowedEndpointOrigin,
} from "./linkChecks.ts";

describe("Worker proxy link proof trust", () => {
  const token = "test-worker-proxy-secret-32-characters-long";
  const forwarded = {
    "x-forwarded-host": "app.example.test",
    "x-forwarded-proto": "https",
  };
  const request = (headers: Record<string, string>) =>
    HttpServerRequest.fromWeb(
      new Request("http://app.example.test/api/connect/link-proof", { headers }),
    );

  it("maps a verified Worker request to the actual listener and preserves MCP headers", () => {
    const httpRequest = request({ ...forwarded, "x-t3code-proxy-token": token });
    const url = linkProofRequestUrl(httpRequest, token, 4884);
    expect(url).toBe("http://127.0.0.1:4884");
    expect(
      isAllowedEndpointOrigin({
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 4884 },
        requestUrl: url!,
      }),
    ).toBe(true);
    expect(
      isAllowedEndpointOrigin({
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        requestUrl: url!,
      }),
    ).toBe(false);
    expect(httpRequest.headers["x-forwarded-host"]).toBe("app.example.test");
    expect(httpRequest.headers["x-forwarded-proto"]).toBe("https");
  });

  it.each([
    { secret: undefined, headers: { ...forwarded, "x-t3code-proxy-token": token } },
    { secret: token, headers: forwarded },
    { secret: token, headers: { ...forwarded, "x-t3code-proxy-token": "wrong" } },
    { secret: "short", headers: { ...forwarded, "x-t3code-proxy-token": "short" } },
    {
      secret: token,
      headers: {
        ...forwarded,
        "x-t3code-proxy-token": token,
        "x-forwarded-host": "app.example.test, evil.example",
      },
    },
    {
      secret: token,
      headers: { ...forwarded, "x-t3code-proxy-token": token, "x-forwarded-proto": "https, http" },
    },
    {
      secret: token,
      headers: { ...forwarded, "x-t3code-proxy-token": token, forwarded: "host=evil.example" },
    },
  ])("rejects unverified or malformed forwarded authority %#", ({ secret, headers }) => {
    expect(linkProofRequestUrl(request(headers), secret, 3773)).toBeNull();
  });

  it("keeps direct requests on their original authority", () => {
    const local = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1:4884/api/connect/link-proof"),
    );
    expect(linkProofRequestUrl(local, undefined, 3773)).toBe(local.originalUrl);
  });

  it("rejects proxy trust when the listener port is unavailable", () => {
    expect(
      linkProofRequestUrl(
        request({ ...forwarded, "x-t3code-proxy-token": token }),
        token,
        undefined,
      ),
    ).toBeNull();
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
