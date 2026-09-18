import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetBillingPortalConfiguration } from "@distilled.cloud/stripe/stripe";
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

const waitUntilDeactivated = (id: string) =>
  GetBillingPortalConfiguration({ configuration: id }).pipe(
    Effect.map((configuration) =>
      configuration.active ? ("active" as const) : ("inactive" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

test.provider(
  "create, update, and deactivate a billing portal configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingPortalConfiguration("CustomerPortal", {
            name: "Alchemy Customer Portal",
            defaultReturnUrl: "https://example.com/account",
            businessProfile: {
              headline: "Manage your billing",
              privacyPolicyUrl: "https://example.com/privacy",
            },
            features: {
              invoiceHistory: { enabled: true },
              customerUpdate: {
                enabled: true,
                allowedUpdates: ["email", "address"],
              },
            },
            metadata: { env: "test" },
          });
        }),
      );

      expect(created.id).toMatch(/^bpc_/);
      expect(created.name).toEqual("Alchemy Customer Portal");
      expect(created.active).toEqual(true);
      expect(created.defaultReturnUrl).toEqual("https://example.com/account");
      expect(created.businessProfile.headline).toEqual("Manage your billing");
      expect(created.businessProfile.privacyPolicyUrl).toEqual(
        "https://example.com/privacy",
      );
      expect(created.features.invoiceHistory.enabled).toEqual(true);
      expect(created.features.customerUpdate.enabled).toEqual(true);
      expect(created.features.customerUpdate.allowedUpdates).toEqual([
        "email",
        "address",
      ]);
      expect(created.metadata).toMatchObject({ env: "test" });
      expect(created.livemode).toEqual(false);
      expect(created.created).toEqual(expect.any(Number));

      const fetched = yield* GetBillingPortalConfiguration({
        configuration: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual("Alchemy Customer Portal");
      expect(fetched.active).toEqual(true);
      expect(fetched.default_return_url).toEqual("https://example.com/account");
      expect(fetched.features.invoice_history.enabled).toEqual(true);
      expect(fetched.features.customer_update.enabled).toEqual(true);
      expect(fetched.metadata?.env).toEqual("test");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingPortalConfiguration("CustomerPortal", {
            name: "Alchemy Customer Portal Updated",
            defaultReturnUrl: "https://example.com/billing",
            businessProfile: {
              headline: "Updated headline",
              privacyPolicyUrl: "https://example.com/privacy",
              termsOfServiceUrl: "https://example.com/terms",
            },
            features: {
              invoiceHistory: { enabled: true },
              customerUpdate: {
                enabled: true,
                allowedUpdates: ["email", "name"],
              },
              paymentMethodUpdate: { enabled: true },
            },
            metadata: { env: "test", revision: "2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("Alchemy Customer Portal Updated");
      expect(updated.active).toEqual(true);
      expect(updated.defaultReturnUrl).toEqual("https://example.com/billing");
      expect(updated.businessProfile.headline).toEqual("Updated headline");
      expect(updated.businessProfile.termsOfServiceUrl).toEqual(
        "https://example.com/terms",
      );
      expect(updated.features.customerUpdate.allowedUpdates).toEqual([
        "email",
        "name",
      ]);
      expect(updated.features.paymentMethodUpdate.enabled).toEqual(true);
      expect(updated.metadata).toEqual({ env: "test", revision: "2" });

      const refetched = yield* GetBillingPortalConfiguration({
        configuration: updated.id,
      });
      expect(refetched.name).toEqual("Alchemy Customer Portal Updated");
      expect(refetched.default_return_url).toEqual(
        "https://example.com/billing",
      );
      expect(refetched.features.payment_method_update.enabled).toEqual(true);
      expect(refetched.metadata?.env).toEqual("test");
      expect(refetched.metadata?.revision).toEqual("2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(created.id);
      expect(deactivated).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed billing portal configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingPortalConfiguration("ListPortal", {
            name: "Alchemy List Portal",
            features: {
              invoiceHistory: { enabled: true },
            },
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Stripe.BillingPortalConfiguration,
      );
      const all = yield* provider.list();
      const found = all.find(
        (configuration) => configuration.id === deployed.id,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.features.invoiceHistory.enabled).toEqual(true);
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const deactivated = yield* waitUntilDeactivated(deployed.id);
      expect(deactivated).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
