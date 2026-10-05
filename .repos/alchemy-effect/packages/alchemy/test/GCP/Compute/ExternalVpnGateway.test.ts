import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (project: string, externalVpnGateway: string) =>
  compute.getExternalVpnGateways({ project, externalVpnGateway }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete an external VPN gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ExternalVpnGateway("Peer", {
            description: "alchemy test external vpn",
            redundancyType: "TWO_IPS_REDUNDANCY",
            interfaces: [
              { id: 0, ipAddress: "203.0.113.1" },
              { id: 1, ipAddress: "203.0.113.2" },
            ],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.externalVpnGatewayName).toEqual(expect.any(String));
      expect(created.description).toEqual("alchemy test external vpn");
      expect(created.redundancyType).toEqual("TWO_IPS_REDUNDANCY");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.interfaces).toHaveLength(2);
      expect(created.interfaces[0]?.ipAddress).toEqual("203.0.113.1");
      expect(created.interfaces[1]?.ipAddress).toEqual("203.0.113.2");

      const fetched = yield* compute.getExternalVpnGateways({
        project: created.project,
        externalVpnGateway: created.externalVpnGatewayName,
      });
      expect(fetched.name).toEqual(created.externalVpnGatewayName);
      expect(fetched.description).toEqual("alchemy test external vpn");
      expect(fetched.redundancyType).toEqual("TWO_IPS_REDUNDANCY");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.interfaces?.[0]?.ipAddress).toEqual("203.0.113.1");
      expect(fetched.interfaces?.[1]?.ipAddress).toEqual("203.0.113.2");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.ExternalVpnGateway("Peer", {
            externalVpnGatewayName: created.externalVpnGatewayName,
            description: "alchemy test external vpn",
            redundancyType: "TWO_IPS_REDUNDANCY",
            interfaces: [
              { id: 0, ipAddress: "203.0.113.1" },
              { id: 1, ipAddress: "203.0.113.2" },
            ],
            labels: { env: "prod", role: "vpn" },
          });
        }),
      );

      expect(updated.externalVpnGatewayName).toEqual(
        created.externalVpnGatewayName,
      );
      expect(updated.externalVpnGatewayId).toEqual(
        created.externalVpnGatewayId,
      );
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "vpn",
      });

      const fetchedUpdated = yield* compute.getExternalVpnGateways({
        project: updated.project,
        externalVpnGateway: updated.externalVpnGatewayName,
      });
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("vpn");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.project,
        created.externalVpnGatewayName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 90_000 },
);
