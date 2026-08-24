/**
 * Typed out-of-band "assert gone" helpers shared by the EC2 test suites.
 *
 * Each helper describes the resource by id after the final `stack.destroy()`
 * and succeeds only when the API returns the typed NotFound tag (or, for
 * instances, a terminal state). A bounded retry absorbs EC2's eventual
 * consistency; anything else fails the test — proving the suite left zero
 * orphans.
 */
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

class ResourceStillExists extends Data.TaggedError("ResourceStillExists")<{
  readonly id: string;
}> {}

const goneRetry = {
  while: (e: { _tag: string }): boolean => e._tag === "ResourceStillExists",
  schedule: Schedule.spaced("3 seconds"),
  times: 10,
} as const;

export const assertVpcGone = Effect.fn(function* (vpcId: string) {
  yield* ec2.describeVpcs({ VpcIds: [vpcId] }).pipe(
    Effect.flatMap(() => Effect.fail(new ResourceStillExists({ id: vpcId }))),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
  );
});

export const assertEipGone = Effect.fn(function* (allocationId: string) {
  yield* ec2.describeAddresses({ AllocationIds: [allocationId] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ResourceStillExists({ id: allocationId })),
    ),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidAllocationID.NotFound", () => Effect.void),
  );
});

export const assertInternetGatewayGone = Effect.fn(function* (igwId: string) {
  yield* ec2.describeInternetGateways({ InternetGatewayIds: [igwId] }).pipe(
    Effect.flatMap(() => Effect.fail(new ResourceStillExists({ id: igwId }))),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidInternetGatewayID.NotFound", () => Effect.void),
  );
});

export const assertRouteTableGone = Effect.fn(function* (routeTableId: string) {
  yield* ec2.describeRouteTables({ RouteTableIds: [routeTableId] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ResourceStillExists({ id: routeTableId })),
    ),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidRouteTableID.NotFound", () => Effect.void),
  );
});

export const assertSecurityGroupGone = Effect.fn(function* (groupId: string) {
  yield* ec2.describeSecurityGroups({ GroupIds: [groupId] }).pipe(
    Effect.flatMap(() => Effect.fail(new ResourceStillExists({ id: groupId }))),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidGroup.NotFound", () => Effect.void),
  );
});

export const assertNetworkAclGone = Effect.fn(function* (networkAclId: string) {
  yield* ec2.describeNetworkAcls({ NetworkAclIds: [networkAclId] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ResourceStillExists({ id: networkAclId })),
    ),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidNetworkAclID.NotFound", () => Effect.void),
  );
});

export const assertSubnetGone = Effect.fn(function* (subnetId: string) {
  yield* ec2.describeSubnets({ SubnetIds: [subnetId] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ResourceStillExists({ id: subnetId })),
    ),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidSubnetID.NotFound", () => Effect.void),
  );
});

export const assertKeyPairGone = Effect.fn(function* (keyPairId: string) {
  yield* ec2.describeKeyPairs({ KeyPairIds: [keyPairId] }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ResourceStillExists({ id: keyPairId })),
    ),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidKeyPair.NotFound", () => Effect.void),
  );
});

/**
 * A terminated instance remains visible in `describeInstances` for a while;
 * `terminated` (or the id no longer resolving) is the terminal, non-billing
 * state that proves the suite left nothing running.
 */
export const assertInstanceTerminated = Effect.fn(function* (
  instanceId: string,
) {
  yield* ec2.describeInstances({ InstanceIds: [instanceId] }).pipe(
    Effect.flatMap((result) => {
      const state = result.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      return state === undefined || state === "terminated"
        ? Effect.void
        : Effect.fail(new ResourceStillExists({ id: instanceId }));
    }),
    Effect.retry(goneRetry),
    Effect.catchTag("InvalidInstanceID.NotFound", () => Effect.void),
  );
});
