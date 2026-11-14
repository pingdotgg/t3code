import * as AWS from "@alchemy.run/aws";
import { Filter } from "@alchemy.run/aws/Inspector2/Filter";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// The findings-filter APIs work regardless of Inspector enablement, so the
// Filter lifecycle always runs live and may overlap the enablement tests in
// Enabler.test.ts. The CIS scan tests live there because the CIS APIs depend
// on the account/region enablement singleton.
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
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void)),
      );

      const deploy = (props: { action: "NONE" | "SUPPRESS"; reason: string }) =>
        stack.deploy(
          Effect.gen(function* () {
            const filter = yield* Filter("SuppressInfo", {
              action: props.action,
              reason: props.reason,
              description: "created by alchemy Inspector2 resource test",
              filterCriteria: { severity: [{ comparison: "EQUALS", value: "INFORMATIONAL" }] },
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
      const live = (yield* inspector2.listFilters({ arns: [created.arn] })).filters[0];
      expect(live?.action).toBe("SUPPRESS");
      expect(live?.tags?.["env"]).toBe("test");
      expect(live?.tags?.["alchemy::id"]).toBe("SuppressInfo");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Filter);
      const all = yield* provider.list();
      expect(all.some((f) => f.arn === created.arn)).toBe(true);

      // Update in place — the ARN is stable.
      const updated = yield* deploy({ action: "NONE", reason: "keep them visible after all" });
      expect(updated.arn).toBe(created.arn);
      expect(updated.action).toBe("NONE");
      const liveUpdated = (yield* inspector2.listFilters({ arns: [created.arn] })).filters[0];
      expect(liveUpdated?.action).toBe("NONE");
      expect(liveUpdated?.reason).toBe("keep them visible after all");

      // Destroy — the filter is gone.
      yield* stack.destroy();
      const gone = yield* inspector2.listFilters({ arns: [created.arn] });
      expect(gone.filters).toHaveLength(0);
    }),
  { tags: ["provider:aws", "provider:aws:inspector2", "live"], timeout: 120_000 },
);
