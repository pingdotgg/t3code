import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  DeleteAccount,
  GetAccountByAccount,
  CreateAccount,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** Opt-in: the testing Stripe account must be a Connect platform. */
const CONNECT_ENABLED = process.env.STRIPE_TEST_CONNECT === "1";

const isMissing = isMissingStripeResource;

const waitUntilGone = (id: string) =>
  GetAccountByAccount({ account: id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const deleteAccount = (account: string) =>
  DeleteAccount({ account }).pipe(Effect.catchIf(isMissing, () => Effect.void));

const probeCreate = () =>
  CreateAccount({
    type: "express",
    country: "US",
    email: "alchemy.account.probe@example.com",
  });

test.provider(
  "connect accounts entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeCreate().pipe(Effect.result);
      if (Result.isFailure(probe)) {
        expect(probe.failure._tag).not.toEqual("UnknownStripeError");
        expect(probe.failure._tag).toEqual("InvalidRequestError");
        expect(probe.failure.message ?? "").toContain("signed up for Connect");
        yield* stack.destroy();
        return;
      }

      yield* deleteAccount(probe.success.id);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!CONNECT_ENABLED)(
  "create, update, and delete a connected account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Account("CatalogAccount", {
            type: "express",
            country: "US",
            email: "alchemy.catalog.account@example.com",
            businessType: "company",
            defaultCurrency: "usd",
            businessProfile: {
              name: "Alchemy Catalog Merchant",
              url: "https://alchemy.run",
              mcc: "5734",
              supportEmail: "support@alchemy.run",
            },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            settings: {
              payouts: { schedule: { interval: "manual" } },
            },
            metadata: { tier: "gold" },
          });
        }),
      );

      expect(created.id).toMatch(/^acct_/);
      expect(created.type).toEqual("express");
      expect(created.country).toEqual("US");
      expect(created.email).toEqual("alchemy.catalog.account@example.com");
      expect(created.businessType).toEqual("company");
      expect(created.defaultCurrency).toEqual("usd");
      expect(created.businessProfileName).toEqual("Alchemy Catalog Merchant");
      expect(created.businessProfileUrl).toEqual("https://alchemy.run");
      expect(created.metadata).toMatchObject({ tier: "gold" });
      expect(Object.keys(created.capabilities)).toEqual(
        expect.arrayContaining(["card_payments", "transfers"]),
      );

      const fetched = yield* GetAccountByAccount({ account: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.email).toEqual(created.email);
      expect(fetched.business_profile?.name).toEqual(
        "Alchemy Catalog Merchant",
      );
      expect(fetched.business_profile?.url).toEqual("https://alchemy.run");
      expect(fetched.settings?.payouts?.schedule?.interval).toEqual("manual");
      expect(fetched.metadata?.tier).toEqual("gold");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Account("CatalogAccount", {
            type: "express",
            country: "US",
            email: "alchemy.catalog.account.updated@example.com",
            businessType: "company",
            defaultCurrency: "usd",
            businessProfile: {
              name: "Alchemy Catalog Merchant Updated",
              url: "https://www.alchemy.run",
              mcc: "5734",
              supportEmail: "support@alchemy.run",
            },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            settings: {
              payouts: { schedule: { interval: "manual" } },
            },
            metadata: { tier: "platinum", sku: "acct-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.email).toEqual(
        "alchemy.catalog.account.updated@example.com",
      );
      expect(updated.businessProfileName).toEqual(
        "Alchemy Catalog Merchant Updated",
      );
      expect(updated.metadata).toEqual({ tier: "platinum", sku: "acct-1" });

      const refetched = yield* GetAccountByAccount({ account: updated.id });
      expect(refetched.email).toEqual(updated.email);
      expect(refetched.business_profile?.name).toEqual(
        "Alchemy Catalog Merchant Updated",
      );
      expect(refetched.business_profile?.url).toEqual(
        "https://www.alchemy.run",
      );
      expect(refetched.metadata?.tier).toEqual("platinum");
      expect(refetched.metadata?.sku).toEqual("acct-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!CONNECT_ENABLED)(
  "list enumerates the deployed connected account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.Account("ListAccount", {
            type: "express",
            country: "US",
            email: "alchemy.list.account@example.com",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.Account);
      const all = yield* provider.list();
      const found = all.find((account) => account.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.email).toEqual(deployed.email);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
