import * as sfn from "@distilled.cloud/aws/sfn";
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

export interface ActivityProps {
  /**
   * Name of the activity (1-80 characters; letters, digits, dashes and
   * underscores). If omitted, a deterministic physical name is generated
   * from the app, stage, and logical ID. Changing the name triggers a
   * replacement.
   */
  activityName?: string;
  /**
   * Tags to apply to the activity. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Activity extends Resource<
  "AWS.StepFunctions.Activity",
  ActivityProps,
  {
    /**
     * Physical name of the activity.
     */
    activityName: string;
    /**
     * ARN of the activity — reference it from a state machine Task state's
     * `Resource` field.
     */
    activityArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Step Functions activity — a named endpoint that external workers
 * poll for tasks (`GetActivityTask`) and complete with the `SendTask*`
 * callback operations.
 *
 * Activities support worker-hosted task processing outside Lambda. For
 * most callback flows the `.waitForTaskToken` service-integration pattern
 * on a {@link StateMachine} Task state is preferred.
 * @resource
 * @section Creating Activities
 * @example Basic Activity
 * ```typescript
 * import * as StepFunctions from "alchemy/AWS/StepFunctions";
 *
 * const activity = yield* StepFunctions.Activity("ApprovalActivity");
 * ```
 *
 * @example Reference an Activity from a State Machine
 * ```typescript
 * const machine = yield* StepFunctions.StateMachine("ApprovalFlow", {
 *   definition: {
 *     StartAt: "WaitForWorker",
 *     States: {
 *       WaitForWorker: {
 *         Type: "Task",
 *         Resource: activity.activityArn,
 *         End: true,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @section Completing Tasks at Runtime
 * @example Send a task result scoped to the activity
 * ```typescript
 * // init
 * const sendTaskSuccess = yield* StepFunctions.SendTaskSuccess(activity);
 *
 * // runtime
 * yield* sendTaskSuccess({
 *   taskToken: token,
 *   output: JSON.stringify({ approved: true }),
 * });
 * ```
 */
export const Activity = Resource<Activity>("AWS.StepFunctions.Activity");

const toSfnTags = (tags: Record<string, string>): sfn.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const fromSfnTags = (
  tags: ReadonlyArray<sfn.Tag> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { key: string; value: string } =>
          typeof tag.key === "string" && typeof tag.value === "string",
      )
      .map((tag) => [tag.key, tag.value]),
  );

export const ActivityProvider = () =>
  Provider.effect(
    Activity,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<ActivityProps, "activityName">,
      ) {
        return (
          props.activityName ??
          (yield* createPhysicalName({ id, maxLength: 80 }))
        );
      });

      const activityArnOf = (region: string, accountId: string, name: string) =>
        `arn:aws:states:${region}:${accountId}:activity:${name}`;

      const describeOrUndefined = Effect.fn(function* (activityArn: string) {
        return yield* sfn
          .describeActivity({ activityArn })
          .pipe(
            Effect.catchTag("ActivityDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const fetchObservedTags = Effect.fn(function* (resourceArn: string) {
        return yield* sfn.listTagsForResource({ resourceArn }).pipe(
          Effect.map((r) => fromSfnTags(r.tags)),
          Effect.catchTag("ResourceNotFound", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );
      });

      return Activity.Provider.of({
        stables: ["activityName", "activityArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* sfn.listActivities
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.activities ?? [])
              .map((activity) => ({
                activityName: activity.name,
                activityArn: activity.activityArn,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.activityName ?? (yield* createName(id, olds ?? {}));
          const activityArn =
            output?.activityArn ?? activityArnOf(region, accountId, name);
          const found = yield* describeOrUndefined(activityArn);
          if (!found) return undefined;
          const attrs = {
            activityName: found.name,
            activityArn: found.activityArn,
          };
          const tags = yield* fetchObservedTags(activityArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // tags converge via update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          // `news` is undefined when the resource is declared without a
          // props argument (`Activity("id")`).
          const props = news ?? {};
          const name = output?.activityName ?? (yield* createName(id, props));
          const activityArn = activityArnOf(region, accountId, name);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...props.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* describeOrUndefined(activityArn);

          // 2. ENSURE — createActivity is idempotent for an identical
          //    configuration; ActivityAlreadyExists only fires when the
          //    existing activity differs (encryption config), in which case
          //    we keep the existing one (the ARN is deterministic).
          if (observed === undefined) {
            yield* sfn
              .createActivity({ name, tags: toSfnTags(desiredTags) })
              .pipe(
                Effect.catchTag("ActivityAlreadyExists", () => Effect.void),
              );
          }

          // 3. SYNC TAGS — against OBSERVED cloud tags (create-time tags
          //    only apply on first create; adoption may carry foreign tags).
          const observedTags = yield* fetchObservedTags(activityArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sfn.tagResource({
              resourceArn: activityArn,
              tags: upsert.map(({ Key, Value }) => ({
                key: Key,
                value: Value,
              })),
            });
          }
          if (removed.length > 0) {
            yield* sfn.untagResource({
              resourceArn: activityArn,
              tagKeys: removed,
            });
          }

          yield* session.note(activityArn);
          return { activityName: name, activityArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteActivity is idempotent — deleting a non-existent activity
          // succeeds.
          yield* sfn.deleteActivity({ activityArn: output.activityArn });
        }),
      });
    }),
  );
