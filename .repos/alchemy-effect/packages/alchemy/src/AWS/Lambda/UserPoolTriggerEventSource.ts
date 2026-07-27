import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Namespace from "../../Namespace.ts";
import {
  UserPoolTriggerEventSource as CognitoUserPoolTriggerEventSource,
  type UserPoolTriggerEvent,
  type UserPoolTriggerEventSourceService,
  type UserPoolTriggerHandler,
  type UserPoolTriggerProps,
  userPoolTriggerSourcePrefixes,
} from "../Cognito/UserPoolTriggerEventSource.ts";
import type { UserPool, UserPoolTriggerName } from "../Cognito/UserPool.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

/**
 * The `version`/`triggerSource`/`userPoolId`/`request`/`response` envelope
 * shared by every user pool Lambda trigger. Declared structurally —
 * `@types/aws-lambda` keeps `BaseTriggerEvent` in an internal `_common`
 * module that its package root does not re-export.
 */
export interface UserPoolTriggerEnvelope {
  version: string;
  triggerSource: string;
  region: string;
  userPoolId: string;
  userName?: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

/**
 * A Cognito user pool trigger invocation — the
 * `version`/`triggerSource`/`userPoolId`/`request`/`response` envelope
 * shared by every user pool Lambda trigger.
 */
export const isUserPoolTriggerEvent = (
  event: any,
): event is UserPoolTriggerEnvelope =>
  typeof event?.version === "string" &&
  typeof event?.triggerSource === "string" &&
  typeof event?.userPoolId === "string" &&
  typeof event?.request === "object" &&
  event?.request !== null &&
  typeof event?.response === "object" &&
  event?.response !== null;

/**
 * Connects a Cognito user pool Lambda trigger to the current Lambda
 * function.
 *
 * At deploy time this layer injects the function ARN into the pool's
 * `LambdaConfig` through the pool's binding contract and materializes the
 * `lambda:InvokeFunction` Permission for `cognito-idp.amazonaws.com`; at
 * runtime it dispatches matching trigger events (matched on `userPoolId` +
 * `triggerSource` prefix) to the registered handler and returns the
 * handler's (mutated) event to Cognito.
 * @binding
 * @section Handling user pool triggers
 * @example Auto-confirm sign-ups
 * ```typescript
 * yield* Cognito.onPreSignUp(pool, (event) =>
 *   Effect.sync(() => Cognito.autoConfirmUser(event, { verifyEmail: true })),
 * );
 * ```
 */
export const UserPoolTriggerEventSource = Layer.effect(
  CognitoUserPoolTriggerEventSource,
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const host = yield* Lambda.Function;
    const Permission = yield* LambdaPermission;

    return Effect.fn(function* <T extends UserPoolTriggerName, Req = never>(
      userPool: UserPool,
      props: UserPoolTriggerProps<T>,
      handler: UserPoolTriggerHandler<T, Req>,
    ) {
      const UserPoolId = yield* userPool.userPoolId;

      // Deploy-time: inject this function's ARN into the pool's
      // LambdaConfig (the pool's provider syncs it) and create the invoke
      // Permission for cognito-idp. Skipped once running inside the
      // deployed Function (the global guard), where the only work is
      // registering the runtime dispatcher below. Namespaced under the
      // host for stable logical identity.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* userPool.bind`AWS.Cognito.UserPoolTrigger(${host}, ${userPool}, ${props.trigger})`(
              {
                lambdaConfig: { [props.trigger]: host.functionArn },
              },
            );

            yield* Permission(
              `${userPool.LogicalId}-${props.trigger}-Permission`,
              {
                action: "lambda:InvokeFunction",
                functionName: host.functionName,
                principal: "cognito-idp.amazonaws.com",
                sourceArn: userPool.userPoolArn,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const userPoolId = yield* UserPoolId;
          const prefix = userPoolTriggerSourcePrefixes[props.trigger];

          return (event: any) => {
            if (
              isUserPoolTriggerEvent(event) &&
              event.userPoolId === userPoolId &&
              event.triggerSource.startsWith(prefix)
            ) {
              // Cognito triggers are request-response: the Lambda's return
              // value (the event with a mutated `response`) IS the trigger
              // response. `void` from the handler answers with the event
              // as-is.
              return handler(event as UserPoolTriggerEvent<T>).pipe(
                Effect.map((result) => result ?? event),
                Effect.orDie,
              );
            }
          };
        }),
      );
    }) as UserPoolTriggerEventSourceService;
  }),
);
