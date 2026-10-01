import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetCustomer } from "@distilled.cloud/stripe/stripe";
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
  GetCustomer({ customer: id }).pipe(
    Effect.map((customer) =>
      "deleted" in customer && customer.deleted
        ? ("gone" as const)
        : ("found" as const),
    ),
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
  "create, update, and delete a customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Customer("CatalogCustomer", {
            email: "alchemy.catalog.customer@example.com",
            name: "Alchemy Catalog Customer",
            description: "Initial description",
            phone: "+15555550100",
            metadata: { plan: "pro" },
          });
        }),
      );

      expect(created.id).toMatch(/^cus_/);
      expect(created.email).toEqual("alchemy.catalog.customer@example.com");
      expect(created.name).toEqual("Alchemy Catalog Customer");
      expect(created.description).toEqual("Initial description");
      expect(created.phone).toEqual("+15555550100");
      expect(created.metadata).toMatchObject({ plan: "pro" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetCustomer({ customer: created.id });
      if (!("email" in fetched)) {
        return;
      }
      expect(fetched.id).toEqual(created.id);
      expect(fetched.email).toEqual(created.email);
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("Initial description");
      expect(fetched.phone).toEqual("+15555550100");
      expect(fetched.metadata?.plan).toEqual("pro");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Customer("CatalogCustomer", {
            email: "alchemy.catalog.customer.updated@example.com",
            name: "Alchemy Catalog Customer Updated",
            description: "Updated description",
            phone: "+15555550199",
            metadata: { plan: "enterprise", sku: "ent-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.email).toEqual(
        "alchemy.catalog.customer.updated@example.com",
      );
      expect(updated.name).toEqual("Alchemy Catalog Customer Updated");
      expect(updated.description).toEqual("Updated description");
      expect(updated.phone).toEqual("+15555550199");
      expect(updated.metadata).toEqual({ plan: "enterprise", sku: "ent-1" });

      const refetched = yield* GetCustomer({ customer: updated.id });
      if (!("email" in refetched)) {
        return;
      }
      expect(refetched.email).toEqual(updated.email);
      expect(refetched.name).toEqual(updated.name);
      expect(refetched.description).toEqual("Updated description");
      expect(refetched.phone).toEqual("+15555550199");
      expect(refetched.metadata?.plan).toEqual("enterprise");
      expect(refetched.metadata?.sku).toEqual("ent-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Customer("ListCustomer", {
            email: "alchemy.list.customer@example.com",
            name: "Alchemy List Customer",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.Customer);
      const all = yield* provider.list();
      const found = all.find((customer) => customer.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.email).toEqual(deployed.email);
      expect(found?.name).toEqual(deployed.name);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
