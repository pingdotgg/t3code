import * as AWS from "@/AWS";
import { Discovery, GroupingConfiguration } from "@/AWS/ApplicationSignals";
import * as Test from "@/Test/Alchemy";
import * as appsignals from "@distilled.cloud/aws/application-signals";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const observedDefinitions = appsignals
  .listGroupingAttributeDefinitions({})
  .pipe(Effect.map((r) => r.GroupingAttributeDefinitions));

// The grouping configuration is an ACCOUNT-LEVEL singleton: this test owns
// it for the duration of the run (create → update → delete restores the
// account to its unconfigured default).
test.provider(
  "create, update, and destroy the account grouping configuration (+ discovery)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // CREATE — one custom grouping dimension (plus the idempotent
      // account-level Discovery enablement in the same stack).
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const discovery = yield* Discovery("Discovery", {});
          const grouping = yield* GroupingConfiguration("Grouping", {
            groupingAttributeDefinitions: [
              {
                GroupingName: "AlchemyTestTeam",
                GroupingSourceKeys: ["Tag.team"],
                DefaultGroupingValue: "unassigned",
              },
            ],
          });
          return { discovery, grouping };
        }),
      );

      expect(first.discovery.accountId).toMatch(/^\d{12}$/);
      expect(
        first.grouping.groupingAttributeDefinitions.map((d) => d.GroupingName),
      ).toEqual(["AlchemyTestTeam"]);

      // Out-of-band verification via distilled.
      const observed = yield* observedDefinitions;
      expect(observed.map((d) => d.GroupingName)).toEqual(["AlchemyTestTeam"]);
      expect(observed[0].DefaultGroupingValue).toBe("unassigned");

      // UPDATE IN PLACE — PutGroupingConfiguration replaces the whole list.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          const discovery = yield* Discovery("Discovery", {});
          const grouping = yield* GroupingConfiguration("Grouping", {
            groupingAttributeDefinitions: [
              {
                GroupingName: "AlchemyTestTeam",
                GroupingSourceKeys: ["Tag.team"],
              },
              {
                GroupingName: "AlchemyTestCostCenter",
                GroupingSourceKeys: ["Tag.cost-center"],
                DefaultGroupingValue: "shared",
              },
            ],
          });
          return { discovery, grouping };
        }),
      );

      expect(
        second.grouping.groupingAttributeDefinitions.map((d) => d.GroupingName),
      ).toEqual(["AlchemyTestTeam", "AlchemyTestCostCenter"]);
      const updated = yield* observedDefinitions;
      expect(updated).toHaveLength(2);

      // DESTROY — the account reverts to no grouping configuration.
      // (Discovery deletion is a documented no-op.)
      yield* stack.destroy();
      const afterDestroy = yield* observedDefinitions;
      expect(afterDestroy).toHaveLength(0);
    }),
  { timeout: 120_000 },
);
