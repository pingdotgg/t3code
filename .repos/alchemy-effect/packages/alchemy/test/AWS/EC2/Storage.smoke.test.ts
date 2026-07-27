import * as AWS from "@/AWS";
import {
  amazonLinux2023,
  Instance,
  NetworkInterface,
  NetworkInterfaceAttachment,
  SecurityGroup,
  Subnet,
  Volume,
  VolumeAttachment,
  Vpc,
} from "@/AWS/EC2";
import * as Test from "./VpcTest.ts";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const AZ = "us-west-2a";

// A single cheap t3.micro instance hosts both the EBS volume attachment and the
// ENI attachment so we pay for exactly one instance launch. The instance,
// subnet, volume, and ENI all share one AZ (EBS/ENI attachment requires it).
test.provider(
  "attach a volume and an ENI to a t3.micro instance, then detach and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const imageId = (yield* amazonLinux2023()) ?? "ami-00000000000000000";

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("StorageVpc", { cidrBlock: "10.90.0.0/16" });
          const subnet = yield* Subnet("StorageSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.90.1.0/24",
            availabilityZone: AZ,
            mapPublicIpOnLaunch: true,
          });
          const sg = yield* SecurityGroup("StorageSg", {
            vpcId: vpc.vpcId,
            description: "alchemy storage smoke test",
            egress: [
              {
                ipProtocol: "-1",
                cidrIpv4: "0.0.0.0/0",
                description: "all outbound",
              },
            ],
          });
          const instance = yield* Instance("StorageInstance", {
            imageId,
            instanceType: "t3.micro",
            subnetId: subnet.subnetId,
            securityGroupIds: [sg.groupId],
          });
          const volume = yield* Volume("StorageVolume", {
            availabilityZone: AZ,
            size: 1,
            volumeType: "gp3",
          });
          const volumeAttachment = yield* VolumeAttachment(
            "StorageVolumeAttachment",
            {
              volumeId: volume.volumeId,
              instanceId: instance.instanceId,
              device: "/dev/sdf",
            },
          );
          const eni = yield* NetworkInterface("StorageEni", {
            subnetId: subnet.subnetId,
            description: "alchemy storage smoke test secondary eni",
            securityGroupIds: [sg.groupId],
          });
          const eniAttachment = yield* NetworkInterfaceAttachment(
            "StorageEniAttachment",
            {
              networkInterfaceId: eni.networkInterfaceId,
              instanceId: instance.instanceId,
              deviceIndex: 1,
            },
          );
          return {
            instance,
            volume,
            volumeAttachment,
            eni,
            eniAttachment,
          };
        }),
      );

      const { instance, volume, volumeAttachment, eni, eniAttachment } =
        deployed;

      // Volume attachment reached 'attached'.
      expect(volumeAttachment.state).toBe("attached");
      expect(volumeAttachment.instanceId).toBe(instance.instanceId);

      const observedVolume = yield* EC2.describeVolumes({
        VolumeIds: [volume.volumeId],
      });
      const attachment = observedVolume.Volumes?.[0]?.Attachments?.find(
        (a) => a.InstanceId === instance.instanceId,
      );
      expect(attachment?.State).toBe("attached");
      expect(attachment?.Device).toBe("/dev/sdf");

      // ENI attachment reached 'attached' on device index 1.
      expect(eniAttachment.status).toBe("attached");
      expect(eniAttachment.attachmentId).toMatch(/^eni-attach-/);

      const observedEni = yield* EC2.describeNetworkInterfaces({
        NetworkInterfaceIds: [eni.networkInterfaceId],
      });
      const eniAttach = observedEni.NetworkInterfaces?.[0]?.Attachment;
      expect(eniAttach?.Status).toBe("attached");
      expect(eniAttach?.InstanceId).toBe(instance.instanceId);
      expect(eniAttach?.DeviceIndex).toBe(1);

      // Tear everything down and verify the volume + ENI are gone out-of-band.
      yield* stack.destroy();

      yield* assertVolumeGone(volume.volumeId);
      yield* assertEniGone(eni.networkInterfaceId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

const assertVolumeGone = Effect.fn(function* (volumeId: string) {
  yield* EC2.describeVolumes({ VolumeIds: [volumeId] }).pipe(
    Effect.flatMap((result) => {
      const state = result.Volumes?.[0]?.State;
      // `deleting` is terminal — EC2 can keep a deleted volume visible in
      // this state for many minutes of internal bookkeeping.
      return state === undefined || state === "deleted" || state === "deleting"
        ? Effect.void
        : Effect.fail(new StillExists());
    }),
    Effect.retry({
      while: (e) => e instanceof StillExists,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(20)]),
    }),
    Effect.catchTag("InvalidVolume.NotFound", () => Effect.void),
  );
});

const assertEniGone = Effect.fn(function* (eniId: string) {
  yield* EC2.describeNetworkInterfaces({
    NetworkInterfaceIds: [eniId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new StillExists())),
    Effect.retry({
      while: (e) => e instanceof StillExists,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(20)]),
    }),
    Effect.catchTag("InvalidNetworkInterfaceID.NotFound", () => Effect.void),
  );
});

class StillExists extends Data.TaggedError("StillExists") {}
