import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionRoute } from "./catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import { connectionRouteKind, connectionRouteLabel, insertRoute, upsertRoute } from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function direct(id: string, httpBaseUrl: string): ConnectionRoute {
  return {
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      connectionId: id,
    }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: ENVIRONMENT_ID,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  };
}

const RELAY: ConnectionRoute = {
  target: new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Desk" }),
  profile: Option.none(),
};
const LAN = direct("lan", "http://192.168.1.10:3773/");
const TAILNET = direct("tailnet", "https://desk.tail1234.ts.net/");
const PUBLIC = direct("public", "https://desk.example.com/");

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:3773/"))).toBe("tailnet");
    expect(connectionRouteKind(TAILNET)).toBe("tailnet");
    expect(connectionRouteKind(PUBLIC)).toBe("public");
    expect(connectionRouteKind(direct("lo", "http://127.0.0.1:3773/"))).toBe("loopback");
    expect(connectionRouteKind(direct("ts6", "http://[fd7a:115c:a1e0::1]:3773/"))).toBe("tailnet");
    expect(connectionRouteLabel(TAILNET)).toBe("Tailscale");
    expect(connectionRouteLabel(RELAY)).toBe("T3 Connect");
  });

  it("places a new route after faster kinds and ahead of T3 Connect", () => {
    expect(insertRoute([RELAY], LAN)).toEqual([LAN, RELAY]);
    expect(insertRoute([LAN, RELAY], TAILNET)).toEqual([LAN, TAILNET, RELAY]);
    expect(insertRoute([TAILNET], LAN)).toEqual([LAN, TAILNET]);
    expect(insertRoute([LAN, TAILNET], RELAY)).toEqual([LAN, TAILNET, RELAY]);
  });

  it("keeps a user's order when a saved route is replaced", () => {
    // The user preferred T3 Connect over the LAN; re-pairing the LAN keeps that.
    const repaired = direct("lan", "http://192.168.1.11:3773/");
    expect(upsertRoute([RELAY, LAN], repaired)).toEqual([RELAY, repaired]);
  });
});
