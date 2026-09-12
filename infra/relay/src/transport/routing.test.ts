import { describe, expect, it } from "vite-plus/test";

import {
  relayConnectorPath,
  relayEdgeEndpointHostname,
  relayEdgeRouteSuffix,
  resolveRelayEdgeRoute,
} from "./routing.ts";

describe("relay edge routing", () => {
  it("routes public traffic by opaque endpoint hostname", () => {
    expect(
      resolveRelayEdgeRoute({
        hostname: "a1b2c3d4e5f60718-t3r.tunnels.test",
        pathname: "/oauth/token",
        edgeRouteSuffix: "t3r.tunnels.test",
      }),
    ).toEqual({ kind: "public", endpointKey: "a1b2c3d4e5f60718" });
  });

  it("routes only the reserved path as a connector", () => {
    expect(
      resolveRelayEdgeRoute({
        hostname: "a1b2c3d4e5f60718-t3r.tunnels.test",
        pathname: relayConnectorPath,
        edgeRouteSuffix: "t3r.tunnels.test",
      }),
    ).toEqual({ kind: "connector", endpointKey: "a1b2c3d4e5f60718" });
  });

  it("rejects apex, nested, and unrelated hostnames", () => {
    for (const hostname of [
      "t3r.tunnels.test",
      "nested.a1b2c3d4e5f60718-t3r.tunnels.test",
      "a1b2c3d4e5f60718-t3r.other.test",
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
      relayEdgeEndpointHostname("pr/123", "tunnels.test", "a1b2c3d4e5f6071829384756aabbccdd"),
    ).toBe("a1b2c3d4e5f60718-t3r-pr-123.tunnels.test");
  });
});
