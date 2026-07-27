import * as AWS from "@/AWS";
import { ActionTarget } from "@/AWS/SecurityHub/ActionTarget.ts";
import { AutomationRule } from "@/AWS/SecurityHub/AutomationRule.ts";
import { FindingAggregator } from "@/AWS/SecurityHub/FindingAggregator.ts";
import { Hub } from "@/AWS/SecurityHub/Hub.ts";
import { Insight } from "@/AWS/SecurityHub/Insight.ts";
import * as Test from "@/Test/Alchemy";
import * as securityhub from "@distilled.cloud/aws/securityhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeSecurityHubTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeSecurityHubTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// `describeHub` throws `InvalidAccessException` when the account is not
// subscribed to Security Hub.
const describeHub = securityhub.describeHub({}).pipe(
  Effect.map((hub) => hub as securityhub.DescribeHubResponse | undefined),
  Effect.catchTag("InvalidAccessException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

// ActionTarget, Insight, AutomationRule, and FindingAggregator all require
// Security Hub to be enabled. To avoid touching a Hub the user already
// operates (capture-and-restore safety), the test only runs when Security Hub
// is not already enabled — it enables the Hub itself and disables it again on
// destroy.
test.provider(
  "lifecycle: action target + insight + automation rule + finding aggregator",
  (stack) =>
    Effect.gen(function* () {
      // Destroy OUR previous resources first — a crashed prior run leaves the
      // test's own Hub enabled, which must not be mistaken for a foreign one.
      yield* stack.destroy();

      const preexisting = yield* describeHub;
      if (preexisting) {
        yield* Effect.logInfo(
          `Security Hub already enabled (${preexisting.HubArn}) — skipping SecurityHub resources lifecycle test`,
        );
        return;
      }

      // Phase 0 — enable the Hub alone so the sub-resources (which have no
      // data dependency on it) never race its enablement.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hub("Hub", { enableDefaultStandards: false });
        }),
      );

      // Phase 1 — create all four sub-resources.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Hub("Hub", { enableDefaultStandards: false });
          const action = yield* ActionTarget("Escalate", {
            name: "Escalate",
            description: "Escalate the selected findings",
          });
          const insight = yield* Insight("ActiveByResource", {
            filters: {
              RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            },
            groupByAttribute: "ResourceId",
          });
          const rule = yield* AutomationRule("SuppressInfo", {
            description: "Suppress informational findings",
            ruleOrder: 1,
            criteria: {
              SeverityLabel: [{ Value: "INFORMATIONAL", Comparison: "EQUALS" }],
            },
            actions: [
              {
                Type: "FINDING_FIELDS_UPDATE",
                FindingFieldsUpdate: {
                  Workflow: { Status: "SUPPRESSED" },
                },
              },
            ],
            tags: { env: "test" },
          });
          const aggregator = yield* FindingAggregator("Aggregator", {
            regionLinkingMode: "SPECIFIED_REGIONS",
            regions: ["eu-west-1"],
          });
          return {
            actionTargetArn: action.actionTargetArn,
            actionId: action.id,
            insightArn: insight.insightArn,
            insightName: insight.name,
            ruleArn: rule.ruleArn,
            aggregatorArn: aggregator.findingAggregatorArn,
          };
        }),
      );
      expect(created.actionTargetArn).toContain(":action/custom/");
      expect(created.insightArn).toContain(":insight/");
      expect(created.ruleArn).toContain(":automation-rule/");
      expect(created.aggregatorArn).toContain(":finding-aggregator/");

      // Out-of-band verification.
      const liveAction = yield* securityhub.describeActionTargets({
        ActionTargetArns: [created.actionTargetArn],
      });
      expect(liveAction.ActionTargets?.[0]?.Name).toBe("Escalate");

      const liveInsight = yield* securityhub.getInsights({
        InsightArns: [created.insightArn],
      });
      expect(liveInsight.Insights?.[0]?.GroupByAttribute).toBe("ResourceId");

      const liveRule = yield* securityhub.batchGetAutomationRules({
        AutomationRulesArns: [created.ruleArn],
      });
      expect(liveRule.Rules?.[0]?.RuleOrder).toBe(1);
      const ruleTags = yield* securityhub.listTagsForResource({
        ResourceArn: created.ruleArn,
      });
      expect(ruleTags.Tags?.["env"]).toBe("test");
      expect(ruleTags.Tags?.["alchemy::id"]).toBe("SuppressInfo");

      const liveAggregator = yield* securityhub.getFindingAggregator({
        FindingAggregatorArn: created.aggregatorArn,
      });
      expect(liveAggregator.RegionLinkingMode).toBe("SPECIFIED_REGIONS");
      expect(liveAggregator.Regions).toEqual(["eu-west-1"]);

      // Phase 2 — in-place updates across all four resources.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* Hub("Hub", { enableDefaultStandards: false });
          const action = yield* ActionTarget("Escalate", {
            name: "Escalate",
            description: "Escalate the selected findings to on-call",
          });
          const insight = yield* Insight("ActiveByResource", {
            filters: {
              RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
            },
            groupByAttribute: "SeverityLabel",
          });
          const rule = yield* AutomationRule("SuppressInfo", {
            description: "Suppress informational findings",
            ruleOrder: 5,
            ruleStatus: "DISABLED",
            criteria: {
              SeverityLabel: [{ Value: "INFORMATIONAL", Comparison: "EQUALS" }],
            },
            actions: [
              {
                Type: "FINDING_FIELDS_UPDATE",
                FindingFieldsUpdate: {
                  Workflow: { Status: "SUPPRESSED" },
                },
              },
            ],
            tags: { env: "prod" },
          });
          const aggregator = yield* FindingAggregator("Aggregator", {
            regionLinkingMode: "SPECIFIED_REGIONS",
            regions: ["eu-west-1", "eu-central-1"],
          });
          return {
            actionTargetArn: action.actionTargetArn,
            insightArn: insight.insightArn,
            ruleArn: rule.ruleArn,
            aggregatorArn: aggregator.findingAggregatorArn,
          };
        }),
      );

      // All four update in place — identities are unchanged.
      expect(updated.actionTargetArn).toBe(created.actionTargetArn);
      expect(updated.insightArn).toBe(created.insightArn);
      expect(updated.ruleArn).toBe(created.ruleArn);
      expect(updated.aggregatorArn).toBe(created.aggregatorArn);

      const updatedAction = yield* securityhub.describeActionTargets({
        ActionTargetArns: [created.actionTargetArn],
      });
      expect(updatedAction.ActionTargets?.[0]?.Description).toBe(
        "Escalate the selected findings to on-call",
      );

      const updatedInsight = yield* securityhub.getInsights({
        InsightArns: [created.insightArn],
      });
      expect(updatedInsight.Insights?.[0]?.GroupByAttribute).toBe(
        "SeverityLabel",
      );

      const updatedRule = yield* securityhub.batchGetAutomationRules({
        AutomationRulesArns: [created.ruleArn],
      });
      expect(updatedRule.Rules?.[0]?.RuleOrder).toBe(5);
      expect(updatedRule.Rules?.[0]?.RuleStatus).toBe("DISABLED");
      const updatedTags = yield* securityhub.listTagsForResource({
        ResourceArn: created.ruleArn,
      });
      expect(updatedTags.Tags?.["env"]).toBe("prod");

      const updatedAggregator = yield* securityhub.getFindingAggregator({
        FindingAggregatorArn: created.aggregatorArn,
      });
      // The API returns Regions in normalized order.
      expect([...(updatedAggregator.Regions ?? [])].sort()).toEqual([
        "eu-central-1",
        "eu-west-1",
      ]);

      // Destroy — every resource is removed and Security Hub is disabled
      // (which also proves delete-idempotence via the InvalidAccess catches:
      // the hub disable may land before the sub-resource deletes re-check).
      yield* stack.destroy();
      const after = yield* describeHub;
      expect(after).toBeUndefined();
    }),
  { timeout: 300_000 },
);
