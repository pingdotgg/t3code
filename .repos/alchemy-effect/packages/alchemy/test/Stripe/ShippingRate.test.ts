import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetShippingRate } from "@distilled.cloud/stripe/stripe";
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

const waitUntilDeactivated = (id: string) =>
  GetShippingRate({ shipping_rate_token: id }).pipe(
    Effect.map((rate) =>
      rate.active ? ("active" as const) : ("inactive" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

test.provider(
  "create, update, and deactivate a shipping rate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ShippingRate("GroundRate", {
            displayName: "Alchemy Ground",
            amount: 500,
            currency: "usd",
            deliveryEstimate: {
              minimum: { unit: "business_day", value: 5 },
              maximum: { unit: "business_day", value: 7 },
            },
            metadata: { region: "us" },
          });
        }),
      );

      expect(created.id).toMatch(/^shr_/);
      expect(created.displayName).toEqual("Alchemy Ground");
      expect(created.type).toEqual("fixed_amount");
      expect(created.amount).toEqual(500);
      expect(created.currency).toEqual("usd");
      expect(created.active).toEqual(true);
      expect(created.deliveryEstimate).toEqual({
        minimum: { unit: "business_day", value: 5 },
        maximum: { unit: "business_day", value: 7 },
      });
      expect(created.metadata).toMatchObject({ region: "us" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetShippingRate({
        shipping_rate_token: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.display_name).toEqual("Alchemy Ground");
      expect(fetched.fixed_amount?.amount).toEqual(500);
      expect(fetched.fixed_amount?.currency).toEqual("usd");
      expect(fetched.active).toEqual(true);
      expect(fetched.metadata?.region).toEqual("us");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ShippingRate("GroundRate", {
            displayName: "Alchemy Ground",
            amount: 500,
            currency: "usd",
            deliveryEstimate: {
              minimum: { unit: "business_day", value: 5 },
              maximum: { unit: "business_day", value: 7 },
            },
            taxBehavior: "exclusive",
            metadata: { region: "us", channel: "web" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.active).toEqual(true);
      expect(updated.taxBehavior).toEqual("exclusive");
      expect(updated.metadata).toEqual({ region: "us", channel: "web" });

      const refetched = yield* GetShippingRate({
        shipping_rate_token: updated.id,
      });
      expect(refetched.active).toEqual(true);
      expect(refetched.tax_behavior).toEqual("exclusive");
      expect(refetched.metadata?.region).toEqual("us");
      expect(refetched.metadata?.channel).toEqual("web");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(created.id);
      expect(deactivated).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed shipping rate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ShippingRate("ListRate", {
            displayName: "Alchemy List Rate",
            amount: 799,
            currency: "usd",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.ShippingRate);
      const all = yield* provider.list();
      const found = all.find((rate) => rate.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.displayName).toEqual(deployed.displayName);
      expect(found?.metadata).toMatchObject({ kind: "list" });
      expect(found?.amount).toEqual(799);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(deployed.id);
      expect(deactivated).toEqual("inactive");

      const after = yield* provider.list();
      expect(after.find((rate) => rate.id === deployed.id)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when amount changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ShippingRate("ReplaceRate", {
            displayName: "Alchemy Replace Rate",
            amount: 1000,
            currency: "usd",
            metadata: { version: "v1" },
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ShippingRate("ReplaceRate", {
            displayName: "Alchemy Replace Rate",
            amount: 2500,
            currency: "usd",
            metadata: { version: "v2" },
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.amount).toEqual(2500);
      expect(replaced.metadata).toMatchObject({ version: "v2" });

      const newFetched = yield* GetShippingRate({
        shipping_rate_token: replaced.id,
      });
      expect(newFetched.fixed_amount?.amount).toEqual(2500);

      const oldFetched = yield* GetShippingRate({
        shipping_rate_token: created.id,
      });
      expect(oldFetched.active).toEqual(false);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(replaced.id);
      expect(deactivated).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
