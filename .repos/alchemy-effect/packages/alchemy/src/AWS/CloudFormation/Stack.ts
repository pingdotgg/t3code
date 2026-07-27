import * as cloudformation from "@distilled.cloud/aws/cloudformation";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { toWireMinutes } from "../../Util/Duration.ts";

/**
 * Bounded wait for a stack to leave an in-progress status. Explicitly-typed
 * pipeable helper — an inline `Effect.retry` in a provider lifecycle op leaks
 * `Retry.Return`'s conditional into declaration emit and widens the provider
 * layer to `unknown` R for every `AWS.providers()` consumer.
 */
const retryUntilStackSettled = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "StackNotSettled",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(120)]),
  });
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * Behaviour when stack creation fails.
 * - `ROLLBACK` (default) — roll the stack back and delete created resources.
 * - `DO_NOTHING` — leave created resources in place for inspection.
 * - `DELETE` — delete the stack and all created resources.
 */
export type OnFailure = "DO_NOTHING" | "ROLLBACK" | "DELETE";

export interface StackProps {
  /**
   * Name of the CloudFormation stack. Must be 1-128 characters, start with a
   * letter, and contain only letters, digits, and hyphens. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * stack.
   */
  stackName?: string;
  /**
   * The CloudFormation template as an inline JSON or YAML string. Mutually
   * exclusive with `templateURL`. Maximum 51,200 bytes — use `templateURL`
   * for larger templates.
   */
  templateBody?: string;
  /**
   * Location of a template stored in Amazon S3 (an `https://` URL to an S3
   * object). Mutually exclusive with `templateBody`.
   */
  templateURL?: string;
  /**
   * Input parameter values for the template, keyed by parameter name.
   */
  parameters?: Record<string, string>;
  /**
   * IAM capabilities the stack is allowed to acknowledge. Required when the
   * template creates IAM resources (`CAPABILITY_IAM` /
   * `CAPABILITY_NAMED_IAM`) or uses macros (`CAPABILITY_AUTO_EXPAND`).
   */
  capabilities?: Array<
    "CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM" | "CAPABILITY_AUTO_EXPAND"
  >;
  /**
   * ARN of an IAM role that CloudFormation assumes to create/update/delete
   * the stack's resources. Defaults to the credentials of the deploying
   * principal.
   */
  roleArn?: string;
  /**
   * SNS topic ARNs that receive stack event notifications.
   */
  notificationARNs?: string[];
  /**
   * Whether to disable rollback of the stack if creation fails.
   * @default false
   */
  disableRollback?: boolean;
  /**
   * Behaviour when stack creation fails. Applied only on create.
   * @default "ROLLBACK"
   */
  onFailure?: OnFailure;
  /**
   * Amount of time that can pass before the stack status becomes
   * `CREATE_FAILED` (e.g. `"30 minutes"` or `Duration.minutes(30)`; a bare
   * number is milliseconds). Converted to whole minutes on the wire.
   */
  timeout?: Duration.Input;
  /**
   * User-defined tags propagated to every resource in the stack.
   */
  tags?: Record<string, string>;
}

