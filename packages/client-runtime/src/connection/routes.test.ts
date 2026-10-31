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
  isSshNetworkAddress,
  mergeLearnedRoutes,
  redactSshAddresses,
  removedWithRelay,
  routesAfterRemoving,
  sshTargetLabel,
  pendingRouteOrder,
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

describe("SSH addresses", () => {
  const devbox = { alias: "devbox", hostname: "203.0.113.42", username: "deploy", port: 2222 };
  const bare = { alias: "198.51.100.7", hostname: "198.51.100.7", username: null, port: null };

  it("tells an address from an alias the user chose", () => {
    for (const address of [
      "203.0.113.42",
      "2001:db8::1",
      "[2001:db8::1]",
      "build.example.com",
      "deploy@devbox",
    ]) {
      expect(isSshNetworkAddress(address)).toBe(true);
    }
    for (const alias of ["devbox", "vectr", "build-box_2", " devbox "]) {
      expect(isSshNetworkAddress(alias)).toBe(false);
    }
  });

  it("labels a target by its alias, never its address", () => {
    expect(sshTargetLabel(devbox)).toBe("SSH devbox");
    expect(sshTargetLabel(bare)).toBe("SSH");
    expect(sshTargetLabel({ ...devbox, alias: "build.example.com" })).toBe("SSH");
  });

  it("hides the target's address in error text", () => {
    expect(redactSshAddresses("deploy@203.0.113.42: Permission denied (publickey).", devbox)).toBe(
      "•••@devbox: Permission denied (publickey).",
    );
    expect(
      redactSshAddresses("ssh: connect to host 203.0.113.42 port 2222: timed out", devbox),
    ).toBe("ssh: connect to host devbox port 2222: timed out");
    expect(redactSshAddresses("ssh: connect to host 198.51.100.7 port 22: refused", bare)).toBe(
      "ssh: connect to host ••• port 22: refused",
    );
    expect(
      redactSshAddresses("Could not resolve hostname build.example.com: Name not known", {
        ...bare,
        alias: "build.example.com",
        hostname: "build.example.com",
      }),
    ).toBe("Could not resolve hostname •••: Name not known");
  });

  it.each(["buildbox", "build.example.com", "box.tail1234.ts.net"])(
    "redacts only sensitive parts of the configured hostname %s",
    (hostname) => {
      const target = { ...devbox, hostname };
      const visibleHost = hostname === "buildbox" ? hostname : "devbox";
      expect(redactSshAddresses(`connect to host ${hostname}`, target)).toBe(
        `connect to host ${visibleHost}`,
      );
      expect(redactSshAddresses(`deploy@${hostname}: Permission denied`, target)).toBe(
        `•••@${visibleHost}: Permission denied`,
      );
      expect(redactSshAddresses("deploy@devbox: Permission denied", target)).toBe(
        "•••@devbox: Permission denied",
      );
    },
  );

  it("hides the known username even when SSH prints an unknown hostname", () => {
    expect(redactSshAddresses("deploy@resolved.example.com: Permission denied", devbox)).toBe(
      "•••@resolved.example.com: Permission denied",
    );
  });

  it("masks IP literals the target does not name", () => {
    // ssh resolves an alias to an address the client never saw.
    expect(
      redactSshAddresses("connect to host 192.0.2.9 port 22 via 2001:db8::5: refused", {
        ...devbox,
        hostname: "devbox",
      }),
    ).toBe("connect to host ••• port 22 via •••: refused");
  });

  it.each([
    "2001:db8::",
    "[2001:db8::]",
    "2001::",
    "::1",
    "[2001:db8::1]",
    "2001:db8::5",
    "fdab::cafe",
    "a::b",
    "2001:db8:0:1:2:3:4:5",
    "[2001:db8:0:1:2:3:4:5]",
  ])("masks the resolved IPv6 address %s", (address) => {
    expect(
      redactSshAddresses(`connect to host ${address} port 22: refused`, {
        ...devbox,
        hostname: "devbox",
      }),
    ).toBe("connect to host ••• port 22: refused");
  });

  it.each([
    "node.js",
    "connect to host node.js",
    "Could not resolve hostname unknown.example.com",
    "Connection closed by unknown.example.com",
    "other@unknown.example.com: Permission denied",
    "other@buildbox: Permission denied",
    "12:34:56",
    "dead:beef:cafe",
    "::",
    "std::",
    "std::vector",
    "std::bad_alloc",
    "crate::dead::beef",
  ])("preserves unrelated error text containing %s", (text) => {
    expect(redactSshAddresses(`SSH failed: ${text}`, devbox)).toBe(`SSH failed: ${text}`);
  });
});
