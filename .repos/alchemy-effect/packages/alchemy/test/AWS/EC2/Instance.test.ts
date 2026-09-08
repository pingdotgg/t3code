import * as AWS from "@/AWS";
import { amazonLinux2023, Instance, Subnet, Vpc } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertInstanceTerminated, assertVpcGone } from "./Gone.ts";

// Two permits: the list test and the replacement test each hold a custom VPC
// and may run concurrently within this file.
const { test } = Test.make({ providers: AWS.providers() }, 2);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// `list()` enumerates every non-terminated instance in the account/region via
// the paginated `ec2.describeInstances` op (items nested under
// Reservations[].Instances[]). Deploy a real instance, resolve the provider
// from context with the typed `findProvider`, call `list()`, and assert the
// deployed instance appears in the exhaustively paginated result.
test.provider(
  "list enumerates the deployed instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imageId = amazonLinux2023();

      // The testing account has no default VPC, so provision a VPC + subnet to
      // launch the instance into.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("ListInstanceVpc", {
            cidrBlock: "10.0.0.0/16",
          });
          const subnet = yield* Subnet("ListInstanceSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
          });
          const instance = yield* Instance("ListInstance", {
            imageId,
            instanceType: "t3.micro",
            subnetId: subnet.subnetId,
          });
          return { vpc, instance };
        }),
      );

      const provider = yield* Provider.findProvider(Instance);
      const all = yield* provider.list();

      expect(
        all.some((x) => x.instanceId === deployed.instance.instanceId),
      ).toBe(true);

      yield* stack.destroy();

      // Zero-orphan proof: the instance reached a terminal state and the VPC
      // (which cannot delete while any ENI lingers) is gone.
      yield* assertInstanceTerminated(deployed.instance.instanceId);
      yield* assertVpcGone(deployed.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Replacement must launch a distinct physical instance. The create phase of a
// replacement runs under a freshly minted generation id, so the tag-based
// recovery lookup (branded with `alchemy::instance`) can never re-adopt the
// old generation's live instance — which the cleanup phase then terminates,
// leaving state pointing at a terminated instance (#1026).
test.provider.skipIf(!!process.env.FAST)(
  "replace launches a distinct instance and terminates only the old one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imageId = amazonLinux2023();

      const deploy = (userData: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const vpc = yield* Vpc("ReplaceInstanceVpc", {
              cidrBlock: "10.0.0.0/16",
            });
            const subnet = yield* Subnet("ReplaceInstanceSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.0.1.0/24",
            });
            const instance = yield* Instance("ReplaceInstance", {
              imageId,
              instanceType: "t3.micro",
              subnetId: subnet.subnetId,
              userData,
              tags: { Name: "alchemy-replace-instance-test" },
            });
            return { vpc, instance };
          }),
        );

      const first = yield* deploy("#!/bin/bash\necho generation-one\n");

      // userData is a force-new prop, so this deploy plans a replacement.
      const second = yield* deploy("#!/bin/bash\necho generation-two\n");

      // The replacement created a distinct physical instance...
      expect(second.instance.instanceId).not.toBe(first.instance.instanceId);

      // ...that is alive after cleanup (out-of-band via distilled)...
      const live = yield* ec2.describeInstances({
        InstanceIds: [second.instance.instanceId],
      });
      const liveState =
        live.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "unknown";
      expect(["pending", "running"]).toContain(liveState);

      // ...while the old generation was the one terminated.
      yield* assertInstanceTerminated(first.instance.instanceId);

      yield* stack.destroy();

      // Zero-orphan proof for the replacement generation and the VPC.
      yield* assertInstanceTerminated(second.instance.instanceId);
      yield* assertVpcGone(second.vpc.vpcId);
    }).pipe(logLevel),
  { timeout: 600_000 },
);
