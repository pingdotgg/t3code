// @effect-diagnostics nodeBuiltinImport:off - reads the user guide to check its anchors.
import * as NodeFS from "node:fs";

import { T3_CONNECT_TROUBLESHOOTING_SECTIONS, connectReachableMcpUrl } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const checkedAt = "2026-10-19T00:00:00.000Z";
const connected = { readyConnections: 4, hostname: "env.example.test", protocol: "quic" };
const notConnected = { readyConnections: 0, hostname: null, protocol: null };
const facts = (
  overrides: Partial<ConnectReachability.ReachabilityFacts>,
): ConnectReachability.ReachabilityFacts => ({
  managedTunnelConfigured: true,
  connector: connected,
  endpoint: null,
  edgeReachable: null,
  exitNode: null,
  ...overrides,
});

describe("classifyReachability", () => {
  it.each([
    [{ kind: "status", status: 502 }, "origin_unreachable"],
    [{ kind: "status", status: 530 }, "no_connector"],
    [{ kind: "network_error" }, "timeout"],
  ] as const)("maps endpoint result %o to %s", (endpoint, cause) => {
    expect(
      ConnectReachability.classifyReachability(facts({ endpoint, edgeReachable: true }), checkedAt),
    ).toMatchObject({ status: "unreachable", cause });
  });

  it("keeps the endpoint cause when the TCP edge test cannot explain it", () => {
    // QUIC (UDP) can connect while TCP 7844 is blocked.
    expect(
      ConnectReachability.classifyReachability(
        facts({ endpoint: { kind: "status", status: 502 }, edgeReachable: false }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    expect(
      ConnectReachability.classifyReachability(
        facts({
          connector: { readyConnections: null, hostname: "env.example.test", protocol: null },
          endpoint: { kind: "status", status: 502 },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "origin_unreachable" });
    // Failed DNS also fails the edge lookups.
    expect(
      ConnectReachability.classifyReachability(
        facts({
          connector: { readyConnections: null, hostname: "env.example.test", protocol: null },
          endpoint: { kind: "dns_failed" },
          edgeReachable: false,
        }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "dns_failed" });
  });

  it("waits on a connector that has not connected while the edge answers", () => {
    expect(
      ConnectReachability.classifyReachability(
        facts({ connector: notConnected, edgeReachable: true }),
        checkedAt,
      ),
    ).toMatchObject({ cause: "connector_not_ready" });
  });
});

describe("ConnectReachability", () => {
  it.effect("exposes the checked tunnel's MCP URL until its config changes", () => {
    const tunnelConfig = { providerKind: "cloudflare_tunnel", connectorToken: "first" };
    let config = new TextEncoder().encode(JSON.stringify(tunnelConfig));
    const dependencies = Layer.mergeAll(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () => Effect.sync(() => Option.some(config)),
      }),
      Layer.mock(ManagedEndpointRuntime.CloudManagedEndpointRuntime)({
        inspectConnector: () => Effect.succeed(connected),
        readinessChanged: Stream.empty,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}"))),
        ),
      ),
      Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
    );

    return Effect.gen(function* () {
      const reachability = yield* ConnectReachability.ConnectReachability;
      yield* reachability.check;
      const result = Option.getOrThrow(yield* reachability.latest);
      expect(result.status === "reachable" && connectReachableMcpUrl(result)).toBe(
        "https://env.example.test/mcp",
      );

      // A relink stores a new tunnel before its connector reports in.
      config = new TextEncoder().encode(
        JSON.stringify({ ...tunnelConfig, connectorToken: "second" }),
      );
      expect(yield* reachability.latest).toEqual(Option.none());
    }).pipe(Effect.provide(ConnectReachability.layer.pipe(Layer.provide(dependencies))));
  });
});

describe("T3 Connect troubleshooting links", () => {
  it("each section names a heading in the user guide", () => {
    const guide = NodeFS.readFileSync(
      new URL("../../../../docs/user/t3-connect-troubleshooting.md", import.meta.url),
      "utf8",
    );
    // GitHub's heading anchors: lowercase, drop punctuation, spaces become hyphens.
    const anchors = new Set(
      [...guide.matchAll(/^#{2,3} (.+)$/gm)].map(([, heading]) =>
        heading!
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, "")
          .replace(/ /g, "-"),
      ),
    );
    for (const section of T3_CONNECT_TROUBLESHOOTING_SECTIONS) {
      expect(anchors, section).toContain(section);
    }
  });
});
