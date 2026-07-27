import * as AWS from "@/AWS";
import { ObservabilityConfiguration } from "@/AWS/AppRunner";
import * as Test from "@/Test/Alchemy";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeObservabilityConfiguration on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        apprunner.describeObservabilityConfiguration({
          ObservabilityConfigurationArn: `arn:aws:apprunner:us-west-2:${Account}:observabilityconfiguration/alchemy-nonexistent-probe/1/00000000000000000000000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// No ACTIVE revision of the named configuration remains. Unlike auto
// scaling configuration summaries, observability configuration summaries
// carry no Status field — the list only returns active revisions.
const assertConfigGone = (name: string) =>
  Effect.gen(function* () {
    const page = yield* apprunner.listObservabilityConfigurations({
      ObservabilityConfigurationName: name,
    });
    const active = (page.ObservabilityConfigurationSummaryList ?? []).filter(
      (s) => s.ObservabilityConfigurationName === name,
    );
    if (active.length > 0) {
      return yield* Effect.fail(
        new Error(
          `Observability configuration '${name}' still has ${active.length} ACTIVE revision(s)`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Observability configurations are immutable revisions — fast and free, so
// the full lifecycle (create, no-op, replace-by-name, destroy) runs ungated.
test.provider(
  "create, no-op, replace, and destroy an observability configuration",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const props = {
        observabilityConfigurationName: "alchemy-test-obs",
        traceConfiguration: { vendor: "AWSXRAY" as const },
      };

      // Create.
      const created = yield* stack.deploy(
        ObservabilityConfiguration("Obs", props),
      );
      expect(created.observabilityConfigurationName).toBe("alchemy-test-obs");
      expect(created.observabilityConfigurationArn).toContain(
        ":observabilityconfiguration/alchemy-test-obs/",
      );
      expect(created.traceVendor).toBe("AWSXRAY");
      expect(created.observabilityConfigurationRevision).toBeGreaterThanOrEqual(
        1,
      );

      // Out-of-band verification via distilled.
      const described = yield* apprunner.describeObservabilityConfiguration({
        ObservabilityConfigurationArn: created.observabilityConfigurationArn,
      });
      expect(described.ObservabilityConfiguration.Status?.toUpperCase()).toBe(
        "ACTIVE",
      );
      expect(
        described.ObservabilityConfiguration.TraceConfiguration?.Vendor,
      ).toBe("AWSXRAY");

      // No-op redeploy must not create a new revision.
      const noop = yield* stack.deploy(
        ObservabilityConfiguration("Obs", props),
      );
      expect(noop.observabilityConfigurationRevision).toBe(
        created.observabilityConfigurationRevision,
      );

      // Name change → replace; every revision of the old name is deleted.
      const replaced = yield* stack.deploy(
        ObservabilityConfiguration("Obs", {
          ...props,
          observabilityConfigurationName: "alchemy-test-obs-b",
        }),
      );
      expect(replaced.observabilityConfigurationName).toBe(
        "alchemy-test-obs-b",
      );
      yield* assertConfigGone("alchemy-test-obs");

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertConfigGone("alchemy-test-obs-b");
    }),
  { timeout: 120_000 },
);
