import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";

/** The private subnets and security group Aurora runs in (stands in for a real VPC setup). */
export const Private = Effect.gen(function* () {
  const vpc = yield* AWS.EC2.Vpc("Vpc", { cidrBlock: "10.0.0.0/16" });
  const a = yield* AWS.EC2.Subnet("A", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: "us-east-1a",
  });
  const b = yield* AWS.EC2.Subnet("B", {
    vpcId: vpc.vpcId,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: "us-east-1b",
  });
  const sg = yield* AWS.EC2.SecurityGroup("Db", { vpcId: vpc.vpcId, description: "database" });
  return { subnetIds: [a.subnetId, b.subnetId], securityGroupIds: [sg.groupId] };
});
