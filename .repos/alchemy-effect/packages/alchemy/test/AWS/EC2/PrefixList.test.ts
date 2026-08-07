import * as AWS from "@/AWS";
import { PrefixList } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class PrefixListStillExists extends Data.TaggedError("PrefixListStillExists") {}

const getEntries = (prefixListId: string) =>
  EC2.getManagedPrefixListEntries({ PrefixListId: prefixListId }).pipe(
    Effect.map((r) =>
      Object.fromEntries(
        (r.Entries ?? []).map((e) => [e.Cidr!, e.Description ?? ""]),
      ),
    ),
  );

const assertDeleted = Effect.fn(function* (prefixListId: string) {
  yield* EC2.describeManagedPrefixLists({ PrefixListIds: [prefixListId] }).pipe(
    Effect.flatMap((r) => {
      const state = r.PrefixLists?.[0]?.State;
      return state === undefined || state === "delete-complete"
        ? Effect.void
        : Effect.fail(new PrefixListStillExists());
    }),
    Effect.retry({
      while: (e) => e instanceof PrefixListStillExists,
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(8)]),
    }),
    Effect.catchTag("InvalidPrefixListID.NotFound", () => Effect.void),
  );
});

test.provider(
  "create, update entries, delete managed prefix list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with two entries.
      const { prefixList } = yield* stack.deploy(
        Effect.gen(function* () {
          const prefixList = yield* PrefixList("TestPrefixList", {
            maxEntries: 5,
            entries: [
              { cidr: "10.0.0.0/16", description: "vpc-a" },
              { cidr: "10.1.0.0/16", description: "vpc-b" },
            ],
          });
          return { prefixList };
        }),
      );

      expect(prefixList.prefixListId).toMatch(/^pl-/);
      expect(prefixList.addressFamily).toEqual("IPv4");
      expect(prefixList.maxEntries).toEqual(5);

      // Verify out-of-band.
      const described = yield* EC2.describeManagedPrefixLists({
        PrefixListIds: [prefixList.prefixListId],
      });
      expect(described.PrefixLists?.[0]?.PrefixListId).toEqual(
        prefixList.prefixListId,
      );
      expect(described.PrefixLists?.[0]?.State).toEqual("create-complete");

      const entries1 = yield* getEntries(prefixList.prefixListId);
      expect(entries1).toEqual({
        "10.0.0.0/16": "vpc-a",
        "10.1.0.0/16": "vpc-b",
      });

      // Update entries: drop one, add one, change a description.
      const { prefixList: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const prefixList = yield* PrefixList("TestPrefixList", {
            maxEntries: 5,
            entries: [
              { cidr: "10.0.0.0/16", description: "vpc-a-renamed" },
              { cidr: "10.2.0.0/16", description: "vpc-c" },
            ],
          });
          return { prefixList };
        }),
      );

      // Same list (in-place modify), version bumped.
      expect(updated.prefixListId).toEqual(prefixList.prefixListId);
      expect(updated.version).toBeGreaterThan(prefixList.version);

      const entries2 = yield* getEntries(prefixList.prefixListId);
      expect(entries2).toEqual({
        "10.0.0.0/16": "vpc-a-renamed",
        "10.2.0.0/16": "vpc-c",
      });

      yield* stack.destroy();
      yield* assertDeleted(prefixList.prefixListId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "list enumerates the deployed prefix list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { prefixList } = yield* stack.deploy(
        Effect.gen(function* () {
          const prefixList = yield* PrefixList("ListPrefixList", {
            maxEntries: 3,
            entries: [{ cidr: "192.168.0.0/24" }],
          });
          return { prefixList };
        }),
      );

      const provider = yield* Provider.findProvider(PrefixList);
      const all = yield* provider.list();
      expect(all.some((x) => x.prefixListId === prefixList.prefixListId)).toBe(
        true,
      );

      yield* stack.destroy();
      yield* assertDeleted(prefixList.prefixListId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
