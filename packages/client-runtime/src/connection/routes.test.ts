import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { connectOverRoutes, type EnvironmentConnectionLease, type RouteCheck } from "./driver.ts";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import {
  connectionRoutes,
  discoveredRoutes,
  lanCredentialParentId,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  credentialConnectionId,
  insertRoute,
  entryWithRoutes,
  mergeLearnedRoutes,
  pendingRouteOrder,
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

describe("discovered routes", () => {
  it("borrows only a LAN-paired credential and preserves the proof marker", () => {
    const entry = entryWithRoutes({ target: LAN.target, profile: LAN.profile, enabled: true }, [
      LAN,
      RELAY,
    ]);
    const result = discoveredRoutes(entry, ["http://192.168.1.22:3773/"]);
    expect(result.map((route) => [connectionRouteId(route.target), route.discovery])).toEqual([
      [`learned:${ENVIRONMENT_ID}:http://192.168.1.22:3773@lan`, true],
    ]);
    const restricted = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, RELAY],
    );
    expect(discoveredRoutes(restricted, ["http://192.168.1.22:3773/"])).toEqual([]);
  });

  it("follows a moved machine with its LAN credential, not the paired token", () => {
    const lanDpop = new BearerConnectionProfile({
      connectionId: `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@tailnet`,
      environmentId: ENVIRONMENT_ID,
      label: "Desk",
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
      learned: true,
      lanDpop: true,
    });
    const entry = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [
        TAILNET,
        {
          target: new BearerConnectionTarget({
            environmentId: ENVIRONMENT_ID,
            label: "Desk",
            connectionId: lanDpop.connectionId,
          }),
          profile: Option.some(lanDpop),
        },
      ],
    );
    const [route] = discoveredRoutes(entry, ["http://192.168.1.22:3773/"]);
    expect(connectionRouteId(route!.target)).toBe(
      `learned:${ENVIRONMENT_ID}:http://192.168.1.22:3773@tailnet`,
    );
    expect(Option.getOrThrow(route!.profile)).toMatchObject({ lanDpop: true });
    expect(sendsTokenInClear(connectionRoutes(entry), route!)).toBe(false);
  });

  it("discovers a moved address from a T3 Connect LAN route once a paired token needs a LAN credential", () => {
    const learnedId = `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773`;
    const connect = learned(learnedId, "http://192.168.1.10:3773/");
    const profile = Option.getOrThrow(connect.profile) as BearerConnectionProfile;
    const overConnect = {
      ...connect,
      profile: Option.some(
        new BearerConnectionProfile({ ...profile, authorization: "t3-connect" }),
      ),
    };
    const entry = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, RELAY, overConnect],
    );
    const [route] = discoveredRoutes(entry, ["http://192.168.1.22:3773/"]);
    expect(connectionRouteId(route!.target)).toBe(
      `learned:${ENVIRONMENT_ID}:http://192.168.1.22:3773@tailnet`,
    );
    expect(Option.getOrThrow(route!.profile)).toMatchObject({ lanDpop: true });
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

  it("learns a LAN address over the tailnet only with a LAN credential, ranked below encrypted routes", () => {
    const entry = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, RELAY],
    );
    const reported = [
      { httpBaseUrl: "http://192.168.1.10:3773/", kind: "lan" },
      { httpBaseUrl: "http://desk.local:3773/", kind: "lan" },
    ];
    expect(
      mergeLearnedRoutes({ entry, activeRoute: TAILNET, reported, allowInsecure: true }),
    ).toBeNull();
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: TAILNET,
      reported,
      allowInsecure: true,
      lanCredential: true,
    });
    expect(ids(routes)).toEqual([
      "tailnet",
      "relay",
      `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@tailnet`,
    ]);
    expect(profileOf(routes![2]!)).toMatchObject({ learned: true, lanDpop: true });
    expect(sendsTokenInClear(routes!, routes![2]!)).toBe(false);
  });

  it("keeps a name learned through T3 Connect when a LAN credential is available", () => {
    const entry = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, RELAY],
    );
    const reported = [{ httpBaseUrl: "http://desk.local:3773/", kind: "lan" }];
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported,
      allowInsecure: true,
    })!;
    expect(profileOf(routes.at(-1)!)).toMatchObject({
      httpBaseUrl: "http://desk.local:3773/",
      authorization: "t3-connect",
    });
    expect(
      mergeLearnedRoutes({
        entry: entryWithRoutes(entry, routes),
        activeRoute: TAILNET,
        reported,
        allowInsecure: true,
        lanCredential: true,
      }),
    ).toBeNull();
  });

  it.each([
    [
      "a tailnet pairing with a LAN address",
      TAILNET,
      "http://192.168.1.10:3773/",
      "lan",
      "tailnet",
    ],
    [
      "a tailnet pairing with only tailnet addresses",
      TAILNET,
      "http://100.64.0.1:3773/",
      "tailnet",
      null,
    ],
    [
      "a LAN pairing, whose token may use plain HTTP",
      LAN,
      "http://192.168.1.10:3773/",
      "lan",
      null,
    ],
    [
      "a tailnet pairing with only a loopback address",
      TAILNET,
      "http://127.0.0.1:3773/",
      "lan",
      null,
    ],
  ])("decides whether %s needs a LAN credential", (_name, route, httpBaseUrl, kind, expected) => {
    const entry = entryWithRoutes({ target: route.target, profile: route.profile, enabled: true }, [
      route,
    ]);
    expect(
      lanCredentialParentId({ entry, activeRoute: route, reported: [{ httpBaseUrl, kind }] }),
    ).toBe(expected);
  });

  it("learns a LAN address over T3 Connect behind it, using the T3 Connect credential", () => {
    const routes = mergeLearnedRoutes({
      entry: relayOnly,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
    });
    expect(ids(routes)).toEqual(["relay", `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773`]);
    expect(profileOf(routes![1]!)).toMatchObject({
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
    const entry = entryWithRoutes(relayOnly, first);
    const moved = mergeLearnedRoutes({
      entry,
      activeRoute: RELAY,
      reported: [{ httpBaseUrl: "http://10.0.0.42:3773/" }],
      allowInsecure: true,
    });
    expect(ids(moved)).toEqual(["relay", `learned:${ENVIRONMENT_ID}:http://10.0.0.42:3773`]);
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
      `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773`,
      "relay",
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
    expect(ids(routes)).toEqual(["public", "relay", `learned:${ENVIRONMENT_ID}:${lanOrigin}`]);
    expect(profileOf(routes![2]!)).toMatchObject({ authorization: "t3-connect" });
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
    const withLearned = entryWithRoutes(relayOnly, learned);
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
    const learnedLan = first.find((route) => connectionRouteId(route.target) !== "relay")!;
    const entry = entryWithRoutes(relayOnly, first);
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

  it("does not mint a LAN credential for a loopback address or a LAN route that is already saved", () => {
    const savedLan = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, LAN],
    );
    expect(
      lanCredentialParentId({
        entry: savedLan,
        activeRoute: TAILNET,
        reported: [{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" }],
      }),
    ).toBeNull();
    expect(
      mergeLearnedRoutes({
        entry: savedLan,
        activeRoute: TAILNET,
        reported: [{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" }],
        allowInsecure: true,
        lanCredential: true,
      }),
    ).toBeNull();
  });

  it("upgrades a cleartext learned route to the LAN credential instead of dropping it", () => {
    const stale = learned(
      `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@tailnet`,
      "http://192.168.1.10:3773/",
    );
    const entry = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, stale, RELAY],
    );
    expect(sendsTokenInClear(connectionRoutes(entry), stale)).toBe(true);
    const routes = mergeLearnedRoutes({
      entry,
      activeRoute: TAILNET,
      reported: [{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" }],
      allowInsecure: true,
      lanCredential: true,
    });
    const learnedId = `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@tailnet`;
    expect(ids(routes)).toEqual(["tailnet", "relay", learnedId]);
    const upgraded = routes!.find((route) => connectionRouteId(route.target) === learnedId)!;
    expect(profileOf(upgraded)).toMatchObject({ lanDpop: true });
    expect(profileOf(upgraded)).not.toHaveProperty("authorization");
    const saved = entryWithRoutes(entry, routes!);
    expect(usableRoutes(saved).map((route) => connectionRouteId(route.target))).toContain(
      learnedId,
    );
    expect(sendsTokenInClear(connectionRoutes(saved), upgraded)).toBe(false);
  });

  it("upgrades a T3 Connect LAN route when the tailnet connection has a LAN credential", () => {
    const saved = entryWithRoutes(
      { target: TAILNET.target, profile: TAILNET.profile, enabled: true },
      [TAILNET, RELAY],
    );
    const reported = [{ httpBaseUrl: "http://192.168.1.10:3773/", kind: "lan" as const }];
    const fromRelay = mergeLearnedRoutes({
      entry: saved,
      activeRoute: RELAY,
      reported,
      allowInsecure: true,
    });
    expect(ids(fromRelay)).toEqual([
      "tailnet",
      "relay",
      `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773`,
    ]);
    expect(profileOf(fromRelay![2]!)).toMatchObject({ authorization: "t3-connect" });
    const relayEntry = entryWithRoutes(saved, fromRelay!);
    const [discovered] = discoveredRoutes(relayEntry, ["http://192.168.1.22:3773/"]);
    expect(connectionRouteId(discovered!.target)).toBe(
      `learned:${ENVIRONMENT_ID}:http://192.168.1.22:3773@tailnet`,
    );
    expect(profileOf(discovered!)).toMatchObject({ lanDpop: true });
    const fromTailnet = mergeLearnedRoutes({
      entry: relayEntry,
      activeRoute: TAILNET,
      reported,
      allowInsecure: true,
      lanCredential: true,
    });
    const learnedId = `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@tailnet`;
    expect(ids(fromTailnet)).toEqual(["tailnet", "relay", learnedId]);
    expect(profileOf(fromTailnet![2]!)).toMatchObject({ lanDpop: true });
    expect(profileOf(fromTailnet![2]!)).not.toHaveProperty("authorization");
    const again = mergeLearnedRoutes({
      entry: entryWithRoutes(relayEntry, fromTailnet!),
      activeRoute: TAILNET,
      reported,
      allowInsecure: true,
      lanCredential: true,
    });
    expect(again).toBeNull();
  });

  it.effect("keeps a user relay-first order ahead of a new LAN credential route", () =>
    Effect.gen(function* () {
      const saved = entryWithRoutes(
        { target: RELAY.target, profile: RELAY.profile, enabled: true },
        [RELAY, TAILNET],
      );
      const learned = mergeLearnedRoutes({
        entry: saved,
        activeRoute: TAILNET,
        reported: [{ httpBaseUrl: "http://192.168.1.10:3773/", kind: "lan" }],
        allowInsecure: true,
        lanCredential: true,
      });
      const learnedId = `learned:${ENVIRONMENT_ID}:http://192.168.1.10:3773@tailnet`;
      expect(ids(learned)).toEqual(["relay", "tailnet", learnedId]);
      const connected = yield* firstAnswered(learned!);
      expect(connected).toEqual(["relay"]);
      const tailnetSilent: RouteCheck = "silent";
      const answered: RouteCheck = "answered";
      const fallback = yield* firstAnswered(learned!, (route) =>
        connectionRouteId(route.target) === "tailnet" ? tailnetSilent : answered,
      );
      expect(fallback).toEqual(["relay"]);
    }),
  );
});

function firstAnswered(
  routes: ReadonlyArray<ConnectionRoute>,
  check: (route: ConnectionRoute) => RouteCheck = () => "answered",
) {
  const entry = entryWithRoutes(
    { target: routes[0]!.target, profile: routes[0]!.profile, enabled: true },
    routes,
  );
  return Effect.scoped(
    Effect.gen(function* () {
      const tried = yield* Ref.make<Array<string>>([]);
      yield* connectOverRoutes(
        entry,
        (route) => Effect.succeed(check(route)),
        (route) =>
          Ref.update(tried, (current) => [...current, connectionRouteId(route.target)]).pipe(
            Effect.as({} as EnvironmentConnectionLease),
          ),
      );
      return yield* Ref.get(tried);
    }),
  );
}
