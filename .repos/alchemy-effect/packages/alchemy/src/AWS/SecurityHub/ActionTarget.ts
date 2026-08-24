import * as securityhub from "@distilled.cloud/aws/securityhub";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ActionTargetProps {
  /**
   * Display name of the custom action (shown in the Security Hub console's
   * action menu, max 20 characters). Updatable in place.
   */
  name: string;

  /**
   * Description of the custom action. Updatable in place.
   */
  description: string;

  /**
   * ID of the custom action (alphanumeric, max 20 characters). It becomes the
   * final segment of the action target ARN. If omitted, a unique id is
   * generated. Changing this replaces the action target.
   */
  id?: string;
}

/** @resource */
export interface ActionTarget extends Resource<
  "AWS.SecurityHub.ActionTarget",
  ActionTargetProps,
  {
    /** ARN of the action target (`…:action/custom/{id}`). */
    actionTargetArn: string;
    /** ID of the custom action (final ARN segment). */
    id: string;
    /** Display name of the custom action. */
    name: string;
    /** Description of the custom action. */
    description: string;
  },
  never,
  Providers
> {}

/**
 * A Security Hub custom action target. Selecting the custom action on
 * findings or insights in the console publishes a
 * `Security Hub Findings - Custom Action` event to EventBridge, which a
 * Function can consume via {@link consumeCustomActions}.
 *
 * @section Creating a Custom Action
 * @example Send Findings to a Triage Function
 * ```typescript
 * const action = yield* AWS.SecurityHub.ActionTarget("Escalate", {
 *   name: "Escalate",
 *   description: "Escalate the selected findings to on-call",
 * });
 * ```
 *
 * @example Consume Custom Action Events
 * ```typescript
 * yield* AWS.SecurityHub.consumeCustomActions(
 *   { actionArns: [action.actionTargetArn] },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(event.detail.findings),
 *     ),
 * );
 * ```
 */
const ActionTargetResource = Resource<ActionTarget>(
  "AWS.SecurityHub.ActionTarget",
);

export { ActionTargetResource as ActionTarget };

const actionTargetArn = (region: string, accountId: string, id: string) =>
  `arn:aws:securityhub:${region}:${accountId}:action/custom/${id}`;

export const ActionTargetProvider = () =>
  Provider.effect(
    ActionTargetResource,
    Effect.gen(function* () {
      // Custom action ids are strictly alphanumeric, max 20 characters —
      // strip the physical name's delimiters and keep its trailing (random,
      // instance-stable) suffix for uniqueness.
      const toId = (id: string, props: { id?: string }) =>
        props.id
          ? Effect.succeed(props.id)
          : createPhysicalName({ id, maxLength: 64 }).pipe(
              Effect.map((name) =>
                name.replace(/[^a-zA-Z0-9]/g, "").slice(-20),
              ),
            );

      const getActionTarget = (arn: string) =>
        securityhub.describeActionTargets({ ActionTargetArns: [arn] }).pipe(
          Effect.map((r) => r.ActionTargets?.[0]),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
          // The whole hub may be disabled — the action target is gone too.
          Effect.catchTag("InvalidAccessException", () =>
            Effect.succeed(undefined),
          ),
        );

      const buildAttrs = (arn: string, t: securityhub.ActionTarget) => ({
        actionTargetArn: arn,
        id: arn.split("/").at(-1)!,
        name: t.Name ?? "",
        description: t.Description ?? "",
      });

      return {
        stables: ["actionTargetArn", "id"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          if ((yield* toId(id, olds)) !== (yield* toId(id, news))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const actionId = output?.id ?? (yield* toId(id, olds ?? {}));
          const { accountId, region } = yield* AWSEnvironment.current;
          const arn = actionTargetArn(region, accountId, actionId);
          const live = yield* getActionTarget(arn);
          if (!live) return undefined;
          // Action targets cannot be tagged; the id embeds the app/stage
          // physical-name hash, so a match is ours.
          return buildAttrs(arn, live);
        }),
        list: () =>
          Effect.gen(function* () {
            const pages = yield* securityhub.describeActionTargets
              .pages({})
              .pipe(Stream.runCollect);
            const out: ActionTarget["Attributes"][] = [];
            for (const page of pages) {
              for (const t of page.ActionTargets ?? []) {
                if (t.ActionTargetArn) {
                  out.push(buildAttrs(t.ActionTargetArn, t));
                }
              }
            }
            return out;
          }).pipe(
            // No hub — no action targets.
            Effect.catchTag("InvalidAccessException", () =>
              Effect.succeed([] as ActionTarget["Attributes"][]),
            ),
          ),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const actionId = output?.id ?? (yield* toId(id, news));
          const { accountId, region } = yield* AWSEnvironment.current;
          const arn = actionTargetArn(region, accountId, actionId);

          // 1. OBSERVE — cloud state is authoritative.
          const live = yield* getActionTarget(arn);

          if (!live) {
            // 2. ENSURE — tolerate the create race.
            yield* securityhub
              .createActionTarget({
                Name: news.name,
                Description: news.description,
                Id: actionId,
              })
              .pipe(
                Effect.catchTag("ResourceConflictException", () => Effect.void),
              );
          } else if (
            live.Name !== news.name ||
            live.Description !== news.description
          ) {
            // 3. SYNC — observed ↔ desired.
            yield* securityhub.updateActionTarget({
              ActionTargetArn: arn,
              Name: news.name,
              Description: news.description,
            });
          }

          // 4. RETURN fresh attributes.
          const final = yield* getActionTarget(arn);
          yield* session.note(arn);
          return buildAttrs(
            arn,
            final ?? { Name: news.name, Description: news.description },
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the action target (or the whole hub) may be gone.
          yield* securityhub
            .deleteActionTarget({ ActionTargetArn: output.actionTargetArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.catchTag("InvalidAccessException", () => Effect.void),
            );
        }),
      };
    }),
  );
