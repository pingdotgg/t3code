import * as AWS from "@/AWS";
import {
  MicrosoftTeamsChannelConfiguration,
  SlackChannelConfiguration,
} from "@/AWS/Chatbot";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as chatbot from "@distilled.cloud/aws/chatbot";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// ---------------------------------------------------------------------------
// Ungated probes — Slack/Teams channel configurations require a workspace
// onboarded via the AWS Chatbot console OAuth flow, which cannot be scripted.
// These probes prove the typed error semantics the providers depend on, in
// every CI pass, at near-zero cost.
// ---------------------------------------------------------------------------

// Workspace-onboarding gate: creating a configuration against a workspace
// that has not been authorized via the console OAuth flow is rejected with
// the synthetic SlackWorkspaceNotAuthorized tag (patched in
// distilled/packages/aws/patches/chatbot.json). A failed create still
// reserves the configuration name server-side (undeletable tombstone), so
// repeated runs of this probe surface the typed ConflictException instead —
// both tags prove the create is rejected without onboarding.
test.provider(
  "createSlackChannelConfiguration without an onboarded workspace fails with SlackWorkspaceNotAuthorized",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const error = yield* Effect.flip(
        chatbot.createSlackChannelConfiguration({
          SlackTeamId: "T0000000000",
          SlackChannelId: "C0000000000",
          ConfigurationName: "alchemy-chatbot-probe-slack",
          IamRoleArn: `arn:aws:iam::${accountId}:role/alchemy-nonexistent-role`,
        }),
      );
      expect(["SlackWorkspaceNotAuthorized", "ConflictException"]).toContain(
        error._tag,
      );
    }),
  { timeout: 30_000 },
);

// Team-onboarding gate: the Teams create fails at team validation (before
// any name reservation), so this probe is exactly repeatable.
test.provider(
  "createMicrosoftTeamsChannelConfiguration without a configured team fails with MicrosoftTeamsTeamNotConfigured",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const error = yield* Effect.flip(
        chatbot.createMicrosoftTeamsChannelConfiguration({
          ChannelId: "19%3aalchemyprobe%40thread.tacv2",
          TeamId: "0a1b2c3d-4e5f-1a2b-3c4d-0a1b2c3d4e5f",
          TenantId: "1a2b3c4d-5e6f-1a2b-3c4d-1a2b3c4d5e6f",
          ConfigurationName: "alchemy-chatbot-probe-teams",
          IamRoleArn: `arn:aws:iam::${accountId}:role/alchemy-nonexistent-role`,
        }),
      );
      expect(error._tag).toBe("MicrosoftTeamsTeamNotConfigured");
    }),
  { timeout: 30_000 },
);

// Validates the distilled chatbot patch: the wire ResourceNotFoundException
// is outside the Smithy model's union for this operation and is added via
// patches/chatbot.json. The Teams read endpoint occasionally has >30s tail
// latency under a full c128 sweep, so this probe gets a narrow 60s budget;
// the typed assertion is unchanged and no service error is masked.
test.provider(
  "getMicrosoftTeamsChannelConfiguration on a nonexistent configuration fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const error = yield* Effect.flip(
        chatbot.getMicrosoftTeamsChannelConfiguration({
          ChatConfigurationArn: `arn:aws:chatbot::${accountId}:chat-configuration/microsoft-teams-channel/alchemy-probe-nonexistent`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

// The Slack read path is a filter — an unknown ARN yields an empty list, not
// a not-found error.
test.provider(
  "describeSlackChannelConfigurations with an unknown ARN yields an empty list",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWS.AWSEnvironment.current;
      const result = yield* chatbot.describeSlackChannelConfigurations({
        ChatConfigurationArn: `arn:aws:chatbot::${accountId}:chat-configuration/slack-channel/alchemy-probe-nonexistent`,
      });
      expect(result.SlackChannelConfigurations).toEqual([]);
    }),
  { timeout: 30_000 },
);

// ---------------------------------------------------------------------------
// Gated live lifecycles — require AWS_TEST_CHATBOT=1 plus an account whose
// Slack workspace / Microsoft Teams team has been onboarded via the console
// OAuth flow, with the workspace identifiers supplied via env vars.
// ---------------------------------------------------------------------------

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

class ConfigurationStillExists extends Data.TaggedError(
  "ConfigurationStillExists",
)<{ readonly arn: string }> {}

const assertSlackConfigurationDeleted = (arn: string) =>
  chatbot
    .describeSlackChannelConfigurations({ ChatConfigurationArn: arn })
    .pipe(
      Effect.flatMap((r) =>
        (r.SlackChannelConfigurations ?? []).length === 0
          ? Effect.void
          : Effect.fail(new ConfigurationStillExists({ arn })),
      ),
      Effect.retry({
        while: (e) => e._tag === "ConfigurationStillExists",
        schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
      }),
    );

test.provider.skipIf(
  !process.env.AWS_TEST_CHATBOT ||
    !process.env.AWS_CHATBOT_SLACK_TEAM_ID ||
    !process.env.AWS_CHATBOT_SLACK_CHANNEL_ID,
)(
  "create, update, delete Slack channel configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const slackTeamId = process.env.AWS_CHATBOT_SLACK_TEAM_ID!;
      const slackChannelId = process.env.AWS_CHATBOT_SLACK_CHANNEL_ID!;

      const deploy = (loggingLevel: "ERROR" | "INFO") =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* Role("ChatbotSlackRole", {
              assumeRolePolicyDocument: chatbotAssumeRolePolicy,
              managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
            });
            const config = yield* SlackChannelConfiguration("Config", {
              slackTeamId,
              slackChannelId,
              iamRoleArn: role.roleArn,
              loggingLevel,
              tags: { Environment: "test" },
            });
            return { config };
          }),
        );

      const { config } = yield* deploy("ERROR");
      expect(config.chatConfigurationArn).toContain(
        ":chat-configuration/slack-channel/",
      );
      expect(config.slackTeamId).toBe(slackTeamId);
      expect(config.slackChannelId).toBe(slackChannelId);

      // out-of-band verification via distilled
      const observed = yield* chatbot
        .describeSlackChannelConfigurations({
          ChatConfigurationArn: config.chatConfigurationArn,
        })
        .pipe(Effect.map((r) => r.SlackChannelConfigurations?.[0]));
      expect(observed?.SlackChannelId).toBe(slackChannelId);
      expect(observed?.LoggingLevel).toBe("ERROR");

      // update the logging level in place
      const { config: updated } = yield* deploy("INFO");
      expect(updated.chatConfigurationArn).toBe(config.chatConfigurationArn);
      const afterUpdate = yield* chatbot
        .describeSlackChannelConfigurations({
          ChatConfigurationArn: config.chatConfigurationArn,
        })
        .pipe(Effect.map((r) => r.SlackChannelConfigurations?.[0]));
      expect(afterUpdate?.LoggingLevel).toBe("INFO");

      yield* stack.destroy();
      yield* assertSlackConfigurationDeleted(config.chatConfigurationArn);
    }),
  { timeout: 300_000 },
);

