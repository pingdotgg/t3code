import * as AWS from "@/AWS";
import { ReceiptFilter } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as ses from "@distilled.cloud/aws/ses";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class FilterStillExists extends Data.TaggedError("FilterStillExists")<{
  readonly name: string;
}> {}

const findFilter = (name: string) =>
  ses
    .listReceiptFilters({})
    .pipe(
      Effect.map((response) =>
        (response.Filters ?? []).find((filter) => filter.Name === name),
      ),
    );

const assertFilterDeleted = (name: string) =>
  findFilter(name).pipe(
    Effect.flatMap((found) =>
      found ? Effect.fail(new FilterStillExists({ name })) : Effect.void,
    ),
    Effect.retry({
      while: (e) => e._tag === "FilterStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "receipt filter lifecycle: create, verify, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const filter = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptFilter("BlockRange", {
            ipFilter: { policy: "Block", cidr: "10.0.0.0/24" },
          });
        }),
      );

      expect(filter.filterName).toBeDefined();

      // out-of-band verification via distilled
      const observed = yield* findFilter(filter.filterName);
      expect(observed?.IpFilter?.Policy).toBe("Block");
      expect(observed?.IpFilter?.Cidr).toBe("10.0.0.0/24");

      yield* stack.destroy();
      yield* assertFilterDeleted(filter.filterName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing the IP rule replaces the filter (no update API)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptFilter("Filter", {
            ipFilter: { policy: "Block", cidr: "10.0.0.0/24" },
          });
        }),
      );

      // Flipping Block -> Allow has no update API, so the filter is replaced.
      // Auto-naming gives the replacement a fresh instance suffix, so the old
      // filter is deleted and a distinct new one created.
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ReceiptFilter("Filter", {
            ipFilter: { policy: "Allow", cidr: "10.0.0.0/24" },
          });
        }),
      );

      expect(second.filterName).not.toBe(first.filterName);
      const observed = yield* findFilter(second.filterName);
      expect(observed?.IpFilter?.Policy).toBe("Allow");
      yield* assertFilterDeleted(first.filterName);

      yield* stack.destroy();
      yield* assertFilterDeleted(second.filterName);
    }),
  { timeout: 120_000 },
);
