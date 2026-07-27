import * as AWS from "@/AWS";
import { ConfigRule } from "@/AWS/Config";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/aws/config-service";
import * as iam from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { makeConfigTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeConfigTestLease();

// Acquire outside the individual lifecycle timer. Bindings holds the same
// account/Region recorder lease for its file-long fixture, and queueing behind
// it is scheduling rather than part of this rule's cloud-operation budget.
beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost.
test.provider(
  "describeConfigRules on a nonexistent rule fails with NoSuchConfigRuleException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        config.describeConfigRules({
          ConfigRuleNames: ["alchemy-nonexistent-config-rule-probe"],
        }),
      );
      expect(error._tag).toBe("NoSuchConfigRuleException");
    }),
);

const findRule = (ruleName: string) =>
  config.describeConfigRules({ ConfigRuleNames: [ruleName] }).pipe(
    Effect.map((r) => (r.ConfigRules ?? []).at(0)),
    Effect.catchTag("NoSuchConfigRuleException", () =>
      Effect.succeed(undefined),
    ),
  );

class RuleStillExists extends Data.TaggedError("RuleStillExists")<{
  readonly ruleName: string;
  readonly state: string;
}> {}

// Rule deletion is asynchronous — DELETING is an irreversible terminal
// trajectory, so gone-or-DELETING both count as deleted.
const assertRuleDeleting = (ruleName: string) =>
  findRule(ruleName).pipe(
    Effect.flatMap((rule) =>
      rule === undefined || rule.ConfigRuleState === "DELETING"
        ? Effect.void
        : Effect.fail(
            new RuleStillExists({
              ruleName,
              state: rule.ConfigRuleState ?? "unknown",
            }),
          ),
    ),
    Effect.retry({
      while: (e) => e._tag === "RuleStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// PutConfigRule requires a configuration recorder in the account/region
// (NoAvailableConfigurationRecorderException otherwise). Capture-and-restore:
// if the account has none, stand up a minimal recorder on the Config
// service-linked role for the duration of the test and delete it afterwards;
// an existing foreign recorder is left untouched. The recorder name is a
// deterministic constant unique to this test so a leftover from a
// previously-killed run is RECLAIMED (and thus cleaned up at the end)
// instead of orphaning forever.
const TEST_RECORDER_NAME = "alchemy-test-configrule-recorder";

const ensureRecorder = Effect.gen(function* () {
  const existing = yield* config.describeConfigurationRecorders({});
  const recorders = existing.ConfigurationRecorders ?? [];
  if (recorders.some((r) => r.name === TEST_RECORDER_NAME)) {
    // Leftover from a previously-killed run — reclaim it so the release
    // finalizer deletes it when this run finishes.
    return true;
  }
  if (recorders.length > 0) {
    // A foreign recorder already exists (only one per account/region is
    // allowed) — use it, never touch it.
    return false;
  }
  yield* iam
    .createServiceLinkedRole({ AWSServiceName: "config.amazonaws.com" })
    .pipe(
      Effect.catchTag("InvalidInputException", () => Effect.succeed(undefined)),
    );
  const role = yield* iam.getRole({ RoleName: "AWSServiceRoleForConfig" });
  // A freshly-created service-linked role can be transiently rejected until
  // IAM propagates.
  yield* config
    .putConfigurationRecorder({
      ConfigurationRecorder: {
        name: TEST_RECORDER_NAME,
        roleARN: role.Role.Arn,
        recordingGroup: { resourceTypes: ["AWS::S3::Bucket"] },
      },
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "InvalidRoleException",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(15),
        ]),
      }),
    );
  return true;
});

// Idempotent: tolerates the recorder already being gone.
const removeRecorderIfCreated = (created: boolean) =>
  created
    ? config
        .deleteConfigurationRecorder({
          ConfigurationRecorderName: TEST_RECORDER_NAME,
        })
        .pipe(
          Effect.catchTag(
            "NoSuchConfigurationRecorderException",
            () => Effect.void,
          ),
          Effect.orDie,
        )
    : Effect.void;

test.provider(
  "create, update, replace on rename, delete managed config rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      // acquireRelease guarantees the out-of-band recorder is deleted on
      // success, failure, AND interruption; the deterministic name +
      // reclaim in ensureRecorder means a re-run converges on any orphan
      // from a previously-killed run.
      yield* Effect.acquireRelease(ensureRecorder, (created) =>
        removeRecorderIfCreated(created),
      );

      yield* Effect.gen(function* () {
        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ConfigRule("VersioningRule", {
              description: "buckets must have versioning enabled",
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
              },
              scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
              tags: { Environment: "test" },
            });
          }),
        );

        expect(rule.configRuleName).toBeDefined();
        expect(rule.configRuleArn).toContain(":config-rule/");
        expect(rule.configRuleId).toContain("config-rule-");

        // Out-of-band verification via distilled.
        const created = yield* findRule(rule.configRuleName);
        expect(created?.Source.Owner).toBe("AWS");
        expect(created?.Source.SourceIdentifier).toBe(
          "S3_BUCKET_VERSIONING_ENABLED",
        );
        expect(created?.Description).toBe(
          "buckets must have versioning enabled",
        );
        expect(created?.Scope?.ComplianceResourceTypes).toEqual([
          "AWS::S3::Bucket",
        ]);
        const tags = yield* config
          .listTagsForResource({ ResourceArn: rule.configRuleArn })
          .pipe(
            Effect.map((r) =>
              Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
            ),
          );
        expect(tags.Environment).toBe("test");
        expect(tags["alchemy::id"]).toBe("VersioningRule");

        // Update the description and tags in place.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ConfigRule("VersioningRule", {
              description: "buckets must have versioning enabled (v2)",
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
              },
              scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
              tags: { Environment: "prod" },
            });
          }),
        );
        expect(updated.configRuleName).toBe(rule.configRuleName);
        expect(updated.configRuleArn).toBe(rule.configRuleArn);

        const afterUpdate = yield* findRule(rule.configRuleName);
        expect(afterUpdate?.Description).toBe(
          "buckets must have versioning enabled (v2)",
        );
        const updatedTags = yield* config
          .listTagsForResource({ ResourceArn: rule.configRuleArn })
          .pipe(
            Effect.map((r) =>
              Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
            ),
          );
        expect(updatedTags.Environment).toBe("prod");

        // Renaming replaces the rule.
        const renamed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* ConfigRule("VersioningRule", {
              configRuleName: "alchemy-test-config-rule-renamed",
              source: {
                owner: "AWS",
                sourceIdentifier: "S3_BUCKET_VERSIONING_ENABLED",
              },
              scope: { complianceResourceTypes: ["AWS::S3::Bucket"] },
            });
          }),
        );
        expect(renamed.configRuleName).toBe("alchemy-test-config-rule-renamed");
        expect(renamed.configRuleArn).not.toBe(rule.configRuleArn);
        yield* assertRuleDeleting(rule.configRuleName);

        yield* stack.destroy();
        yield* assertRuleDeleting(renamed.configRuleName);
      });
    }),
  { timeout: 120_000 },
);
