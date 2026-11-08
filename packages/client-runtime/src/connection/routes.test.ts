import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import {
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  credentialConnectionId,
  insertRoute,
  entryWithRoutes,
  claimedGatewayPeerIds,
  desiredGatewayPeers,
  gatewayPeerUpstreamUrl,
  mergeGatewayRoutes,
  mergeLearnedRoutes,
  pendingRouteOrder,
  planGatewayPeerReconcile,
  retainedGatewayPeerIds,
  removedWithRelay,
  routesAfterRemoving,
  sendsTokenInClear,
  upsertRoute,
  usableRoutes,
} from "./routes.ts";

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

function learned(id: string, httpBaseUrl: string): ConnectionRoute {
  const route = direct(id, httpBaseUrl);
  const profile = Option.getOrThrow(route.profile) as BearerConnectionProfile;
  return {
    target: route.target,
    profile: Option.some(new BearerConnectionProfile({ ...profile, learned: true })),
  };
}

describe("connection routes", () => {
  it("classifies direct routes by address", () => {
    expect(connectionRouteKind(LAN)).toBe("lan");
    // Tailscale, Cloudflare WARP and Mesh, and other VPNs share 100.64.0.0/10.
    expect(connectionRouteKind(direct("ip", "http://100.101.102.103:3773/"))).toBe("vpn");
    expect(connectionRouteLabel(direct("mesh", "http://100.96.0.1:3773/"))).toBe("VPN");
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
    const repaired = direct("lan", "http://192.168.1.11:3773/");
    expect(upsertRoute([RELAY, LAN], repaired)).toEqual([RELAY, repaired]);
  });

  it("puts a newly paired route ahead of saved routes of the same kind", () => {
    const pasted = direct("lan-2", "http://192.168.1.11:3773/");
    expect(upsertRoute([LAN, TAILNET], pasted)).toEqual([pasted, LAN, TAILNET]);
  });

  it("keeps a newly paired route behind a different kind of the same rank", () => {
    const vpn = direct("vpn", "http://100.101.102.103:3773/");
    const pasted = direct("ts-2", "http://[fd7a:115c:a1e0::2]:3773/");
    expect(upsertRoute([vpn, TAILNET], pasted)).toEqual([vpn, pasted, TAILNET]);
  });

  it("shows a dragged order only until the saved routes catch up or change", () => {
    const dragged = ["tailnet", "lan"];
    expect(pendingRouteOrder(dragged, ["lan", "tailnet"])).toBe(dragged);
    expect(pendingRouteOrder(dragged, ["tailnet", "lan"])).toBeNull();
    expect(pendingRouteOrder(dragged, ["lan", "public"])).toBeNull();
    expect(pendingRouteOrder(dragged, ["lan", "tailnet", "public"])).toBeNull();
  });
});