const findTeamsConfiguration = (arn: string) =>
  chatbot
    .getMicrosoftTeamsChannelConfiguration({ ChatConfigurationArn: arn })
    .pipe(
      Effect.map((r) => r.ChannelConfiguration),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const assertTeamsConfigurationDeleted = (arn: string) =>
  findTeamsConfiguration(arn).pipe(
    Effect.flatMap((config) =>
      config === undefined
        ? Effect.void
        : Effect.fail(new ConfigurationStillExists({ arn })),
    ),
    Effect.retry({
      while: (e) => e._tag === "ConfigurationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider.skipIf(
  !process.env.AWS_TEST_CHATBOT ||
    !process.env.AWS_CHATBOT_TEAMS_TEAM_ID ||
    !process.env.AWS_CHATBOT_TEAMS_TENANT_ID ||
    !process.env.AWS_CHATBOT_TEAMS_CHANNEL_ID,
)(
  "create, update, delete Microsoft Teams channel configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const teamId = process.env.AWS_CHATBOT_TEAMS_TEAM_ID!;
      const tenantId = process.env.AWS_CHATBOT_TEAMS_TENANT_ID!;
      const teamsChannelId = process.env.AWS_CHATBOT_TEAMS_CHANNEL_ID!;

      const deploy = (loggingLevel: "ERROR" | "INFO") =>
        stack.deploy(
          Effect.gen(function* () {
            const role = yield* Role("ChatbotTeamsRole", {
              assumeRolePolicyDocument: chatbotAssumeRolePolicy,
              managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
            });
            const config = yield* MicrosoftTeamsChannelConfiguration("Config", {
              teamId,
              tenantId,
              teamsChannelId,
              iamRoleArn: role.roleArn,
              loggingLevel,
              tags: { Environment: "test" },
            });
            return { config };
          }),
        );

      const { config } = yield* deploy("ERROR");
      expect(config.chatConfigurationArn).toContain(
        ":chat-configuration/microsoft-teams-channel/",
      );
      expect(config.teamId).toBe(teamId);
      expect(config.tenantId).toBe(tenantId);

      // out-of-band verification via distilled
      const observed = yield* findTeamsConfiguration(
        config.chatConfigurationArn,
      );
      expect(observed?.ChannelId).toBe(teamsChannelId);
      expect(observed?.LoggingLevel).toBe("ERROR");

      // update the logging level in place
      const { config: updated } = yield* deploy("INFO");
      expect(updated.chatConfigurationArn).toBe(config.chatConfigurationArn);
      const afterUpdate = yield* findTeamsConfiguration(
        config.chatConfigurationArn,
      );
      expect(afterUpdate?.LoggingLevel).toBe("INFO");

      yield* stack.destroy();
      yield* assertTeamsConfigurationDeleted(config.chatConfigurationArn);
    }),
  { timeout: 300_000 },
);
