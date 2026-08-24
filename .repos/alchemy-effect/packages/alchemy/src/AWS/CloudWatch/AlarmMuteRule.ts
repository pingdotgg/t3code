import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { createManagedTags, createName, retryConcurrent } from "./common.ts";

export type AlarmMuteRuleName = string;
export type AlarmMuteRuleArn =
  `arn:aws:cloudwatch:${RegionID}:${AccountID}:alarm-mute-rule:${string}`;

export interface AlarmMuteRuleProps extends Omit<
  cloudwatch.PutAlarmMuteRuleInput,
  "Name" | "Tags"
> {
  /**
   * Name of the mute rule. If omitted, a unique name is generated.
   */
  name?: AlarmMuteRuleName;
  /**
   * Optional tags to apply to the mute rule.
   */
  tags?: Record<string, string>;
}

export interface AlarmMuteRule extends Resource<
  "AWS.CloudWatch.AlarmMuteRule",
  AlarmMuteRuleProps,
  {
    /** Physical name of the mute rule. */
    alarmMuteRuleName: AlarmMuteRuleName;
    /** ARN of the mute rule. */
    alarmMuteRuleArn: AlarmMuteRuleArn;
    /** Current status of the mute rule. */
    status: string | undefined;
    /** The mute type of the rule. */
    muteType: string | undefined;
    /** The full mute rule description as last read from CloudWatch. */
    alarmMuteRule: cloudwatch.GetAlarmMuteRuleOutput;
    /** Tags on the mute rule, including the internal Alchemy ownership tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch alarm mute rule — suppresses alarm actions on a recurring
 * schedule (e.g. maintenance windows) instead of manually disabling and
 * re-enabling alarm actions.
 * @resource
 * @section Creating Mute Rules
 * @example Scheduled Mute
 * ```typescript
 * const rule = yield* AlarmMuteRule("NightlyMute", {
 *   Rule: {
 *     Schedule: {
 *       Expression: "0 2 * * SUN",
 *       Duration: "PT1H",
 *     },
 *   },
 * });
 * ```
 *
 * @section Reading Mute Rules at Runtime
 * @example Read the Mute Rule from a Function
 * ```typescript
 * // init — bind the rule to the function (see GetAlarmMuteRule)
 * const getAlarmMuteRule = yield* AWS.CloudWatch.GetAlarmMuteRule(rule);
 *
 * // runtime
 * const result = yield* getAlarmMuteRule();
 * const schedule = result.Rule?.Schedule;
 * ```
 */
export const AlarmMuteRule = Resource<AlarmMuteRule>(
  "AWS.CloudWatch.AlarmMuteRule",
);

export const AlarmMuteRuleProvider = () =>
  Provider.effect(
    AlarmMuteRule,
    Effect.gen(function* () {
      const createMuteRuleName = (id: string, props: { name?: string } = {}) =>
        createName(id, props.name, 255);

      const alarmMuteRuleArn = (name: string) =>
        AWSEnvironment.current.pipe(
          Effect.map(
            (env) =>
              `arn:aws:cloudwatch:${env.region}:${env.accountId}:alarm-mute-rule:${name}` as AlarmMuteRuleArn,
          ),
        );

      const readAlarmMuteRule = Effect.fn(function* (name: string) {
        const output = yield* cloudwatch
          .getAlarmMuteRule({
            AlarmMuteRuleName: name,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!output?.Name || !output.AlarmMuteRuleArn) {
          return undefined;
        }

        return {
          alarmMuteRuleName: output.Name,
          alarmMuteRuleArn: output.AlarmMuteRuleArn as AlarmMuteRuleArn,
          status: output.Status,
          muteType: output.MuteType,
          alarmMuteRule: output,
          tags: {},
        };
      });

      return {
        stables: ["alarmMuteRuleName", "alarmMuteRuleArn"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createMuteRuleName(id, olds);
          const newName = yield* createMuteRuleName(id, news);

          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.alarmMuteRuleName ??
            (yield* createMuteRuleName(id, olds ?? {}));
          return yield* readAlarmMuteRule(name);
        }),
        // AWS account/region collection: `listAlarmMuteRules` paginates every
        // mute rule in the region. The summary only carries the ARN, so we
        // derive the name from it and re-read each rule to return the full
        // `Attributes` shape (identical to `read`).
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* cloudwatch.listAlarmMuteRules
              .pages({})
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.AlarmMuteRuleSummaries ?? [],
                  ),
                ),
              );

            const rows = yield* Effect.forEach(
              summaries,
              (summary) => {
                const name =
                  summary.AlarmMuteRuleArn?.split(":alarm-mute-rule:")[1];
                if (!name) {
                  return Effect.succeed(undefined);
                }
                return readAlarmMuteRule(name);
              },
              { concurrency: 10 },
            );

            return rows.filter(
              (row): row is NonNullable<typeof row> => row !== undefined,
            );
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe — pin the physical name from `output` if we already
          // have one; otherwise derive it from desired props.
          const name =
            output?.alarmMuteRuleName ?? (yield* createMuteRuleName(id, news));

          // Ensure — `putAlarmMuteRule` is an upsert. The CloudWatch API
          // accepts `Tags` on every put, so we send the full managed tag
          // set every reconcile and let the API converge it.
          const tags = yield* createManagedTags(id, news.tags);

          yield* retryConcurrent(
            cloudwatch.putAlarmMuteRule({
              ...news,
              Name: name,
              Tags: Object.entries(tags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            }),
          );

          yield* session.note(yield* alarmMuteRuleArn(name));

          const state = yield* readAlarmMuteRule(name);
          if (!state) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled alarm mute rule '${name}'`),
            );
          }

          return {
            ...state,
            tags,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrent(
            cloudwatch.deleteAlarmMuteRule({
              AlarmMuteRuleName: output.alarmMuteRuleName,
            }),
          );
        }),
      };
    }),
  );
