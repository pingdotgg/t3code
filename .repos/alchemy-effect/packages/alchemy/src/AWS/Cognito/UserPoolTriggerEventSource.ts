import type * as lambda from "aws-lambda";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UserPool, UserPoolTriggerName } from "./UserPool.ts";

/**
 * The typed event each trigger slot receives (the Cognito
 * `version`/`triggerSource`/`request`/`response` envelope from
 * `aws-lambda`).
 */
export interface UserPoolTriggerEventMap {
  PreSignUp: lambda.PreSignUpTriggerEvent;
  PostConfirmation: lambda.PostConfirmationTriggerEvent;
  PreAuthentication: lambda.PreAuthenticationTriggerEvent;
  PostAuthentication: lambda.PostAuthenticationTriggerEvent;
  CustomMessage: lambda.CustomMessageTriggerEvent;
  DefineAuthChallenge: lambda.DefineAuthChallengeTriggerEvent;
  CreateAuthChallenge: lambda.CreateAuthChallengeTriggerEvent;
  VerifyAuthChallengeResponse: lambda.VerifyAuthChallengeResponseTriggerEvent;
  PreTokenGeneration: lambda.PreTokenGenerationTriggerEvent;
  UserMigration: lambda.UserMigrationTriggerEvent;
}

export type UserPoolTriggerEvent<T extends UserPoolTriggerName> =
  UserPoolTriggerEventMap[T];

/**
 * The `triggerSource` prefix Cognito stamps on invocations of each trigger
 * slot (e.g. `PreSignUp` fires with `PreSignUp_SignUp`,
 * `PreSignUp_AdminCreateUser`, …; `PreTokenGeneration` fires with
 * `TokenGeneration_*`). Used by the runtime dispatcher to route events to
 * the registered handler.
 */
export const userPoolTriggerSourcePrefixes: Record<
  UserPoolTriggerName,
  string
> = {
  PreSignUp: "PreSignUp_",
  PostConfirmation: "PostConfirmation_",
  PreAuthentication: "PreAuthentication_",
  PostAuthentication: "PostAuthentication_",
  CustomMessage: "CustomMessage_",
  DefineAuthChallenge: "DefineAuthChallenge_",
  CreateAuthChallenge: "CreateAuthChallenge_",
  VerifyAuthChallengeResponse: "VerifyAuthChallengeResponse_",
  PreTokenGeneration: "TokenGeneration_",
  UserMigration: "UserMigration_",
};

export interface UserPoolTriggerProps<
  T extends UserPoolTriggerName = UserPoolTriggerName,
> {
  /** The trigger slot to handle, e.g. `PreSignUp` or `CustomMessage`. */
  trigger: T;
}

/**
 * A user pool trigger handler receives the typed trigger event and returns
 * the (usually mutated) event, which becomes the Lambda's response back to
 * Cognito. Returning `void` responds with the event as-is.
 */
export type UserPoolTriggerHandler<
  T extends UserPoolTriggerName,
  Req = never,
> = (
  event: UserPoolTriggerEvent<T>,
) => Effect.Effect<UserPoolTriggerEvent<T> | void, never, Req>;

export type UserPoolTriggerEventSourceService = <
  T extends UserPoolTriggerName,
  Req = never,
>(
  userPool: UserPool,
  props: UserPoolTriggerProps<T>,
  handler: UserPoolTriggerHandler<T, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a Cognito {@link UserPool} Lambda trigger to the
 * hosting Lambda function.
 *
 * At deploy time the Lambda implementation
 * (`Lambda.UserPoolTriggerEventSource`) injects the function ARN into the
 * pool's `LambdaConfig` (via the pool's binding contract) and creates the
 * `lambda:InvokeFunction` Permission for `cognito-idp.amazonaws.com`; at
 * runtime it dispatches matching trigger events to the handler and returns
 * the handler's (mutated) event to Cognito.
 *
 * Use the {@link onUserPoolTrigger} helper (or the per-slot shorthands
 * {@link onPreSignUp}, {@link onPostConfirmation},
 * {@link onPreTokenGeneration}, {@link onCustomMessage}) rather than the
 * service directly, and provide `Lambda.UserPoolTriggerEventSource` on the
 * hosting function.
 * @binding
 * @section Handling User Pool Triggers
 * @example Auto-confirm Sign-ups from a Lambda Function
 * ```typescript
 * export default AuthFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const pool = yield* Cognito.UserPool("Users", {});
 *
 *     // deploy: wires PreSignUp in the pool's LambdaConfig + invoke Permission
 *     // runtime: dispatches PreSignUp_* events to this handler
 *     yield* Cognito.onPreSignUp(pool, (event) =>
 *       Effect.sync(() => Cognito.autoConfirmUser(event, { verifyEmail: true })),
 *     );
 *
 *     return {};
 *   }).pipe(Effect.provide(Lambda.UserPoolTriggerEventSource)),
 * );
 * ```
 */