describe("learned routes", () => {
  const relayOnly: ConnectionCatalogEntry = {
    target: RELAY.target,
    profile: RELAY.profile,
    enabled: true,
  };
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("learns a LAN address over T3 Connect, ahead of it, using the T3 Connect credential", () => {
    const routes = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([`learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773`, "relay"]);
    expect(profileOf(routes![0]!)).toMatchObject({
      learned: true,
      authorization: "t3-connect",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    });
  });

  it("replaces a learned LAN address when the server reports a new one", () => {
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(moved)).toEqual([`learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773`, "relay"]);
  });

  it("keeps a learned route where the user moved it while the server reports it", () => {
    const lan = { httpBaseUrl: "http://192.168.1.10:3773/" };
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [lan],
      allowInsecure: true,
    })!;
    const reordered = entryWithRoutes(relayOnly, [first[1]!, first[0]!]);
    expect(
      mergeLearnedRoutes({
        entry: reordered,
        activeRoute: RELAY,
        reported: [lan],
        allowInsecure: true,
      }),
    ).toBeNull();
    const next = mergeLearnedRoutes({
      entry: reordered,
      activeRoute: RELAY,
      reported: [lan, { httpBaseUrl: "http://100.101.102.103:3773/" }],
      allowInsecure: true,
    });
    expect(ids(next)).toEqual([
      `learned:${ENVIRONMENT_ID}:http://100.101.102.103:3773`,
      "relay",
      `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773`,
    ]);
  });

  it("labels a learned address Tailscale only while the server reports it as tailnet", () => {
    const tailscale = { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" };
    const mesh = { kind: "lan", httpBaseUrl: "http://100.96.0.1:3773/" };
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [tailscale, mesh],
      allowInsecure: true,
    })!;
    expect(first.map(connectionRouteLabel)).toEqual(["Tailscale", "VPN", "T3 Connect"]);

    const corrected = mergeLearnedRoutes({
      entry: entryWithRoutes(relayOnly, first),
      activeRoute: RELAY,
      reported: [{ ...tailscale, kind: "lan" }, mesh],
      allowInsecure: true,
    })!;
    expect(ids(corrected)).toEqual(ids(first));
    expect(corrected.map(connectionRouteLabel)).toEqual(["VPN", "VPN", "T3 Connect"]);
    expect(
      mergeLearnedRoutes({
        entry: entryWithRoutes(relayOnly, corrected),
        activeRoute: RELAY,
        reported: [{ ...tailscale, kind: "lan" }, mesh],
        allowInsecure: true,
      }),
    ).toBeNull();
  });

  it("leaves user routes alone and does not learn an address already saved", () => {
    const entry: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [RELAY],
      enabled: true,
    };
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: RELAY,
        reported: [{ httpBaseUrl: "http://192.168.1.10:3773" }],
        allowInsecure: true,
      }),
    ).toBeNull();
    expect(
      mergeLearnedRoutes({ entry, activeRoute: RELAY, reported: [], allowInsecure: true }),
    ).toBeNull();
  });

  it("borrows the paired token when learned over a bearer route", () => {
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: LAN.target,
      profile: LAN.profile,
    };
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    const learned = routes.find((route) => connectionRouteKind(route) === "tailnet")!;
    expect(profileOf(learned)).not.toHaveProperty("authorization");
    expect(credentialConnectionId(connectionRouteId(learned.target))).toBe("lan");
  });

  it("keeps a token paired over HTTPS off plain HTTP addresses outside the tailnet", () => {
    const entry = entryWithRoutes(relayOnly, [PUBLIC, RELAY]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: PUBLIC,
      reported: [
        { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
        { kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3773/" },
        { kind: "tailnet", httpBaseUrl: "https://desk.tail1234.ts.net/" },
      ],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      `learned:${ENVIRONMENT_ID}:http://100.101.102.103:3773@public`,
      `learned:${ENVIRONMENT_ID}:https://desk.tail1234.ts.net@public`,
      "public",
      "relay",
    ]);
  });

  it("drops a stale plain HTTP route borrowing an HTTPS-paired token while another route is active", () => {
    const lanOrigin = "http://10.0.0.42:3773";
    const stale = learned(`learned:${ENVIRONMENT_ID}:${lanOrigin}@public`, `${lanOrigin}/`);
    const entry = entryWithRoutes(relayOnly, [stale, PUBLIC, RELAY]);
    expect(sendsTokenInClear([stale, PUBLIC, RELAY], stale)).toBe(true);
    expect(ids(usableRoutes(entry))).toEqual(["public", "relay"]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ kind: "lan", httpBaseUrl: `${lanOrigin}/` }],
      allowInsecure: true,
    });
    // The stale route is gone; the address is learned again with T3 Connect's credential.
    expect(ids(routes)).toEqual([`learned:${ENVIRONMENT_ID}:${lanOrigin}`, "public", "relay"]);
    expect(profileOf(routes![0]!)).toMatchObject({ authorization: "t3-connect" });
  });

  it("keeps plain HTTP routes that don't borrow the active HTTPS-paired token", () => {
    const lanOrigin = "http://10.0.0.42:3773";
    const overLan = learned(`learned:${ENVIRONMENT_ID}:${lanOrigin}@lan`, `${lanOrigin}/`);
    const routes = mergeLearnedRoutes({
      entry: entryWithRoutes(relayOnly, [overLan, LAN, PUBLIC, RELAY]),
      activeRoute: PUBLIC,
      reported: [{ kind: "lan", httpBaseUrl: `${lanOrigin}/` }],
      allowInsecure: true,
    });
    expect(routes).toBeNull();
  });

  it("learns plain HTTP LAN addresses over a token paired over plain HTTP", () => {
    const entry = entryWithRoutes(relayOnly, [LAN, RELAY]);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: LAN,
      reported: [{ kind: "lan", httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual([
      "lan",
      `learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773@lan`,
      "relay",
    ]);
  });

  it("skips plain HTTP from an HTTPS page and never learns loopback", () => {
    expect(
      mergeLearnedRoutes({
        entry: relayOnly,
        activeRoute: RELAY,
        reported: [
          { httpBaseUrl: "http://192.168.1.10:3773/" },
          { httpBaseUrl: "http://127.0.0.1:3773/" },
        ],
        allowInsecure: false,
      }),
    ).toBeNull();
  });

  it("removes learned routes along with the route whose credential they borrow", () => {
    const overRelay = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    expect(routesAfterRemoving(overRelay, "relay")).toEqual([]);

    const paired: ConnectionCatalogEntry = {
      ...relayOnly,
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [RELAY],
    };
    const overLan = mergeLearnedRoutes({
      entry: paired,
      activeRoute: LAN,
      reported: [{ httpBaseUrl: "https://desk.tail1234.ts.net/" }],
      allowInsecure: true,
    })!;
    expect(ids(routesAfterRemoving(overLan, "lan"))).toEqual(["relay"]);
    expect(ids(routesAfterRemoving(overLan, "relay"))).toHaveLength(2);
  });

  it("counts an environment reached only through T3 Connect as removed with it", () => {
    const learned = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    expect(removedWithRelay(relayOnly)).toBe(true);
    expect(removedWithRelay(entryWithRoutes(relayOnly, learned))).toBe(true);
    expect(removedWithRelay(entryWithRoutes(relayOnly, [LAN, RELAY]))).toBe(false);
  });

  it("keeps pull request routing trust when a route is learned", () => {
    const learned = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const withLearned: ConnectionCatalogEntry = {
      ...relayOnly,
      target: learned[0]!.target,
      profile: learned[0]!.profile,
      alternateRoutes: learned.slice(1),
    };
    expect(pullRequestRoutingConnectionKey(withLearned)).toBe(
      pullRequestRoutingConnectionKey(relayOnly),
    );
  });

  it("keeps the T3 Connect credential when learning over a learned T3 Connect route", () => {
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    })!;
    const learnedLan = first[0]!;
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: learnedLan.target,
      profile: learnedLan.profile,
      alternateRoutes: first.slice(1),
    };
    const next = mergeLearnedRoutes({
      entry,
      activeRoute: learnedLan,
      reported: [
        { httpBaseUrl: "http://192.168.1.10:3773/" },
        { httpBaseUrl: "https://desk.tail1234.ts.net/" },
      ],
      allowInsecure: true,
    })!;
    for (const route of next.filter((candidate) => connectionRouteKind(candidate) !== "relay")) {
      expect(profileOf(route)).toMatchObject({ authorization: "t3-connect" });
      expect(connectionRouteId(route.target)).not.toContain("@");
    }
  });

  it("saves a scheme change on the same host as a new address", () => {
    const first = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://desk.local:3773/" }],
      allowInsecure: true,
    })!;
    const entry: ConnectionCatalogEntry = {
      ...relayOnly,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "https://desk.local:3773/" }],
      allowInsecure: true,
    });
    expect(moved).not.toBeNull();
    expect(profileOf(moved![0]!)).toMatchObject({ httpBaseUrl: "https://desk.local:3773/" });
  });
});

