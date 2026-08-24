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

/**
 * A criteria block controlling when a custom action button is shown on a
 * notification.
 */
export interface CustomActionAttachmentCriteria {
  /**
   * The operation to perform on the named variable: `HAS_VALUE` or `EQUALS`.
   */
  operator: "HAS_VALUE" | "EQUALS" | (string & {});
  /**
   * The name of the notification variable to operate on.
   */
  variableName: string;
  /**
   * The value to compare the variable against when the operator is `EQUALS`.
   */
  value?: string;
}

/**
 * Defines when and how a custom action surfaces as a button on chat
 * notifications.
 */
export interface CustomActionAttachment {
  /**
   * The type of notification the action button appears on, e.g.
   * `CloudWatch`. Although the AWS API documentation marks this optional,
   * the live API rejects attachments without it (`Invalid request body`).
   */
  notificationType: string;
  /**
   * The label of the button that appears on the notification.
   */
  buttonText?: string;
  /**
   * Conditions (over notification variables) that must be met for the button
   * to appear.
   */
  criteria?: CustomActionAttachmentCriteria[];
  /**
   * Variable values bound into the action's command text.
   */
  variables?: Record<string, string>;
}

export interface CustomActionProps {
  /**
   * Name of the custom action (1-64 characters, `A-Za-z0-9-_`). Forms the
   * trailing segment of the custom action ARN.
   *
   * Changing the name replaces the custom action.
   * @default ${app}-${stage}-${id}
   */
  actionName?: string;
  /**
   * The CLI command text executed when the action is invoked, e.g.
   * `aws lambda list-functions`. Variables from attachments may be
   * interpolated with `$variable` syntax.
   */
  commandText: string;
  /**
   * An alias that lets chat users invoke the action as `@aws run <alias>`.
   */
  aliasName?: string;
  /**
   * Notification attachments that surface the action as a button on
   * matching notifications.
   */
  attachments?: CustomActionAttachment[];
  /**
   * Tags to apply to the custom action. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface CustomAction extends Resource<
  "AWS.Chatbot.CustomAction",
  CustomActionProps,
  {
    /**
     * Name of the custom action.
     */
    actionName: string;
    /**
     * The ARN of the custom action.
     */
    customActionArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Chatbot (Amazon Q Developer in chat applications) custom action —
 * a reusable CLI command that chat users invoke by alias or as a button on
 * notifications.
 *
 * Custom actions exist at the account level and do not require a chat
 * workspace to be onboarded, though they only become usable once a Slack or
 * Microsoft Teams channel configuration exists.
 *
 * @resource
 * @section Creating Custom Actions
 * @example List Lambda functions from chat
 * ```typescript
 * import * as Chatbot from "alchemy/AWS/Chatbot";
 *
 * const action = yield* Chatbot.CustomAction("ListFunctions", {
 *   commandText: "aws lambda list-functions",
 *   aliasName: "list-functions",
 * });
 * ```
 *
 * @example Button on CloudWatch alarm notifications
 * ```typescript
 * const action = yield* Chatbot.CustomAction("DescribeAlarm", {
 *   commandText: "aws cloudwatch describe-alarms --alarm-names $AlarmName",
 *   attachments: [
 *     {
 *       notificationType: "CloudWatch",
 *       buttonText: "Describe alarm",
 *       criteria: [
 *         { operator: "HAS_VALUE", variableName: "AlarmName" },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export const CustomAction = Resource<CustomAction>("AWS.Chatbot.CustomAction");

const toWireAttachment = (
  attachment: CustomActionAttachment,
): chatbot.CustomActionAttachment => ({
  NotificationType: attachment.notificationType,
  ButtonText: attachment.buttonText,
  Criteria: attachment.criteria?.map((c) => ({
    Operator: c.operator,
    VariableName: c.variableName,
    Value: c.value,
  })),
  Variables: attachment.variables,
});

export const CustomActionProvider = () =>
  Provider.effect(
    CustomAction,
    Effect.gen(function* () {
      const createActionName = Effect.fn(function* (
        id: string,
        props: Pick<CustomActionProps, "actionName">,
      ) {
        // Custom action names are limited to 64 characters of [A-Za-z0-9-_].
        return (
          props.actionName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const actionArn = Effect.fn(function* (actionName: string) {
        const { accountId } = yield* AWSEnvironment.current;
        // Chatbot custom action ARNs are global (no region component).
        return `arn:aws:chatbot::${accountId}:custom-action/${actionName}`;
      });

      const observeAction = (arn: string) =>
        chatbot.getCustomAction({ CustomActionArn: arn }).pipe(
          Effect.map((r) => r.CustomAction),
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

      return CustomAction.Provider.of({
        stables: ["actionName", "customActionArn"],
        list: () =>
          Effect.gen(function* () {
            const arns = yield* chatbot.listCustomActions
              .items({})
              .pipe(Stream.runCollect);
            return Array.from(arns).map((arn) => ({
              actionName: arn.slice(arn.lastIndexOf("/") + 1),
              customActionArn: arn,
            }));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const actionName =
            output?.actionName ?? (yield* createActionName(id, olds ?? {}));
          const arn = output?.customActionArn ?? (yield* actionArn(actionName));
          const found = yield* observeAction(arn);
          if (found === undefined) return undefined;
          const attrs = { actionName, customActionArn: found.CustomActionArn };
          const tags = yield* observedTags(found.CustomActionArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createActionName(id, olds ?? {});
          const newName = yield* createActionName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: engine default update logic for mutable fields
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const actionName =
            output?.actionName ?? (yield* createActionName(id, news));
          const arn = output?.customActionArn ?? (yield* actionArn(actionName));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredDefinition = { CommandText: news.commandText };
          const desiredAttachments = news.attachments?.map(toWireAttachment);

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observeAction(arn);

          // 2. ENSURE — create when missing; a concurrent create surfaces as
          //    the typed ConflictException, which we treat as a race and
          //    re-observe.
          if (live === undefined) {
            live = yield* chatbot
              .createCustomAction({
                ActionName: actionName,
                Definition: desiredDefinition,
                AliasName: news.aliasName,
                Attachments: desiredAttachments,
                Tags: toChatbotTags(desiredTags),
              })
              .pipe(
                Effect.map((r) => r.CustomActionArn),
                Effect.catchTag("ConflictException", () => Effect.succeed(arn)),
                Effect.flatMap(observeAction),
              );
          }

          // 3. SYNC — diff the OBSERVED definition, alias, and attachments
          //    against the desired state; update only on drift.
          const inSync =
            live !== undefined &&
            live.Definition.CommandText === news.commandText &&
            live.AliasName === news.aliasName &&
            JSON.stringify(live.Attachments ?? []) ===
              JSON.stringify(desiredAttachments ?? []);
          if (!inSync) {
            yield* chatbot.updateCustomAction({
              CustomActionArn: arn,
              Definition: desiredDefinition,
              AliasName: news.aliasName,
              Attachments: desiredAttachments,
            });
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

          yield* session.note(actionName);
          return { actionName, customActionArn: arn };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* chatbot
            .deleteCustomAction({ CustomActionArn: output.customActionArn })
            .pipe(
              // Idempotent delete — a missing action is not an error.
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
