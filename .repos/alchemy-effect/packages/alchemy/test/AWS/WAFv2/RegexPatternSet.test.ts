import * as AWS from "@/AWS";
import { RegexPatternSet } from "@/AWS/WAFv2";
import * as Test from "@/Test/Alchemy";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class RegexPatternSetStillExists extends Data.TaggedError(
  "RegexPatternSetStillExists",
)<{
  readonly name: string;
}> {}

const assertDeleted = (name: string, id: string) =>
  wafv2.getRegexPatternSet({ Name: name, Scope: "REGIONAL", Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new RegexPatternSetStillExists({ name }))),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RegexPatternSetStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update expressions and tags, delete",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const set = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RegexPatternSet("LifecycleRegexSet", {
            regularExpressions: ["^/wp-admin", "\\.php$"],
            description: "bad paths",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(set.scope).toBe("REGIONAL");
      expect([...set.regularExpressions].sort()).toEqual([
        "\\.php$",
        "^/wp-admin",
      ]);

      // out-of-band verification via distilled
      const created = yield* wafv2.getRegexPatternSet({
        Name: set.regexPatternSetName,
        Scope: "REGIONAL",
        Id: set.regexPatternSetId,
      });
      expect(
        (created.RegexPatternSet?.RegularExpressionList ?? [])
          .map((r) => r.RegexString)
          .sort(),
      ).toEqual(["\\.php$", "^/wp-admin"]);
      expect(created.RegexPatternSet?.Description).toBe("bad paths");

      const tags = yield* wafv2.listTagsForResource({
        ResourceARN: set.regexPatternSetArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.TagInfoForResource?.TagList ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.Environment).toBe("test");
      expect(tagRecord["alchemy::id"]).toBe("LifecycleRegexSet");

      // expressions are mutable — updated in place
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* RegexPatternSet("LifecycleRegexSet", {
            regularExpressions: ["^/admin"],
            description: "bad paths",
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.regexPatternSetId).toBe(set.regexPatternSetId);
      expect(updated.regularExpressions).toEqual(["^/admin"]);

      const afterUpdate = yield* wafv2.getRegexPatternSet({
        Name: set.regexPatternSetName,
        Scope: "REGIONAL",
        Id: set.regexPatternSetId,
      });
      expect(
        (afterUpdate.RegexPatternSet?.RegularExpressionList ?? []).map(
          (r) => r.RegexString,
        ),
      ).toEqual(["^/admin"]);

      yield* stack.destroy();
      yield* assertDeleted(set.regexPatternSetName, set.regexPatternSetId);
    }),
  { timeout: 120_000 },
);
