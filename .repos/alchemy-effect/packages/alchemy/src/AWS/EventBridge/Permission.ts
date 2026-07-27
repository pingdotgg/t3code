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
 * @resource
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
    /** The statement ID identifying the permission on the bus policy. */
    statementId: string;
    /** The name of the event bus the permission is attached to. */
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

      type PermissionAttrs = { statementId: string; eventBusName: string };

      return {
        stables: ["statementId", "eventBusName"],
        list: () =>
          Effect.gen(function* () {
            // EventBridge has no list-permissions API. A Permission is a
            // single statement inside an event bus resource policy, so we
            // enumerate every bus in the ambient account/region (manual
            // NextToken pagination — listEventBuses is not a paginated
            // distilled op), describe each bus to read its Policy JSON, and
            // emit one Attributes per statement Sid.
            const busNames: string[] = [];
            let nextToken: string | undefined;
            do {
              const page = yield* eventbridge.listEventBuses({
                NextToken: nextToken,
              });
              for (const bus of page.EventBuses ?? []) {
                if (bus.Name) busNames.push(bus.Name);
              }
              nextToken = page.NextToken;
            } while (nextToken);

            const perBus = yield* Effect.forEach(
              busNames,
              (busName) =>
                Effect.gen(function* () {
                  const res = yield* eventbridge.describeEventBus({
                    Name: busName,
                  });
                  if (!res.Policy) return [] as PermissionAttrs[];
                  const policy = yield* Effect.try({
                    try: () =>
                      JSON.parse(res.Policy!) as {
                        Statement?: { Sid?: string } | { Sid?: string }[];
                      },
                    catch: (cause) => new Error("invalid policy", { cause }),
                  }).pipe(
                    // A malformed/non-JSON policy yields no permissions
                    // rather than failing the whole enumeration.
                    Effect.orElseSucceed(() => ({
                      Statement: [] as { Sid?: string }[],
                    })),
                  );
                  const statements = Array.isArray(policy.Statement)
                    ? policy.Statement
                    : policy.Statement
                      ? [policy.Statement]
                      : [];
                  return statements
                    .filter(
                      (s): s is { Sid: string } => typeof s.Sid === "string",
                    )
                    .map(
                      (s): PermissionAttrs => ({
                        statementId: s.Sid,
                        eventBusName: busName,
                      }),
                    );
                }).pipe(
                  // Bus removed out of band between list and describe — skip.
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed([] as PermissionAttrs[]),
                  ),
                ),
              { concurrency: 10 },
            );
            return perBus.flat();
          }),
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
