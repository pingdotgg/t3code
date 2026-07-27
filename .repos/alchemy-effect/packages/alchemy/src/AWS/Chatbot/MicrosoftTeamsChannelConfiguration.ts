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

export interface MicrosoftTeamsChannelConfigurationProps {
  /**
   * Name of the configuration (1-128 characters, `A-Za-z0-9-_`). Forms the
   * trailing segment of the chat configuration ARN.
   *
   * Changing the name replaces the configuration.
   * @default ${app}-${stage}-${id}
   */
  configurationName?: string;
  /**
   * ID of the Microsoft Teams team authorized with AWS Chatbot. The team
   * must first be onboarded via the AWS Chatbot console OAuth flow — this
   * cannot be automated.
   *
   * Changing the team replaces the configuration.
   */
  teamId: string;
  /**
   * ID of the Microsoft Teams tenant.
   *
   * Changing the tenant replaces the configuration.
   */
  tenantId: string;
  /**
   * ID of the Microsoft Teams channel.
   */
  teamsChannelId: string;
  /**
   * Name of the Microsoft Teams channel. Informational only.
   */
  teamsChannelName?: string;
  /**
   * Name of the Microsoft Teams team. Informational only.
   */
  teamName?: string;
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

export interface MicrosoftTeamsChannelConfiguration extends Resource<
  "AWS.Chatbot.MicrosoftTeamsChannelConfiguration",
  MicrosoftTeamsChannelConfigurationProps,
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
     * The Microsoft Teams team ID.
     */
    teamId: string;
    /**
     * The Microsoft Entra (Azure AD) tenant ID.
     */
    tenantId: string;
    /**
     * The Microsoft Teams channel ID.
     */
    teamsChannelId: string;
    /**
     * Current state of the configuration (e.g. `ENABLED`).
     */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS Chatbot (Amazon Q Developer in chat applications) Microsoft Teams
 * channel configuration that delivers SNS notifications to a Teams channel
 * and lets channel members run read-only or scoped AWS commands.
 *
 * The Microsoft Teams team must be onboarded to AWS Chatbot beforehand via
 * the console OAuth flow (Chatbot console -> Configure new client ->
 * Microsoft Teams) — team authorization cannot be automated.
 *
 * @resource
 * @section Creating Microsoft Teams Channel Configurations
 * @example Notify a Teams channel from an SNS topic
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
 * const config = yield* Chatbot.MicrosoftTeamsChannelConfiguration("Alerts", {
 *   teamId: "0a1b2c3d-4e5f-1a2b-3c4d-0a1b2c3d4e5f",
 *   tenantId: "1a2b3c4d-5e6f-1a2b-3c4d-1a2b3c4d5e6f",
 *   teamsChannelId: "19%3ab6ef35dc342d56ba5654e6fc6d25a071%40thread.tacv2",
 *   iamRoleArn: role.roleArn,
 *   snsTopicArns: [topic.topicArn],
 * });
 * ```
 */
export const MicrosoftTeamsChannelConfiguration =
  Resource<MicrosoftTeamsChannelConfiguration>(
    "AWS.Chatbot.MicrosoftTeamsChannelConfiguration",
  );

export const MicrosoftTeamsChannelConfigurationProvider = () =>
  Provider.effect(
    MicrosoftTeamsChannelConfiguration,
    Effect.gen(function* () {
      const createConfigurationName = Effect.fn(function* (
        id: string,
        props: Pick<
          MicrosoftTeamsChannelConfigurationProps,
          "configurationName"
        >,
      ) {
        return (
          props.configurationName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const configurationArn = Effect.fn(function* (configurationName: string) {
        const { accountId } = yield* AWSEnvironment.current;
        // Chatbot chat-configuration ARNs are global (no region component).
        return `arn:aws:chatbot::${accountId}:chat-configuration/microsoft-teams-channel/${configurationName}`;
      });

      const observeConfiguration = (arn: string) =>
        chatbot
          .getMicrosoftTeamsChannelConfiguration({ ChatConfigurationArn: arn })
          .pipe(
            Effect.map((r) => r.ChannelConfiguration),
            // Typed via the distilled chatbot patch — the wire error is a
            // ResourceNotFoundException outside the Smithy model's union.
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const observedTags = (arn: string) =>
        chatbot.listTagsForResource({ ResourceARN: arn }).pipe(
          Effect.map((r) => fromChatbotTags(r.Tags)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttributes = (
        configurationName: string,
        live: chatbot.TeamsChannelConfiguration,
      ) => ({
        configurationName,
        chatConfigurationArn: live.ChatConfigurationArn,
        teamId: live.TeamId,
        tenantId: live.TenantId,
        teamsChannelId: live.ChannelId,
        state: live.State,
      });

      return MicrosoftTeamsChannelConfiguration.Provider.of({
        stables: [
          "configurationName",
          "chatConfigurationArn",
          "teamId",
          "tenantId",
        ],
        list: () =>
          Effect.gen(function* () {
            const configurations =
              yield* chatbot.listMicrosoftTeamsChannelConfigurations
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
          if (
            oldName !== newName ||
            olds?.teamId !== news.teamId ||
            olds?.tenantId !== news.tenantId
          ) {
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
              .createMicrosoftTeamsChannelConfiguration({
                ChannelId: news.teamsChannelId,
                ChannelName: news.teamsChannelName,
                TeamId: news.teamId,
                TeamName: news.teamName,
                TenantId: news.tenantId,
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
            live.ChannelId === news.teamsChannelId &&
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
              .updateMicrosoftTeamsChannelConfiguration({
                ChatConfigurationArn: arn,
                ChannelId: news.teamsChannelId,
                ChannelName: news.teamsChannelName,
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
                teamId: news.teamId,
                tenantId: news.tenantId,
                teamsChannelId: news.teamsChannelId,
                state: undefined,
              };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* chatbot
            .deleteMicrosoftTeamsChannelConfiguration({
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
