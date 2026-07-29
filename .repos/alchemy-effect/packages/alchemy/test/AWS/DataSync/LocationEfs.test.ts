import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as datasync from "@distilled.cloud/aws/datasync";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

const waitUntilLocationGone = (locationArn: string) =>
  datasync.describeLocationEfs({ LocationArn: locationArn }).pipe(
    Effect.as(false),
    Effect.catchTag("LocationNotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.fixed("1 seconds"),
      until: (gone) => gone,
      times: 20,
    }),
  );

test.provider(
  "typed LocationNotFound on a nonexistent EFS location",
  () =>
    Effect.gen(function* () {
      const result = yield* datasync
        .describeLocationEfs({
          LocationArn:
            "arn:aws:datasync:us-west-2:391965393224:location/loc-00000000000000000",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const err = result.failure as { _tag: string };
        expect(err._tag).toBe("LocationNotFound");
      }
    }),
  { timeout: 60_000 },
);

// The live lifecycle requires an EFS file system + mount target; the mount
// target's ENI takes 1–3 minutes to become available and again to release on
// teardown, so the full cycle is gated behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create EFS location from a file system + mount target, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const region = yield* Region;
      const vpc = yield* getDefaultVpc;
      const subnets = yield* EC2.describeSubnets({
        Filters: [
          { Name: "vpc-id", Values: [vpc.vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      });
      const subnetId = subnets.Subnets![0]!.SubnetId!;
      const groups = yield* EC2.describeSecurityGroups({
        Filters: [
          { Name: "vpc-id", Values: [vpc.vpcId] },
          { Name: "group-name", Values: ["default"] },
        ],
      });
      const sg = groups.SecurityGroups![0]!;
      const accountId = sg.OwnerId!;
      const securityGroupId = sg.GroupId!;
      const subnetArn = `arn:aws:ec2:${region}:${accountId}:subnet/${subnetId}`;
      const securityGroupArn = `arn:aws:ec2:${region}:${accountId}:security-group/${securityGroupId}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const files = yield* AWS.EFS.FileSystem("EfsLocFiles");
          const target = yield* AWS.EFS.MountTarget("EfsLocTarget", {
            fileSystemId: files.fileSystemId,
            subnetId,
          });
          const location = yield* AWS.DataSync.LocationEfs("EfsLoc", {
            // depend on the mount target so the location is created only once
            // the network endpoint is available
            efsFilesystemArn: files.fileSystemArn,
            subnetArn,
            securityGroupArns: [securityGroupArn],
            tags: { mount: target.mountTargetId },
          });
          return { location };
        }),
      );
      expect(created.location.locationArn).toContain(":location/loc-");
      expect(created.location.locationUri).toContain("efs://");
      const arn = created.location.locationArn;

      const observed = yield* datasync.describeLocationEfs({
        LocationArn: arn,
      });
      expect(observed.Ec2Config?.SubnetArn).toBe(subnetArn);

      yield* stack.destroy();
      const gone = yield* waitUntilLocationGone(arn);
      expect(gone).toBe(true);
    }),
  { timeout: 600_000 },
);