export interface Stack extends Resource<
  "AWS.CloudFormation.Stack",
  StackProps,
  {
    /**
     * Name of the stack.
     */
    stackName: string;
    /**
     * The unique stack ID (ARN).
     */
    stackId: string;
    /**
     * Current status of the stack (e.g. `CREATE_COMPLETE`, `UPDATE_COMPLETE`).
     */
    stackStatus: string;
    /** Template outputs keyed by output name. */
    outputs: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS CloudFormation stack — deploy an existing CloudFormation template
 * from Alchemy as an interop/escape hatch.
 *
 * Create and update are asynchronous: the provider submits the template and
 * then polls (bounded) until the stack reaches a terminal state, surfacing a
 * `CREATE_FAILED` / `ROLLBACK_COMPLETE` / `UPDATE_ROLLBACK_COMPLETE` status as
 * a typed error rather than hanging. An update whose template and parameters
 * are unchanged is a no-op (`No updates are to be performed`). Deletion waits
 * for `DELETE_COMPLETE`.
 * @resource
 * @section Deploying a Template
 * @example Inline Template (SNS Topic)
 * ```typescript
 * const stack = yield* CloudFormation.Stack("Notifications", {
 *   templateBody: JSON.stringify({
 *     Resources: {
 *       Topic: { Type: "AWS::SNS::Topic", Properties: { DisplayName: "alerts" } },
 *     },
 *     Outputs: { TopicArn: { Value: { Ref: "Topic" } } },
 *   }),
 * });
 * // stack.outputs.TopicArn -> "arn:aws:sns:us-west-2:...:Notifications-Topic-..."
 * ```
 *
 * @example Template with Parameters
 * ```typescript
 * const stack = yield* CloudFormation.Stack("Config", {
 *   templateBody: JSON.stringify({
 *     Parameters: { Value: { Type: "String" } },
 *     Resources: {
 *       Param: {
 *         Type: "AWS::SSM::Parameter",
 *         Properties: { Type: "String", Value: { Ref: "Value" } },
 *       },
 *     },
 *   }),
 *   parameters: { Value: "hello" },
 * });
 * ```
 *
 * @section IAM Templates
 * @example Acknowledging Capabilities
 * ```typescript
 * const stack = yield* CloudFormation.Stack("Roles", {
 *   templateBody: iamTemplateJson,
 *   capabilities: ["CAPABILITY_NAMED_IAM"],
 * });
 * ```
 */
export const Stack = Resource<Stack>("AWS.CloudFormation.Stack");

class StackNotSettled extends Data.TaggedError("StackNotSettled")<{
  readonly stackId: string;
  readonly status: string;
}> {}

class StackOperationFailed extends Data.TaggedError("StackOperationFailed")<{
  readonly stackName: string;
  readonly status: string;
  readonly reason: string | undefined;
}> {}

/** A stack in one of these statuses is mid-operation. */
const isInProgress = (status: string | undefined): boolean =>
  status?.endsWith("_IN_PROGRESS") ?? false;

/**
 * A ROLLBACK_COMPLETE / ROLLBACK_FAILED create leaves the stack in a
 * non-updatable "created but failed" state — it can only be deleted.
 */
const isFailedCreateRemnant = (status: string | undefined): boolean =>
  status === "ROLLBACK_COMPLETE" || status === "ROLLBACK_FAILED";

const isFailure = (status: string | undefined): boolean =>
  (status?.endsWith("_FAILED") ?? false) ||
  status === "ROLLBACK_COMPLETE" ||
  status === "UPDATE_ROLLBACK_COMPLETE";

const toParameters = (
  parameters: Record<string, string> | undefined,
): cloudformation.Parameter[] | undefined =>
  parameters === undefined
    ? undefined
    : Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({
        ParameterKey,
        ParameterValue,
      }));

const toWireTags = (tags: Record<string, string>): cloudformation.Tag[] =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

