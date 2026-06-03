import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, update, delete subnet", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const { vpc, subnet } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("TestSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        return { vpc, subnet };
      }),
    );

    const actualSubnet = yield* EC2.describeSubnets({
      SubnetIds: [subnet.subnetId],
    });

    expect(actualSubnet.Subnets?.[0]?.SubnetId).toEqual(subnet.subnetId);
    expect(actualSubnet.Subnets?.[0]?.CidrBlock).toEqual("10.0.1.0/24");
    expect(actualSubnet.Subnets?.[0]?.VpcId).toEqual(vpc.vpcId);
    expect(actualSubnet.Subnets?.[0]?.State).toEqual("available");
    expect(actualSubnet.Subnets?.[0]?.MapPublicIpOnLaunch).toEqual(false);

    // Update subnet attributes
    const { subnet: updatedSubnet } = yield* stack.deploy(
      Effect.gen(function* () {
        const vpc = yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("TestSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
          mapPublicIpOnLaunch: true,
        });
        return { vpc, subnet };
      }),
    );

    yield* expectSubnetAttribute({
      SubnetId: updatedSubnet.subnetId,
      Attribute: "mapPublicIpOnLaunch",
      Value: true,
    });

    // Delete subnet and VPC
    yield* stack.destroy();

    yield* assertSubnetDeleted(subnet.subnetId);
  }).pipe(logLevel),
);

const expectSubnetAttribute = Effect.fn(function* (props: {
  SubnetId: string;
  Attribute: "mapPublicIpOnLaunch" | "assignIpv6AddressOnCreation";
  Value: boolean;
}) {
  yield* EC2.describeSubnets({
    SubnetIds: [props.SubnetId],
  }).pipe(
    Effect.tap(Effect.logDebug),
    Effect.flatMap((result) => {
      const subnet = result.Subnets?.[0];
      const actualValue =
        props.Attribute === "mapPublicIpOnLaunch"
          ? subnet?.MapPublicIpOnLaunch
          : subnet?.AssignIpv6AddressOnCreation;

      return actualValue === props.Value
        ? Effect.succeed(result)
        : Effect.fail(new SubnetAttributeStale());
    }),
    Effect.retry({
      while: (e) => e instanceof SubnetAttributeStale,
      schedule: Schedule.exponential(100),
    }),
  );
});

const assertSubnetDeleted = Effect.fn(function* (subnetId: string) {
  yield* EC2.describeSubnets({
    SubnetIds: [subnetId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new SubnetStillExists())),
    Effect.retry({
      while: (e) => e instanceof SubnetStillExists,
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
  );
});

class SubnetStillExists extends Data.TaggedError("SubnetStillExists") {}

class SubnetAttributeStale extends Data.TaggedError("SubnetAttributeStale") {}
