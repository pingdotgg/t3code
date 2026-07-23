import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
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

test.provider.skip("create, update, delete vpc", (stack) =>
  Effect.gen(function* () {
    const vpc = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
          enableDnsSupport: true,
          enableDnsHostnames: true,
        });
      }),
    );

    const actualVpc = yield* EC2.describeVpcs({
      VpcIds: [vpc.vpcId],
    });
    expect(actualVpc.Vpcs?.[0]?.VpcId).toEqual(vpc.vpcId);
    expect(actualVpc.Vpcs?.[0]?.CidrBlock).toEqual("10.0.0.0/16");
    expect(actualVpc.Vpcs?.[0]?.State).toEqual("available");

    yield* expectVpcAttribute({
      VpcId: vpc.vpcId,
      Attribute: "enableDnsSupport",
      Value: true,
    });

    yield* expectVpcAttribute({
      VpcId: vpc.vpcId,
      Attribute: "enableDnsHostnames",
      Value: true,
    });

    // Update VPC attributes
    const updatedVpc = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Vpc("TestVpc", {
          cidrBlock: "10.0.0.0/16",
          enableDnsSupport: false,
          enableDnsHostnames: false,
        });
      }),
    );

    yield* expectVpcAttribute({
      VpcId: updatedVpc.vpcId,
      Attribute: "enableDnsSupport",
      Value: false,
    });

    yield* expectVpcAttribute({
      VpcId: updatedVpc.vpcId,
      Attribute: "enableDnsHostnames",
      Value: false,
    });

    yield* stack.destroy();

    yield* assertVpcDeleted(vpc.vpcId);
  }).pipe(logLevel),
);

const expectVpcAttribute = Effect.fn(function* (props: {
  VpcId: string;
  Attribute: EC2.VpcAttributeName;
  Value: boolean;
}) {
  yield* EC2.describeVpcAttribute({
    VpcId: props.VpcId,
    Attribute: props.Attribute,
  }).pipe(
    Effect.tap(Effect.logDebug),
    Effect.flatMap((result: any) =>
      result[`${props.Attribute[0].toUpperCase()}${props.Attribute.slice(1)}`]
        ?.Value === props.Value
        ? Effect.succeed(result)
        : Effect.fail(new VpcAttributeStale()),
    ),
    Effect.retry({
      while: (e) => e._tag === "VpcAttributeStale",
      schedule: Schedule.exponential(100),
    }),
  );
});

class VpcAttributeStale extends Data.TaggedError("VpcAttributeStale") {}

class VpcStillExists extends Data.TaggedError("VpcStillExists") {}

export const assertVpcDeleted = Effect.fn(function* (vpcId: string) {
  yield* EC2.describeVpcs({
    VpcIds: [vpcId],
  }).pipe(
    Effect.flatMap(() => Effect.fail(new VpcStillExists())),
    Effect.retry({
      while: (e) => e._tag === "VpcStillExists",
      schedule: Schedule.exponential(100),
    }),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );
});
