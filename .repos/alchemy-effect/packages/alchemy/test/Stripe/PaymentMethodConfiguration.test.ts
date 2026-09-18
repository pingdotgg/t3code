import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPaymentMethodConfiguration } from "@distilled.cloud/stripe/stripe";
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

const isMissing = isMissingStripeResource;

const waitUntilInactive = (id: string) =>
  GetPaymentMethodConfiguration({ configuration: id }).pipe(
    Effect.map((configuration) =>
      configuration.active ? ("active" as const) : ("inactive" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

test.provider(
  "create, update, and deactivate a payment method configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentMethodConfiguration("Checkout", {
            name: "Alchemy Checkout PMC",
            card: { displayPreference: { preference: "on" } },
            link: { displayPreference: { preference: "off" } },
          });
        }),
      );

      expect(created.id).toMatch(/^pmc_/);
      expect(created.name).toEqual("Alchemy Checkout PMC");
      expect(created.active).toEqual(true);
      expect(created.isDefault).toEqual(false);
      expect(created.card?.displayPreference.preference).toEqual("on");
      expect(created.link?.displayPreference.preference).toEqual("off");
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetPaymentMethodConfiguration({
        configuration: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual("Alchemy Checkout PMC");
      expect(fetched.active).toEqual(true);
      expect(fetched.is_default).toEqual(false);
      expect(fetched.card?.display_preference.preference).toEqual("on");
      expect(fetched.link?.display_preference.preference).toEqual("off");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentMethodConfiguration("Checkout", {
            name: "Alchemy Checkout PMC Updated",
            card: { displayPreference: { preference: "on" } },
            link: { displayPreference: { preference: "on" } },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("Alchemy Checkout PMC Updated");
      expect(updated.active).toEqual(true);
      expect(updated.isDefault).toEqual(false);
      expect(updated.card?.displayPreference.preference).toEqual("on");
      expect(updated.link?.displayPreference.preference).toEqual("on");

      const refetched = yield* GetPaymentMethodConfiguration({
        configuration: updated.id,
      });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.name).toEqual("Alchemy Checkout PMC Updated");
      expect(refetched.card?.display_preference.preference).toEqual("on");
      expect(refetched.link?.display_preference.preference).toEqual("on");
      expect(refetched.active).toEqual(true);

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(created.id);
      expect(inactive).toEqual("inactive");
      const deactivated = yield* GetPaymentMethodConfiguration({
        configuration: created.id,
      });
      expect(deactivated.active).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed payment method configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentMethodConfiguration("ListCheckout", {
            name: "Alchemy List PMC",
            card: { displayPreference: { preference: "on" } },
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Stripe.PaymentMethodConfiguration,
      );
      const all = yield* provider.list();
      const found = all.find(
        (configuration) => configuration.id === deployed.id,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.isDefault).toEqual(false);
      expect(found?.card?.displayPreference.preference).toEqual("on");

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(deployed.id);
      expect(inactive).toEqual("inactive");

      const after = yield* provider.list();
      expect(
        after.find((configuration) => configuration.id === deployed.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