describe("gateway routes", () => {
  const GATEWAY_ID = EnvironmentId.make("env_gateway");
  const PEER_ID = EnvironmentId.make("environment-1");
  const gatewayOrigin = "https://connect-host.example/";
  const paired: ConnectionCatalogEntry = {
    target: LAN.target,
    profile: LAN.profile,
    alternateRoutes: [RELAY],
    enabled: true,
  };
  const ids = (routes: ReadonlyArray<ConnectionRoute> | null) =>
    routes?.map((route) => connectionRouteId(route.target)) ?? null;
  const profileOf = (route: ConnectionRoute) => Option.getOrThrow(route.profile);

  it("adds a gateway route ahead of T3 Connect, borrowing the paired credential", () => {
    const routes = mergeGatewayRoutes({
      entry: paired,
      gatewayEnvironmentId: GATEWAY_ID,
      gatewayHttpBaseUrl: gatewayOrigin,
      advertised: [{ environmentId: PEER_ID, label: "Desk" }],
    });
    expect(ids(routes)).toEqual(["lan", `gateway:${GATEWAY_ID}:${PEER_ID}@lan`, "relay"]);
    expect(connectionRouteKind(routes![1]!)).toBe("gateway");
    expect(connectionRouteLabel(routes![1]!)).toBe("LAN gateway");
    expect(profileOf(routes![1]!)).toMatchObject({
      learned: true,
      gatewayEnvironmentId: GATEWAY_ID,
      httpBaseUrl: `https://connect-host.example/__t3_gateway/${PEER_ID}/`,
      wsBaseUrl: `wss://connect-host.example/__t3_gateway/${PEER_ID}/`,
    });
    expect(credentialConnectionId(connectionRouteId(routes![1]!.target))).toBe("lan");
  });

  it("drops gateway routes when the host stops advertising the peer", () => {
    const first = mergeGatewayRoutes({
      entry: paired,
      gatewayEnvironmentId: GATEWAY_ID,
      gatewayHttpBaseUrl: gatewayOrigin,
      advertised: [{ environmentId: PEER_ID, label: "Desk" }],
    })!;
    const entry: ConnectionCatalogEntry = {
      ...paired,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    expect(
      ids(
        mergeGatewayRoutes({
          entry,
          gatewayEnvironmentId: GATEWAY_ID,
          gatewayHttpBaseUrl: gatewayOrigin,
          advertised: [],
        }),
      ),
    ).toEqual(["lan", "relay"]);
  });

  it("retires a gateway route whose credential changed", () => {
    const withRelayOnlyGateway: ConnectionCatalogEntry = {
      ...paired,
      alternateRoutes: [
        RELAY,
        {
          target: new BearerConnectionTarget({
            environmentId: PEER_ID,
            label: "Desk",
            connectionId: `gateway:${GATEWAY_ID}:${PEER_ID}`,
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: `gateway:${GATEWAY_ID}:${PEER_ID}`,
              environmentId: PEER_ID,
              label: "Desk",
              httpBaseUrl: `https://connect-host.example/__t3_gateway/${PEER_ID}/`,
              wsBaseUrl: `wss://connect-host.example/__t3_gateway/${PEER_ID}/`,
              learned: true,
              gatewayEnvironmentId: GATEWAY_ID,
            }),
          ),
        },
      ],
    };
    expect(
      ids(
        mergeGatewayRoutes({
          entry: withRelayOnlyGateway,
          gatewayEnvironmentId: GATEWAY_ID,
          gatewayHttpBaseUrl: gatewayOrigin,
          advertised: [{ environmentId: PEER_ID, label: "Desk" }],
        }),
      ),
    ).toEqual(["lan", `gateway:${GATEWAY_ID}:${PEER_ID}@lan`, "relay"]);
  });

  it("does not create a gateway route without a paired bearer credential", () => {
    expect(
      mergeGatewayRoutes({
        entry: { target: RELAY.target, profile: RELAY.profile, enabled: true },
        gatewayEnvironmentId: GATEWAY_ID,
        gatewayHttpBaseUrl: gatewayOrigin,
        advertised: [{ environmentId: PEER_ID, label: "Desk" }],
      }),
    ).toBeNull();
  });

  it("does not add a learned route when the peer was paired through this gateway", () => {
    const pairedThroughGateway: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId: PEER_ID,
        label: "Desk",
        connectionId: "bearer:peer:https://connect-host.example",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "bearer:peer:https://connect-host.example",
          environmentId: PEER_ID,
          label: "Desk",
          httpBaseUrl: `https://connect-host.example/__t3_gateway/${PEER_ID}/`,
          wsBaseUrl: `wss://connect-host.example/__t3_gateway/${PEER_ID}/`,
          gatewayEnvironmentId: GATEWAY_ID,
        }),
      ),
      enabled: true,
    };
    expect(
      mergeGatewayRoutes({
        entry: pairedThroughGateway,
        gatewayEnvironmentId: GATEWAY_ID,
        gatewayHttpBaseUrl: gatewayOrigin,
        advertised: [{ environmentId: PEER_ID, label: "Desk" }],
      }),
    ).toBeNull();
  });

  it("ignores advertisements for other peers", () => {
    expect(
      mergeGatewayRoutes({
        entry: paired,
        gatewayEnvironmentId: GATEWAY_ID,
        gatewayHttpBaseUrl: gatewayOrigin,
        advertised: [{ environmentId: EnvironmentId.make("env_other"), label: "Other" }],
      }),
    ).toBeNull();
  });

  it("prefers direct routes over gateway, and gateway over relay", () => {
    expect(insertRoute([RELAY], LAN)).toEqual([LAN, RELAY]);
    const gateway = mergeGatewayRoutes({
      entry: paired,
      gatewayEnvironmentId: GATEWAY_ID,
      gatewayHttpBaseUrl: gatewayOrigin,
      advertised: [{ environmentId: PEER_ID, label: "Desk" }],
    })!;
    const gatewayRoute = gateway.find((route) => connectionRouteKind(route) === "gateway")!;
    expect(insertRoute([RELAY], gatewayRoute)).toEqual([gatewayRoute, RELAY]);
  });

  it("keeps gateway routes when learning direct endpoints", () => {
    const withGateway = mergeGatewayRoutes({
      entry: paired,
      gatewayEnvironmentId: GATEWAY_ID,
      gatewayHttpBaseUrl: gatewayOrigin,
      advertised: [{ environmentId: PEER_ID, label: "Desk" }],
    })!;
    const entry: ConnectionCatalogEntry = {
      ...paired,
      target: withGateway[0]!.target,
      profile: withGateway[0]!.profile,
      alternateRoutes: withGateway.slice(1),
    };
    const next = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ kind: "lan", httpBaseUrl: "http://192.168.1.50:13773/" }],
      allowInsecure: true,
    });
    expect(ids(next)).toContain(`gateway:${GATEWAY_ID}:${PEER_ID}@lan`);
  });

  it("rewrites gateway peer URLs when the host origin changes", () => {
    const first = mergeGatewayRoutes({
      entry: paired,
      gatewayEnvironmentId: GATEWAY_ID,
      gatewayHttpBaseUrl: "https://lan-host.example/",
      advertised: [{ environmentId: PEER_ID, label: "Desk" }],
    })!;
    const entry: ConnectionCatalogEntry = {
      ...paired,
      target: first[0]!.target,
      profile: first[0]!.profile,
      alternateRoutes: first.slice(1),
    };
    const next = mergeGatewayRoutes({
      entry,
      gatewayEnvironmentId: GATEWAY_ID,
      gatewayHttpBaseUrl: gatewayOrigin,
      advertised: [{ environmentId: PEER_ID, label: "Desk" }],
    });
    expect(
      profileOf(next!.find((route) => connectionRouteKind(route) === "gateway")!),
    ).toMatchObject({
      httpBaseUrl: `https://connect-host.example/__t3_gateway/${PEER_ID}/`,
    });
  });

  it("drops http gateway routes on an https page", () => {
    const previous = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "https:" },
    });
    try {
      const lanGateway = "http://192.168.1.10:13773/";
      expect(
        mergeGatewayRoutes({
          entry: paired,
          gatewayEnvironmentId: GATEWAY_ID,
          gatewayHttpBaseUrl: lanGateway,
          advertised: [{ environmentId: PEER_ID, label: "Desk" }],
        }),
      ).toBeNull();

      const withHttpsGateway = mergeGatewayRoutes({
        entry: paired,
        gatewayEnvironmentId: GATEWAY_ID,
        gatewayHttpBaseUrl: gatewayOrigin,
        advertised: [{ environmentId: PEER_ID, label: "Desk" }],
      })!;
      const entry: ConnectionCatalogEntry = {
        ...paired,
        target: withHttpsGateway[0]!.target,
        profile: withHttpsGateway[0]!.profile,
        alternateRoutes: withHttpsGateway.slice(1),
      };
      expect(
        ids(
          mergeGatewayRoutes({
            entry,
            gatewayEnvironmentId: GATEWAY_ID,
            gatewayHttpBaseUrl: lanGateway,
            advertised: [{ environmentId: PEER_ID, label: "Desk" }],
          }),
        ),
      ).toEqual(["lan", "relay"]);
    } finally {
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: previous,
      });
    }
  });
});

