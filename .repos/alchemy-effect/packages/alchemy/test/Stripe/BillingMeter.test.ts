import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetBillingMeter } from "@distilled.cloud/stripe/stripe";
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
  GetBillingMeter({ id }).pipe(
    Effect.map((meter) =>
      meter.status === "inactive" ? ("inactive" as const) : ("active" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("inactive" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "inactive",
      times: 10,
    }),
  );

test.provider(
  "create, update, and deactivate a billing meter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingMeter("UsageMeter", {
            displayName: "Alchemy API Calls",
            eventName: "alchemy_bm_lifecycle",
            defaultAggregation: { formula: "sum" },
            valueSettings: { eventPayloadKey: "value" },
            customerMapping: {
              type: "by_id",
              eventPayloadKey: "stripe_customer_id",
            },
          });
        }),
      );

      expect(created.id).toMatch(/^mtr_/);
      expect(created.displayName).toEqual("Alchemy API Calls");
      expect(created.eventName).toEqual("alchemy_bm_lifecycle");
      expect(created.defaultAggregation).toEqual({ formula: "sum" });
      expect(created.valueSettings).toEqual({ eventPayloadKey: "value" });
      expect(created.customerMapping).toEqual({
        type: "by_id",
        eventPayloadKey: "stripe_customer_id",
      });
      expect(created.status).toEqual("active");
      expect(created.created).toEqual(expect.any(Number));
      expect(created.updated).toEqual(expect.any(Number));
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetBillingMeter({ id: created.id });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.display_name).toEqual("Alchemy API Calls");
      expect(fetched.event_name).toEqual("alchemy_bm_lifecycle");
      expect(fetched.default_aggregation.formula).toEqual("sum");
      expect(fetched.value_settings.event_payload_key).toEqual("value");
      expect(fetched.customer_mapping.type).toEqual("by_id");
      expect(fetched.customer_mapping.event_payload_key).toEqual(
        "stripe_customer_id",
      );
      expect(fetched.status).toEqual("active");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingMeter("UsageMeter", {
            displayName: "Alchemy API Calls Updated",
            eventName: "alchemy_bm_lifecycle",
            defaultAggregation: { formula: "sum" },
            valueSettings: { eventPayloadKey: "value" },
            customerMapping: {
              type: "by_id",
              eventPayloadKey: "stripe_customer_id",
            },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.displayName).toEqual("Alchemy API Calls Updated");
      expect(updated.eventName).toEqual("alchemy_bm_lifecycle");
      expect(updated.status).toEqual("active");

      const refetched = yield* GetBillingMeter({ id: updated.id });
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.display_name).toEqual("Alchemy API Calls Updated");
      expect(refetched.event_name).toEqual("alchemy_bm_lifecycle");
      expect(refetched.status).toEqual("active");

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(created.id);
      expect(inactive).toEqual("inactive");
      const deactivated = yield* GetBillingMeter({ id: created.id });
      expect(deactivated.status).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when event name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingMeter("ReplaceMeter", {
            displayName: "Alchemy Replace Meter",
            eventName: "alchemy_bm_replace_a",
            defaultAggregation: { formula: "sum" },
          });
        }),
      );

      expect(created.eventName).toEqual("alchemy_bm_replace_a");
      expect(created.status).toEqual("active");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingMeter("ReplaceMeter", {
            displayName: "Alchemy Replace Meter",
            eventName: "alchemy_bm_replace_b",
            defaultAggregation: { formula: "sum" },
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.eventName).toEqual("alchemy_bm_replace_b");
      expect(replaced.status).toEqual("active");

      const fetched = yield* GetBillingMeter({ id: replaced.id });
      expect(fetched.id).toEqual(replaced.id);
      expect(fetched.event_name).toEqual("alchemy_bm_replace_b");
      expect(fetched.status).toEqual("active");

      const oldInactive = yield* waitUntilInactive(created.id);
      expect(oldInactive).toEqual("inactive");

      yield* stack.destroy();

      const gone = yield* waitUntilInactive(replaced.id);
      expect(gone).toEqual("inactive");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed billing meter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.BillingMeter("ListMeter", {
            displayName: "Alchemy List Meter",
            eventName: "alchemy_bm_list",
            defaultAggregation: { formula: "count" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.BillingMeter);
      const all = yield* provider.list();
      const found = all.find((meter) => meter.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.displayName).toEqual(deployed.displayName);
      expect(found?.eventName).toEqual("alchemy_bm_list");
      expect(found?.defaultAggregation).toEqual({ formula: "count" });

      yield* stack.destroy();

      const inactive = yield* waitUntilInactive(deployed.id);
      expect(inactive).toEqual("inactive");

      const after = yield* provider.list();
      expect(after.find((meter) => meter.id === deployed.id)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
