import * as AWS from "@/AWS";
import {
  amazonLinux2023,
  Instance,
  Subnet,
  Vpc,
  type InstanceProps,
} from "@/AWS/EC2";
import * as Provider from "@/Provider";
import { State } from "@/State/State";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Test from "./VpcTest.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertInstanceTerminated, assertVpcGone } from "./Gone.ts";

// The fixed-IP fixture keeps two VPCs to verify allocation scope. Tests run
// sequentially so the file holds at most these two VPCs.
const { test } = Test.make({ providers: AWS.providers() }, 2);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe.sequential(
  "Instance",
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
  () => {
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

          const program = (userData: string, privateIpAddress?: string) =>
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
                privateIpAddress,
                tags: { Name: "alchemy-replace-instance-test" },
              });
              return { vpc, instance };
            });

          const first = yield* stack.deploy(
            program("#!/bin/bash\necho generation-one\n"),
          );
          const next = program("#!/bin/bash\necho generation-two\n");
          const automatic = yield* stack.plan(next);
          expect(automatic.resources.ReplaceInstance).toMatchObject({
            action: "replace",
            deleteFirst: false,
          });
          const pinned = yield* stack.plan(
            program(
              "#!/bin/bash\necho generation-two\n",
              first.instance.privateIpAddress,
            ),
          );
          expect(pinned.resources.ReplaceInstance).toMatchObject({
            action: "replace",
            deleteFirst: true,
          });

          // userData is a force-new prop, so this deploy plans a replacement.
          const second = yield* stack.deploy(next);

          // The replacement created a distinct physical instance...
          expect(second.instance.instanceId).not.toBe(
            first.instance.instanceId,
          );

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

    const fixedIpProgram = (props: Partial<InstanceProps> = {}) =>
      Effect.gen(function* () {
        const vpc = yield* Vpc("FixedIpVpc", { cidrBlock: "10.0.0.0/16" });
        const subnet = yield* Subnet("FixedIpSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        const otherVpc = yield* Vpc("OtherFixedIpVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const otherSubnet = yield* Subnet("OtherFixedIpSubnet", {
          vpcId: otherVpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        const instance = yield* Instance("FixedIpInstance", {
          imageId: amazonLinux2023(),
          instanceType: "t3.micro",
          subnetId: subnet.subnetId,
          privateIpAddress: "10.0.1.10",
          userData: "#!/bin/bash\necho generation-one\n",
          ...props,
        });
        return { vpc, subnet, otherVpc, otherSubnet, instance };
      });

    test.provider(
      "fixed-IP replacements delete first only when reusing the same allocation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const first = yield* stack.deploy(fixedIpProgram());
          const unchanged = yield* stack.plan(fixedIpProgram());
          expect(unchanged.resources.FixedIpInstance?.action).toBe("noop");

          const tags = { Name: "alchemy-fixed-ip-replacement" };
          const update = yield* stack.plan(fixedIpProgram({ tags }));
          expect(update.resources.FixedIpInstance?.action).toBe("update");
          const updated = yield* stack.deploy(fixedIpProgram({ tags }));
          expect(updated.instance.instanceId).toBe(first.instance.instanceId);

          const differentIp = yield* stack.plan(
            fixedIpProgram({
              privateIpAddress: "10.0.1.11",
            }),
          );
          expect(differentIp.resources.FixedIpInstance).toMatchObject({
            action: "replace",
            deleteFirst: false,
          });
          const differentSubnet = yield* stack.plan(
            fixedIpProgram({
              subnetId: first.otherSubnet.subnetId,
            }),
          );
          expect(differentSubnet.resources.FixedIpInstance).toMatchObject({
            action: "replace",
            deleteFirst: false,
          });

          const next = fixedIpProgram({
            userData: "#!/bin/bash\necho generation-two\n",
            tags,
          });
          const replacement = yield* stack.plan(next);
          expect(replacement.resources.FixedIpInstance).toMatchObject({
            action: "replace",
            deleteFirst: true,
          });
          const second = yield* stack.deploy(next);
          expect(second.instance.instanceId).not.toBe(
            first.instance.instanceId,
          );
          const live = yield* ec2.describeInstances({
            InstanceIds: [second.instance.instanceId],
          });
          expect(live.Reservations?.[0]?.Instances?.[0]).toMatchObject({
            PrivateIpAddress: "10.0.1.10",
            SubnetId: first.subnet.subnetId,
            State: { Name: "running" },
          });
          yield* assertInstanceTerminated(first.instance.instanceId);
          const settled = yield* stack.plan(next);
          expect(settled.resources.FixedIpInstance?.action).toBe("noop");

          yield* stack.destroy();
          yield* assertInstanceTerminated(second.instance.instanceId);
          yield* assertVpcGone(first.vpc.vpcId);
          yield* assertVpcGone(first.otherVpc.vpcId);
        }).pipe(logLevel),
      { timeout: 120_000 },
    );

    test.provider(
      "recovers a launched fixed-IP replacement whose output was not persisted",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const state = yield* yield* State;
          const key = {
            stack: stack.name,
            stage: stack.stage,
            fqn: "FixedIpInstance",
          };
          const first = yield* stack.deploy(fixedIpProgram());
          const firstState = yield* state.get(key);
          if (
            firstState?.status !== "created" &&
            firstState?.status !== "updated"
          ) {
            return yield* Effect.die(
              new Error("Expected a deployed original instance"),
            );
          }

          const next = fixedIpProgram({ privateIpAddress: "10.0.1.11" });
          const second = yield* stack.deploy(next);
          const secondState = yield* state.get(key);
          if (
            secondState?.status !== "created" &&
            secondState?.status !== "updated"
          ) {
            return yield* Effect.die(
              new Error("Expected a deployed replacement instance"),
            );
          }
          // Retain the real candidate's generation and tags, but simulate the
          // interrupted commit between its EC2 launch and persisting its output.
          yield* state.set({
            ...key,
            value: {
              ...secondState,
              status: "replacing",
              attr: undefined,
              deleteFirst: false,
              old: firstState,
            },
          });
          const recovery = yield* stack.plan(next);
          expect(recovery.resources.FixedIpInstance).toMatchObject({
            action: "replace",
            deleteFirst: false,
          });
          expect(recovery.resources.FixedIpInstance).not.toMatchObject({
            restart: true,
          });
          const recovered = yield* stack.deploy(next);
          expect(recovered.instance.instanceId).toBe(
            second.instance.instanceId,
          );
          const live = yield* ec2.describeInstances({
            InstanceIds: [recovered.instance.instanceId],
          });
          expect(live.Reservations?.[0]?.Instances?.[0]).toMatchObject({
            PrivateIpAddress: "10.0.1.11",
            State: { Name: "running" },
          });
          const settled = yield* stack.plan(next);
          expect(settled.resources.FixedIpInstance?.action).toBe("noop");

          yield* stack.destroy();
          yield* assertInstanceTerminated(first.instance.instanceId);
          yield* assertInstanceTerminated(second.instance.instanceId);
          yield* assertVpcGone(first.vpc.vpcId);
          yield* assertVpcGone(first.otherVpc.vpcId);
        }).pipe(logLevel),
      { timeout: 120_000 },
    );
  },
);