describe("gateway peer upstream selection", () => {
  const GATEWAY_ID = EnvironmentId.make("env_gateway");

  it("prefers LAN over Tailscale and loopback", () => {
    const entry: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      alternateRoutes: [TAILNET, direct("loop", "http://127.0.0.1:3773/")],
      enabled: true,
    };
    expect(gatewayPeerUpstreamUrl(entry)).toBe("http://192.168.1.10:3773");
  });

  it("skips gateway, relay, and public routes", () => {
    expect(
      gatewayPeerUpstreamUrl({
        target: RELAY.target,
        profile: RELAY.profile,
        enabled: true,
      }),
    ).toBeNull();
    expect(
      gatewayPeerUpstreamUrl({
        target: PUBLIC.target,
        profile: PUBLIC.profile,
        enabled: true,
      }),
    ).toBeNull();
  });

  it("builds the desired peer set from enabled catalog entries", () => {
    const peer: ConnectionCatalogEntry = {
      target: LAN.target,
      profile: LAN.profile,
      enabled: true,
    };
    const disabled: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId: EnvironmentId.make("env_off"),
        label: "Off",
        connectionId: "off",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "off",
          environmentId: EnvironmentId.make("env_off"),
          label: "Off",
          httpBaseUrl: "http://192.168.1.99:3773/",
          wsBaseUrl: "ws://192.168.1.99:3773/",
        }),
      ),
      enabled: false,
    };
    expect(desiredGatewayPeers([peer, disabled], GATEWAY_ID)).toEqual([
      { environmentId: ENVIRONMENT_ID, url: "http://192.168.1.10:3773" },
    ]);
    expect(desiredGatewayPeers([peer], ENVIRONMENT_ID)).toEqual([]);
  });

  it("plans adds for missing or moved peers and removes stale ones", () => {
    const keep = EnvironmentId.make("env_keep");
    const move = EnvironmentId.make("env_move");
    const drop = EnvironmentId.make("env_drop");
    expect(
      planGatewayPeerReconcile({
        desired: [
          { environmentId: keep, url: "http://192.168.1.10:3773" },
          { environmentId: move, url: "http://192.168.1.20:3773" },
        ],
        listed: [
          { environmentId: keep, httpBaseUrl: "http://192.168.1.10:3773/" },
          { environmentId: move, httpBaseUrl: "http://192.168.1.99:3773/" },
          { environmentId: drop, httpBaseUrl: "http://192.168.1.30:3773/" },
        ],
        previousDesired: new Set([keep, move, drop]),
      }),
    ).toEqual({
      add: [{ environmentId: move, url: "http://192.168.1.20:3773" }],
      remove: [drop],
    });
  });

  it("does not remove peers another client may still need", () => {
    const keep = EnvironmentId.make("env_keep");
    const otherClientPeer = EnvironmentId.make("env_other");
    expect(
      planGatewayPeerReconcile({
        desired: [{ environmentId: keep, url: "http://192.168.1.10:3773" }],
        listed: [
          { environmentId: keep, httpBaseUrl: "http://192.168.1.10:3773/" },
          { environmentId: otherClientPeer, httpBaseUrl: "http://192.168.1.50:3773/" },
        ],
        previousDesired: new Set([keep]),
      }),
    ).toEqual({ add: [], remove: [] });
    expect(
      planGatewayPeerReconcile({
        desired: [],
        listed: [{ environmentId: otherClientPeer, httpBaseUrl: "http://192.168.1.50:3773/" }],
        previousDesired: new Set(),
      }),
    ).toEqual({ add: [], remove: [] });
  });

  it("claims ownership only for successful or already-listed registrations", () => {
    const owned = EnvironmentId.make("env_owned");
    const listed = EnvironmentId.make("env_listed");
    const failed = EnvironmentId.make("env_failed");
    const succeeded = EnvironmentId.make("env_ok");
    expect(
      claimedGatewayPeerIds({
        desired: [
          { environmentId: owned },
          { environmentId: listed },
          { environmentId: failed },
          { environmentId: succeeded },
        ],
        previousDesired: new Set([owned]),
        addAttempts: [failed, succeeded],
        addSucceeded: new Set([succeeded]),
      }),
    ).toEqual(new Set([owned, listed, succeeded]));

    // A later catalog drop of a never-claimed peer must not plan a remove.
    expect(
      planGatewayPeerReconcile({
        desired: [],
        listed: [{ environmentId: failed, httpBaseUrl: "http://192.168.1.90:3773/" }],
        previousDesired: claimedGatewayPeerIds({
          desired: [{ environmentId: failed }],
          previousDesired: new Set(),
          addAttempts: [failed],
          addSucceeded: new Set(),
        }),
      }),
    ).toEqual({ add: [], remove: [] });
  });

  it("retries remove when ownership is retained after a failed remove", () => {
    const stale = EnvironmentId.make("env_stale");
    // claimedGatewayPeerIds drops peers that left desired; the registry merges
    // removeFailed back in so a transient lanGatewayRemove failure can retry.
    const previousDesired = new Set([
      ...claimedGatewayPeerIds({
        desired: [],
        previousDesired: new Set([stale]),
        addAttempts: [],
        addSucceeded: new Set(),
      }),
      stale,
    ]);
    expect(
      planGatewayPeerReconcile({
        desired: [],
        listed: [{ environmentId: stale, httpBaseUrl: "http://192.168.1.90:3773/" }],
        previousDesired,
      }),
    ).toEqual({ add: [], remove: [stale] });
  });

  it("does not remove peers the catalog still reaches through this gateway", () => {
    const keep = EnvironmentId.make("env_keep");
    const pairedThroughGateway = EnvironmentId.make("env_gateway_only");
    const drop = EnvironmentId.make("env_drop");
    expect(
      planGatewayPeerReconcile({
        desired: [{ environmentId: keep, url: "http://192.168.1.10:3773" }],
        listed: [
          { environmentId: keep, httpBaseUrl: "http://192.168.1.10:3773/" },
          { environmentId: pairedThroughGateway, httpBaseUrl: "http://192.168.1.40:3773/" },
          { environmentId: drop, httpBaseUrl: "http://192.168.1.30:3773/" },
        ],
        retain: new Set([pairedThroughGateway]),
      }),
    ).toEqual({
      add: [],
      remove: [drop],
    });

    const gatewayOnly: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId: pairedThroughGateway,
        label: "Peer",
        connectionId: "bearer:peer:https://connect-host.example",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "bearer:peer:https://connect-host.example",
          environmentId: pairedThroughGateway,
          label: "Peer",
          httpBaseUrl: `https://connect-host.example/__t3_gateway/${pairedThroughGateway}/`,
          wsBaseUrl: `wss://connect-host.example/__t3_gateway/${pairedThroughGateway}/`,
          gatewayEnvironmentId: GATEWAY_ID,
        }),
      ),
      enabled: true,
    };
    expect(retainedGatewayPeerIds([gatewayOnly], GATEWAY_ID)).toEqual(
      new Set([pairedThroughGateway]),
    );
    expect(desiredGatewayPeers([gatewayOnly], GATEWAY_ID)).toEqual([]);
  });
});
