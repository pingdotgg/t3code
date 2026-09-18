import * as Provider from "@/Provider";
import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetTerminalConfiguration,
  type DeletedTerminalConfiguration,
  type TerminalConfiguration as StripeTerminalConfiguration,
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

const isDeletedConfiguration = (
  value: StripeTerminalConfiguration | DeletedTerminalConfiguration,
): value is DeletedTerminalConfiguration =>
  "deleted" in value && value.deleted === true;

const waitUntilGone = (id: string) =>
  GetTerminalConfiguration({ configuration: id }).pipe(
    Effect.map((configuration) =>
      "deleted" in configuration && configuration.deleted === true
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchIf(isMissing, () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a terminal configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalConfiguration("Storefront", {
            name: "Alchemy Terminal Config",
            offline: { enabled: true },
            tipping: {
              usd: {
                fixedAmounts: [100, 200, 300],
                percentages: [15, 20, 25],
                smartTipThreshold: 1000,
              },
            },
            rebootWindow: { startHour: 2, endHour: 4 },
          });
        }),
      );

      expect(created.id).toMatch(/^tmc_/);
      expect(created.name).toEqual("Alchemy Terminal Config");
      expect(created.isAccountDefault).toEqual(false);
      expect(created.offline).toEqual({ enabled: true });
      expect(created.tipping?.usd?.fixedAmounts).toEqual([100, 200, 300]);
      expect(created.tipping?.usd?.percentages).toEqual([15, 20, 25]);
      expect(created.tipping?.usd?.smartTipThreshold).toEqual(1000);
      expect(created.rebootWindow).toEqual({ startHour: 2, endHour: 4 });
      expect(created.livemode).toEqual(false);

      const fetched = yield* GetTerminalConfiguration({
        configuration: created.id,
      });
      expect(isDeletedConfiguration(fetched)).toEqual(false);
      if (isDeletedConfiguration(fetched)) {
        return;
      }
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toEqual("Alchemy Terminal Config");
      expect(fetched.is_account_default).toEqual(false);
      expect(fetched.offline?.enabled).toEqual(true);
      expect(fetched.tipping?.usd?.fixed_amounts).toEqual([100, 200, 300]);
      expect(fetched.tipping?.usd?.percentages).toEqual([15, 20, 25]);
      expect(fetched.tipping?.usd?.smart_tip_threshold).toEqual(1000);
      expect(fetched.reboot_window?.start_hour).toEqual(2);
      expect(fetched.reboot_window?.end_hour).toEqual(4);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalConfiguration("Storefront", {
            name: "Alchemy Terminal Config Updated",
            offline: { enabled: false },
            tipping: {
              usd: {
                fixedAmounts: [200, 300, 400],
                percentages: [10, 15, 20],
                smartTipThreshold: 2000,
              },
            },
            rebootWindow: { startHour: 3, endHour: 5 },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("Alchemy Terminal Config Updated");
      expect(updated.isAccountDefault).toEqual(false);
      expect(updated.offline).toEqual({ enabled: false });
      expect(updated.tipping?.usd?.fixedAmounts).toEqual([200, 300, 400]);
      expect(updated.tipping?.usd?.percentages).toEqual([10, 15, 20]);
      expect(updated.tipping?.usd?.smartTipThreshold).toEqual(2000);
      expect(updated.rebootWindow).toEqual({ startHour: 3, endHour: 5 });

      const refetched = yield* GetTerminalConfiguration({
        configuration: updated.id,
      });
      expect(isDeletedConfiguration(refetched)).toEqual(false);
      if (isDeletedConfiguration(refetched)) {
        return;
      }
      expect(refetched.id).toEqual(updated.id);
      expect(refetched.name).toEqual("Alchemy Terminal Config Updated");
      expect(refetched.offline?.enabled).toEqual(false);
      expect(refetched.tipping?.usd?.fixed_amounts).toEqual([200, 300, 400]);
      expect(refetched.tipping?.usd?.percentages).toEqual([10, 15, 20]);
      expect(refetched.tipping?.usd?.smart_tip_threshold).toEqual(2000);
      expect(refetched.reboot_window?.start_hour).toEqual(3);
      expect(refetched.reboot_window?.end_hour).toEqual(5);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed terminal configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Stripe.TerminalConfiguration("ListStorefront", {
            name: "Alchemy List Terminal Config",
            offline: { enabled: true },
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Stripe.TerminalConfiguration,
      );
      const all = yield* provider.list();
      const found = all.find(
        (configuration) => configuration.id === deployed.id,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.isAccountDefault).toEqual(false);
      expect(found?.offline).toEqual({ enabled: true });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");

      const after = yield* provider.list();
      expect(
        after.find((configuration) => configuration.id === deployed.id),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
