import * as Test from "@/Test/Alchemy";
import { makeEc2VpcCapacityLease } from "./VpcCapacity.ts";

/** Test adapter for files that create custom VPCs. */
export const make = <ROut = any>(
  options: Test.MakeOptions<ROut>,
  permits: 1 | 2 = 1,
) => {
  const api = Test.make(options);
  const lease = makeEc2VpcCapacityLease(permits);

  // Waiting is intentional scheduling across the full AWS run, not a cloud
  // operation, so it uses the run's hard wall rather than a per-test budget.
  api.beforeAll(lease.acquire, { timeout: 3_600_000 });
  api.afterAll(lease.release);

  return api;
};
