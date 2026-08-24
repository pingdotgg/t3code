import * as AWS from "@/AWS";
import { Vpc, VpcPeeringConnection } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() }, 2);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const DEAD = new Set(["deleted", "deleting", "rejected", "failed", "expired"]);

class PeeringStillLive extends Data.TaggedError("PeeringStillLive") {}

const assertDeleted = Effect.fn(function* (pcxId: string) {
  yield* EC2.describeVpcPeeringConnections({
    VpcPeeringConnectionIds: [pcxId],
  }).pipe(
    Effect.flatMap((r) => {
      const code = r.VpcPeeringConnections?.[0]?.Status?.Code;
      return code === undefined || DEAD.has(code)
        ? Effect.void
        : Effect.fail(new PeeringStillLive());
    }),
    Effect.retry({
      while: (e) => e instanceof PeeringStillLive,
      schedule: Schedule.max([Schedule.exponential(300), Schedule.recurs(8)]),
    }),
    Effect.catchTag(
      "InvalidVpcPeeringConnectionID.NotFound",
      () => Effect.void,
    ),
    Effect.catchTag(
      "InvalidVpcPeeringConnectionId.NotFound",
      () => Effect.void,
    ),
  );
});

test.provider(
  "create, auto-accept, delete same-account peering connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { peering, vpcA, vpcB } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpcA = yield* Vpc("PeeringVpcA", {
            cidrBlock: "10.10.0.0/16",
          });
          const vpcB = yield* Vpc("PeeringVpcB", {
            cidrBlock: "10.20.0.0/16",
          });
          const peering = yield* VpcPeeringConnection("Peering", {
            vpcId: vpcA.vpcId,
            peerVpcId: vpcB.vpcId,
          });
          return { peering, vpcA, vpcB };
        }),
      );

      expect(peering.vpcPeeringConnectionId).toMatch(/^pcx-/);
      expect(peering.status).toEqual("active");
      expect(peering.requesterVpcId).toEqual(vpcA.vpcId);
      expect(peering.accepterVpcId).toEqual(vpcB.vpcId);

      // Verify out-of-band that it is ACTIVE.
      const described = yield* EC2.describeVpcPeeringConnections({
        VpcPeeringConnectionIds: [peering.vpcPeeringConnectionId],
      });
      const pcx = described.VpcPeeringConnections?.[0];
      expect(pcx?.Status?.Code).toEqual("active");
      expect(pcx?.RequesterVpcInfo?.VpcId).toEqual(vpcA.vpcId);
      expect(pcx?.AccepterVpcInfo?.VpcId).toEqual(vpcB.vpcId);

      yield* stack.destroy();
      yield* assertDeleted(peering.vpcPeeringConnectionId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed peering connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { peering } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpcA = yield* Vpc("ListPeeringVpcA", {
            cidrBlock: "10.30.0.0/16",
          });
          const vpcB = yield* Vpc("ListPeeringVpcB", {
            cidrBlock: "10.40.0.0/16",
          });
          const peering = yield* VpcPeeringConnection("ListPeering", {
            vpcId: vpcA.vpcId,
            peerVpcId: vpcB.vpcId,
          });
          return { peering };
        }),
      );

      const provider = yield* Provider.findProvider(VpcPeeringConnection);
      const all = yield* provider.list();
      expect(
        all.some(
          (x) => x.vpcPeeringConnectionId === peering.vpcPeeringConnectionId,
        ),
      ).toBe(true);

      yield* stack.destroy();
      yield* assertDeleted(peering.vpcPeeringConnectionId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
