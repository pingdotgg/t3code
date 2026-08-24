import * as AWS from "@/AWS";
import { AutoScalingConfiguration } from "@/AWS/AppRunner";
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
  "describeAutoScalingConfiguration on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        apprunner.describeAutoScalingConfiguration({
          AutoScalingConfigurationArn: `arn:aws:apprunner:us-west-2:${Account}:autoscalingconfiguration/alchemy-nonexistent-probe/1/00000000000000000000000000000000`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// No ACTIVE revision of the named configuration remains (deleted configs
// linger as INACTIVE for observability).
const assertConfigGone = (name: string) =>
  Effect.gen(function* () {
    const page = yield* apprunner.listAutoScalingConfigurations({
      AutoScalingConfigurationName: name,
    });
    // App Runner returns lowercase statuses ("active") despite documenting
    // uppercase — compare case-insensitively.
    const active = (page.AutoScalingConfigurationSummaryList ?? []).filter(
      (s) =>
        s.AutoScalingConfigurationName === name &&
        s.Status?.toUpperCase() === "ACTIVE",
    );
    if (active.length > 0) {
      return yield* Effect.fail(
        new Error(
          `Auto scaling configuration '${name}' still has ${active.length} ACTIVE revision(s)`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Auto scaling configurations are immutable revisions — fast and free, so
// the full lifecycle (create, no-op, revise, replace-by-name, destroy)
// runs ungated.
test.provider(
  "create, revise, replace, and destroy an auto scaling configuration",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const props = {
        autoScalingConfigurationName: "alchemy-test-asc",
        maxConcurrency: 50,
        minSize: 1,
        maxSize: 3,
      };

      // Create.
      const created = yield* stack.deploy(
        AutoScalingConfiguration("Asc", props),
      );
      expect(created.autoScalingConfigurationName).toBe("alchemy-test-asc");
      expect(created.autoScalingConfigurationArn).toContain(
        ":autoscalingconfiguration/alchemy-test-asc/",
      );
      expect(created.maxConcurrency).toBe(50);
      expect(created.maxSize).toBe(3);

      // Out-of-band verification via distilled.
      const described = yield* apprunner.describeAutoScalingConfiguration({
        AutoScalingConfigurationArn: created.autoScalingConfigurationArn,
      });
      expect(described.AutoScalingConfiguration.Status?.toUpperCase()).toBe(
        "ACTIVE",
      );
      expect(described.AutoScalingConfiguration.MaxConcurrency).toBe(50);
      expect(described.AutoScalingConfiguration.MinSize).toBe(1);
      expect(described.AutoScalingConfiguration.MaxSize).toBe(3);

      // No-op redeploy must not create a new revision.
      const noop = yield* stack.deploy(AutoScalingConfiguration("Asc", props));
      expect(noop.autoScalingConfigurationRevision).toBe(
        created.autoScalingConfigurationRevision,
      );

      // Settings change → new revision under the same name.
      const revised = yield* stack.deploy(
        AutoScalingConfiguration("Asc", { ...props, maxConcurrency: 80 }),
      );
      expect(revised.autoScalingConfigurationName).toBe("alchemy-test-asc");
      expect(revised.autoScalingConfigurationRevision).toBe(
        created.autoScalingConfigurationRevision + 1,
      );
      expect(revised.autoScalingConfigurationArn).not.toBe(
        created.autoScalingConfigurationArn,
      );
      expect(revised.maxConcurrency).toBe(80);

      // Name change → replace; every revision of the old name is deleted.
      const replaced = yield* stack.deploy(
        AutoScalingConfiguration("Asc", {
          ...props,
          autoScalingConfigurationName: "alchemy-test-asc-b",
        }),
      );
      expect(replaced.autoScalingConfigurationName).toBe("alchemy-test-asc-b");
      yield* assertConfigGone("alchemy-test-asc");

      // Destroy and verify deletion out-of-band.
      yield* stack.destroy();
      yield* assertConfigGone("alchemy-test-asc-b");
    }),
  { timeout: 120_000 },
);
