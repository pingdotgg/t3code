import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetPrice,
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
  GetPrice({ price: id }).pipe(
    Effect.map((price) =>
      price.active ? ("active" as const) : ("inactive" as const),
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
  "create, update, and deactivate a one-time price",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy One-Time Price Product",
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Price("OneTimePrice", {
            product: product.id,
            currency: "usd",
            unitAmount: 2000,
            nickname: "Launch price",
            metadata: { tier: "pro" },
          });
        }),
      );

      expect(created.id).toMatch(/^price_/);
      expect(created.product).toEqual(product.id);
      expect(created.currency).toEqual("usd");
      expect(created.unitAmount).toEqual(2000);
      expect(created.active).toEqual(true);
      expect(created.nickname).toEqual("Launch price");
      expect(created.type).toEqual("one_time");
      expect(created.recurring).toBeUndefined();
      expect(created.metadata).toMatchObject({ tier: "pro" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetPrice({ price: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.unit_amount).toEqual(2000);
      expect(fetched.nickname).toEqual("Launch price");
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
          return yield* Stripe.Price("OneTimePrice", {
            product: product.id,
            currency: "usd",
            unitAmount: 2000,
            nickname: "Launch price (paused)",
            active: false,
            metadata: { tier: "enterprise", sku: "ent-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.nickname).toEqual("Launch price (paused)");
      expect(updated.active).toEqual(false);
      expect(updated.metadata).toEqual({ tier: "enterprise", sku: "ent-1" });

      const refetched = yield* GetPrice({ price: updated.id });
      expect(refetched.nickname).toEqual(updated.nickname);
      expect(refetched.active).toEqual(false);
      expect(refetched.metadata?.tier).toEqual("enterprise");
      expect(refetched.metadata?.sku).toEqual("ent-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(created.id);
      expect(deactivated).toEqual("inactive");

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "create a recurring price and list it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Recurring Price Product",
      });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Price("MonthlyPrice", {
            product: product.id,
            currency: "usd",
            unitAmount: 1500,
            recurring: { interval: "month" },
            nickname: "Pro monthly",
            metadata: { kind: "list" },
          });
        }),
      );

      expect(deployed.type).toEqual("recurring");
      expect(deployed.recurring?.interval).toEqual("month");
      expect(deployed.unitAmount).toEqual(1500);

      const fetched = yield* GetPrice({ price: deployed.id });
      expect(fetched.recurring?.interval).toEqual("month");
      expect(fetched.unit_amount).toEqual(1500);

      const provider = yield* Provider.findProvider(Stripe.Price);
      const all = yield* provider.list();
      const found = all.find((price) => price.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.nickname).toEqual("Pro monthly");
      expect(found?.metadata).toMatchObject({ kind: "list" });
      expect(found?.recurring?.interval).toEqual("month");

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(deployed.id);
      expect(deactivated).toEqual("inactive");

      const after = yield* provider.list();
      expect(after.find((price) => price.id === deployed.id)).toBeUndefined();

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when unit amount changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const product = yield* CreateProduct({
        name: "Alchemy Replace Price Product",
      });

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Price("ReplacePrice", {
            product: product.id,
            currency: "usd",
            unitAmount: 1000,
            nickname: "v1",
          });
        }),
      );

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Price("ReplacePrice", {
            product: product.id,
            currency: "usd",
            unitAmount: 2500,
            nickname: "v2",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.unitAmount).toEqual(2500);
      expect(replaced.nickname).toEqual("v2");
      expect(replaced.product).toEqual(product.id);

      const newFetched = yield* GetPrice({ price: replaced.id });
      expect(newFetched.unit_amount).toEqual(2500);

      const oldFetched = yield* GetPrice({ price: created.id });
      expect(oldFetched.active).toEqual(false);

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(replaced.id);
      expect(deactivated).toEqual("inactive");

      yield* archiveProduct(product.id);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
