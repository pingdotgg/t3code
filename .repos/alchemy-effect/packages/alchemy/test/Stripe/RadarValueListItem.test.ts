import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetRadarValueListItem,
  GetRadarValueLists,
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

const isMissing = isMissingStripeResource;

const waitUntilGone = (id: string) =>
  GetRadarValueListItem({ item: id }).pipe(
    Effect.as("found" as const),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "radar value lists entitlement probe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* GetRadarValueLists({ limit: 1 }).pipe(
        Effect.result,
      );

      if (Result.isSuccess(result)) {
        expect(Array.isArray(result.success.data)).toBe(true);
      } else {
        expect(["InvalidRequestError", "Forbidden", "Unauthorized"]).toContain(
          result.failure._tag,
        );
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider(
  "create, update, and delete a radar value list item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* Stripe.RadarValueList("ItemLifecycleList", {
            name: "Alchemy Radar Value List Item Lifecycle",
            itemType: "email",
          });
          const item = yield* Stripe.RadarValueListItem("BlockedEmail", {
            valueList: list.id,
            value: "blocked@example.com",
          });
          return { list, item };
        }),
      );

      expect(created.item.id).toMatch(/^rsli_/);
      expect(created.item.valueList).toEqual(created.list.id);
      expect(created.item.value).toEqual("blocked@example.com");
      expect(created.item.livemode).toEqual(false);
      expect(created.item.created).toEqual(expect.any(Number));
      expect(created.item.createdBy).toEqual(expect.any(String));

      const fetched = yield* GetRadarValueListItem({
        item: created.item.id,
      });
      expect(fetched.id).toEqual(created.item.id);
      expect(fetched.value_list).toEqual(created.list.id);
      expect(fetched.value).toEqual("blocked@example.com");
      expect(fetched.livemode).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* Stripe.RadarValueList("ItemLifecycleList", {
            name: "Alchemy Radar Value List Item Lifecycle",
            itemType: "email",
          });
          const item = yield* Stripe.RadarValueListItem("BlockedEmail", {
            valueList: list.id,
            value: "blocked@example.com",
          });
          return { list, item };
        }),
      );

      expect(updated.item.id).toEqual(created.item.id);
      expect(updated.item.valueList).toEqual(created.list.id);
      expect(updated.item.value).toEqual("blocked@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.item.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed radar value list item",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* Stripe.RadarValueList("ItemListList", {
            name: "Alchemy Radar Value List Item List",
            itemType: "email",
          });
          const item = yield* Stripe.RadarValueListItem("ListEmail", {
            valueList: list.id,
            value: "list@example.com",
          });
          return { list, item };
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.RadarValueListItem);
      const all = yield* provider.list();
      const found = all.find((item) => item.id === deployed.item.id);
      expect(found).toBeDefined();
      expect(found?.valueList).toEqual(deployed.list.id);
      expect(found?.value).toEqual("list@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.item.id);
      expect(gone).toEqual("gone");

      const after = yield* provider.list();
      expect(
        after.find((item) => item.id === deployed.item.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when the item value changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* Stripe.RadarValueList("ItemReplaceList", {
            name: "Alchemy Radar Value List Item Replace",
            itemType: "email",
          });
          const item = yield* Stripe.RadarValueListItem("ReplaceEmail", {
            valueList: list.id,
            value: "first@example.com",
          });
          return { list, item };
        }),
      );

      expect(created.item.value).toEqual("first@example.com");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* Stripe.RadarValueList("ItemReplaceList", {
            name: "Alchemy Radar Value List Item Replace",
            itemType: "email",
          });
          const item = yield* Stripe.RadarValueListItem("ReplaceEmail", {
            valueList: list.id,
            value: "second@example.com",
          });
          return { list, item };
        }),
      );

      expect(replaced.item.id).not.toEqual(created.item.id);
      expect(replaced.item.valueList).toEqual(created.list.id);
      expect(replaced.item.value).toEqual("second@example.com");

      const newFetched = yield* GetRadarValueListItem({
        item: replaced.item.id,
      });
      expect(newFetched.value).toEqual("second@example.com");

      const oldGone = yield* waitUntilGone(created.item.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.item.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
