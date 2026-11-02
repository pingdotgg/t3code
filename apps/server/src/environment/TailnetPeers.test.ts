import * as NodeServices from "@effect/platform-node/NodeServices";
import { parseTailscaleStatus, TailscaleStatusParseError } from "@t3tools/tailscale";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as TailscaleHost from "../tailscale/TailscaleHost.ts";
import * as TailnetPeers from "./TailnetPeers.ts";

const peer = (id: string, address: string, fields: Record<string, unknown> = {}) => ({
  ID: id,
  HostName: `${id}-host`,
  DNSName: `${id}.tail.ts.net.`,
  UserID: 7,
  TailscaleIPs: [address],
  Online: true,
  ...fields,
});

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { ID: "nBox", UserID: 7, TailscaleIPs: ["100.100.1.1"] },
  Peer: {
    a: peer("studio", "100.88.1.2"),
    b: peer("ci", "100.88.1.3", { UserID: 99, Tags: ["tag:server"] }),
    c: peer("friend", "100.88.1.4", { UserID: 99 }),
    d: peer("shared", "100.88.1.5", { AltSharerUserID: 55 }),
    e: peer("asleep", "100.88.1.6", { Online: false }),
    f: peer("printer", "100.88.1.7"),
  },
});

const layerTest = (
  probed: Array<string>,
  status: TailscaleHost.TailscaleHost["Service"]["status"] = parseTailscaleStatus(STATUS),
) =>
  Layer.mergeAll(
    Layer.succeed(
      TailscaleHost.TailscaleHost,
      TailscaleHost.TailscaleHost.of({
        inUse: Effect.succeed(true),
        status,
        freshStatus: status,
        whois: () => Effect.die("whois is not used for discovery"),
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          probed.push(url.host);
          const body =
            url.hostname === "100.88.1.7"
              ? new Response("not found", { status: 404 })
              : Response.json({ environmentId: `env-${url.hostname}` });
          return HttpClientResponse.fromWeb(request, body);
        }),
      ),
    ),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailnet-peers-test-" }),
  );

it.layer(NodeServices.layer)("TailnetPeers", (it) => {
  it.effect("probes online peers the owner owns or that are tagged, and returns only names", () => {
    const probed: Array<string> = [];
    return Effect.gen(function* () {
      const peers = yield* TailnetPeers.TailnetPeers;
      expect(yield* peers.list).toEqual([
        {
          name: "studio",
          magicDnsName: "studio.tail.ts.net",
          tailnetIpv4: "100.88.1.2",
          environmentId: "env-100.88.1.2",
        },
        {
          name: "ci",
          magicDnsName: "ci.tail.ts.net",
          tailnetIpv4: "100.88.1.3",
          environmentId: "env-100.88.1.3",
        },
      ]);
      expect(probed.toSorted()).toEqual(["100.88.1.2:3773", "100.88.1.3:3773", "100.88.1.7:3773"]);
      // Served from the cache, with no new probes.
      yield* peers.list;
      expect(probed).toHaveLength(3);
    }).pipe(Effect.provide(TailnetPeers.layer.pipe(Layer.provide(layerTest(probed)))));
  });

  it.effect("asks Tailscale again after a failed read instead of keeping an empty tailnet", () => {
    let reads = 0;
    const status = Effect.suspend(() => {
      reads += 1;
      return reads === 1
        ? Effect.fail(new TailscaleStatusParseError({ cause: "tailscaled restarting" }))
        : parseTailscaleStatus(STATUS);
    });
    return Effect.gen(function* () {
      const peers = yield* TailnetPeers.TailnetPeers;
      expect(yield* peers.list).toEqual([]);
      expect((yield* peers.list).map((peer) => peer.name)).toEqual(["studio", "ci"]);
    }).pipe(Effect.provide(TailnetPeers.layer.pipe(Layer.provide(layerTest([], status)))));
  });
});
