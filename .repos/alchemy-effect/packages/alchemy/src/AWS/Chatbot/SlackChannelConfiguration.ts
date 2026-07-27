import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { fromChatbotTags, toChatbotTags } from "./internal.ts";

export interface SlackChannelConfigurationProps {
  /**
   * Name of the configuration (1-128 characters, `A-Za-z0-9-_`). Forms the
   * trailing segment of the chat configuration ARN.
   *
   * Changing the name replaces the configuration.
   * @default ${app}-${stage}-${id}
   */
  configurationName?: string;
  /**
   * ID of the Slack workspace (team) authorized with AWS Chatbot, e.g.
   * `T012ABCDEFG`. The workspace must first be onboarded via the AWS Chatbot
   * console OAuth flow — this cannot be automated.
   *
   * Changing the workspace replaces the configuration.
   */
  slackTeamId: string;
  /**
   * ID of the Slack channel, e.g. `C012AB3CD`. In Slack, copy it from the
   * channel details or the channel URL.
   */
  slackChannelId: string;
  /**
   * Name of the Slack channel. Informational only.
   */
  slackChannelName?: string;
  /**
   * ARN of the IAM role that defines the permissions for running commands
   * from this channel (the channel role). Must trust
   * `chatbot.amazonaws.com`.
   */
  iamRoleArn: string;
  /**
   * ARNs of the SNS topics that deliver notifications to this channel.
   */
  snsTopicArns?: string[];
  /**
   * Logging level for the configuration: `ERROR`, `INFO`, or `NONE`.
   * @default NONE
   */
  loggingLevel?: "ERROR" | "INFO" | "NONE";
  /**
   * ARNs of the IAM managed policies applied as channel guardrails. The AWS
   * managed `AdministratorAccess` policy is applied by default if this is
   * not set.
   */
  guardrailPolicyArns?: string[];
  /**
   * Whether channel members must have their AWS user identities authorized
   * before running commands.
   * @default false
   */
  userAuthorizationRequired?: boolean;
  /**
   * Tags to apply to the configuration. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface SlackChannelConfiguration extends Resource<
  "AWS.Chatbot.SlackChannelConfiguration",
  SlackChannelConfigurationProps,
  {
    /**
     * Name of the channel configuration.
     */
    configurationName: string;
    /**
     * The ARN of the channel configuration.
     */
    chatConfigurationArn: string;
    /**
     * The Slack workspace (team) ID.
     */
    slackTeamId: string;
    /**
     * The Slack channel ID.
     */
    slackChannelId: string;
    /**
     * Name of the Slack workspace.
     */
    slackTeamName: string;
    /**
     * Current state of the configuration (e.g. `ENABLED`).
     */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Chatbot (Amazon Q Developer in chat applications) Slack channel
 * configuration that delivers SNS notifications to a Slack channel and lets
 * channel members run read-only or scoped AWS commands.
 *
 * The Slack workspace must be onboarded to AWS Chatbot beforehand via the
 * console OAuth flow (Chatbot console -> Configure new client -> Slack) —
 * workspace authorization cannot be automated.
 *
 * @resource
 * @section Creating Slack Channel Configurations
 * @example Notify a Slack channel from an SNS topic
 * ```typescript
 * import * as Chatbot from "alchemy/AWS/Chatbot";
 * import { Role } from "alchemy/AWS/IAM/Role";
 * import * as SNS from "alchemy/AWS/SNS";
 *
 * const topic = yield* SNS.Topic("Alerts", {});
 * const role = yield* Role("ChatbotRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "chatbot.amazonaws.com" },
 *         Action: ["sts:AssumeRole"],
 *       },
 *     ],
 *   },
 *   managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
 * });
 *
 * const config = yield* Chatbot.SlackChannelConfiguration("Alerts", {
 *   slackTeamId: "T012ABCDEFG",
 *   slackChannelId: "C012AB3CD",
 *   iamRoleArn: role.roleArn,
 *   snsTopicArns: [topic.topicArn],
 *   loggingLevel: "ERROR",
 * });
 * ```
 */
export const SlackChannelConfiguration = Resource<SlackChannelConfiguration>(
  "AWS.Chatbot.SlackChannelConfiguration",
);

export const SlackChannelConfigurationProvider = () =>
  Provider.effect(
    SlackChannelConfiguration,
    Effect.gen(function* () {
      const createConfigurationName = Effect.fn(function* (
        id: string,
        props: Pick<SlackChannelConfigurationProps, "configurationName">,
      ) {
        return (
          props.configurationName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const configurationArn = Effect.fn(function* (configurationName: string) {
        const { accountId } = yield* AWSEnvironment.current;
        // Chatbot chat-configuration ARNs are global (no region component).
        return `arn:aws:chatbot::${accountId}:chat-configuration/slack-channel/${configurationName}`;
      });

      // describeSlackChannelConfigurations is a filter — an unknown ARN
      // yields an empty list rather than a not-found error.
      const observeConfiguration = (arn: string) =>
        chatbot
          .describeSlackChannelConfigurations({ ChatConfigurationArn: arn })
          .pipe(Effect.map((r) => r.SlackChannelConfigurations?.[0]));

      const observedTags = (arn: string) =>
        chatbot.listTagsForResource({ ResourceARN: arn }).pipe(
          Effect.map((r) => fromChatbotTags(r.Tags)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttributes = (
        configurationName: string,
        live: chatbot.SlackChannelConfiguration,
      ) => ({
        configurationName,
        chatConfigurationArn: live.ChatConfigurationArn,
        slackTeamId: live.SlackTeamId,
        slackChannelId: live.SlackChannelId,
        slackTeamName: live.SlackTeamName,
        state: live.State,
      });

      return SlackChannelConfiguration.Provider.of({
        stables: ["configurationName", "chatConfigurationArn", "slackTeamId"],
        list: () =>
          Effect.gen(function* () {
            const configurations =
              yield* chatbot.describeSlackChannelConfigurations
                .items({})
                .pipe(Stream.runCollect);
            return Array.from(configurations).map((config) => {
              const arn = config.ChatConfigurationArn;
              return toAttributes(arn.slice(arn.lastIndexOf("/") + 1), config);
            });
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const configurationName =
            output?.configurationName ??
            (yield* createConfigurationName(id, olds ?? {}));
          const arn =
            output?.chatConfigurationArn ??
            (yield* configurationArn(configurationName));
          const found = yield* observeConfiguration(arn);
          if (found === undefined) return undefined;
          const attrs = toAttributes(configurationName, found);
          const tags = yield* observedTags(found.ChatConfigurationArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createConfigurationName(id, olds ?? {});
          const newName = yield* createConfigurationName(id, news ?? {});
          if (oldName !== newName || olds?.slackTeamId !== news.slackTeamId) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const configurationName =
            output?.configurationName ??
            (yield* createConfigurationName(id, news));
          const arn =
            output?.chatConfigurationArn ??
            (yield* configurationArn(configurationName));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredTopics = [...(news.snsTopicArns ?? [])].sort();
          const desiredGuardrails = news.guardrailPolicyArns
            ? [...news.guardrailPolicyArns].sort()
            : undefined;

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observeConfiguration(arn);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    the typed ConflictException, which we treat as a race and
          //    re-observe.
          if (live === undefined) {
            live = yield* chatbot
              .createSlackChannelConfiguration({
                SlackTeamId: news.slackTeamId,
                SlackChannelId: news.slackChannelId,
                SlackChannelName: news.slackChannelName,
                ConfigurationName: configurationName,
                IamRoleArn: news.iamRoleArn,
                SnsTopicArns: news.snsTopicArns,
                LoggingLevel: news.loggingLevel,
                GuardrailPolicyArns: news.guardrailPolicyArns,
                UserAuthorizationRequired: news.userAuthorizationRequired,
                Tags: toChatbotTags(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.ChannelConfiguration),
                Effect.catchTag("ConflictException", () =>
                  observeConfiguration(arn),
                ),
              );
          }

          // 3. SYNC — diff the OBSERVED mutable aspects against the desired
          //    state; update only on drift.
          const inSync =
            live !== undefined &&
            live.SlackChannelId === news.slackChannelId &&
            live.IamRoleArn === news.iamRoleArn &&
            JSON.stringify([...live.SnsTopicArns].sort()) ===
              JSON.stringify(desiredTopics) &&
            (live.LoggingLevel ?? "NONE") === (news.loggingLevel ?? "NONE") &&
            JSON.stringify(
              live.GuardrailPolicyArns
                ? [...live.GuardrailPolicyArns].sort()
                : undefined,
            ) === JSON.stringify(desiredGuardrails) &&
            (live.UserAuthorizationRequired ?? false) ===
              (news.userAuthorizationRequired ?? false);
          if (!inSync) {
            live = yield* chatbot
              .updateSlackChannelConfiguration({
                ChatConfigurationArn: arn,
                SlackChannelId: news.slackChannelId,
                SlackChannelName: news.slackChannelName,
                IamRoleArn: news.iamRoleArn,
                SnsTopicArns: news.snsTopicArns,
                LoggingLevel: news.loggingLevel,
                GuardrailPolicyArns: news.guardrailPolicyArns,
                UserAuthorizationRequired: news.userAuthorizationRequired,
              })
              .pipe(Effect.map((r) => r.ChannelConfiguration));
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (create-time Tags only apply on first create).
          const currentTags = yield* observedTags(arn);
          const { upsert, removed } = diffTags(currentTags, desiredTags);
          if (upsert.length > 0) {
            yield* chatbot.tagResource({
              ResourceARN: arn,
              Tags: upsert.map(({ Key, Value }) => ({
                TagKey: Key,
                TagValue: Value,
              })),
            });
          }
          if (removed.length > 0) {
            yield* chatbot.untagResource({
              ResourceARN: arn,
              TagKeys: removed,
            });
          }

          yield* session.note(configurationName);
          return live !== undefined
            ? toAttributes(configurationName, live)
            : {
                configurationName,
                chatConfigurationArn: arn,
                slackTeamId: news.slackTeamId,
                slackChannelId: news.slackChannelId,
                slackTeamName: "",
                state: undefined,
              };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* chatbot
            .deleteSlackChannelConfiguration({
              ChatConfigurationArn: output.chatConfigurationArn,
            })
            .pipe(
              // Idempotent delete — a missing configuration is not an error.
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
