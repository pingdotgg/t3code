import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { Link, Sink } from "@/AWS/OAM";
import * as Test from "@/Test/Alchemy";
import * as oam from "@distilled.cloud/aws/oam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { makeOamTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const serviceLease = makeOamTestLease();

beforeAll(serviceLease.acquire, { timeout: 3_600_000 });
afterAll(serviceLease.release);

const assertSinkGone = (sinkArn: string) =>
  oam.getSink({ Identifier: sinkArn }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`sink ${sinkArn} still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

// Policy validation resolves principals, so the source account must be a
// REAL account — we use the caller's own. Nothing ever links to this sink
// (same-account links are rejected); the policy only exercises put/get/diff.
const sinkPolicy = (accountId: string, resourceTypes: string[]) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { AWS: [accountId] },
      Action: ["oam:CreateLink", "oam:UpdateLink"],
      Resource: "*",
      Condition: {
        "ForAllValues:StringEquals": { "oam:ResourceTypes": resourceTypes },
      },
    },
  ],
});

// AWS enforces ONE sink per account per region, so every test that deploys a
// sink must run sequentially — including the same-account Link probe, which
// shares the lifecycle test's sink instead of deploying its own.
describe.sequential("AWS.OAM.Sink", () => {
  test.provider(
    "sink lifecycle (policy + tags) and same-account link rejection",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* AWSEnvironment.current;
        yield* stack.destroy();

        const deploySink = (props: {
          policy: Record<string, any>;
          tags: Record<string, string>;
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const sink = yield* Sink("MonitoringSink", props);
              return {
                sinkName: sink.sinkName,
                sinkArn: sink.sinkArn,
                sinkId: sink.sinkId,
              };
            }),
          );

        const created = yield* deploySink({
          policy: sinkPolicy(accountId, ["AWS::CloudWatch::Metric"]),
          tags: { purpose: "alchemy-test" },
        });
        expect(created.sinkArn).toContain(":sink/");
        expect(created.sinkArn).toContain(created.sinkId);

        // Out-of-band: the sink, its policy, and its tags are all live.
        const observed = yield* oam.getSink({ Identifier: created.sinkArn });
        expect(observed.Name).toBe(created.sinkName);
        const policy = yield* oam.getSinkPolicy({
          SinkIdentifier: created.sinkArn,
        });
        expect(policy.Policy).toContain("oam:CreateLink");
        expect(policy.Policy).toContain("AWS::CloudWatch::Metric");
        const tags = yield* oam.listTagsForResource({
          ResourceArn: created.sinkArn,
        });
        expect(tags.Tags?.purpose).toBe("alchemy-test");
        expect(tags.Tags?.["alchemy::id"]).toBe("MonitoringSink");

        // Same-account link create-path probe: OAM rejects a link whose sink
        // lives in the caller's own account with a typed
        // InvalidParameterException. This proves the createLink wire shape
        // (the full Link lifecycle needs a second account — gated below).
        const linkAttempt = yield* Effect.result(
          oam.createLink({
            LabelTemplate: "$AccountName",
            ResourceTypes: ["AWS::CloudWatch::Metric"],
            SinkIdentifier: created.sinkArn,
          }),
        );
        expect(Result.isFailure(linkAttempt)).toBe(true);
        if (Result.isFailure(linkAttempt)) {
          const failure = linkAttempt.failure;
          expect(failure._tag).toBe("InvalidParameterException");
          if (failure._tag === "InvalidParameterException") {
            expect(failure.message ?? "").toContain("same account");
          }
        }

        // Update: widen the sink policy and change tags; the sink itself
        // (name/arn/id) is stable.
        const updated = yield* deploySink({
          policy: sinkPolicy(accountId, [
            "AWS::CloudWatch::Metric",
            "AWS::Logs::LogGroup",
          ]),
          tags: { purpose: "alchemy-test", updated: "true" },
        });
        expect(updated.sinkArn).toBe(created.sinkArn);
        const updatedPolicy = yield* oam.getSinkPolicy({
          SinkIdentifier: created.sinkArn,
        });
        expect(updatedPolicy.Policy).toContain("AWS::Logs::LogGroup");
        const updatedTags = yield* oam.listTagsForResource({
          ResourceArn: created.sinkArn,
        });
        expect(updatedTags.Tags?.updated).toBe("true");

        yield* stack.destroy();
        yield* assertSinkGone(created.sinkArn);
      }),
    { timeout: 180_000 },
  );

  // Full Link lifecycle requires a sink in a DIFFERENT account whose policy
  // authorizes this one. Point AWS_TEST_OAM_SINK_ARN at such a sink to run.
  test.provider.skipIf(!process.env.AWS_TEST_OAM_SINK_ARN)(
    "link lifecycle against a cross-account sink",
    (stack) =>
      Effect.gen(function* () {
        const sinkIdentifier = process.env.AWS_TEST_OAM_SINK_ARN!;
        yield* stack.destroy();

        const deployLink = (resourceTypes: string[]) =>
          stack.deploy(
            Effect.gen(function* () {
              const link = yield* Link("CrossAccountLink", {
                labelTemplate: "$AccountName",
                resourceTypes,
                sinkIdentifier,
                tags: { purpose: "alchemy-test" },
              });
              return { linkArn: link.linkArn, label: link.label };
            }),
          );

        const created = yield* deployLink(["AWS::CloudWatch::Metric"]);
        const live = yield* oam.getLink({ Identifier: created.linkArn });
        expect(live.ResourceTypes).toEqual(["AWS::CloudWatch::Metric"]);

        // Update mutates resource types in place (no replacement).
        const updated = yield* deployLink([
          "AWS::CloudWatch::Metric",
          "AWS::Logs::LogGroup",
        ]);
        expect(updated.linkArn).toBe(created.linkArn);
        const after = yield* oam.getLink({ Identifier: created.linkArn });
        expect([...(after.ResourceTypes ?? [])].sort()).toEqual([
          "AWS::CloudWatch::Metric",
          "AWS::Logs::LogGroup",
        ]);

        yield* stack.destroy();
        const gone = yield* Effect.result(
          oam.getLink({ Identifier: created.linkArn }),
        );
        expect(Result.isFailure(gone)).toBe(true);
      }),
    { timeout: 180_000 },
  );
});