const toTagRecord = (
  tags: cloudformation.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toOutputs = (
  outputs: cloudformation.Output[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (outputs ?? []).flatMap((o) =>
      o.OutputKey !== undefined && o.OutputValue !== undefined
        ? [[o.OutputKey, o.OutputValue]]
        : [],
    ),
  );

export const StackProvider = () =>
  Provider.effect(
    Stack,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<StackProps>) =>
        props.stackName
          ? Effect.succeed(props.stackName)
          : createPhysicalName({ id, maxLength: 128 });

      /**
       * Describe a stack by name or id. A missing stack (typed
       * `StackNotFound`) or a fully-deleted stack reads as absent.
       */
      const describe = Effect.fn(function* (nameOrId: string) {
        const response = yield* cloudformation
          .describeStacks({ StackName: nameOrId })
          .pipe(
            Effect.map((r) => r.Stacks ?? []),
            Effect.catchTag("StackNotFound", () => Effect.succeed([])),
          );
        const stack = response[0];
        return stack === undefined || stack.StackStatus === "DELETE_COMPLETE"
          ? undefined
          : stack;
      });

      // Create/update run asynchronously; CloudFormation reports *_IN_PROGRESS
      // while converging. A small stack settles in ~1-2 minutes; budget
      // ~10 min (120 * 5s).
      const waitForSettled = Effect.fn(function* (
        stackId: string,
        stackName: string,
      ) {
        const stack = yield* describe(stackId).pipe(
          Effect.flatMap((s) =>
            s !== undefined && isInProgress(s.StackStatus)
              ? Effect.fail(
                  new StackNotSettled({
                    stackId,
                    status: s.StackStatus ?? "UNKNOWN",
                  }),
                )
              : Effect.succeed(s),
          ),
          retryUntilStackSettled,
        );
        if (stack !== undefined && isFailure(stack.StackStatus)) {
          return yield* Effect.fail(
            new StackOperationFailed({
              stackName,
              status: stack.StackStatus ?? "UNKNOWN",
              reason: stack.StackStatusReason,
            }),
          );
        }
        return stack;
      });

      // Deletion is asynchronous too — wait until the stack reports
      // DELETE_COMPLETE (or vanishes) so dependencies can be torn down after.
      const waitUntilGone = Effect.fn(function* (
        stackId: string,
        stackName: string,
      ) {
        yield* retryUntilStackSettled(
          describe(stackId).pipe(
            Effect.flatMap(
              (
                s,
              ): Effect.Effect<
                void,
                StackNotSettled | StackOperationFailed
              > => {
                if (s === undefined) return Effect.void;
                if (s.StackStatus === "DELETE_FAILED") {
                  return Effect.fail(
                    new StackOperationFailed({
                      stackName,
                      status: "DELETE_FAILED",
                      reason: s.StackStatusReason,
                    }),
                  );
                }
                return Effect.fail(
                  new StackNotSettled({
                    stackId,
                    status: s.StackStatus ?? "UNKNOWN",
                  }),
                );
              },
            ),
          ),
        );
      });

      const toAttrs = (stack: cloudformation.Stack) => ({
        stackName: stack.StackName!,
        stackId: stack.StackId!,
        stackStatus: stack.StackStatus!,
        outputs: toOutputs(stack.Outputs),
      });

      return {
        stables: ["stackName", "stackId"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const stack = yield* describe(
            output?.stackId ?? (yield* toName(id, olds ?? {})),
          );
          if (stack === undefined) return undefined;
          const attrs = toAttrs(stack);
          const tags = toTagRecord(stack.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.stackName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output is only an id
          // cache.
          let observed = yield* describe(output?.stackId ?? name);

          // A stack left in ROLLBACK_COMPLETE/ROLLBACK_FAILED by a failed
          // create can only be deleted; clear it before recreating.
          if (
            observed !== undefined &&
            isFailedCreateRemnant(observed.StackStatus)
          ) {
            yield* cloudformation.deleteStack({ StackName: observed.StackId! });
            yield* waitUntilGone(observed.StackId!, name);
            observed = undefined;
          }

          // 2. Ensure — create if missing, then wait for CREATE_COMPLETE.
          if (observed === undefined) {
            const created = yield* cloudformation.createStack({
              StackName: name,
              TemplateBody: news.templateBody,
              TemplateURL: news.templateURL,
              Parameters: toParameters(news.parameters),
              Capabilities: news.capabilities,
              RoleARN: news.roleArn,
              NotificationARNs: news.notificationARNs,
              DisableRollback: news.disableRollback,
              OnFailure: news.onFailure,
              TimeoutInMinutes: toWireMinutes(news.timeout),
              Tags: toWireTags(desiredTags),
            });
            const settled = yield* waitForSettled(created.StackId!, name);
            if (settled === undefined) {
              return yield* Effect.fail(
                new StackOperationFailed({
                  stackName: name,
                  status: "DELETE_COMPLETE",
                  reason: "Stack disappeared immediately after creation",
                }),
              );
            }
            yield* session.note(name);
            return toAttrs(settled);
          }

          // 3. Sync — submit the desired template/params/tags. An unchanged
          // template is a no-op (typed NoUpdateToPerform); skip the wait.
          const didUpdate = yield* cloudformation
            .updateStack({
              StackName: observed.StackId!,
              TemplateBody: news.templateBody,
              TemplateURL: news.templateURL,
              Parameters: toParameters(news.parameters),
              Capabilities: news.capabilities,
              RoleARN: news.roleArn,
              NotificationARNs: news.notificationARNs,
              DisableRollback: news.disableRollback,
              Tags: toWireTags(desiredTags),
            })
            .pipe(
              Effect.as(true),
              Effect.catchTag("NoUpdateToPerform", () => Effect.succeed(false)),
            );

          const final = didUpdate
            ? yield* waitForSettled(observed.StackId!, name)
            : observed;
          if (final === undefined) {
            return yield* Effect.fail(
              new StackOperationFailed({
                stackName: name,
                status: "DELETE_COMPLETE",
                reason: "Stack disappeared while updating",
              }),
            );
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* cloudformation.deleteStack({ StackName: output.stackId });
          yield* waitUntilGone(output.stackId, output.stackName);
        }),

        list: () =>
          cloudformation.describeStacks.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.Stacks ?? [])
                .flatMap((s) =>
                  s.StackName !== undefined &&
                  s.StackId !== undefined &&
                  s.StackStatus !== undefined &&
                  s.StackStatus !== "DELETE_COMPLETE"
                    ? [
                        {
                          stackName: s.StackName,
                          stackId: s.StackId,
                          stackStatus: s.StackStatus,
                          outputs: toOutputs(s.Outputs),
                        },
                      ]
                    : [],
                ),
            ),
            Effect.catchTag("StackNotFound", () => Effect.succeed([])),
          ),
      };
    }),
  );