export interface UserPoolTriggerEventSource extends Binding.Service<
  UserPoolTriggerEventSource,
  "AWS.Cognito.UserPoolTriggerEventSource",
  UserPoolTriggerEventSourceService
> {}

export const UserPoolTriggerEventSource =
  Binding.Service<UserPoolTriggerEventSource>(
    "AWS.Cognito.UserPoolTriggerEventSource",
  );

/**
 * Handle a Cognito user pool Lambda trigger with the current Lambda
 * function.
 *
 * Provide `Lambda.UserPoolTriggerEventSource` on the hosting function to
 * satisfy the requirement.
 *
 * @param userPool The user pool whose trigger to handle.
 * @param props The trigger slot to handle.
 * @param handler Invoked once per trigger event; the returned event is the
 * response Cognito receives.
 *
 * @example Auto-confirm every sign-up
 * ```typescript
 * yield* Cognito.onUserPoolTrigger(pool, { trigger: "PreSignUp" }, (event) =>
 *   Effect.sync(() => Cognito.autoConfirmUser(event, { verifyEmail: true })),
 * );
 * ```
 */
export function onUserPoolTrigger<T extends UserPoolTriggerName, Req = never>(
  userPool: UserPool,
  props: UserPoolTriggerProps<T>,
  handler: UserPoolTriggerHandler<T, Req>,
): Effect.Effect<void, never, UserPoolTriggerEventSource> {
  return UserPoolTriggerEventSource.use((source) =>
    source(userPool, props, handler),
  );
}

/**
 * Handle the `PreSignUp` trigger — runs before Cognito registers a new
 * user; the handler can auto-confirm the user (see
 * {@link autoConfirmUser}) or reject the sign-up.
 */
export const onPreSignUp = <Req = never>(
  userPool: UserPool,
  handler: UserPoolTriggerHandler<"PreSignUp", Req>,
) => onUserPoolTrigger(userPool, { trigger: "PreSignUp" }, handler);

/**
 * Handle the `PostConfirmation` trigger — runs after a user confirms their
 * account (welcome emails, provisioning rows, analytics).
 */
export const onPostConfirmation = <Req = never>(
  userPool: UserPool,
  handler: UserPoolTriggerHandler<"PostConfirmation", Req>,
) => onUserPoolTrigger(userPool, { trigger: "PostConfirmation" }, handler);

/**
 * Handle the `PreTokenGeneration` trigger — runs before Cognito issues
 * tokens; the handler can add, override, or suppress claims via
 * `event.response.claimsOverrideDetails`.
 */
export const onPreTokenGeneration = <Req = never>(
  userPool: UserPool,
  handler: UserPoolTriggerHandler<"PreTokenGeneration", Req>,
) => onUserPoolTrigger(userPool, { trigger: "PreTokenGeneration" }, handler);

/**
 * Handle the `CustomMessage` trigger — customizes the verification /
 * invitation messages Cognito sends by mutating
 * `event.response.emailSubject` / `emailMessage` / `smsMessage`.
 */
export const onCustomMessage = <Req = never>(
  userPool: UserPool,
  handler: UserPoolTriggerHandler<"CustomMessage", Req>,
) => onUserPoolTrigger(userPool, { trigger: "CustomMessage" }, handler);

/**
 * Mutate a `PreSignUp` trigger event's response to auto-confirm the user
 * (and optionally auto-verify their email / phone number), then return the
 * event so it can be handed straight back to Cognito.
 *
 * @example Sign-ups arrive CONFIRMED, no confirmation code required
 * ```typescript
 * yield* Cognito.onPreSignUp(pool, (event) =>
 *   Effect.sync(() => Cognito.autoConfirmUser(event, { verifyEmail: true })),
 * );
 * ```
 */
export const autoConfirmUser = <E extends lambda.PreSignUpTriggerEvent>(
  event: E,
  options?: {
    /** Also mark the user's email as verified. @default false */
    verifyEmail?: boolean;
    /** Also mark the user's phone number as verified. @default false */
    verifyPhone?: boolean;
  },
): E => {
  event.response.autoConfirmUser = true;
  if (options?.verifyEmail === true) {
    event.response.autoVerifyEmail = true;
  }
  if (options?.verifyPhone === true) {
    event.response.autoVerifyPhone = true;
  }
  return event;
};
