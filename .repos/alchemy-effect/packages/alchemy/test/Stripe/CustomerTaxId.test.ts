import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetCustomerTaxIdsById } from "@distilled.cloud/stripe/stripe";
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

const waitUntilGone = (customer: string, id: string) =>
  GetCustomerTaxIdsById({ customer, id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a customer tax id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("TaxIdLifecycleCustomer", {
            email: "alchemy.taxid.lifecycle@example.com",
            name: "Alchemy Tax ID Lifecycle",
          });
          const taxId = yield* Stripe.CustomerTaxId("LifecycleVat", {
            customer: customer.id,
            type: "eu_vat",
            value: "DE123456789",
          });
          return { customer, taxId };
        }),
      );

      expect(created.taxId.id).toMatch(/^txi_/);
      expect(created.taxId.customer).toEqual(created.customer.id);
      expect(created.taxId.type).toEqual("eu_vat");
      expect(created.taxId.value).toEqual("DE123456789");
      expect(created.taxId.country).toEqual("DE");
      expect(created.taxId.livemode).toEqual(false);
      expect(created.taxId.created).toEqual(expect.any(Number));

      const fetched = yield* GetCustomerTaxIdsById({
        customer: created.taxId.customer,
        id: created.taxId.id,
      });
      expect(fetched.id).toEqual(created.taxId.id);
      expect(fetched.type).toEqual("eu_vat");
      expect(fetched.value).toEqual("DE123456789");
      expect(fetched.livemode).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("TaxIdLifecycleCustomer", {
            email: "alchemy.taxid.lifecycle@example.com",
            name: "Alchemy Tax ID Lifecycle",
          });
          const taxId = yield* Stripe.CustomerTaxId("LifecycleVat", {
            customer: customer.id,
            type: "eu_vat",
            value: "DE123456789",
          });
          return { customer, taxId };
        }),
      );

      expect(updated.taxId.id).toEqual(created.taxId.id);
      expect(updated.taxId.customer).toEqual(created.customer.id);
      expect(updated.taxId.type).toEqual("eu_vat");
      expect(updated.taxId.value).toEqual("DE123456789");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.taxId.customer,
        created.taxId.id,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed customer tax id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("TaxIdListCustomer", {
            email: "alchemy.taxid.list@example.com",
            name: "Alchemy Tax ID List",
          });
          const taxId = yield* Stripe.CustomerTaxId("ListVat", {
            customer: customer.id,
            type: "eu_vat",
            value: "ATU12345678",
          });
          return { customer, taxId };
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.CustomerTaxId);
      const all = yield* provider.list();
      const found = all.find((taxId) => taxId.id === deployed.taxId.id);
      expect(found).toBeDefined();
      expect(found?.customer).toEqual(deployed.customer.id);
      expect(found?.type).toEqual("eu_vat");
      expect(found?.value).toEqual("ATU12345678");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.taxId.customer,
        deployed.taxId.id,
      );
      expect(gone).toEqual("gone");

      const after = yield* provider.list();
      expect(
        after.find((taxId) => taxId.id === deployed.taxId.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the tax id value changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("TaxIdReplaceCustomer", {
            email: "alchemy.taxid.replace@example.com",
            name: "Alchemy Tax ID Replace",
          });
          const taxId = yield* Stripe.CustomerTaxId("ReplaceVat", {
            customer: customer.id,
            type: "eu_vat",
            value: "DE123456789",
          });
          return { customer, taxId };
        }),
      );

      expect(created.taxId.value).toEqual("DE123456789");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("TaxIdReplaceCustomer", {
            email: "alchemy.taxid.replace@example.com",
            name: "Alchemy Tax ID Replace",
          });
          const taxId = yield* Stripe.CustomerTaxId("ReplaceVat", {
            customer: customer.id,
            type: "eu_vat",
            value: "DE000000000",
          });
          return { customer, taxId };
        }),
      );

      expect(replaced.taxId.id).not.toEqual(created.taxId.id);
      expect(replaced.taxId.customer).toEqual(created.customer.id);
      expect(replaced.taxId.value).toEqual("DE000000000");

      const newFetched = yield* GetCustomerTaxIdsById({
        customer: replaced.taxId.customer,
        id: replaced.taxId.id,
      });
      expect(newFetched.value).toEqual("DE000000000");

      const oldGone = yield* waitUntilGone(
        created.taxId.customer,
        created.taxId.id,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.taxId.customer,
        replaced.taxId.id,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
