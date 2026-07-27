import * as Test from "@/Test/Alchemy";
import type { TestOptions } from "alchemy-test";
import { makeApiGatewayTestLease } from "./TestLease.ts";

const apiGatewayOptions = (options: TestOptions | undefined): TestOptions => {
  const normalized =
    typeof options === "number" ? { timeout: options } : options;
  return {
    ...normalized,
    // Once a file owns the service lease, an individual lifecycle should
    // finish well inside two minutes. Fail there rather than concealing a
    // provider hang behind the full-run timeout.
    timeout: normalized?.timeout ?? 120_000,
    // API Gateway REST mutations share an account-wide throttle. A timed-out
    // retry starts with a fresh scratch state and therefore cannot reclaim the
    // physical API from the interrupted attempt, so these live tests run once.
    // TestLease serializes only this service's files; do not use the runner's
    // global `exclusive` lock here because that would also block unrelated AWS
    // services while API Gateway waits on its slow control plane.
    retry: 0,
  };
};

/**
 * API Gateway REST test adapter.
 *
 * The old Vitest project ran this directory in a single fork with file
 * concurrency disabled. A shared root-hook lease restores that scheduling
 * contract without teaching the generic runner about service paths.
 */
export const make = <ROut = any>(options: Test.MakeOptions<ROut>) => {
  const api = Test.make(options);
  const testLease = makeApiGatewayTestLease();

  // The first 12 files can enter the runner together. Waiting here is
  // intentional service scheduling rather than a cloud operation, so allow
  // the queue to span the full hard-walled AWS run.
  api.beforeAll(testLease.acquire, { timeout: 3_600_000 });
  api.afterAll(testLease.release);

  const provider = api.test.provider;

  const providerWithOptions = ((name, fn, testOptions) =>
    provider(name, fn, apiGatewayOptions(testOptions))) as typeof provider;
  providerWithOptions.skip = (name, fn, testOptions) =>
    provider.skip(name, fn, apiGatewayOptions(testOptions));
  providerWithOptions.skipIf = (condition) => (name, fn, testOptions) =>
    provider.skipIf(condition)(name, fn, apiGatewayOptions(testOptions));

  api.test.provider = providerWithOptions;
  return api;
};
