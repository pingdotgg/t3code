import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

// The testing account has the default quota of five VPCs per Region. Its
// default VPC consumes one slot, and non-EC2 suites (EFS, ECS, RDS, etc.) may
// need another while EC2 tests run. Limit EC2 to three concurrent custom VPCs
// so the full AWS wave retains one spare slot instead of racing the hard quota.
const ec2VpcCapacity = Semaphore.makeUnsafe(3);

export const makeEc2VpcCapacityLease = (permits: 1 | 2 = 1) => {
  let held = false;

  return {
    acquire: Effect.uninterruptibleMask((restore) =>
      restore(ec2VpcCapacity.take(permits)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            held = true;
          }),
        ),
        Effect.asVoid,
      ),
    ),
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      return ec2VpcCapacity.release(permits).pipe(Effect.asVoid);
    }),
  };
};
