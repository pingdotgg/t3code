import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetBillingCreditGrant } from "@distilled.cloud/stripe/stripe";
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

const EXPIRES_AT = 4_102_444_800;

const waitUntilVoided = (id: string) =>
  GetBillingCreditGrant({ id }).pipe(
    Effect.map((grant) =>
      grant.voided_at != null ? ("voided" as const) : ("active" as const),
    ),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "voided" || status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and void a credit grant",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("GrantCustomer", {
            email: "alchemy.credit.grant@example.com",
            name: "Alchemy Credit Grant Customer",
          });
          return yield* Stripe.CreditGrant("WelcomeCredits", {
            customer: customer.id,
            amount: {
              type: "monetary",
              monetary: { currency: "usd", value: 1000 },
            },
            applicabilityConfig: { scope: { priceType: "metered" } },
            category: "promotional",
            name: "Alchemy Welcome Credits",
            metadata: { campaign: "welcome" },
          });
        }),
      );

      expect(created.id).toMatch(/^credgr_/);
      expect(created.customer).toMatch(/^cus_/);
      expect(created.amount).toEqual({
        type: "monetary",
        monetary: { currency: "usd", value: 1000 },
      });
      expect(created.applicabilityConfig).toEqual({
        scope: { priceType: "metered" },
      });
      expect(created.category).toEqual("promotional");
      expect(created.name).toEqual("Alchemy Welcome Credits");
      expect(created.voidedAt).toBeUndefined();
      expect(created.livemode).toEqual(false);
      expect(created.metadata).toMatchObject({ campaign: "welcome" });
      expect(created.created).toEqual(expect.any(Number));

      const fetched = yield* GetBillingCreditGrant({ id: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.amount.monetary?.currency).toEqual("usd");
      expect(fetched.amount.monetary?.value).toEqual(1000);
      expect(fetched.applicability_config.scope.price_type).toEqual("metered");
      expect(fetched.category).toEqual("promotional");
      expect(fetched.name).toEqual("Alchemy Welcome Credits");
      expect(fetched.voided_at).toBeNull();
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
          const customer = yield* Stripe.Customer("GrantCustomer", {
            email: "alchemy.credit.grant@example.com",
            name: "Alchemy Credit Grant Customer",
          });
          return yield* Stripe.CreditGrant("WelcomeCredits", {
            customer: customer.id,
            amount: {
              type: "monetary",
              monetary: { currency: "usd", value: 1000 },
            },
            applicabilityConfig: { scope: { priceType: "metered" } },
            category: "promotional",
            name: "Alchemy Welcome Credits",
            expiresAt: EXPIRES_AT,
            metadata: { campaign: "spring", sku: "credits-2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.expiresAt).toEqual(EXPIRES_AT);
      expect(updated.metadata).toEqual({
        campaign: "spring",
        sku: "credits-2",
      });
      expect(updated.amount.monetary?.value).toEqual(1000);

      const refetched = yield* GetBillingCreditGrant({ id: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.expires_at).toEqual(EXPIRES_AT);
      expect(refetched.metadata?.campaign).toEqual("spring");
      expect(refetched.metadata?.sku).toEqual("credits-2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();
      expect(refetched.voided_at).toBeNull();

      yield* stack.destroy();

      const voided = yield* waitUntilVoided(created.id);
      expect(voided === "voided" || voided === "gone").toEqual(true);
      if (voided === "voided") {
        const deactivated = yield* GetBillingCreditGrant({
          id: created.id,
        });
        expect(deactivated.voided_at).toEqual(expect.any(Number));
      }
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed credit grant",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("ListGrantCustomer", {
            email: "alchemy.credit.grant.list@example.com",
            name: "Alchemy Credit Grant List Customer",
          });
          return yield* Stripe.CreditGrant("ListCredits", {
            customer: customer.id,
            amount: {
              type: "monetary",
              monetary: { currency: "usd", value: 2500 },
            },
            applicabilityConfig: { scope: { priceType: "metered" } },
            category: "paid",
            name: "Alchemy List Credits",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.CreditGrant);
      const all = yield* provider.list();
      const found = all.find((grant) => grant.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.amount.monetary?.value).toEqual(2500);
      expect(found?.metadata).toMatchObject({ kind: "list" });
      expect(found?.voidedAt).toBeUndefined();

      yield* stack.destroy();

      const voided = yield* waitUntilVoided(deployed.id);
      expect(voided === "voided" || voided === "gone").toEqual(true);

      const after = yield* provider.list();
      expect(after.find((grant) => grant.id === deployed.id)).toBeUndefined();
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
          const customer = yield* Stripe.Customer("ReplaceGrantCustomer", {
            email: "alchemy.credit.grant.replace@example.com",
            name: "Alchemy Credit Grant Replace Customer",
          });
          return yield* Stripe.CreditGrant("ReplaceCredits", {
            customer: customer.id,
            amount: {
              type: "monetary",
              monetary: { currency: "usd", value: 1000 },
            },
            applicabilityConfig: { scope: { priceType: "metered" } },
            category: "promotional",
            name: "Alchemy Replace Credits",
          });
        }),
      );

      expect(created.amount.monetary?.value).toEqual(1000);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const customer = yield* Stripe.Customer("ReplaceGrantCustomer", {
            email: "alchemy.credit.grant.replace@example.com",
            name: "Alchemy Credit Grant Replace Customer",
          });
          return yield* Stripe.CreditGrant("ReplaceCredits", {
            customer: customer.id,
            amount: {
              type: "monetary",
              monetary: { currency: "usd", value: 2000 },
            },
            applicabilityConfig: { scope: { priceType: "metered" } },
            category: "promotional",
            name: "Alchemy Replace Credits",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.amount.monetary?.value).toEqual(2000);

      const fetched = yield* GetBillingCreditGrant({ id: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.amount.monetary?.value).toEqual(2000);

      const oldVoided = yield* waitUntilVoided(created.id);
      expect(oldVoided === "voided" || oldVoided === "gone").toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilVoided(replaced.id);
      expect(gone === "voided" || gone === "gone").toEqual(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
