import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetApplePayDomain } from "@distilled.cloud/stripe/stripe";
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

const LIFECYCLE_DOMAIN = "alchemy-apple-pay-lifecycle.example.com";
const REPLACE_FROM_DOMAIN = "alchemy-apple-pay-replace-a.example.com";
const REPLACE_TO_DOMAIN = "alchemy-apple-pay-replace-b.example.com";
const LIST_DOMAIN = "alchemy-apple-pay-list.example.com";

const waitUntilGone = (id: string) =>
  GetApplePayDomain({ domain: id }).pipe(
    Effect.as("found" as const),
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
  "create, update, and delete an apple pay domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ApplePayDomain("Checkout", {
            domainName: LIFECYCLE_DOMAIN,
          });
        }),
      );

      expect(created.id).toMatch(/^apwc_/);
      expect(created.domainName).toEqual(LIFECYCLE_DOMAIN);
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetApplePayDomain({
        domain: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.domain_name).toEqual(LIFECYCLE_DOMAIN);
      expect(fetched.livemode).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ApplePayDomain("Checkout", {
            domainName: LIFECYCLE_DOMAIN,
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.domainName).toEqual(LIFECYCLE_DOMAIN);

      const refetched = yield* GetApplePayDomain({
        domain: updated.id,
      });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.domain_name).toEqual(LIFECYCLE_DOMAIN);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when domainName changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ApplePayDomain("ReplaceDomain", {
            domainName: REPLACE_FROM_DOMAIN,
          });
        }),
      );

      expect(created.domainName).toEqual(REPLACE_FROM_DOMAIN);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ApplePayDomain("ReplaceDomain", {
            domainName: REPLACE_TO_DOMAIN,
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.domainName).toEqual(REPLACE_TO_DOMAIN);

      const fetched = yield* GetApplePayDomain({
        domain: replaced.id,
      });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.domain_name).toEqual(REPLACE_TO_DOMAIN);

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed apple pay domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.ApplePayDomain("ListDomain", {
            domainName: LIST_DOMAIN,
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.ApplePayDomain);
      const all = yield* provider.list();
      const found = all.find((domain) => domain.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.domainName).toEqual(LIST_DOMAIN);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
