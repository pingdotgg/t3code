import * as AWS from "@/AWS";
import { CisScanConfiguration } from "@/AWS/Inspector2/CisScanConfiguration.ts";
import { Filter } from "@/AWS/Inspector2/Filter.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as inspector2 from "@distilled.cloud/aws/inspector2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// The findings-filter APIs work regardless of Inspector enablement, so the
// Filter lifecycle always runs live.
test.provider(
  "lifecycle: findings filter create, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Self-heal: an interrupted previous run can orphan the live filter
      // (state lost, so the cloud resource is unadoptable under a fresh
      // stage). Delete any filter this test's logical id created before.
      const orphans = (yield* inspector2.listFilters({})).filters.filter(
        (f) => f.tags?.["alchemy::id"] === "SuppressInfo",
      );
      yield* Effect.forEach(orphans, (f) =>
        inspector2
          .deleteFilter({ arn: f.arn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          ),
      );

      const deploy = (props: { action: "NONE" | "SUPPRESS"; reason: string }) =>
        stack.deploy(
          Effect.gen(function* () {
            const filter = yield* Filter("SuppressInfo", {
              action: props.action,
              reason: props.reason,
              description: "created by alchemy Inspector2 resource test",
              filterCriteria: {
                severity: [{ comparison: "EQUALS", value: "INFORMATIONAL" }],
              },
              tags: { env: "test" },
            });
            return {
              arn: filter.arn,
              name: filter.name,
              action: filter.action,
              reason: filter.reason,
            };
          }),
        );

      // Create.
      const created = yield* deploy({
        action: "SUPPRESS",
        reason: "informational findings are tracked elsewhere",
      });
      expect(created.arn).toContain("/filter/");
      expect(created.action).toBe("SUPPRESS");

      // Out-of-band verification via distilled.
      const live = (yield* inspector2.listFilters({ arns: [created.arn] }))
        .filters[0];
      expect(live?.action).toBe("SUPPRESS");
      expect(live?.tags?.["env"]).toBe("test");
      expect(live?.tags?.["alchemy::id"]).toBe("SuppressInfo");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Filter);
      const all = yield* provider.list();
      expect(all.some((f) => f.arn === created.arn)).toBe(true);

      // Update in place — the ARN is stable.
      const updated = yield* deploy({
        action: "NONE",
        reason: "keep them visible after all",
      });
      expect(updated.arn).toBe(created.arn);
      expect(updated.action).toBe("NONE");
      const liveUpdated = (yield* inspector2.listFilters({
        arns: [created.arn],
      })).filters[0];
      expect(liveUpdated?.action).toBe("NONE");
      expect(liveUpdated?.reason).toBe("keep them visible after all");

      // Destroy — the filter is gone.
      yield* stack.destroy();
      const gone = yield* inspector2.listFilters({ arns: [created.arn] });
      expect(gone.filters).toHaveLength(0);
    }),
  { timeout: 120_000 },
);

// The CIS scan APIs are hard-gated on Inspector enablement — a disabled
// account gets a typed AccessDeniedException ("Invoking account is not
// enabled."). This ungated probe pins that behavior; the full lifecycle
// below only runs against an Inspector-enabled account.
test.provider("CIS scan APIs reject a non-enabled account (typed)", () =>
  Effect.gen(function* () {
    const account = (yield* inspector2.batchGetAccountStatus({})).accounts?.[0];
    if (account?.state?.status === "ENABLED") {
      yield* Effect.logInfo(
        "Inspector is enabled in this account — CIS APIs are accessible, probe not applicable",
      );
      return;
    }
    const result = yield* Effect.result(
      inspector2.listCisScanConfigurations({}),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("AccessDeniedException");
    }
  }),
);

// Full CIS scan configuration lifecycle — requires Inspector to be enabled
// (INSPECTOR2_TEST_CIS=1 on an enabled account).
test.provider.skipIf(!process.env.INSPECTOR2_TEST_CIS)(
  "lifecycle: CIS scan configuration create, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (props: {
        securityLevel: "LEVEL_1" | "LEVEL_2";
        timeOfDay: string;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const cis = yield* CisScanConfiguration("NightlyCis", {
              securityLevel: props.securityLevel,
              schedule: {
                daily: {
                  startTime: { timeOfDay: props.timeOfDay, timezone: "UTC" },
                },
              },
              targets: {
                accountIds: ["SELF"],
                targetResourceTags: { AlchemyCisTest: ["true"] },
              },
              tags: { env: "test" },
            });
            return {
              scanConfigurationArn: cis.scanConfigurationArn,
              scanName: cis.scanName,
              securityLevel: cis.securityLevel,
            };
          }),
        );

      const created = yield* deploy({
        securityLevel: "LEVEL_1",
        timeOfDay: "02:00",
      });
      expect(created.scanConfigurationArn).toContain("scan-configuration");
      expect(created.securityLevel).toBe("LEVEL_1");

      const byArn = () =>
        inspector2
          .listCisScanConfigurations({
            filterCriteria: {
              scanConfigurationArnFilters: [
                { comparison: "EQUALS", value: created.scanConfigurationArn },
              ],
            },
          })
          .pipe(Effect.map((r) => r.scanConfigurations?.[0]));

      const live = yield* byArn();
      expect(live?.securityLevel).toBe("LEVEL_1");
      expect(live?.schedule?.daily?.startTime.timeOfDay).toBe("02:00");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(CisScanConfiguration);
      const all = yield* provider.list();
      expect(
        all.some(
          (c) => c.scanConfigurationArn === created.scanConfigurationArn,
        ),
      ).toBe(true);

      // Update in place — the ARN is stable.
      const updated = yield* deploy({
        securityLevel: "LEVEL_2",
        timeOfDay: "03:30",
      });
      expect(updated.scanConfigurationArn).toBe(created.scanConfigurationArn);
      expect(updated.securityLevel).toBe("LEVEL_2");
      const liveUpdated = yield* byArn();
      expect(liveUpdated?.schedule?.daily?.startTime.timeOfDay).toBe("03:30");

      // Destroy — the configuration is gone.
      yield* stack.destroy();
      expect(yield* byArn()).toBeUndefined();
    }),
  { timeout: 120_000 },
);
