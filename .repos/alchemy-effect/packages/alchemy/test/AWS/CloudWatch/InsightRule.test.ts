import * as AWS from "@/AWS";
import { InsightRule } from "@/AWS/CloudWatch";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// list() enumerates every Contributor Insights rule in the account/region via
// `describeInsightRules`. We deploy a real rule, resolve the provider from
// context via the typed `findProvider`, call `list()`, and assert the deployed
// rule appears in the exhaustively paginated result.
test.provider("list enumerates the deployed insight rule", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* InsightRule("ListInsightRule", {
          name: "alchemy-test-insight-rule-list",
          RuleState: "ENABLED",
          RuleDefinition: {
            Schema: {
              Name: "CloudWatchLogRule",
              Version: 1,
            },
            LogGroupNames: ["alchemy-test-insight-rule-list-log-group"],
            LogFormat: "JSON",
            Contribution: {
              Keys: ["$.ip"],
              Filters: [],
            },
            AggregateOn: "Count",
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(InsightRule);
    const all = yield* provider.list();

    expect(all.some((r) => r.ruleName === deployed.ruleName)).toBe(true);

    yield* stack.destroy();

    // Out-of-band assert-gone: the exhaustively-paginated live listing no
    // longer contains the rule after the final destroy.
    const after = yield* provider.list();
    expect(after.some((r) => r.ruleName === deployed.ruleName)).toBe(false);
  }),
);
