import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetRadarValueList } from "@distilled.cloud/stripe/stripe";
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
  GetRadarValueList({ value_list: id }).pipe(
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
  "create, update, and delete a radar value list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.RadarValueList("BlockedEmails", {
            name: "Alchemy Blocked Emails",
            itemType: "email",
            metadata: { team: "fraud" },
          });
        }),
      );

      expect(created.id).toMatch(/^rsl_/);
      expect(created.alias).toEqual(expect.any(String));
      expect(created.name).toEqual("Alchemy Blocked Emails");
      expect(created.itemType).toEqual("email");
      expect(created.createdBy).toEqual(expect.any(String));
      expect(created.metadata).toMatchObject({ team: "fraud" });
      expect(created.created).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetRadarValueList({
        value_list: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.alias).toEqual(created.alias);
      expect(fetched.name).toEqual("Alchemy Blocked Emails");
      expect(fetched.item_type).toEqual("email");
      expect(fetched.metadata?.team).toEqual("fraud");
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stack],
      ).toBeDefined();
      expect(
        fetched.metadata?.[Stripe.alchemyMetadataKeys.stage],
      ).toBeDefined();
      expect(fetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.RadarValueList("BlockedEmails", {
            name: "Alchemy Blocked Emails Updated",
            itemType: "email",
            metadata: { team: "risk", sku: "rvl-2" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.alias).toEqual(created.alias);
      expect(updated.name).toEqual("Alchemy Blocked Emails Updated");
      expect(updated.itemType).toEqual("email");
      expect(updated.metadata).toEqual({ team: "risk", sku: "rvl-2" });

      const refetched = yield* GetRadarValueList({
        value_list: updated.id,
      });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.alias).toEqual(created.alias);
      expect(refetched.name).toEqual("Alchemy Blocked Emails Updated");
      expect(refetched.item_type).toEqual("email");
      expect(refetched.metadata?.team).toEqual("risk");
      expect(refetched.metadata?.sku).toEqual("rvl-2");
      expect(refetched.metadata?.[Stripe.alchemyMetadataKeys.id]).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when item type changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.RadarValueList("ReplaceList", {
            name: "Alchemy Replace List",
            itemType: "email",
          });
        }),
      );

      expect(created.itemType).toEqual("email");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.RadarValueList("ReplaceList", {
            name: "Alchemy Replace List",
            itemType: "ip_address",
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.itemType).toEqual("ip_address");
      expect(replaced.name).toEqual("Alchemy Replace List");

      const fetched = yield* GetRadarValueList({
        value_list: replaced.id,
      });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.item_type).toEqual("ip_address");

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed radar value list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.RadarValueList("ListValueList", {
            name: "Alchemy List Value List",
            itemType: "string",
            metadata: { kind: "list" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.RadarValueList);
      const all = yield* provider.list();
      const found = all.find((list) => list.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.itemType).toEqual("string");
      expect(found?.metadata).toMatchObject({ kind: "list" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
