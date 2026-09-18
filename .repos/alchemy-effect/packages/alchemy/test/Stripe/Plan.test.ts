import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPlan } from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (id: string) =>
  GetPlan({ plan: id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("MonthlyPlanProduct", {
            name: "Alchemy Monthly Plan Product",
          });
          return yield* Stripe.Plan("MonthlyPlan", {
            product: product.id,
            currency: "usd",
            interval: "month",
            amount: 1500,
            nickname: "Alchemy monthly",
            metadata: { tier: "pro" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.product).toEqual(expect.any(String));
      expect(created.currency).toEqual("usd");
      expect(created.interval).toEqual("month");
      expect(created.intervalCount).toEqual(1);
      expect(created.amount).toEqual(1500);
      expect(created.active).toEqual(true);
      expect(created.nickname).toEqual("Alchemy monthly");
      expect(created.usageType).toEqual("licensed");
      expect(created.billingScheme).toEqual("per_unit");
      expect(created.livemode).toEqual(false);
      expect(created.metadata).toMatchObject({ tier: "pro" });
      expect(created.created).toEqual(expect.any(Number));

      const fetched = yield* GetPlan({ plan: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.amount).toEqual(1500);
      expect(fetched.interval).toEqual("month");
      expect(fetched.nickname).toEqual("Alchemy monthly");
      expect(fetched.active).toEqual(true);
      expect(fetched.metadata?.tier).toEqual("pro");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("MonthlyPlanProduct", {
            name: "Alchemy Monthly Plan Product",
          });
          return yield* Stripe.Plan("MonthlyPlan", {
            product: product.id,
            currency: "usd",
            interval: "month",
            amount: 1500,
            nickname: "Alchemy monthly (trial)",
            trialPeriodDays: 14,
            metadata: { tier: "enterprise", sku: "ent-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.nickname).toEqual("Alchemy monthly (trial)");
      expect(updated.trialPeriodDays).toEqual(14);
      expect(updated.amount).toEqual(1500);
      expect(updated.metadata).toEqual({
        tier: "enterprise",
        sku: "ent-1",
      });

      const refetched = yield* GetPlan({ plan: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.nickname).toEqual("Alchemy monthly (trial)");
      expect(refetched.trial_period_days).toEqual(14);
      expect(refetched.amount).toEqual(1500);
      expect(refetched.metadata?.tier).toEqual("enterprise");
      expect(refetched.metadata?.sku).toEqual("ent-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the amount changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("ReplacePlanProduct", {
            name: "Alchemy Replace Plan Product",
          });
          return yield* Stripe.Plan("ReplacePlan", {
            product: product.id,
            currency: "usd",
            interval: "month",
            amount: 1000,
            nickname: "v1",
          });
        }),
      );

      expect(created.amount).toEqual(1000);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("ReplacePlanProduct", {
            name: "Alchemy Replace Plan Product",
          });
          return yield* Stripe.Plan("ReplacePlan", {
            product: product.id,
            currency: "usd",
            interval: "month",
            amount: 2500,
            nickname: "v2",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.amount).toEqual(2500);
      expect(replaced.nickname).toEqual("v2");
      expect(replaced.interval).toEqual("month");

      const fetched = yield* GetPlan({ plan: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.amount).toEqual(2500);
      expect(fetched.nickname).toEqual("v2");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const product = yield* Stripe.Product("ListPlanProduct", {
            name: "Alchemy List Plan Product",
          });
          return yield* Stripe.Plan("ListPlan", {
            product: product.id,
            currency: "usd",
            interval: "year",
            amount: 12000,
            nickname: "Alchemy yearly",
            metadata: { kind: "list" },
          });
        }),
      );

      expect(deployed.interval).toEqual("year");
      expect(deployed.amount).toEqual(12000);

      const provider = yield* Provider.findProvider(Stripe.Plan);
      const all = yield* provider.list();
      const found = all.find((plan) => plan.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.nickname).toEqual("Alchemy yearly");
      expect(found?.interval).toEqual("year");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
