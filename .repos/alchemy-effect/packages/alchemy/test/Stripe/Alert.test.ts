import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import { GetBillingAlert } from "@distilled.cloud/stripe/stripe";
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

const waitUntilArchived = (id: string) =>
  GetBillingAlert({ id }).pipe(
    Effect.map((alert) =>
      alert.status === "archived"
        ? ("archived" as const)
        : ("present" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("archived" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "archived",
      times: 10,
    }),
  );

test.provider(
  "create, deactivate, and archive a billing alert",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const meter = yield* Stripe.BillingMeter("AlertMeter", {
            displayName: "Alchemy Alert Meter",
            eventName: "alchemy_alrt_lifecycle",
            defaultAggregation: { formula: "sum" },
          });
          const alert = yield* Stripe.Alert("UsageAlert", {
            title: "Alchemy Usage Alert",
            usageThreshold: {
              gte: 100,
              meter: meter.id,
              recurrence: "one_time",
            },
          });
          return { meter, alert };
        }),
      );

      expect(created.alert.id).toMatch(/^alrt_/);
      expect(created.alert.title).toEqual("Alchemy Usage Alert");
      expect(created.alert.alertType).toEqual("usage_threshold");
      expect(created.alert.status).toEqual("active");
      expect(created.alert.usageThreshold).toEqual({
        gte: 100,
        meter: created.meter.id,
        recurrence: "one_time",
      });
      expect(created.alert.livemode).toEqual(false);

      const fetched = yield* GetBillingAlert({ id: created.alert.id });
      expect(fetched.id).toEqual(created.alert.id);
      expect(fetched.title).toEqual("Alchemy Usage Alert");
      expect(fetched.alert_type).toEqual("usage_threshold");
      expect(fetched.status).toEqual("active");
      expect(fetched.usage_threshold?.gte).toEqual(100);
      expect(
        typeof fetched.usage_threshold?.meter === "string"
          ? fetched.usage_threshold.meter
          : fetched.usage_threshold?.meter.id,
      ).toEqual(created.meter.id);
      expect(fetched.usage_threshold?.recurrence).toEqual("one_time");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const meter = yield* Stripe.BillingMeter("AlertMeter", {
            displayName: "Alchemy Alert Meter",
            eventName: "alchemy_alrt_lifecycle",
            defaultAggregation: { formula: "sum" },
          });
          const alert = yield* Stripe.Alert("UsageAlert", {
            title: "Alchemy Usage Alert",
            usageThreshold: {
              gte: 100,
              meter: meter.id,
              recurrence: "one_time",
            },
            status: "inactive",
          });
          return { meter, alert };
        }),
      );

      expect(updated.alert.id).toEqual(created.alert.id);
      expect(updated.alert.title).toEqual("Alchemy Usage Alert");
      expect(updated.alert.status).toEqual("inactive");
      expect(updated.alert.usageThreshold?.gte).toEqual(100);

      const refetched = yield* GetBillingAlert({ id: updated.alert.id });
      expect(refetched.id).toEqual(updated.alert.id);
      expect(refetched.title).toEqual("Alchemy Usage Alert");
      expect(refetched.status).toEqual("inactive");

      yield* stack.destroy();

      const archived = yield* waitUntilArchived(created.alert.id);
      expect(archived).toEqual("archived");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when usage threshold changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const meter = yield* Stripe.BillingMeter("ReplaceAlertMeter", {
            displayName: "Alchemy Replace Alert Meter",
            eventName: "alchemy_alrt_replace",
            defaultAggregation: { formula: "sum" },
          });
          const alert = yield* Stripe.Alert("ReplaceAlert", {
            title: "Alchemy Replace Alert",
            usageThreshold: {
              gte: 50,
              meter: meter.id,
              recurrence: "one_time",
            },
          });
          return { meter, alert };
        }),
      );

      expect(created.alert.usageThreshold?.gte).toEqual(50);
      expect(created.alert.status).toEqual("active");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const meter = yield* Stripe.BillingMeter("ReplaceAlertMeter", {
            displayName: "Alchemy Replace Alert Meter",
            eventName: "alchemy_alrt_replace",
            defaultAggregation: { formula: "sum" },
          });
          const alert = yield* Stripe.Alert("ReplaceAlert", {
            title: "Alchemy Replace Alert",
            usageThreshold: {
              gte: 500,
              meter: meter.id,
              recurrence: "one_time",
            },
          });
          return { meter, alert };
        }),
      );

      expect(replaced.alert.id).not.toEqual(created.alert.id);
      expect(replaced.alert.usageThreshold?.gte).toEqual(500);
      expect(replaced.alert.status).toEqual("active");

      const fetched = yield* GetBillingAlert({ id: replaced.alert.id });
      expect(fetched.id).toEqual(replaced.alert.id);
      expect(fetched.usage_threshold?.gte).toEqual(500);
      expect(fetched.status).toEqual("active");

      const oldArchived = yield* waitUntilArchived(created.alert.id);
      expect(oldArchived).toEqual("archived");

      yield* stack.destroy();

      const gone = yield* waitUntilArchived(replaced.alert.id);
      expect(gone).toEqual("archived");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed billing alert",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const meter = yield* Stripe.BillingMeter("ListAlertMeter", {
            displayName: "Alchemy List Alert Meter",
            eventName: "alchemy_alrt_list",
            defaultAggregation: { formula: "count" },
          });
          const alert = yield* Stripe.Alert("ListAlert", {
            title: "Alchemy List Alert",
            usageThreshold: {
              gte: 10,
              meter: meter.id,
              recurrence: "one_time",
            },
          });
          return { meter, alert };
        }),
      );

      const provider = yield* Provider.findProvider(Stripe.Alert);
      const all = yield* provider.list();
      const found = all.find((alert) => alert.id === deployed.alert.id);
      expect(found).toBeDefined();
      expect(found?.title).toEqual(deployed.alert.title);
      expect(found?.usageThreshold?.gte).toEqual(10);
      expect(found?.usageThreshold?.meter).toEqual(deployed.meter.id);

      yield* stack.destroy();

      const archived = yield* waitUntilArchived(deployed.alert.id);
      expect(archived).toEqual("archived");

      const after = yield* provider.list();
      expect(
        after.find((alert) => alert.id === deployed.alert.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
