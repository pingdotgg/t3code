import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface PermissionProps {
  /**
   * Event bus name. Defaults to the account default bus.
   */
  eventBusName?: string;
  /**
   * The action that EventBridge allows for the principal.
   * @default "events:PutEvents"
   */
  action?: string;
  /**
   * The AWS account ID, organization ID, or `*` principal receiving access.
   */
  principal: string;
  /**
   * Optional statement identifier. If omitted, Alchemy generates one.
   */
  statementId?: string;
  /**
   * Optional condition limiting the allowed caller.
   */
  condition?: eventbridge.Condition;
}

/**
 * An EventBridge event bus permission statement.
 *
 * `Permission` manages a single `PutPermission` / `RemovePermission` lifecycle
 * entry on an event bus so helper surfaces can safely grant publishers access
 * without requiring callers to hand-write raw bus policies.
 *
 * @section Granting Access
 * @example Allow Another Account To Publish
 * ```typescript
 * const permission = yield* Permission("PartnerPublish", {
 *   eventBusName: bus.eventBusName,
 *   principal: "123456789012",
 * });
 * ```
 */
export interface Permission extends Resource<
  "AWS.EventBridge.Permission",
  PermissionProps,
  {
    statementId: string;
    eventBusName: string;
  },
  never,
  Providers
> {}

export const Permission = Resource<Permission>("AWS.EventBridge.Permission");

export const PermissionProvider = () =>
  Provider.effect(
    Permission,
    Effect.gen(function* () {
      const toStatementId = (id: string, props: PermissionProps) =>
        props.statementId
          ? Effect.succeed(props.statementId)
          : createPhysicalName({
              id,
              maxLength: 64,
            });

      return {
        stables: ["statementId", "eventBusName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldStatementId = yield* toStatementId(id, olds);
          const newStatementId = yield* toStatementId(id, news);

          if (oldStatementId !== newStatementId) {
            return { action: "replace" } as const;
          }

          if (
            (olds.eventBusName ?? "default") !==
            (news.eventBusName ?? "default")
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const statementId =
            output?.statementId ?? (yield* toStatementId(id, news));
          const eventBusName =
            output?.eventBusName ?? news.eventBusName ?? "default";
          const eventBusParam =
            eventBusName !== "default" ? eventBusName : undefined;

          // Observe + Ensure for an existence-only resource: there is no
          // server-side `describePermission` for a single statement, so we
          // remove-then-put unconditionally. `removePermission` tolerates
          // missing statements; `putPermission` is idempotent on identical
          // params and overwrites on different ones — this is the official
          // recommended update path.
          yield* eventbridge
            .removePermission({
              EventBusName: eventBusParam,
              StatementId: statementId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );

          yield* eventbridge.putPermission({
            EventBusName: eventBusParam,
            Action: news.action ?? "events:PutEvents",
            Principal: news.principal,
            StatementId: statementId,
            Condition: news.condition,
          });

          yield* session.note(`EventBridge permission ${statementId}`);

          return {
            statementId,
            eventBusName,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* eventbridge
            .removePermission({
              EventBusName:
                output.eventBusName !== "default"
                  ? output.eventBusName
                  : undefined,
              StatementId: output.statementId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
