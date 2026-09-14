import { describe, expect, it } from "vite-plus/test";

import {
  relayConnectorPath,
  relayEdgeEndpointHostname,
  relayEdgeRouteSuffix,
  relayObjectName,
  resolveRelayEdgeRoute,
} from "./routing.ts";

const userKey = "9f8e7d6c5b4a3210";
const endpointKey = "a1b2c3d4e5f60718";

describe("relay edge routing", () => {
  it("routes public traffic by opaque endpoint and user keys", () => {
    expect(
      resolveRelayEdgeRoute({
        hostname: `${endpointKey}-${userKey}-t3r.tunnels.test`,
        pathname: "/oauth/token",
        edgeRouteSuffix: "t3r.tunnels.test",
      }),
    ).toEqual({ kind: "public", userKey, endpointKey });
  });

  it("routes only the reserved path as a connector", () => {
    expect(
      resolveRelayEdgeRoute({
        hostname: `${endpointKey}-${userKey}-t3r.tunnels.test`,
        pathname: relayConnectorPath,
        edgeRouteSuffix: "t3r.tunnels.test",
      }),
    ).toEqual({ kind: "connector", userKey, endpointKey });
  });

  it("rejects apex, nested, single-key, and unrelated hostnames", () => {
    for (const hostname of [
      "t3r.tunnels.test",
      `${endpointKey}-t3r.tunnels.test`,
      `nested.${endpointKey}-${userKey}-t3r.tunnels.test`,
      `${endpointKey}-${userKey}-t3r.other.test`,
      `${endpointKey}-${userKey}-extra-t3r.tunnels.test`,
      `${endpointKey}-ZZZZ7d6c5b4a3210-t3r.tunnels.test`,
    ]) {
      expect(
        resolveRelayEdgeRoute({
          hostname,
          pathname: "/",
          edgeRouteSuffix: "t3r.tunnels.test",
        }),
      ).toBeNull();
    }
  });

  it("uses separate stable domains per deployment stage", () => {
    expect(relayEdgeRouteSuffix("prod", "tunnels.test")).toBe("t3r.tunnels.test");
    expect(relayEdgeRouteSuffix("pr/123", "tunnels.test")).toBe("t3r-pr-123.tunnels.test");
    expect(
      relayEdgeEndpointHostname("pr/123", "tunnels.test", {
        userKey: `${userKey}ffffffffffffffff`,
        endpointKey: `${endpointKey}0000000000000000`,
      }),
    ).toBe(`${endpointKey}-${userKey}-t3r-pr-123.tunnels.test`);
  });

  it("keeps the whole hostname label within the DNS limit", () => {
    expect(() => relayEdgeRouteSuffix("a".repeat(26), "tunnels.test")).toThrow(RangeError);
    const hostname = relayEdgeEndpointHostname("a".repeat(25), "tunnels.test", {
      userKey,
      endpointKey,
    });
    expect(hostname.split(".")[0]).toHaveLength(63);
  });

  it("names one object per user unless sharding is configured", () => {
    expect(relayObjectName(userKey)).toBe(`user:${userKey}`);
    expect(relayObjectName(userKey, 16)).toBe(`shard:16:${0x9f8e7d6c % 16}`);
    expect(relayObjectName(userKey, 16)).toBe(
      relayObjectName(`${userKey.slice(0, 8)}00000000`, 16),
    );
    expect(() => relayObjectName(userKey, 0)).toThrow(RangeError);
  });
});
