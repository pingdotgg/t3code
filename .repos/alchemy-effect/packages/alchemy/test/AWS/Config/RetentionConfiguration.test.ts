import * as AWS from "@/AWS";
import { RetentionConfiguration } from "@/AWS/Config";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/aws/config-service";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeRetentionConfigurations on a nonexistent name fails with NoSuchRetentionConfigurationException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        config.describeRetentionConfigurations({
          RetentionConfigurationNames: ["alchemy-nonexistent-retention-probe"],
        }),
      );
      expect(error._tag).toBe("NoSuchRetentionConfigurationException");
    }),
);

const observeRetention = config.describeRetentionConfigurations({}).pipe(
  Effect.map((r) => (r.RetentionConfigurations ?? []).at(0)),
  Effect.catchTag("NoSuchRetentionConfigurationException", () =>
    Effect.succeed(undefined),
  ),
);

// The retention configuration is an account-region singleton AWS always
// names `default` — capture any preexisting configuration up front and
// restore it after the lifecycle (success, failure, or interruption) so the
// test never permanently mutates a shared account setting.
const restorePrior = (prior: config.RetentionConfiguration | undefined) =>
  (prior === undefined
    ? Effect.void
    : config
        .putRetentionConfiguration({
          RetentionPeriodInDays: prior.RetentionPeriodInDays,
        })
        .pipe(Effect.asVoid)
  ).pipe(Effect.orDie);

test.provider(
  "create, update, delete retention configuration (Duration retentionPeriod)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const prior = yield* observeRetention;

      yield* Effect.gen(function* () {
        // Create — "90 days" exercises the Duration.Input -> wire-days path.
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* RetentionConfiguration("Retention", {
              retentionPeriod: "90 days",
            });
          }),
        );
        expect(created.retentionConfigurationName).toBe("default");
        expect(created.retentionPeriodInDays).toBe(90);

        // Out-of-band verification via distilled.
        const observed = yield* observeRetention;
        expect(observed?.Name).toBe("default");
        expect(observed?.RetentionPeriodInDays).toBe(90);

        // Update in place (singleton upsert).
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* RetentionConfiguration("Retention", {
              retentionPeriod: "180 days",
            });
          }),
        );
        expect(updated.retentionConfigurationName).toBe("default");
        expect(updated.retentionPeriodInDays).toBe(180);
        const afterUpdate = yield* observeRetention;
        expect(afterUpdate?.RetentionPeriodInDays).toBe(180);

        // Destroy and verify the singleton is gone.
        yield* stack.destroy();
        const afterDestroy = yield* observeRetention;
        expect(afterDestroy).toBeUndefined();
      }).pipe(Effect.ensuring(restorePrior(prior)));
    }),
  { timeout: 120_000 },
);
