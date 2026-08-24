import * as AWS from "@/AWS";
import { Analyzer, ArchiveRule } from "@/AWS/AccessAnalyzer";
import * as Test from "@/Test/Alchemy";
import * as aa from "@distilled.cloud/aws/accessanalyzer";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeAccessAnalyzerTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({
  providers: AWS.providers(),
});
const testLease = makeAccessAnalyzerTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

const findAnalyzer = (name: string) =>
  aa.getAnalyzer({ analyzerName: name }).pipe(
    Effect.map((r) => r.analyzer),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const findArchiveRule = (analyzerName: string, ruleName: string) =>
  aa.getArchiveRule({ analyzerName, ruleName }).pipe(
    Effect.map((r) => r.archiveRule),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

class AnalyzerStillExists extends Data.TaggedError("AnalyzerStillExists")<{
  readonly name: string;
}> {}

const assertAnalyzerDeleted = (name: string) =>
  findAnalyzer(name).pipe(
    Effect.flatMap((analyzer) =>
      analyzer === undefined
        ? Effect.void
        : Effect.fail(new AnalyzerStillExists({ name })),
    ),
    Effect.retry({
      while: (e) => e._tag === "AnalyzerStillExists",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

test.provider(
  "analyzer lifecycle: create ACCOUNT analyzer, update tags, manage archive rule, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const analyzerName = "alchemy-test-external-access";

      const makeStack = (tagValue: string, ruleFilterValue: string) =>
        Effect.gen(function* () {
          const analyzer = yield* Analyzer("AccountAnalyzer", {
            analyzerName,
            type: "ACCOUNT",
            tags: { Environment: tagValue },
          });
          const rule = yield* ArchiveRule("TrustedAccount", {
            analyzerName: analyzer.analyzerName,
            ruleName: "trusted-account",
            filter: {
              "principal.AWS": { eq: [ruleFilterValue] },
            },
          });
          return { analyzer, rule };
        });

      // create
      const { analyzer } = yield* stack.deploy(
        makeStack("test", "111111111111"),
      );
      expect(analyzer.analyzerName).toBe(analyzerName);
      expect(analyzer.analyzerArn).toContain(":analyzer/");
      expect(analyzer.type).toBe("ACCOUNT");

      // out-of-band verify
      const created = yield* findAnalyzer(analyzerName);
      expect(created?.type).toBe("ACCOUNT");
      expect(created?.tags?.Environment).toBe("test");
      expect(created?.tags?.["alchemy::id"]).toBe("AccountAnalyzer");

      const createdRule = yield* findArchiveRule(
        analyzerName,
        "trusted-account",
      );
      expect(createdRule?.filter?.["principal.AWS"]?.eq).toEqual([
        "111111111111",
      ]);

      // update tags + archive rule filter in place (no replacement)
      const updated = yield* stack.deploy(makeStack("prod", "222222222222"));
      expect(updated.analyzer.analyzerArn).toBe(analyzer.analyzerArn);

      const afterTagUpdate = yield* findAnalyzer(analyzerName);
      expect(afterTagUpdate?.tags?.Environment).toBe("prod");

      const afterRuleUpdate = yield* findArchiveRule(
        analyzerName,
        "trusted-account",
      );
      expect(afterRuleUpdate?.filter?.["principal.AWS"]?.eq).toEqual([
        "222222222222",
      ]);

      // destroy
      yield* stack.destroy();
      yield* assertAnalyzerDeleted(analyzerName);
    }),
  { timeout: 180_000 },
);

const observedUnusedAccessAge = (
  analyzer: aa.AnalyzerSummary | undefined,
): number | undefined => analyzer?.configuration?.unusedAccess?.unusedAccessAge;

test.provider(
  "unused-access analyzer: create with a tracking period, replace on change, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const analyzerName = "alchemy-test-unused-access-age";

      const makeStack = (unusedAccessAge: Duration.Input) =>
        Effect.gen(function* () {
          return {
            analyzer: yield* Analyzer("UnusedAccessAnalyzer", {
              analyzerName,
              type: "ACCOUNT_UNUSED_ACCESS",
              unusedAccessAge,
            }),
          };
        });

      // create with a 180-day tracking period
      const { analyzer } = yield* stack.deploy(makeStack("180 days"));
      expect(analyzer.type).toBe("ACCOUNT_UNUSED_ACCESS");

      const created = yield* findAnalyzer(analyzerName);
      expect(observedUnusedAccessAge(created)).toBe(180);

      // the tracking period is create-only — changing it replaces the
      // analyzer (delete-first, keeping the pinned name). The new observed
      // period is the proof: the API rejects in-place updates.
      const updated = yield* stack.deploy(makeStack("365 days"));
      expect(updated.analyzer.analyzerName).toBe(analyzerName);

      const afterReplace = yield* findAnalyzer(analyzerName);
      expect(observedUnusedAccessAge(afterReplace)).toBe(365);

      // destroy
      yield* stack.destroy();
      yield* assertAnalyzerDeleted(analyzerName);
    }),
  { timeout: 180_000 },
);
