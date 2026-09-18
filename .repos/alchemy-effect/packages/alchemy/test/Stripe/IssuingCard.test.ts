import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { isMissingStripeResource } from "@/Stripe/missing.ts";
import {
  GetIssuingCards,
  GetIssuingCard,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Stripe.providers() });

const ISSUING_ENABLED = process.env.STRIPE_TEST_ISSUING === "1";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const billing = {
  address: {
    line1: "123 Main Street",
    city: "San Francisco",
    state: "CA",
    postalCode: "94111",
    country: "US",
  },
} as const;

const waitUntilCanceled = (id: string) =>
  GetIssuingCard({ card: id }).pipe(
    Effect.map((card) =>
      card.status === "canceled" ? ("canceled" as const) : ("live" as const),
    ),
    Effect.catchIf(isMissingStripeResource, () =>
      Effect.succeed("canceled" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "canceled",
      times: 10,
    }),
  );

test.provider(
  "issuing cards entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* GetIssuingCards({ limit: 1 }).pipe(Effect.result);

      if (Result.isSuccess(result)) {
        expect(Array.isArray(result.success.data)).toBe(true);
      } else {
        expect(result.failure._tag).not.toEqual("UnknownStripeError");
        expect(["InvalidRequestError", "Forbidden", "Unauthorized"]).toContain(
          result.failure._tag,
        );
        if (result.failure._tag === "InvalidRequestError") {
          expect(result.failure.message).toContain("not set up to use Issuing");
        }
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!ISSUING_ENABLED)(
  "create, update, and cancel an issuing card",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cardholder = yield* Stripe.IssuingCardholder("ExpenseHolder", {
            name: "Alchemy Card Holder",
            type: "individual",
            email: "alchemy.issuing.card@example.com",
            phoneNumber: "+15555550100",
            billing,
            individual: { firstName: "Alchemy", lastName: "Tester" },
          });
          const card = yield* Stripe.IssuingCard("ExpenseCard", {
            cardholder: cardholder.id,
            currency: "usd",
            type: "virtual",
            status: "inactive",
            metadata: { team: "ops" },
          });
          return { card, cardholder };
        }),
      );

      expect(created.card.id).toMatch(/^ic_/);
      expect(created.card.cardholder).toEqual(created.cardholder.id);
      expect(created.card.currency).toEqual("usd");
      expect(created.card.type).toEqual("virtual");
      expect(created.card.status).toEqual("inactive");
      expect(created.card.brand).toEqual(expect.any(String));
      expect(created.card.last4).toEqual(expect.any(String));
      expect(created.card.expMonth).toEqual(expect.any(Number));
      expect(created.card.expYear).toEqual(expect.any(Number));
      expect(created.card.metadata).toMatchObject({ team: "ops" });
      expect(created.card.livemode).toEqual(false);

      const fetched = yield* GetIssuingCard({ card: created.card.id });
      expect(fetched.id).toEqual(created.card.id);
      expect(fetched.cardholder.id).toEqual(created.cardholder.id);
      expect(fetched.currency).toEqual("usd");
      expect(fetched.type).toEqual("virtual");
      expect(fetched.status).toEqual("inactive");
      expect(fetched.metadata?.team).toEqual("ops");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cardholder = yield* Stripe.IssuingCardholder("ExpenseHolder", {
            name: "Alchemy Card Holder",
            type: "individual",
            email: "alchemy.issuing.card@example.com",
            phoneNumber: "+15555550100",
            billing,
            individual: { firstName: "Alchemy", lastName: "Tester" },
          });
          const card = yield* Stripe.IssuingCard("ExpenseCard", {
            cardholder: cardholder.id,
            currency: "usd",
            type: "virtual",
            status: "inactive",
            spendingControls: {
              spendingLimits: [{ amount: 50_000, interval: "monthly" }],
            },
            metadata: { team: "finance", sku: "ic-2" },
          });
          return { card, cardholder };
        }),
      );

      expect(updated.card.id).toEqual(created.card.id);
      expect(updated.card.status).toEqual("inactive");
      expect(updated.card.metadata).toEqual({ team: "finance", sku: "ic-2" });
      expect(updated.card.spendingControls?.spendingLimits).toEqual([
        { amount: 50_000, interval: "monthly" },
      ]);

      const refetched = yield* GetIssuingCard({ card: updated.card.id });
      expect(refetched.id).toEqual(updated.card.id);
      expect(refetched.status).toEqual("inactive");
      expect(refetched.metadata?.team).toEqual("finance");
      expect(refetched.metadata?.sku).toEqual("ic-2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();
      expect(refetched.spending_controls.spending_limits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            amount: 50_000,
            interval: "monthly",
          }),
        ]),
      );

      yield* stack.destroy();

      const canceled = yield* waitUntilCanceled(created.card.id);
      expect(canceled).toEqual("canceled");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!ISSUING_ENABLED)(
  "list enumerates the deployed issuing card",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const cardholder = yield* Stripe.IssuingCardholder("ListHolder", {
            name: "Alchemy List Holder",
            type: "individual",
            email: "alchemy.issuing.list@example.com",
            phoneNumber: "+15555550100",
            billing,
            individual: { firstName: "Alchemy", lastName: "Lister" },
          });
          const card = yield* Stripe.IssuingCard("ListCard", {
            cardholder: cardholder.id,
            currency: "usd",
            type: "virtual",
            status: "inactive",
            metadata: { kind: "list" },
          });
          return { card, cardholder };
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.IssuingCard);
      const all = yield* provider.list();
      const found = all.find((card) => card.id === deployed.card.id);
      expect(found).toBeDefined();
      expect(found?.cardholder).toEqual(deployed.cardholder.id);
      expect(found?.type).toEqual("virtual");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const canceled = yield* waitUntilCanceled(deployed.card.id);
      expect(canceled).toEqual("canceled");

      const after = yield* provider.list();
      expect(
        after.find((card) => card.id === deployed.card.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
