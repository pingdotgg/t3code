import * as AWS from "@/AWS";
import { Rule } from "@/AWS/EventBridge/Rule.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

/** Typed wait-until-gone: poll describeRule until ResourceNotFoundException. */
const assertRuleGone = Effect.fn(function* (name: string) {
  const gone = yield* eventbridge.describeRule({ Name: name }).pipe(
    Effect.map(() => false),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (isGone): boolean => isGone,
      times: 10,
    }),
  );
  expect(gone).toBe(true);
});

// Canonical `list()` test (AWS account/region-scoped collection across all
// event buses): deploy a real rule, resolve the provider from context via the
// typed `findProvider`, call `list()`, and assert the deployed rule appears in
// the exhaustively-paginated result.
test.provider(
  "list enumerates the deployed rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Rule("ListRule", {
            name: "alchemy-test-rule-list",
            scheduleExpression: "rate(5 minutes)",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Rule);
      const all = yield* provider.list();

      expect(all.some((r) => r.ruleName === rule.ruleName)).toBe(true);
      expect(
        all.some(
          (r) =>
            r.ruleName === rule.ruleName &&
            r.eventBusName === rule.eventBusName,
        ),
      ).toBe(true);

      yield* stack.destroy();

      yield* assertRuleGone("alchemy-test-rule-list");
    }),
  { timeout: 120_000 },
);
