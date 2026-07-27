import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * Raised when a freshly created Chatbot association has not become visible
 * to `listAssociations` within the bounded eventual-consistency window.
 */
export class AssociationNotVisible extends Data.TaggedError(
  "AssociationNotVisible",
)<{
  readonly chatConfiguration: string;
  readonly resource: string;
}> {}

export interface AssociationProps {
  /**
   * ARN of the Slack or Microsoft Teams channel configuration to associate
   * the resource with (e.g.
   * `arn:aws:chatbot::123456789012:chat-configuration/slack-channel/alerts`).
   *
   * Changing the configuration replaces the association.
   */
  chatConfiguration: string;
  /**
   * ARN of the resource to associate with the channel configuration — a
   * Chatbot custom action ARN (e.g.
   * `arn:aws:chatbot::123456789012:custom-action/describe-alarm`).
   *
   * Changing the resource replaces the association.
   */
  resource: string;
}

export interface Association extends Resource<
  "AWS.Chatbot.Association",
  AssociationProps,
  {
    /**
     * ARN of the channel configuration the resource is associated with.
     */
    chatConfigurationArn: string;
    /**
     * ARN of the associated resource (the custom action).
     */
    resourceArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Chatbot (Amazon Q Developer in chat applications) association that
 * links a resource — a {@link CustomAction} — to a Slack or Microsoft Teams
 * channel configuration so the action is available in that channel.
 *
 * @resource
 * @section Associating Custom Actions
 * @example Attach a custom action to a Slack channel configuration
 * ```typescript
 * import * as Chatbot from "alchemy/AWS/Chatbot";
 *
 * const action = yield* Chatbot.CustomAction("DescribeAlarm", {
 *   commandText: "aws cloudwatch describe-alarms --alarm-names $AlarmName",
 * });
 *
 * const config = yield* Chatbot.SlackChannelConfiguration("Alerts", {
 *   slackTeamId: "T012ABCDEFG",
 *   slackChannelId: "C012AB3CD",
 *   iamRoleArn: role.roleArn,
 * });
 *
 * const association = yield* Chatbot.Association("AlarmAction", {
 *   chatConfiguration: config.chatConfigurationArn,
 *   resource: action.customActionArn,
 * });
 * ```
 */
export const Association = Resource<Association>("AWS.Chatbot.Association");

export const AssociationProvider = () =>
  Provider.effect(
    Association,
    Effect.gen(function* () {
      // listAssociations is a filter over a single configuration; an unknown
      // configuration ARN yields an empty list (verified live), while a
      // malformed ARN surfaces the typed InvalidRequestException — both are
      // treated as "no association".
      const observeAssociation = Effect.fn(function* (
        chatConfiguration: string,
        resource: string,
      ) {
        return yield* chatbot.listAssociations
          .items({ ChatConfiguration: chatConfiguration })
          .pipe(
            Stream.runCollect,
            Effect.map((listings) =>
              Array.from(listings).find(
                (listing) => listing.Resource === resource,
              ),
            ),
            Effect.catchTag("InvalidRequestException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttributes = (chatConfiguration: string, resource: string) => ({
        chatConfigurationArn: chatConfiguration,
        resourceArn: resource,
      });

      return Association.Provider.of({
        stables: ["chatConfigurationArn", "resourceArn"],
        // The configuration/resource ARN pair IS the association's identity —
        // changing either side replaces it. There is nothing to update.
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            olds !== undefined &&
            (olds.chatConfiguration !== news.chatConfiguration ||
              olds.resource !== news.resource)
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const chatConfiguration =
            output?.chatConfigurationArn ?? olds?.chatConfiguration;
          const resource = output?.resourceArn ?? olds?.resource;
          if (chatConfiguration === undefined || resource === undefined) {
            return undefined;
          }
          const found = yield* observeAssociation(chatConfiguration, resource);
          if (found === undefined) return undefined;
          // Associations cannot carry tags; existence of the exact
          // configuration/resource pair is the ownership signal.
          return toAttributes(chatConfiguration, resource);
        }),
        // Existence-only resource: observe → if missing, associate. There is
        // no mutable aspect to sync.
        reconcile: Effect.fn(function* ({ news, session }) {
          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* observeAssociation(
            news.chatConfiguration,
            news.resource,
          );

          // 2. ENSURE — associate when missing. The API is an idempotent
          //    upsert, so a concurrent associate converges naturally.
          if (observed === undefined) {
            yield* chatbot.associateToConfiguration({
              Resource: news.resource,
              ChatConfiguration: news.chatConfiguration,
            });

            // 3. RETURN — bounded wait until the association is visible.
            yield* observeAssociation(
              news.chatConfiguration,
              news.resource,
            ).pipe(
              Effect.flatMap((listing) =>
                listing !== undefined
                  ? Effect.void
                  : Effect.fail(
                      new AssociationNotVisible({
                        chatConfiguration: news.chatConfiguration,
                        resource: news.resource,
                      }),
                    ),
              ),
              Effect.retry({
                while: (e): boolean => e._tag === "AssociationNotVisible",
                schedule: Schedule.max([
                  Schedule.fixed("2 seconds"),
                  Schedule.recurs(8),
                ]),
              }),
            );
          }

          yield* session.note(news.resource);
          return toAttributes(news.chatConfiguration, news.resource);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Observe before delete — disassociating a pair that is already
          // gone (or whose configuration was deleted) is not an error.
          const observed = yield* observeAssociation(
            output.chatConfigurationArn,
            output.resourceArn,
          );
          if (observed === undefined) return;
          yield* chatbot
            .disassociateFromConfiguration({
              Resource: output.resourceArn,
              ChatConfiguration: output.chatConfigurationArn,
            })
            .pipe(
              // Idempotent delete — a concurrently removed association or
              // configuration is not an error. A configuration deleted out
              // from under the association surfaces the typed
              // ResourceNotFoundException ("Channel Arn ... does not
              // exist!", patched in distilled).
              Effect.catchTag(
                ["InvalidRequestException", "ResourceNotFoundException"],
                () => Effect.void,
              ),
            );
        }),
        list: () =>
          Effect.gen(function* () {
            const configurationArns: string[] = [];
            const slack = yield* chatbot.describeSlackChannelConfigurations
              .items({})
              .pipe(Stream.runCollect);
            for (const config of slack) {
              configurationArns.push(config.ChatConfigurationArn);
            }
            const teams = yield* chatbot.listMicrosoftTeamsChannelConfigurations
              .items({})
              .pipe(Stream.runCollect);
            for (const config of teams) {
              configurationArns.push(config.ChatConfigurationArn);
            }
            const results: {
              chatConfigurationArn: string;
              resourceArn: string;
            }[] = [];
            for (const arn of configurationArns) {
              const associations = yield* chatbot.listAssociations
                .items({ ChatConfiguration: arn })
                .pipe(Stream.runCollect);
              for (const association of associations) {
                results.push(toAttributes(arn, association.Resource));
              }
            }
            return results;
          }),
      });
    }),
  );
