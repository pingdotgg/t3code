import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetTerminalLocation } from "@distilled.cloud/stripe/stripe";
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
  GetTerminalLocation({ location: id }).pipe(
    Effect.map((location) =>
      "deleted" in location && location.deleted
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

const usAddress = {
  line1: "123 Market Street",
  city: "San Francisco",
  state: "CA",
  postalCode: "94105",
  country: "US",
} as const;

const usAddressUpdated = {
  line1: "125 Market Street",
  city: "San Francisco",
  state: "CA",
  postalCode: "94105",
  country: "US",
} as const;

const caAddress = {
  line1: "100 Queen Street West",
  city: "Toronto",
  state: "ON",
  postalCode: "M5H 2N2",
  country: "CA",
} as const;

test.provider(
  "create, update, and delete a terminal location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalLocation("Storefront", {
            displayName: "Alchemy Storefront",
            address: { ...usAddress },
            phone: "+14155550100",
            metadata: { region: "west" },
          });
        }),
      );

      expect(created.id).toMatch(/^tml_/);
      expect(created.displayName).toEqual("Alchemy Storefront");
      expect(created.address).toEqual(usAddress);
      expect(created.phone).toEqual("+14155550100");
      expect(created.metadata).toMatchObject({ region: "west" });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetTerminalLocation({
        location: created.id,
      });
      if (!("display_name" in fetched)) {
        return;
      }
      expect(fetched.id).toEqual(created.id);
      expect(fetched.display_name).toEqual("Alchemy Storefront");
      expect(fetched.address.line1).toEqual(usAddress.line1);
      expect(fetched.address.city).toEqual(usAddress.city);
      expect(fetched.address.state).toEqual(usAddress.state);
      expect(fetched.address.postal_code).toEqual(usAddress.postalCode);
      expect(fetched.address.country).toEqual(usAddress.country);
      expect(fetched.phone).toEqual("+14155550100");
      expect(fetched.metadata?.region).toEqual("west");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalLocation("Storefront", {
            displayName: "Alchemy Storefront Updated",
            address: { ...usAddressUpdated },
            phone: "+14155550199",
            metadata: { region: "bay", sku: "loc-2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.displayName).toEqual("Alchemy Storefront Updated");
      expect(updated.address).toEqual(usAddressUpdated);
      expect(updated.phone).toEqual("+14155550199");
      expect(updated.metadata).toEqual({ region: "bay", sku: "loc-2" });

      const refetched = yield* GetTerminalLocation({
        location: updated.id,
      });
      if (!("display_name" in refetched)) {
        return;
      }
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.display_name).toEqual("Alchemy Storefront Updated");
      expect(refetched.address.line1).toEqual(usAddressUpdated.line1);
      expect(refetched.phone).toEqual("+14155550199");
      expect(refetched.metadata?.region).toEqual("bay");
      expect(refetched.metadata?.sku).toEqual("loc-2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the country changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalLocation("ReplaceStore", {
            displayName: "Alchemy Replace Store",
            address: { ...usAddress },
          });
        }),
      );

      expect(created.address.country).toEqual("US");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalLocation("ReplaceStore", {
            displayName: "Alchemy Replace Store",
            address: { ...caAddress },
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.address).toEqual(caAddress);
      expect(replaced.displayName).toEqual("Alchemy Replace Store");

      const fetched = yield* GetTerminalLocation({
        location: replaced.id,
      });
      if (!("display_name" in fetched)) {
        return;
      }
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.address.country).toEqual("CA");
      expect(fetched.address.city).toEqual(caAddress.city);
      expect(fetched.address.postal_code).toEqual(caAddress.postalCode);

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed terminal location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalLocation("ListStore", {
            displayName: "Alchemy List Store",
            address: { ...usAddress },
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.TerminalLocation);
      const all = yield* provider.list();
      const found = all.find((location) => location.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.displayName).toEqual(deployed.displayName);
      expect(found?.address.country).toEqual("US");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
