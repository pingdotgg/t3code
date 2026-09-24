import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPromotionCode } from "@distilled.cloud/stripe/stripe";
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

const waitUntilInactive = (id: string) =>
  GetPromotionCode({ promotion_code: id }).pipe(
    Effect.map((promo) =>
      promo.active ? ("active" as const) : ("inactive" as const),
    ),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive" || status === "gone",
      times: 8,
    }),
  );

test.provider(
  "create, update, and deactivate a promotion code",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const coupon = yield* Stripe.Coupon("WelcomeCoupon", {
            percentOff: 15,
            duration: "once",
            name: "Alchemy Promo CRUD",
          });
          return yield* Stripe.PromotionCode("WelcomeCode", {
            coupon: coupon.id,
            metadata: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.code).toEqual(expect.any(String));
      expect(created.active).toEqual(true);
      expect(created.couponId).toEqual(expect.any(String));
      expect(created.metadata).toMatchObject({ env: "test" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetPromotionCode({
        promotion_code: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.code).toEqual(created.code);
      expect(fetched.active).toEqual(true);
      expect(fetched.metadata?.env).toEqual("test");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const coupon = yield* Stripe.Coupon("WelcomeCoupon", {
            percentOff: 15,
            duration: "once",
            name: "Alchemy Promo CRUD",
          });
          return yield* Stripe.PromotionCode("WelcomeCode", {
            coupon: coupon.id,
            metadata: { env: "prod", campaign: "spring" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.metadata).toMatchObject({
        env: "prod",
        campaign: "spring",
      });

      const refetched = yield* GetPromotionCode({
        promotion_code: updated.id,
      });
      expect(refetched.metadata?.env).toEqual("prod");
      expect(refetched.metadata?.campaign).toEqual("spring");
      expect(refetched.active).toEqual(true);

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(created.id);
      expect(inactive === "inactive" || inactive === "gone").toEqual(true);
      if (inactive === "inactive") {
        const deactivated = yield* GetPromotionCode({
          promotion_code: created.id,
        });
        expect(deactivated.active).toEqual(false);
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed promotion code",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const coupon = yield* Stripe.Coupon("ListCoupon", {
            percentOff: 10,
            duration: "once",
            name: "Alchemy Promo List",
          });
          return yield* Stripe.PromotionCode("ListCode", {
            coupon: coupon.id,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.PromotionCode);
      const all = yield* provider.list();
      const found = all.find((item) => item.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.code).toEqual(deployed.code);
      expect(found?.active).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
