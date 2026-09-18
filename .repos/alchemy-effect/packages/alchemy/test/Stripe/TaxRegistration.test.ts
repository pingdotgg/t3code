import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetTaxRegistration,
  GetTaxSettings,
  CreateTaxSettings,
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

const FAR_FUTURE = 1_893_456_000; // 2030-01-01T00:00:00Z

const ensureHeadOffice = Effect.gen(function* () {
  const settings = yield* GetTaxSettings({});
  if (settings.head_office != null) return;
  yield* CreateTaxSettings({
    head_office: {
      address: {
        country: "US",
        line1: "123 Market St",
        city: "San Francisco",
        state: "CA",
        postal_code: "94105",
      },
    },
  });
});

const waitUntilExpired = (id: string) =>
  GetTaxRegistration({ id }).pipe(
    Effect.map((registration) =>
      registration.status === "expired"
        ? ("expired" as const)
        : ("active" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("expired" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "expired",
      times: 10,
    }),
  );

test.provider(
  "create, update, and expire a tax registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* ensureHeadOffice;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRegistration("LifecycleReg", {
            country: "TJ",
            countryOptions: { tj: { type: "simplified" } },
          });
        }),
      );

      expect(created.id).toMatch(/^taxreg_/);
      expect(created.country).toEqual("TJ");
      expect(created.countryOptions.tj?.type).toEqual("simplified");
      expect(created.status).toEqual("active");
      expect(created.expiresAt).toBeUndefined();
      expect(created.activeFrom).toEqual(expect.any(Number));
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetTaxRegistration({ id: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.country).toEqual("TJ");
      expect(fetched.country_options.tj?.type).toEqual("simplified");
      expect(fetched.status).toEqual("active");
      expect(fetched.expires_at).toBeNull();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRegistration("LifecycleReg", {
            country: "TJ",
            countryOptions: { tj: { type: "simplified" } },
            expiresAt: FAR_FUTURE,
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.country).toEqual("TJ");
      expect(updated.expiresAt).toEqual(FAR_FUTURE);
      expect(updated.status).toEqual("active");

      const refetched = yield* GetTaxRegistration({ id: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.expires_at).toEqual(FAR_FUTURE);
      expect(refetched.status).toEqual("active");

      yield* stack.destroy();

      const expired = yield* waitUntilExpired(created.id);
      expect(expired).toEqual("expired");
      const deactivated = yield* GetTaxRegistration({ id: created.id });
      expect(deactivated.status).toEqual("expired");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed tax registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* ensureHeadOffice;

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRegistration("ListReg", {
            country: "ZM",
            countryOptions: { zm: { type: "simplified" } },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.TaxRegistration);
      const all = yield* provider.list();
      const found = all.find((registration) => registration.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.country).toEqual("ZM");
      expect(found?.countryOptions.zm?.type).toEqual("simplified");
      expect(found?.status).toEqual("active");

      yield* stack.destroy();

      const expired = yield* waitUntilExpired(deployed.id);
      expect(expired).toEqual("expired");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when country changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* ensureHeadOffice;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRegistration("ReplaceReg", {
            country: "SR",
            countryOptions: { sr: { type: "standard" } },
          });
        }),
      );

      expect(created.country).toEqual("SR");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TaxRegistration("ReplaceReg", {
            country: "UZ",
            countryOptions: { uz: { type: "simplified" } },
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.country).toEqual("UZ");
      expect(replaced.countryOptions.uz?.type).toEqual("simplified");

      const fetched = yield* GetTaxRegistration({ id: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.country).toEqual("UZ");

      const oldExpired = yield* waitUntilExpired(created.id);
      expect(oldExpired).toEqual("expired");

      yield* stack.destroy();

      const gone = yield* waitUntilExpired(replaced.id);
      expect(gone).toEqual("expired");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
