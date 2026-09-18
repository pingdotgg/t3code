import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTaxSettings } from "@distilled.cloud/stripe/stripe";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getLive = GetTaxSettings({});

const waitForTaxBehavior = (expected: string | null | undefined) =>
  getLive.pipe(
    Effect.flatMap((live) =>
      (live.defaults.tax_behavior ?? null) === (expected ?? null)
        ? Effect.succeed(live)
        : Effect.fail({ _tag: "TaxSettingsNotApplied" as const }),
    ),
    Effect.retry({
      while: (e) => e._tag === "TaxSettingsNotApplied",
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
  );

const otherBehavior = (
  current: string | null | undefined,
): "exclusive" | "inclusive" =>
  current === "exclusive" ? "inclusive" : "exclusive";

// Account-level singleton: run serially so tests do not clobber each
// other's captured baseline under the concurrent suite.
describe.sequential("TaxSettings", () => {
  test.provider(
    "updates tax behavior in place and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const baseline = yield* getLive;
        const baselineBehavior = baseline.defaults.tax_behavior ?? undefined;
        const target = otherBehavior(baselineBehavior);
        const target2 = otherBehavior(target);

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.TaxSettings("AccountTax", {
              defaults: { taxBehavior: target },
            });
          }),
        );

        expect(created.object).toEqual("tax.settings");
        expect(created.taxBehavior).toEqual(target);
        expect(created.initialSettings.taxBehavior).toEqual(baselineBehavior);
        expect(created.livemode).toEqual(false);

        const live1 = yield* waitForTaxBehavior(target);
        expect(live1.defaults.tax_behavior).toEqual(target);

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.TaxSettings("AccountTax", {
              defaults: { taxBehavior: target2 },
            });
          }),
        );

        expect(updated.object).toEqual("tax.settings");
        expect(updated.taxBehavior).toEqual(target2);
        expect(updated.initialSettings.taxBehavior).toEqual(baselineBehavior);

        const live2 = yield* waitForTaxBehavior(target2);
        expect(live2.defaults.tax_behavior).toEqual(target2);

        yield* stack.destroy();

        // Stripe will not unset a field that was originally null. Restore
        // only applies when the captured baseline already had a value.
        if (baselineBehavior !== undefined) {
          const restored = yield* waitForTaxBehavior(baselineBehavior);
          expect(restored.defaults.tax_behavior).toEqual(baselineBehavior);
        } else {
          const after = yield* getLive;
          expect(after.defaults.tax_behavior).toEqual(target2);
        }
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "no-op deploy when desired settings already match the live account",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const baseline = yield* getLive;
        const taxBehavior =
          (baseline.defaults.tax_behavior as
            | Stripe.TaxSettingsTaxBehavior
            | null
            | undefined) ?? undefined;

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stripe.TaxSettings("NoopTax", {
              ...(taxBehavior !== undefined
                ? { defaults: { taxBehavior } }
                : {}),
            });
          }),
        );

        expect(setting.taxBehavior).toEqual(taxBehavior);
        expect(setting.initialSettings.taxBehavior).toEqual(taxBehavior);
        expect(setting.taxCode).toEqual(
          baseline.defaults.tax_code ?? undefined,
        );

        yield* stack.destroy();

        const after = yield* getLive;
        expect(after.defaults.tax_behavior).toEqual(
          baseline.defaults.tax_behavior,
        );
        expect(after.defaults.tax_code).toEqual(baseline.defaults.tax_code);
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "list returns the account tax settings singleton",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const provider = yield* Provider.findProvider(Stripe.TaxSettings);
        const all = yield* provider.list();

        expect(all.length).toEqual(1);
        expect(all[0]?.object).toEqual("tax.settings");
        expect(all[0]?.initialSettings.taxBehavior).toEqual(
          all[0]?.taxBehavior,
        );
        expect(all[0]?.initialSettings.taxCode).toEqual(all[0]?.taxCode);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
