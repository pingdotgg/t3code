import * as AWS from "@/AWS";
import { WebACL } from "@/AWS/WAFv2";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class WebACLStillExists extends Data.TaggedError("WebACLStillExists")<{
  readonly name: string;
}> {}

const assertWebAclDeleted = (
  name: string,
  id: string,
  scope: "REGIONAL" | "CLOUDFRONT",
) =>
  wafv2.getWebACL({ Name: name, Scope: scope, Id: id }).pipe(
    Effect.flatMap(() => Effect.fail(new WebACLStillExists({ name }))),
    Effect.catchTag("WAFNonexistentItemException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "WebACLStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

const visibility = (metricName: string): WAFV2.VisibilityConfig => ({
  SampledRequestsEnabled: true,
  CloudWatchMetricsEnabled: true,
  MetricName: metricName,
});

const BLOCKED_PATH = new TextEncoder().encode("/blocked");

// Flagship rule set: a managed rule group, a rate-based rule and a custom
// byte-match rule.
const flagshipRules: WAFV2.Rule[] = [
  {
    Name: "managed-common",
    Priority: 0,
    Statement: {
      ManagedRuleGroupStatement: {
        VendorName: "AWS",
        Name: "AWSManagedRulesCommonRuleSet",
      },
    },
    OverrideAction: { None: {} },
    VisibilityConfig: visibility("managed-common"),
  },
  {
    Name: "rate-limit",
    Priority: 1,
    Statement: {
      RateBasedStatement: { Limit: 100, AggregateKeyType: "IP" },
    },
    Action: { Block: {} },
    VisibilityConfig: visibility("rate-limit"),
  },
  {
    Name: "block-path",
    Priority: 2,
    Statement: {
      ByteMatchStatement: {
        SearchString: BLOCKED_PATH,
        FieldToMatch: { UriPath: {} },
        TextTransformations: [{ Priority: 0, Type: "LOWERCASE" }],
        PositionalConstraint: "STARTS_WITH",
      },
    },
    Action: { Block: {} },
    VisibilityConfig: visibility("block-path"),
  },
];

test.provider(
  "create with managed + rate-based + byte-match rules, update, delete",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const acl = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WebACL("LifecycleAcl", {
            rules: flagshipRules,
            tags: { Environment: "test" },
          });
        }),
      );

      expect(acl.scope).toBe("REGIONAL");
      expect(acl.webAclArn).toContain(":wafv2:");
      expect(acl.webAclArn).toContain("/webacl/");

      // out-of-band verification via distilled
      const created = yield* wafv2.getWebACL({
        Name: acl.webAclName,
        Scope: "REGIONAL",
        Id: acl.webAclId,
      });
      expect(created.WebACL?.DefaultAction?.Allow).toBeDefined();
      const ruleNames = (created.WebACL?.Rules ?? []).map((r) => r.Name);
      expect(ruleNames).toEqual(["managed-common", "rate-limit", "block-path"]);
      const managed = created.WebACL?.Rules?.find(
        (r) => r.Name === "managed-common",
      );
      expect(managed?.Statement?.ManagedRuleGroupStatement?.Name).toBe(
        "AWSManagedRulesCommonRuleSet",
      );
      const rate = created.WebACL?.Rules?.find((r) => r.Name === "rate-limit");
      expect(rate?.Statement?.RateBasedStatement?.Limit).toBe(100);

      const tags = yield* wafv2.listTagsForResource({
        ResourceARN: acl.webAclArn,
      });
      const tagRecord = Object.fromEntries(
        (tags.TagInfoForResource?.TagList ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tagRecord.Environment).toBe("test");
      expect(tagRecord["alchemy::id"]).toBe("LifecycleAcl");

      // update in place: block by default, drop to a single rule, retag
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WebACL("LifecycleAcl", {
            defaultAction: { Block: {} },
            description: "block by default",
            rules: [flagshipRules[1]],
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      expect(updated.webAclId).toBe(acl.webAclId);

      const afterUpdate = yield* wafv2.getWebACL({
        Name: acl.webAclName,
        Scope: "REGIONAL",
        Id: acl.webAclId,
      });
      expect(afterUpdate.WebACL?.DefaultAction?.Block).toBeDefined();
      expect(afterUpdate.WebACL?.Description).toBe("block by default");
      expect(afterUpdate.WebACL?.Rules?.length).toBe(1);
      expect(afterUpdate.WebACL?.Rules?.[0]?.Name).toBe("rate-limit");

      const updatedTags = yield* wafv2.listTagsForResource({
        ResourceARN: acl.webAclArn,
      });
      const updatedRecord = Object.fromEntries(
        (updatedTags.TagInfoForResource?.TagList ?? []).map((t) => [
          t.Key,
          t.Value,
        ]),
      );
      expect(updatedRecord.Extra).toBe("1");

      yield* stack.destroy();
      yield* assertWebAclDeleted(acl.webAclName, acl.webAclId, "REGIONAL");
    }),
  { timeout: 120_000 },
);

test.provider(
  "explicit name change replaces the web ACL",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WebACL("RenamedAcl", {
            webAclName: "alchemy-test-wafv2-rename-a",
          });
        }),
      );
      expect(first.webAclName).toBe("alchemy-test-wafv2-rename-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WebACL("RenamedAcl", {
            webAclName: "alchemy-test-wafv2-rename-b",
          });
        }),
      );
      expect(second.webAclName).toBe("alchemy-test-wafv2-rename-b");
      expect(second.webAclId).not.toBe(first.webAclId);

      // the old web ACL is gone after replacement
      yield* assertWebAclDeleted(first.webAclName, first.webAclId, "REGIONAL");

      yield* stack.destroy();
      yield* assertWebAclDeleted(
        second.webAclName,
        second.webAclId,
        "REGIONAL",
      );
    }),
  { timeout: 120_000 },
);

// CLOUDFRONT-scoped web ACLs are pinned to us-east-1 by the provider. The
// lifecycle is identical to REGIONAL; gate the live run to keep the default
// suite regional-only.
test.provider.skipIf(!process.env.AWS_TEST_WAF_CLOUDFRONT)(
  "CLOUDFRONT scope provisions in us-east-1",
  (stack) =>
    Effect.gen(function* () {
      // reconcile away any prior partial/crashed deployment
      yield* stack.destroy();

      const acl = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WebACL("EdgeAcl", { scope: "CLOUDFRONT" });
        }),
      );
      expect(acl.scope).toBe("CLOUDFRONT");
      expect(acl.webAclArn).toContain(":us-east-1:");
      expect(acl.webAclArn).toContain("global/webacl/");

      // out-of-band verification pinned to us-east-1
      const created = yield* wafv2
        .getWebACL({
          Name: acl.webAclName,
          Scope: "CLOUDFRONT",
          Id: acl.webAclId,
        })
        .pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));
      expect(created.WebACL?.ARN).toBe(acl.webAclArn);

      yield* stack.destroy();
      yield* assertWebAclDeleted(
        acl.webAclName,
        acl.webAclId,
        "CLOUDFRONT",
      ).pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));
    }),
  { timeout: 120_000 },
);
