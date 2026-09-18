import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetIssuingCardholders,
  GetIssuingCardholder,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { isMissingStripeResource } from "@/Stripe/missing.ts";

const { test } = Test.make({ providers: Stripe.providers() });

const ISSUING_ENABLED = process.env.STRIPE_TEST_ISSUING === "1";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const isMissing = isMissingStripeResource;

const waitUntilInactive = (id: string) =>
  GetIssuingCardholder({ cardholder: id }).pipe(
    Effect.map((cardholder) =>
      cardholder.status === "inactive"
        ? ("inactive" as const)
        : ("active" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
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

test.provider(
  "issuing cardholders entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* GetIssuingCardholders({ limit: 1 }).pipe(
        Effect.result,
      );

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
  "create, update, and deactivate an issuing cardholder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.IssuingCardholder("CatalogHolder", {
            name: "Alice Example",
            type: "individual",
            email: "alchemy.issuing.holder@example.com",
            phoneNumber: "+15555550100",
            billing,
            individual: { firstName: "Alice", lastName: "Example" },
            preferredLocales: ["en"],
            metadata: { team: "ops" },
          });
        }),
      );

      expect(created.id).toMatch(/^ich_/);
      expect(created.name).toEqual("Alice Example");
      expect(created.type).toEqual("individual");
      expect(created.email).toEqual("alchemy.issuing.holder@example.com");
      expect(created.phoneNumber).toEqual("+15555550100");
      expect(created.status).toEqual("active");
      expect(created.firstName).toEqual("Alice");
      expect(created.lastName).toEqual("Example");
      expect(created.preferredLocales).toEqual(["en"]);
      expect(created.billing.address.city).toEqual("San Francisco");
      expect(created.billing.address.postalCode).toEqual("94111");
      expect(created.metadata).toMatchObject({ team: "ops" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetIssuingCardholder({
        cardholder: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual("Alice Example");
      expect(fetched.email).toEqual("alchemy.issuing.holder@example.com");
      expect(fetched.phone_number).toEqual("+15555550100");
      expect(fetched.status).toEqual("active");
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
          return yield* Stripe.IssuingCardholder("CatalogHolder", {
            name: "Alice Example",
            type: "individual",
            email: "alchemy.issuing.holder.updated@example.com",
            phoneNumber: "+15555550199",
            billing: {
              address: {
                ...billing.address,
                line1: "456 Market Street",
              },
            },
            individual: { firstName: "Alice", lastName: "Example" },
            preferredLocales: ["en", "es"],
            spendingControls: {
              spendingLimits: [{ amount: 10000, interval: "monthly" }],
              spendingLimitsCurrency: "usd",
            },
            metadata: { team: "finance", role: "lead" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.email).toEqual(
        "alchemy.issuing.holder.updated@example.com",
      );
      expect(updated.phoneNumber).toEqual("+15555550199");
      expect(updated.billing.address.line1).toEqual("456 Market Street");
      expect(updated.preferredLocales).toEqual(["en", "es"]);
      expect(updated.spendingControls?.spendingLimitsCurrency).toEqual("usd");
      expect(updated.spendingControls?.spendingLimits).toEqual([
        { amount: 10000, interval: "monthly" },
      ]);
      expect(updated.metadata).toEqual({ team: "finance", role: "lead" });
      expect(updated.status).toEqual("active");

      const refetched = yield* GetIssuingCardholder({
        cardholder: updated.id,
      });
      expect(refetched.email).toEqual(
        "alchemy.issuing.holder.updated@example.com",
      );
      expect(refetched.phone_number).toEqual("+15555550199");
      expect(refetched.billing.address.line1).toEqual("456 Market Street");
      expect(refetched.preferred_locales).toEqual(["en", "es"]);
      expect(refetched.metadata?.team).toEqual("finance");
      expect(refetched.metadata?.role).toEqual("lead");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(created.id);
      expect(inactive).toEqual("inactive");
      const deactivated = yield* GetIssuingCardholder({
        cardholder: created.id,
      });
      expect(deactivated.status).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!ISSUING_ENABLED)(
  "list enumerates the deployed issuing cardholder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.IssuingCardholder("ListHolder", {
            name: "List Example",
            type: "individual",
            billing,
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.IssuingCardholder);
      const all = yield* provider.list();
      const found = all.find((cardholder) => cardholder.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(deployed.id);
      expect(inactive).toEqual("inactive");

      const after = yield* provider.list();
      expect(
        after.find((cardholder) => cardholder.id === deployed.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
