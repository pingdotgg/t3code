import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetPaymentLink,
  CreatePrice,
  CreateProduct,
  UpdateProduct,
} from "@distilled.cloud/stripe/stripe";
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
  GetPaymentLink({ payment_link: id }).pipe(
    Effect.map((link) =>
      link.active ? ("active" as const) : ("inactive" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

const archiveProduct = (id: string) =>
  UpdateProduct({ id, active: false }).pipe(
    Effect.catchIf(isMissing, () => Effect.void),
  );

test.provider(
  "create, update, and deactivate a payment link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Payment Link Product",
      });
      const price = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 2000,
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("BuyLink", {
            lineItems: [{ price: price.id, quantity: 1 }],
            metadata: { campaign: "launch" },
          });
        }),
      );

      expect(created.id).toMatch(/^plink_/);
      expect(created.url).toEqual(expect.any(String));
      expect(created.active).toEqual(true);
      expect(created.lineItems).toEqual([
        expect.objectContaining({ price: price.id, quantity: 1 }),
      ]);
      expect(created.allowPromotionCodes).toEqual(false);
      expect(created.billingAddressCollection).toEqual("auto");
      expect(created.metadata).toMatchObject({ campaign: "launch" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetPaymentLink({
        payment_link: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.active).toEqual(true);
      expect(fetched.metadata?.campaign).toEqual("launch");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("BuyLink", {
            lineItems: [{ price: price.id, quantity: 2 }],
            allowPromotionCodes: true,
            inactiveMessage: "This link is no longer available.",
            metadata: { campaign: "spring", sku: "pro" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.lineItems).toEqual([
        expect.objectContaining({ price: price.id, quantity: 2 }),
      ]);
      expect(updated.allowPromotionCodes).toEqual(true);
      expect(updated.inactiveMessage).toEqual(
        "This link is no longer available.",
      );
      expect(updated.metadata).toEqual({ campaign: "spring", sku: "pro" });
      expect(updated.active).toEqual(true);

      const refetched = yield* GetPaymentLink({
        payment_link: updated.id,
      });
      expect(refetched.allow_promotion_codes).toEqual(true);
      expect(refetched.inactive_message).toEqual(
        "This link is no longer available.",
      );
      expect(refetched.metadata?.campaign).toEqual("spring");
      expect(refetched.metadata?.sku).toEqual("pro");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(created.id);
      expect(deactivated).toEqual("inactive");

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed payment link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Payment Link List Product",
      });
      const price = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 1500,
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("ListLink", {
            lineItems: [{ price: price.id, quantity: 1 }],
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.PaymentLink);
      const all = yield* provider.list();
      const found = all.find((link) => link.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.url).toEqual(deployed.url);
      expect(found?.metadata).toMatchObject({ kind: "list" });
      expect(found?.active).toEqual(true);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(deployed.id);
      expect(deactivated).toEqual("inactive");

      const after = yield* provider.list();
      expect(after.find((link) => link.id === deployed.id)).toBeUndefined();

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when line item price changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Payment Link Replace Product",
      });
      const priceV1 = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 1000,
      });
      const priceV2 = yield* CreatePrice({
        product: product.id,
        currency: "usd",
        unit_amount: 2500,
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("ReplaceLink", {
            lineItems: [{ price: priceV1.id, quantity: 1 }],
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentLink("ReplaceLink", {
            lineItems: [{ price: priceV2.id, quantity: 1 }],
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.lineItems).toEqual([
        expect.objectContaining({ price: priceV2.id, quantity: 1 }),
      ]);

      const oldFetched = yield* GetPaymentLink({
        payment_link: created.id,
      });
      expect(oldFetched.active).toEqual(false);

      const newFetched = yield* GetPaymentLink({
        payment_link: replaced.id,
      });
      expect(newFetched.active).toEqual(true);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(replaced.id);
      expect(deactivated).toEqual("inactive");

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
