import * as AWS from "@/AWS";
import {
  Association,
  CustomAction,
  SlackChannelConfiguration,
} from "@/AWS/Chatbot";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as chatbot from "@distilled.cloud/aws/chatbot";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// ---------------------------------------------------------------------------
// Ungated typed-error probes — a full association lifecycle needs a Slack or
// Teams channel configuration, which requires a workspace onboarded via the
// AWS Chatbot console OAuth flow (cannot be scripted). These probes prove the
// typed error semantics the Association provider's observe/associate paths
// depend on, in every CI pass, at near-zero cost.
// ---------------------------------------------------------------------------

// The observe path the provider depends on: listAssociations against an
// unknown (well-formed) configuration ARN yields an empty list rather than a
// not-found error, so observation reads it as "no association".
test.provider(
  "listAssociations with an unknown configuration ARN yields an empty list",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const listings = yield* chatbot.listAssociations
        .items({
          ChatConfiguration: `arn:aws:chatbot::${accountId}:chat-configuration/slack-channel/alchemy-probe-nonexistent`,
        })
        .pipe(Stream.runCollect, Effect.timeout("45 seconds"));
      expect(Array.from(listings)).toEqual([]);
    }),
  { timeout: 60_000 },
);

// Validates the distilled chatbot patch: associateToConfiguration against an
// unknown configuration ARN is rejected with the wire
// ResourceNotFoundException ("Channel Arn ... does not exist!") rather than
// creating a dangling association.
test.provider(
  "associateToConfiguration with an unknown configuration ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const error = yield* Effect.flip(
        chatbot.associateToConfiguration({
          ChatConfiguration: `arn:aws:chatbot::${accountId}:chat-configuration/slack-channel/alchemy-probe-nonexistent`,
          Resource: `arn:aws:chatbot::${accountId}:custom-action/alchemy-probe-nonexistent`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 30_000 },
);

// ---------------------------------------------------------------------------
// Gated live lifecycle — requires AWS_TEST_CHATBOT=1 plus an account whose
// Slack workspace has been onboarded via the console OAuth flow, with the
// workspace identifiers supplied via env vars.
// ---------------------------------------------------------------------------

class AssociationMismatch extends Data.TaggedError("AssociationMismatch")<{
  readonly configuration: string;
  readonly expected: readonly string[];
}> {}

const listAssociatedResources = (configuration: string) =>
  chatbot.listAssociations.items({ ChatConfiguration: configuration }).pipe(
    Stream.runCollect,
    Effect.map((listings) =>
      Array.from(listings).map((listing) => listing.Resource),
    ),
    Effect.catchTag("InvalidRequestException", () =>
      Effect.succeed([] as string[]),
    ),
  );

// Bounded wait until the configuration's association list equals `expected`.
const assertAssociations = (
  configuration: string,
  expected: readonly string[],
) =>
  listAssociatedResources(configuration).pipe(
    Effect.flatMap((resources) =>
      JSON.stringify([...resources].sort()) ===
      JSON.stringify([...expected].sort())
        ? Effect.void
        : Effect.fail(new AssociationMismatch({ configuration, expected })),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "AssociationMismatch",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

const chatbotAssumeRolePolicy: AWS.IAM.PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "chatbot.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider.skipIf(
  !process.env.AWS_TEST_CHATBOT ||
    !process.env.AWS_CHATBOT_SLACK_TEAM_ID ||
    !process.env.AWS_CHATBOT_SLACK_CHANNEL_ID,
)(
  "create, replace (re-point to a second action), delete association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const slackTeamId = process.env.AWS_CHATBOT_SLACK_TEAM_ID!;
      const slackChannelId = process.env.AWS_CHATBOT_SLACK_CHANNEL_ID!;

      // Both custom actions stay deployed across the replacement step — a
      // deploy that replaces a resource while simultaneously removing its old
      // dependency deadlocks the engine.
      const deploy = (target: "a" | "b") =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* Role("AssocChatbotRole", {
              assumeRolePolicyDocument: chatbotAssumeRolePolicy,
              managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
            });
            const config = yield* SlackChannelConfiguration("AssocConfig", {
              slackTeamId,
              slackChannelId,
              iamRoleArn: role.roleArn,
            });
            const actionA = yield* CustomAction("AssocActionA", {
              commandText: "aws lambda list-functions",
            });
            const actionB = yield* CustomAction("AssocActionB", {
              commandText: "aws s3 ls",
            });
            const association = yield* Association("Assoc", {
              chatConfiguration: config.chatConfigurationArn,
              resource:
                target === "a"
                  ? actionA.customActionArn
                  : actionB.customActionArn,
            });
            return { config, actionA, actionB, association };
          }),
        );

      const first = yield* deploy("a");
      expect(first.association.chatConfigurationArn).toBe(
        first.config.chatConfigurationArn,
      );
      expect(first.association.resourceArn).toBe(first.actionA.customActionArn);

      // out-of-band verification via distilled
      yield* assertAssociations(first.config.chatConfigurationArn, [
        first.actionA.customActionArn,
      ]);

      // re-pointing the association to a different resource is a replacement:
      // the new pair is associated and the old one disassociated
      const second = yield* deploy("b");
      expect(second.association.resourceArn).toBe(
        second.actionB.customActionArn,
      );
      yield* assertAssociations(second.config.chatConfigurationArn, [
        second.actionB.customActionArn,
      ]);

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
