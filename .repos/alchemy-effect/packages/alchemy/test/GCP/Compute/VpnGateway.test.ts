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

const waitUntilGone = (
  project: string,
  region: string,
  vpnGatewayName: string,
) =>
  compute.getVpnGateways({ project, region, vpnGateway: vpnGatewayName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an HA VPN gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
            region: "us-central1",
            network: DEFAULT_NETWORK,
            description: "ha vpn",
            labels: { env: "test" },
          });
          return { gateway };
        }),
      );

      expect(created.gateway.vpnGatewayName).toEqual(expect.any(String));
      expect(created.gateway.region).toEqual("us-central1");
      expect(created.gateway.network).toEqual(
        expect.stringContaining(`/networks/${DEFAULT_NETWORK}`),
      );
      expect(created.gateway.description).toEqual("ha vpn");
      expect(created.gateway.labels).toMatchObject({ env: "test" });
      expect(created.gateway.vpnInterfaces.length).toBeGreaterThanOrEqual(2);
      expect(created.gateway.vpnInterfaces[0]?.ipAddress).toEqual(
        expect.any(String),
      );

      const fetched = yield* compute.getVpnGateways({
        project: created.gateway.project,
        region: created.gateway.region,
        vpnGateway: created.gateway.vpnGatewayName,
      });
      expect(fetched.name).toEqual(created.gateway.vpnGatewayName);
      expect(fetched.description).toEqual("ha vpn");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.network).toEqual(
        expect.stringContaining(`/networks/${DEFAULT_NETWORK}`),
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const gateway = yield* GCP.Compute.VpnGateway("Gateway", {
            vpnGatewayName: created.gateway.vpnGatewayName,
            region: "us-central1",
            network: DEFAULT_NETWORK,
            description: "ha vpn",
            labels: { env: "prod", role: "vpn" },
          });
          return { gateway };
        }),
      );

      expect(updated.gateway.vpnGatewayName).toEqual(
        created.gateway.vpnGatewayName,
      );
      expect(updated.gateway.vpnGatewayId).toEqual(
        created.gateway.vpnGatewayId,
      );
      expect(updated.gateway.labels).toMatchObject({
        env: "prod",
        role: "vpn",
      });

      const fetchedUpdated = yield* compute.getVpnGateways({
        project: updated.gateway.project,
        region: updated.gateway.region,
        vpnGateway: updated.gateway.vpnGatewayName,
      });
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("vpn");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.gateway.project,
        created.gateway.region,
        created.gateway.vpnGatewayName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
