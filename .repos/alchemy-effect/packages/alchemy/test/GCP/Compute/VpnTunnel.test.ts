import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { DEFAULT_NETWORK } from "../networkQuota.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const SHARED_SECRET = "alchemy-test-shared-secret";

const waitUntilGone = (
  project: string,
  region: string,
  vpnTunnelName: string,
) =>
  compute.getVpnTunnels({ project, region, vpnTunnel: vpnTunnelName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

test.provider(
  "create, update, and delete an HA VPN tunnel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
            region: "us-central1",
            network: DEFAULT_NETWORK,
          });
          const router = yield* GCP.Compute.Router("Edge", {
            region: "us-central1",
            network: DEFAULT_NETWORK,
            bgp: { asn: 64514 },
          });
          const peer = yield* GCP.Compute.ExternalVpnGateway("Peer", {
            redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
            interfaces: [{ id: 0, ipAddress: "15.0.0.120" }],
          });
          const tunnel = yield* GCP.Compute.VpnTunnel("Tunnel", {
            region: "us-central1",
            vpnGateway: gateway.vpnGatewayName,
            vpnGatewayInterface: 0,
            peerExternalGateway: peer.externalVpnGatewayName,
            peerExternalGatewayInterface: 0,
            router: router.routerName,
            sharedSecret: SHARED_SECRET,
            description: "ha vpn tunnel",
            labels: { env: "test" },
          });
          return { gateway, router, peer, tunnel };
        }),
      );

      expect(created.tunnel.vpnTunnelName).toEqual(expect.any(String));
      expect(created.tunnel.region).toEqual("us-central1");
      expect(created.tunnel.description).toEqual("ha vpn tunnel");
      expect(created.tunnel.labels).toMatchObject({ env: "test" });
      expect(created.tunnel.vpnGateway).toEqual(
        expect.stringContaining(created.gateway.vpnGatewayName),
      );
      expect(created.tunnel.vpnGatewayInterface).toEqual(0);
      expect(created.tunnel.peerExternalGateway).toEqual(
        expect.stringContaining(created.peer.externalVpnGatewayName),
      );
      expect(created.tunnel.peerExternalGatewayInterface).toEqual(0);
      expect(created.tunnel.router).toEqual(
        expect.stringContaining(created.router.routerName),
      );
      expect(created.tunnel.ikeVersion).toEqual(2);
      expect(created.tunnel.sharedSecretHash).toEqual(expect.any(String));

      const fetched = yield* compute.getVpnTunnels({
        project: created.tunnel.project,
        region: created.tunnel.region,
        vpnTunnel: created.tunnel.vpnTunnelName,
      });
      expect(fetched.name).toEqual(created.tunnel.vpnTunnelName);
      expect(fetched.description).toEqual("ha vpn tunnel");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.vpnGateway).toEqual(
        expect.stringContaining(created.gateway.vpnGatewayName),
      );
      expect(fetched.vpnGatewayInterface).toEqual(0);
      expect(fetched.peerExternalGateway).toEqual(
        expect.stringContaining(created.peer.externalVpnGatewayName),
      );
      expect(fetched.router).toEqual(
        expect.stringContaining(created.router.routerName),
      );
      expect(fetched.ikeVersion).toEqual(2);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
            vpnGatewayName: created.gateway.vpnGatewayName,
            region: "us-central1",
            network: DEFAULT_NETWORK,
          });
          const router = yield* GCP.Compute.Router("Edge", {
            routerName: created.router.routerName,
            region: "us-central1",
            network: DEFAULT_NETWORK,
            bgp: { asn: 64514 },
          });
          const peer = yield* GCP.Compute.ExternalVpnGateway("Peer", {
            externalVpnGatewayName: created.peer.externalVpnGatewayName,
            redundancyType: "SINGLE_IP_INTERNALLY_REDUNDANT",
            interfaces: [{ id: 0, ipAddress: "15.0.0.120" }],
          });
          const tunnel = yield* GCP.Compute.VpnTunnel("Tunnel", {
            vpnTunnelName: created.tunnel.vpnTunnelName,
            region: "us-central1",
            vpnGateway: gateway.vpnGatewayName,
            vpnGatewayInterface: 0,
            peerExternalGateway: peer.externalVpnGatewayName,
            peerExternalGatewayInterface: 0,
            router: router.routerName,
            sharedSecret: SHARED_SECRET,
            description: "ha vpn tunnel",
            labels: { env: "prod", role: "vpn" },
          });
          return { gateway, router, peer, tunnel };
        }),
      );

      expect(updated.tunnel.vpnTunnelName).toEqual(
        created.tunnel.vpnTunnelName,
      );
      expect(updated.tunnel.vpnTunnelId).toEqual(created.tunnel.vpnTunnelId);
      expect(updated.tunnel.labels).toMatchObject({
        env: "prod",
        role: "vpn",
      });

      const fetchedUpdated = yield* compute.getVpnTunnels({
        project: updated.tunnel.project,
        region: updated.tunnel.region,
        vpnTunnel: updated.tunnel.vpnTunnelName,
      });
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("vpn");
      expect(fetchedUpdated.id).toEqual(created.tunnel.vpnTunnelId);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.tunnel.project,
        created.tunnel.region,
        created.tunnel.vpnTunnelName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 240_000 },
);
