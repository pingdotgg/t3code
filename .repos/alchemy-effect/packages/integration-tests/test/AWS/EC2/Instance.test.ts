import * as AWS from "@alchemy.run/aws";
import { amazonLinux2023, Instance, Subnet, Vpc, type InstanceProps } from "@alchemy.run/aws/EC2";
import { Queue } from "@alchemy.run/aws/SQS";
import { describe, expect } from "@alchemy.run/test";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Drift from "alchemy/Drift";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { State } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { assertInstanceTerminated, assertVpcGone } from "./Gone.ts";
import * as Test from "./VpcTest.ts";

// The fixed-IP fixture keeps two VPCs to verify allocation scope. Tests run
// sequentially so the file holds at most these two VPCs.
const { test } = Test.make({ providers: AWS.providers() }, 2);

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Terminate an instance outside the stack and wait until EC2 reports it
// terminated; shutting-down -> terminated can take a minute or two.
const terminateOutOfBand = Effect.fn(function* (instanceId: string) {
  yield* ec2.terminateInstances({ InstanceIds: [instanceId] });
  yield* ec2.describeInstances({ InstanceIds: [instanceId] }).pipe(
    Effect.map((r) => r.Reservations?.[0]?.Instances?.[0]?.State?.Name),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (state) => state === "terminated",
      times: 36,
    }),
  );
});

