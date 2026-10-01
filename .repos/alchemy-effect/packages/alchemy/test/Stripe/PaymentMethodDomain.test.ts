import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetPaymentMethodDomain } from "@distilled.cloud/stripe/stripe";
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

const waitUntilDisabled = (id: string) =>
  GetPaymentMethodDomain({
    payment_method_domain: id,
  }).pipe(
    Effect.map((domain) =>
      domain.enabled ? ("enabled" as const) : ("disabled" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("disabled" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "disabled",
      times: 10,
    }),
  );

test.provider(
  "create, update, and deactivate a payment method domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentMethodDomain("Checkout", {
            domainName: "alchemy-pmd-lifecycle.example.com",
          });
        }),
      );

      expect(created.id).toMatch(/^pmd_/);
      expect(created.domainName).toEqual("alchemy-pmd-lifecycle.example.com");
      expect(created.enabled).toEqual(true);
      expect(created.applePay.status).toEqual(expect.any(String));
      expect(created.googlePay.status).toEqual(expect.any(String));
      expect(created.link.status).toEqual(expect.any(String));
      expect(created.paypal.status).toEqual(expect.any(String));
      expect(created.amazonPay.status).toEqual(expect.any(String));
      expect(created.klarna.status).toEqual(expect.any(String));
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetPaymentMethodDomain({
        payment_method_domain: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.domain_name).toEqual("alchemy-pmd-lifecycle.example.com");
      expect(fetched.enabled).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentMethodDomain("Checkout", {
            domainName: "alchemy-pmd-lifecycle.example.com",
            enabled: false,
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.domainName).toEqual("alchemy-pmd-lifecycle.example.com");
      expect(updated.enabled).toEqual(false);

      const refetched = yield* GetPaymentMethodDomain({
        payment_method_domain: updated.id,
      });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.domain_name).toEqual(
        "alchemy-pmd-lifecycle.example.com",
      );
      expect(refetched.enabled).toEqual(false);

      yield* stack.destroy();

      const disabled = yield* waitUntilDisabled(created.id);
      expect(disabled).toEqual("disabled");
      const deactivated = yield* GetPaymentMethodDomain({
        payment_method_domain: created.id,
      });
      expect(deactivated.enabled).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed payment method domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.PaymentMethodDomain("ListCheckout", {
            domainName: "alchemy-pmd-list.example.com",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.PaymentMethodDomain);
      const all = yield* provider.list();
      const found = all.find((domain) => domain.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.domainName).toEqual(deployed.domainName);
      expect(found?.enabled).toEqual(true);

      yield* stack.destroy();

      const disabled = yield* waitUntilDisabled(deployed.id);
      expect(disabled).toEqual("disabled");

      const after = yield* provider.list();
      expect(after.find((domain) => domain.id === deployed.id)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
