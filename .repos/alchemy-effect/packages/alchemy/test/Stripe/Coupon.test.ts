import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetCoupon } from "@distilled.cloud/stripe/stripe";
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
  GetCoupon({ coupon: id }).pipe(
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
  "create, update, and delete a coupon",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Coupon("WelcomeCoupon", {
            percentOff: 20,
            duration: "forever",
            name: "Alchemy Welcome 20%",
            metadata: { campaign: "welcome" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.percentOff).toEqual(20);
      expect(created.amountOff).toBeUndefined();
      expect(created.duration).toEqual("forever");
      expect(created.name).toEqual("Alchemy Welcome 20%");
      expect(created.valid).toEqual(true);
      expect(created.livemode).toEqual(false);
      expect(created.metadata).toMatchObject({ campaign: "welcome" });
      expect(created.created).toEqual(expect.any(Number));

      const fetched = yield* GetCoupon({ coupon: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.percent_off).toEqual(20);
      expect(fetched.duration).toEqual("forever");
      expect(fetched.name).toEqual("Alchemy Welcome 20%");
      expect(fetched.metadata?.campaign).toEqual("welcome");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Coupon("WelcomeCoupon", {
            percentOff: 20,
            duration: "forever",
            name: "Alchemy Welcome 20% Updated",
            metadata: { campaign: "spring", sku: "welcome-2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.percentOff).toEqual(20);
      expect(updated.duration).toEqual("forever");
      expect(updated.name).toEqual("Alchemy Welcome 20% Updated");
      expect(updated.metadata).toEqual({
        campaign: "spring",
        sku: "welcome-2",
      });

      const refetched = yield* GetCoupon({ coupon: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.name).toEqual("Alchemy Welcome 20% Updated");
      expect(refetched.percent_off).toEqual(20);
      expect(refetched.metadata?.campaign).toEqual("spring");
      expect(refetched.metadata?.sku).toEqual("welcome-2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the discount changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Coupon("ReplaceCoupon", {
            percentOff: 10,
            duration: "once",
            name: "Alchemy Replace Coupon",
          });
        }),
      );

      expect(created.percentOff).toEqual(10);
      expect(created.duration).toEqual("once");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Coupon("ReplaceCoupon", {
            amountOff: 500,
            currency: "usd",
            duration: "once",
            name: "Alchemy Replace Coupon",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.amountOff).toEqual(500);
      expect(replaced.currency).toEqual("usd");
      expect(replaced.percentOff).toBeUndefined();
      expect(replaced.duration).toEqual("once");

      const fetched = yield* GetCoupon({ coupon: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.amount_off).toEqual(500);
      expect(fetched.currency).toEqual("usd");
      expect(fetched.percent_off).toBeNull();

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed coupon",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Coupon("ListCoupon", {
            percentOff: 15,
            duration: "forever",
            name: "Alchemy List Coupon",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.Coupon);
      const all = yield* provider.list();
      const found = all.find((coupon) => coupon.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.percentOff).toEqual(15);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
