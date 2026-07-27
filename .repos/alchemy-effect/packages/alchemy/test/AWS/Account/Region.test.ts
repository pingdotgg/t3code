import * as AWS from "@/AWS";
import { Region } from "@/AWS/Account";
import * as Test from "@/Test/Alchemy";
import * as account from "@distilled.cloud/aws/account";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("Account Region", () => {
  // us-east-1 is ENABLED_BY_DEFAULT: reconcile observes the status without
  // issuing any mutation, so this exercises the full lifecycle safely against
  // the real account.
  test.provider(
    "track a default-enabled region without mutation",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const region = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Region("UsEast1", {
              regionName: "us-east-1",
              enabled: true,
            });
          }),
        );

        expect(region.regionName).toBe("us-east-1");
        expect(region.enabled).toBe(true);
        expect(region.regionOptStatus).toBe("ENABLED_BY_DEFAULT");

        // Out-of-band verification.
        const live = yield* account.getRegionOptStatus({
          RegionName: "us-east-1",
        });
        expect(live.RegionOptStatus).toBe("ENABLED_BY_DEFAULT");

        // Destroy intentionally leaves the region's opt-in status untouched.
        yield* stack.destroy();
        const after = yield* account.getRegionOptStatus({
          RegionName: "us-east-1",
        });
        expect(after.RegionOptStatus).toBe("ENABLED_BY_DEFAULT");
      }),
    { timeout: 120_000 },
  );

  // Enabling an opt-in region mutates the account and cannot be immediately
  // reverted (AWS enforces a waiting period before a freshly enabled region
  // can be disabled), so this lifecycle is env-gated. Run with
  // AWS_TEST_REGION_OPT_IN=1 against an account where enabling ap-east-1 is
  // acceptable.
  test.provider.skipIf(!process.env.AWS_TEST_REGION_OPT_IN)(
    "enable an opt-in region",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const region = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Region("HongKong", {
              regionName: "ap-east-1",
              enabled: true,
            });
          }),
        );

        expect(region.regionName).toBe("ap-east-1");
        // Reconcile waits (bounded) for the transition to settle; if the
        // enable is still propagating it reports the transitional status.
        expect(["ENABLED", "ENABLING"]).toContain(region.regionOptStatus);

        // Out-of-band verification.
        const live = yield* account.getRegionOptStatus({
          RegionName: "ap-east-1",
        });
        expect(["ENABLED", "ENABLING"]).toContain(live.RegionOptStatus);

        // Destroy leaves the region enabled by design (disabling a region
        // removes IAM access to everything in it).
        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});
