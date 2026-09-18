import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTaxRate } from "@distilled.cloud/stripe/stripe";
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
  GetTaxRate({ tax_rate: id }).pipe(
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
  "create, update, and deactivate a tax rate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRate("SalesTax", {
            displayName: "Alchemy Sales Tax",
            percentage: 8.25,
            inclusive: false,
            description: "Initial sales tax",
            taxType: "sales_tax",
            metadata: { region: "us" },
          });
        }),
      );

      expect(created.id).toMatch(/^txr_/);
      expect(created.displayName).toEqual("Alchemy Sales Tax");
      expect(created.percentage).toEqual(8.25);
      expect(created.inclusive).toEqual(false);
      expect(created.active).toEqual(true);
      expect(created.description).toEqual("Initial sales tax");
      expect(created.taxType).toEqual("sales_tax");
      expect(created.metadata).toMatchObject({ region: "us" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetTaxRate({ tax_rate: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.display_name).toEqual("Alchemy Sales Tax");
      expect(fetched.percentage).toEqual(8.25);
      expect(fetched.inclusive).toEqual(false);
      expect(fetched.active).toEqual(true);
      expect(fetched.description).toEqual("Initial sales tax");
      expect(fetched.tax_type).toEqual("sales_tax");
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
          return yield* Stripe.TaxRate("SalesTax", {
            displayName: "Alchemy Sales Tax Updated",
            percentage: 8.25,
            inclusive: false,
            description: "Updated sales tax",
            taxType: "sales_tax",
            metadata: { region: "ca", sku: "tax-2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.displayName).toEqual("Alchemy Sales Tax Updated");
      expect(updated.percentage).toEqual(8.25);
      expect(updated.inclusive).toEqual(false);
      expect(updated.active).toEqual(true);
      expect(updated.description).toEqual("Updated sales tax");
      expect(updated.metadata).toEqual({ region: "ca", sku: "tax-2" });

      const refetched = yield* GetTaxRate({ tax_rate: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.display_name).toEqual("Alchemy Sales Tax Updated");
      expect(refetched.percentage).toEqual(8.25);
      expect(refetched.description).toEqual("Updated sales tax");
      expect(refetched.metadata?.region).toEqual("ca");
      expect(refetched.metadata?.sku).toEqual("tax-2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(created.id);
      expect(inactive).toEqual("inactive");
      const deactivated = yield* GetTaxRate({ tax_rate: created.id });
      expect(deactivated.active).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when percentage or inclusive changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRate("ReplaceTax", {
            displayName: "Alchemy Replace Tax",
            percentage: 5,
            inclusive: false,
          });
        }),
      );

      expect(created.percentage).toEqual(5);
      expect(created.inclusive).toEqual(false);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRate("ReplaceTax", {
            displayName: "Alchemy Replace Tax",
            percentage: 10,
            inclusive: true,
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.percentage).toEqual(10);
      expect(replaced.inclusive).toEqual(true);

      const fetched = yield* GetTaxRate({ tax_rate: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.percentage).toEqual(10);
      expect(fetched.inclusive).toEqual(true);

      const oldInactive = yield* waitUntilInactive(created.id);
      expect(oldInactive).toEqual("inactive");

      yield* stack.destroy();

      const gone = yield* waitUntilInactive(replaced.id);
      expect(gone).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed tax rate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRate("ListTax", {
            displayName: "Alchemy List Tax",
            percentage: 7,
            inclusive: false,
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.TaxRate);
      const all = yield* provider.list();
      const found = all.find((rate) => rate.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.displayName).toEqual(deployed.displayName);
      expect(found?.percentage).toEqual(7);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(deployed.id);
      expect(inactive).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
