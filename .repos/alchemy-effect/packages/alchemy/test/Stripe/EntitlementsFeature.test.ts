import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetEntitlementsFeature } from "@distilled.cloud/stripe/stripe";
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

const waitUntilInactive = (id: string) =>
  GetEntitlementsFeature({ id }).pipe(
    Effect.map((feature) =>
      feature.active ? ("active" as const) : ("inactive" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

test.provider(
  "create, update, and deactivate an entitlements feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.EntitlementsFeature("Seats", {
            lookupKey: "alchemy-ent-feat-lifecycle",
            name: "Alchemy Seats Feature",
            metadata: { plan: "pro" },
          });
        }),
      );

      expect(created.id).toMatch(/^feat_/);
      expect(created.lookupKey).toEqual("alchemy-ent-feat-lifecycle");
      expect(created.name).toEqual("Alchemy Seats Feature");
      expect(created.active).toEqual(true);
      expect(created.metadata).toMatchObject({ plan: "pro" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetEntitlementsFeature({ id: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.lookup_key).toEqual("alchemy-ent-feat-lifecycle");
      expect(fetched.name).toEqual("Alchemy Seats Feature");
      expect(fetched.active).toEqual(true);
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
          return yield* Stripe.EntitlementsFeature("Seats", {
            lookupKey: "alchemy-ent-feat-lifecycle",
            name: "Alchemy Seats Feature Updated",
            metadata: { plan: "enterprise", sku: "ent-1" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.lookupKey).toEqual(created.lookupKey);
      expect(updated.name).toEqual("Alchemy Seats Feature Updated");
      expect(updated.active).toEqual(true);
      expect(updated.metadata).toEqual({ plan: "enterprise", sku: "ent-1" });

      const refetched = yield* GetEntitlementsFeature({ id: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.name).toEqual("Alchemy Seats Feature Updated");
      expect(refetched.lookup_key).toEqual("alchemy-ent-feat-lifecycle");
      expect(refetched.metadata?.plan).toEqual("enterprise");
      expect(refetched.metadata?.sku).toEqual("ent-1");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(created.id);
      expect(inactive).toEqual("inactive");
      const deactivated = yield* GetEntitlementsFeature({ id: created.id });
      expect(deactivated.active).toEqual(false);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed entitlements feature",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.EntitlementsFeature("ListFeature", {
            lookupKey: "alchemy-ent-feat-list",
            name: "Alchemy List Feature",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.EntitlementsFeature);
      const all = yield* provider.list();
      const found = all.find((feature) => feature.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.lookupKey).toEqual("alchemy-ent-feat-list");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(deployed.id);
      expect(inactive).toEqual("inactive");

      const after = yield* provider.list();
      expect(
        after.find((feature) => feature.id === deployed.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when lookup key changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.EntitlementsFeature("ReplaceFeature", {
            lookupKey: "alchemy-ent-feat-replace-a",
            name: "Alchemy Replace Feature",
          });
        }),
      );

      expect(created.lookupKey).toEqual("alchemy-ent-feat-replace-a");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.EntitlementsFeature("ReplaceFeature", {
            lookupKey: "alchemy-ent-feat-replace-b",
            name: "Alchemy Replace Feature",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.lookupKey).toEqual("alchemy-ent-feat-replace-b");
      expect(replaced.name).toEqual("Alchemy Replace Feature");

      const fetched = yield* GetEntitlementsFeature({ id: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.lookup_key).toEqual("alchemy-ent-feat-replace-b");

      const oldInactive = yield* waitUntilInactive(created.id);
      expect(oldInactive).toEqual("inactive");

      yield* stack.destroy();

      const gone = yield* waitUntilInactive(replaced.id);
      expect(gone).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