describe.sequential("Instance", { tags: ["provider:aws", "provider:aws:ec2", "live"] }, () => {
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
            const vpc = yield* Vpc("ListInstanceVpc", { cidrBlock: "10.0.0.0/16" });
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

        expect(all.some((x) => x.instanceId === deployed.instance.instanceId)).toBe(true);

        yield* stack.destroy();

        // Zero-orphan proof: the instance reached a terminal state and the VPC
        // (which cannot delete while any ENI lingers) is gone.
        yield* assertInstanceTerminated(deployed.instance.instanceId);
        yield* assertVpcGone(deployed.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 240_000 },
  );

  // Metadata options are applied by RunInstances at launch and updated in
  // place via ModifyInstanceMetadataOptions — the instance id must not change.
  test.provider(
    "metadataOptions apply at launch and update in place",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const imageId = amazonLinux2023();

        const program = (metadataOptions: InstanceProps["metadataOptions"]) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("MetadataInstanceVpc", { cidrBlock: "10.0.0.0/16" });
            const subnet = yield* Subnet("MetadataInstanceSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.0.1.0/24",
            });
            const instance = yield* Instance("MetadataInstance", {
              imageId,
              instanceType: "t3.micro",
              subnetId: subnet.subnetId,
              metadataOptions,
            });
            return { vpc, instance };
          });

        const observeMetadata = (instanceId: string) =>
          ec2
            .describeInstances({ InstanceIds: [instanceId] })
            .pipe(Effect.map((r) => r.Reservations?.[0]?.Instances?.[0]?.MetadataOptions));

        const first = yield* stack.deploy(
          program({ httpTokens: "required", httpPutResponseHopLimit: 1 }),
        );
        expect(yield* observeMetadata(first.instance.instanceId)).toMatchObject({
          HttpTokens: "required",
          HttpPutResponseHopLimit: 1,
        });

        const next = program({
          httpTokens: "required",
          httpPutResponseHopLimit: 2,
          instanceMetadataTags: "enabled",
        });
        const plan = yield* stack.plan(next);
        expect(plan.resources.MetadataInstance).toMatchObject({ action: "update" });

        const second = yield* stack.deploy(next);
        expect(second.instance.instanceId).toBe(first.instance.instanceId);
        expect(yield* observeMetadata(second.instance.instanceId)).toMatchObject({
          HttpTokens: "required",
          HttpPutResponseHopLimit: 2,
          InstanceMetadataTags: "enabled",
        });
        expect(second.instance.metadataOptions).toMatchObject({
          httpTokens: "required",
          httpPutResponseHopLimit: 2,
          instanceMetadataTags: "enabled",
        });

        yield* stack.destroy();

        yield* assertInstanceTerminated(second.instance.instanceId);
        yield* assertVpcGone(second.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 300_000 },
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
            const vpc = yield* Vpc("ReplaceInstanceVpc", { cidrBlock: "10.0.0.0/16" });
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

        const first = yield* stack.deploy(program("#!/bin/bash\necho generation-one\n"));
        const next = program("#!/bin/bash\necho generation-two\n");
        const automatic = yield* stack.plan(next);
        expect(automatic.resources.ReplaceInstance).toMatchObject({
          action: "replace",
          deleteFirst: false,
        });
        const pinned = yield* stack.plan(
          program("#!/bin/bash\necho generation-two\n", first.instance.privateIpAddress),
        );
        expect(pinned.resources.ReplaceInstance).toMatchObject({
          action: "replace",
          deleteFirst: true,
        });

        // userData is a force-new prop, so this deploy plans a replacement.
        const second = yield* stack.deploy(next);

        // The replacement created a distinct physical instance...
        expect(second.instance.instanceId).not.toBe(first.instance.instanceId);

        // ...that is alive after cleanup (out-of-band via distilled)...
        const live = yield* ec2.describeInstances({ InstanceIds: [second.instance.instanceId] });
        const liveState = live.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "unknown";
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

  // EC2 runs userData only at launch. When it interpolates an upstream that
  // is being replaced, its new value is unknown at plan time; the instance
  // must still be replaced, or it keeps running the old userData.
  test.provider.skipIf(!!process.env.FAST)(
    "replaces the instance when userData depends on a replaced upstream",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = (fifo: boolean) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("UpstreamUserDataVpc", { cidrBlock: "10.0.0.0/16" });
            const subnet = yield* Subnet("UpstreamUserDataSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.0.1.0/24",
            });
            // Toggling `fifo` replaces the queue, so its URL is unknown at plan time.
            const queue = yield* Queue(
              "UpstreamUserDataQueue",
              fifo ? { fifo: true } : { fifo: false },
            );
            const instance = yield* Instance("UpstreamUserDataInstance", {
              imageId: amazonLinux2023(),
              instanceType: "t3.micro",
              subnetId: subnet.subnetId,
              userData: Output.interpolate`#!/bin/bash
echo ${queue.queueUrl}
`,
            });
            return { vpc, queue, instance };
          });

        const first = yield* stack.deploy(program(false));
        const plan = yield* stack.plan(program(true));
        expect(plan.resources.UpstreamUserDataInstance?.action).toBe("replace");

        const second = yield* stack.deploy(program(true));
        expect(second.instance.instanceId).not.toBe(first.instance.instanceId);

        // The new instance launched with the replaced queue's URL.
        const userData = yield* ec2.describeInstanceAttribute({
          InstanceId: second.instance.instanceId,
          Attribute: "userData",
        });
        const script = yield* Effect.sync(() =>
          Buffer.from(userData.UserData?.Value ?? "", "base64").toString("utf8"),
        );
        expect(script).toContain(second.queue.queueUrl);
        yield* assertInstanceTerminated(first.instance.instanceId);

        yield* stack.destroy();
        yield* assertInstanceTerminated(second.instance.instanceId);
        yield* assertVpcGone(second.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  // A launch whose reply was lost leaves no saved output, and the tag lookup
  // can miss an instance EC2 has not indexed yet. The ClientToken alchemy
  // derives from the resource's generation makes the retried RunInstances
  // return the first instance instead of a second one.
  test.provider(
    "a launch retried after a lost reply returns the same instance",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployWith = (tags: Record<string, string>) =>
          stack.deploy(
            Effect.gen(function* () {
              const vpc = yield* Vpc("ClientTokenVpc", { cidrBlock: "10.0.0.0/16" });
              const subnet = yield* Subnet("ClientTokenSubnet", {
                vpcId: vpc.vpcId,
                cidrBlock: "10.0.1.0/24",
              });
              const instance = yield* Instance("ClientTokenInstance", {
                imageId: amazonLinux2023(),
                instanceType: "t3.micro",
                subnetId: subnet.subnetId,
                tags,
              });
              return { vpc, instance };
            }),
          );
        const key = { stack: stack.name, stage: stack.stage, fqn: "ClientTokenInstance" };

        // Simulate a lost RunInstances reply: drop the saved output and the
        // generation tag the recovery lookup finds the instance by.
        const loseReply = Effect.fn(function* (instanceId: string) {
          const state = yield* yield* State;
          const row = yield* state.get(key);
          if (row?.status !== "created") {
            return yield* Effect.die(new Error("Expected a created instance row"));
          }
          const { attr: _attr, ...rest } = row;
          yield* state.set({ ...key, value: { ...rest, status: "creating" } });
          yield* ec2.deleteTags({
            Resources: [instanceId],
            Tags: [{ Key: "alchemy::instance" }],
          });
          return row.instanceId;
        });

        const ownedInstances = ec2
          .describeInstances({
            Filters: [
              { Name: "tag:alchemy::stack", Values: [stack.name] },
              { Name: "tag:alchemy::stage", Values: [stack.stage] },
              { Name: "tag:alchemy::id", Values: ["ClientTokenInstance"] },
              { Name: "instance-state-name", Values: ["pending", "running"] },
            ],
          })
          .pipe(
            Effect.map((owned) => (owned.Reservations ?? []).flatMap((r) => r.Instances ?? [])),
          );

        const first = yield* deployWith({ v: "1" });
        const generation = yield* loseReply(first.instance.instanceId);

        const retried = yield* deployWith({ v: "1" });
        expect(retried.instance.instanceId).toBe(first.instance.instanceId);

        // Only one live instance carries this resource's ownership tags, and
        // the sync put the generation tag back.
        const instances = yield* ownedInstances;
        expect(instances.map((i) => i.InstanceId)).toEqual([first.instance.instanceId]);
        expect(instances[0]?.Tags?.find((tag) => tag.Key === "alchemy::instance")?.Value).toBe(
          generation,
        );

        // Lose the reply again, then terminate the instance outside the
        // stack. The retried token now returns a terminated instance, so the
        // launch must start a new one rather than fail or adopt the tombstone.
        yield* loseReply(first.instance.instanceId);
        yield* terminateOutOfBand(first.instance.instanceId);

        const relaunched = yield* deployWith({ v: "1" });
        expect(relaunched.instance.instanceId).not.toBe(first.instance.instanceId);
        expect((yield* ownedInstances).map((i) => i.InstanceId)).toEqual([
          relaunched.instance.instanceId,
        ]);

        // Terminate the instance outside the stack and change a tag. The
        // update finds the saved instance terminated and relaunches under a
        // token keyed on it. Then lose that reply: state still holds the
        // terminated instance, so the retry must send the same token and get
        // the same new instance.
        const state = yield* yield* State;
        const beforeRecreate = yield* state.get(key);
        yield* terminateOutOfBand(relaunched.instance.instanceId);
        const recreated = yield* deployWith({ v: "2" });
        expect(recreated.instance.instanceId).not.toBe(relaunched.instance.instanceId);

        yield* state.set({ ...key, value: beforeRecreate! });
        yield* ec2.deleteTags({
          Resources: [recreated.instance.instanceId],
          Tags: [{ Key: "alchemy::instance" }],
        });
        const retriedRecreate = yield* deployWith({ v: "2" });
        expect(retriedRecreate.instance.instanceId).toBe(recreated.instance.instanceId);
        expect((yield* ownedInstances).map((i) => i.InstanceId)).toEqual([
          recreated.instance.instanceId,
        ]);

        yield* stack.destroy();
        yield* assertInstanceTerminated(recreated.instance.instanceId);
        yield* assertVpcGone(first.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  // EC2 keeps listing a terminated instance for a while. `read` must report
  // it as missing, so drift sees the instance gone rather than changed.
  // Repair relaunches it under a new ClientToken.
  test.provider(
    "drift reports an instance terminated outside the stack as missing and repair relaunches it",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = Effect.gen(function* () {
          const vpc = yield* Vpc("DriftInstanceVpc", { cidrBlock: "10.0.0.0/16" });
          const subnet = yield* Subnet("DriftInstanceSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.0.1.0/24",
          });
          const instance = yield* Instance("DriftInstance", {
            imageId: amazonLinux2023(),
            instanceType: "t3.micro",
            subnetId: subnet.subnetId,
          });
          return { vpc, instance };
        });

        const deployed = yield* stack.deploy(program);
        const state = yield* yield* State;
        const key = { stack: stack.name, stage: stack.stage, fqn: "DriftInstance" };
        const beforeRepair = yield* state.get(key);

        yield* terminateOutOfBand(deployed.instance.instanceId);

        const drift = yield* Drift.detect({ name: stack.name, stage: stack.stage }).pipe(
          Effect.provide(stack.state),
        );
        expect(drift.resources.DriftInstance?.action).toBe("missing");

        const repaired = yield* Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
          Effect.provide(stack.state),
        );
        expect(repaired.resources.DriftInstance?.action).toBe("recreated");
        const relaunched = repaired.resources.DriftInstance?.attr as typeof deployed.instance;
        expect(relaunched.instanceId).not.toBe(deployed.instance.instanceId);
        const live = yield* ec2.describeInstances({ InstanceIds: [relaunched.instanceId] });
        expect(live.Reservations?.[0]?.Instances?.[0]?.State?.Name).toBe("running");

        // Lose the repair's reply: state still holds the terminated instance
        // and the recovery lookup misses. Repairing again must return the
        // same instance rather than launch a second one.
        yield* state.set({ ...key, value: beforeRepair! });
        yield* ec2.deleteTags({
          Resources: [relaunched.instanceId],
          Tags: [{ Key: "alchemy::instance" }],
        });
        const retried = yield* Drift.repair({ name: stack.name, stage: stack.stage }).pipe(
          Effect.provide(stack.state),
        );
        expect(retried.resources.DriftInstance?.action).toBe("recreated");
        expect((retried.resources.DriftInstance?.attr as typeof deployed.instance).instanceId).toBe(
          relaunched.instanceId,
        );
        const owned = yield* ec2.describeInstances({
          Filters: [
            { Name: "tag:alchemy::stack", Values: [stack.name] },
            { Name: "tag:alchemy::stage", Values: [stack.stage] },
            { Name: "tag:alchemy::id", Values: ["DriftInstance"] },
            { Name: "instance-state-name", Values: ["pending", "running"] },
          ],
        });
        expect(
          (owned.Reservations ?? []).flatMap((r) => r.Instances ?? []).map((i) => i.InstanceId),
        ).toEqual([relaunched.instanceId]);

        yield* stack.destroy();
        yield* assertInstanceTerminated(relaunched.instanceId);
        yield* assertVpcGone(deployed.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 900_000 },
  );

  // A Redacted userData is revealed only for RunInstances and compared by
  // value: the copy decoded from state is a new object, which must not
  // replace the instance on every deploy.
  test.provider(
    "accepts Redacted userData and compares it by value",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const program = (token: string) =>
          Effect.gen(function* () {
            const vpc = yield* Vpc("RedactedUserDataVpc", { cidrBlock: "10.0.0.0/16" });
            const subnet = yield* Subnet("RedactedUserDataSubnet", {
              vpcId: vpc.vpcId,
              cidrBlock: "10.0.1.0/24",
            });
            const instance = yield* Instance("RedactedUserDataInstance", {
              imageId: amazonLinux2023(),
              instanceType: "t3.micro",
              subnetId: subnet.subnetId,
              userData: Redacted.make(`#!/bin/bash\necho TOKEN=${token}\n`),
            });
            return { vpc, instance };
          });

        const first = yield* stack.deploy(program("one"));
        const userData = yield* ec2.describeInstanceAttribute({
          InstanceId: first.instance.instanceId,
          Attribute: "userData",
        });
        const script = yield* Effect.sync(() =>
          Buffer.from(userData.UserData?.Value ?? "", "base64").toString("utf8"),
        );
        expect(script).toContain("TOKEN=one");

        const unchanged = yield* stack.plan(program("one"));
        expect(unchanged.resources.RedactedUserDataInstance?.action).toBe("noop");
        const changed = yield* stack.plan(program("two"));
        expect(changed.resources.RedactedUserDataInstance?.action).toBe("replace");

        yield* stack.destroy();
        yield* assertInstanceTerminated(first.instance.instanceId);
        yield* assertVpcGone(first.vpc.vpcId);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  const fixedIpProgram = (props: Partial<InstanceProps> = {}) =>
    Effect.gen(function* () {
      const vpc = yield* Vpc("FixedIpVpc", { cidrBlock: "10.0.0.0/16" });
      const subnet = yield* Subnet("FixedIpSubnet", { vpcId: vpc.vpcId, cidrBlock: "10.0.1.0/24" });
      const otherVpc = yield* Vpc("OtherFixedIpVpc", { cidrBlock: "10.0.0.0/16" });
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

        const differentIp = yield* stack.plan(fixedIpProgram({ privateIpAddress: "10.0.1.11" }));
        expect(differentIp.resources.FixedIpInstance).toMatchObject({
          action: "replace",
          deleteFirst: false,
        });
        const differentSubnet = yield* stack.plan(
          fixedIpProgram({ subnetId: first.otherSubnet.subnetId }),
        );
        expect(differentSubnet.resources.FixedIpInstance).toMatchObject({
          action: "replace",
          deleteFirst: false,
        });

        const next = fixedIpProgram({ userData: "#!/bin/bash\necho generation-two\n", tags });
        const replacement = yield* stack.plan(next);
        expect(replacement.resources.FixedIpInstance).toMatchObject({
          action: "replace",
          deleteFirst: true,
        });
        const second = yield* stack.deploy(next);
        expect(second.instance.instanceId).not.toBe(first.instance.instanceId);
        const live = yield* ec2.describeInstances({ InstanceIds: [second.instance.instanceId] });
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
        const key = { stack: stack.name, stage: stack.stage, fqn: "FixedIpInstance" };
        const first = yield* stack.deploy(fixedIpProgram());
        const firstState = yield* state.get(key);
        if (firstState?.status !== "created" && firstState?.status !== "updated") {
          return yield* Effect.die(new Error("Expected a deployed original instance"));
        }

        const next = fixedIpProgram({ privateIpAddress: "10.0.1.11" });
        const second = yield* stack.deploy(next);
        const secondState = yield* state.get(key);
        if (secondState?.status !== "created" && secondState?.status !== "updated") {
          return yield* Effect.die(new Error("Expected a deployed replacement instance"));
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
        expect(recovery.resources.FixedIpInstance).not.toMatchObject({ restart: true });
        const recovered = yield* stack.deploy(next);
        expect(recovered.instance.instanceId).toBe(second.instance.instanceId);
        const live = yield* ec2.describeInstances({ InstanceIds: [recovered.instance.instanceId] });
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
});
