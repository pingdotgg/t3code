import * as iot from "@distilled.cloud/aws/iot";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { readIotTags, sanitizeRuleName, syncIotTags } from "./internal.ts";

export type Action = iot.Action;

export interface TopicRuleProps {
  /**
   * Name of the rule. Rule names may only contain letters, numbers, and
   * underscores (`[a-zA-Z0-9_]`). If omitted, a unique name is generated.
   * Changing it replaces the rule.
   */
  ruleName?: string;

  /**
   * The SQL statement used to query the topic, e.g.
   * `SELECT * FROM 'my/topic'`.
   */
  sql: string;

  /**
   * The actions associated with the rule (Lambda, SQS, SNS, republish, ...).
   */
  actions: Action[];

  /**
   * A textual description of the rule.
   */
  description?: string;

  /**
   * Whether the rule is disabled.
   * @default false
   */
  ruleDisabled?: boolean;

  /**
   * The version of the SQL rules engine to use (`2015-10-08` or `2016-03-23`).
   * @default "2016-03-23"
   */
  awsIotSqlVersion?: string;

  /**
   * The action to take when an error occurs.
   */
  errorAction?: Action;

  /**
   * User tags to attach to the rule.
   */
  tags?: Record<string, string>;
}

export interface TopicRule extends Resource<
  "AWS.IoT.TopicRule",
  TopicRuleProps,
  {
    /** The name of the rule. */
    ruleName: string;
    /** The ARN of the rule. */
    ruleArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS IoT topic rule — evaluates an SQL statement against messages
 * published to MQTT topics and routes matching messages to one or more
 * actions (invoke a Lambda, enqueue to SQS, republish, etc.).
 *
 * @resource
 * @section Creating a Rule
 * @example Route Messages to a Lambda
 * ```typescript
 * const rule = yield* TopicRule("ingest", {
 *   sql: "SELECT * FROM 'sensors/+/telemetry'",
 *   actions: [{ lambda: { functionArn: yield* fn.functionArn } }],
 * });
 * ```
 */
export const TopicRule = Resource<TopicRule>("AWS.IoT.TopicRule");

export const TopicRuleProvider = () =>
  Provider.effect(
    TopicRule,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: TopicRuleProps,
      ) {
        return (
          props.ruleName ??
          sanitizeRuleName(
            yield* createPhysicalName({ id, delimiter: "_", maxLength: 128 }),
          )
        );
      });

      const ruleArnOf = (accountId: string, region: string, ruleName: string) =>
        `arn:aws:iot:${region}:${accountId}:rule/${ruleName}`;

      const buildPayload = (props: TopicRuleProps): iot.TopicRulePayload => ({
        sql: props.sql,
        description: props.description,
        actions: props.actions,
        ruleDisabled: props.ruleDisabled,
        awsIotSqlVersion: props.awsIotSqlVersion ?? "2016-03-23",
        errorAction: props.errorAction,
      });

      return TopicRule.Provider.of({
        stables: ["ruleName", "ruleArn"],
        list: () =>
          iot.listTopicRules.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.rules ?? [])
                  .filter((r) => r.ruleName != null && r.ruleArn != null)
                  .map((r) => ({
                    ruleName: r.ruleName!,
                    ruleArn: r.ruleArn!,
                  })),
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const ruleName =
            output?.ruleName ?? (yield* createName(id, olds ?? {}));
          const found = yield* iot
            .getTopicRule({ ruleName })
            .pipe(
              Effect.catchTag("TopicRuleNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found) return undefined;
          const ruleArn =
            found.ruleArn ?? ruleArnOf(accountId, region, ruleName);
          const attrs = { ruleName, ruleArn };
          const tags = yield* readIotTags(ruleArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const ruleName = output?.ruleName ?? (yield* createName(id, news));
          const ruleArn = ruleArnOf(accountId, region, ruleName);
          const payload = buildPayload(news);

          // OBSERVE
          const live = yield* iot
            .getTopicRule({ ruleName })
            .pipe(
              Effect.catchTag("TopicRuleNotFound", () =>
                Effect.succeed(undefined),
              ),
            );

          // ENSURE / SYNC — createTopicRule for a new rule, replaceTopicRule
          // (a full upsert of the payload) for an existing one.
          if (live === undefined) {
            yield* iot
              .createTopicRule({ ruleName, topicRulePayload: payload })
              .pipe(
                Effect.catchTag("ResourceAlreadyExistsException", () =>
                  iot.replaceTopicRule({ ruleName, topicRulePayload: payload }),
                ),
              );
          } else {
            yield* iot.replaceTopicRule({
              ruleName,
              topicRulePayload: payload,
            });
          }

          // SYNC tags
          yield* syncIotTags(ruleArn, id, news.tags);

          yield* session.note(ruleName);
          return { ruleName, ruleArn };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* iot
            .deleteTopicRule({ ruleName: output.ruleName })
            .pipe(Effect.catchTag("TopicRuleNotFound", () => Effect.void));
        }),
      });
    }),
  );
