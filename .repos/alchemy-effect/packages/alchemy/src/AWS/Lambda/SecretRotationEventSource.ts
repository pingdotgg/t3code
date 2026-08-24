import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Namespace from "../../Namespace.ts";
import { AWSEnvironment } from "../Environment.ts";
import {
  RotationEventSource as SecretsManagerRotationEventSource,
  type RotationEventSourceProps,
  type RotationEventSourceService,
  type SecretRotationEvent,
} from "../SecretsManager/RotationEventSource.ts";
import { RotationSchedule } from "../SecretsManager/RotationSchedule.ts";
import type { Secret } from "../SecretsManager/Secret.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

/**
 * Narrow an arbitrary Lambda invocation payload to a Secrets Manager
 * rotation event (`createSecret`/`setSecret`/`testSecret`/`finishSecret`).
 *
 * `ClientRequestToken` is deliberately NOT required: the validation
 * invocation Secrets Manager performs when a rotation schedule is
 * configured with `RotateImmediately: false` can arrive without one, and an
 * unmatched event fails the whole invocation ("No event handler found"),
 * which Secrets Manager records as a failed rotation attempt.
 */
export const isSecretRotationEvent = (
  event: any,
): event is SecretRotationEvent =>
  typeof event?.Step === "string" && typeof event?.SecretId === "string";

/**
 * Lambda runtime implementation for
 * `AWS.SecretsManager.onSecretRotation(...)`.
 *
 * This layer does three things at deploy time:
 *
 * 1. Grants `secretsmanager.amazonaws.com` permission to invoke the current
 *    function (scoped to this account via `aws:SourceAccount`).
 * 2. Attaches the rotation-protocol IAM actions for the bound secret
 *    (`DescribeSecret`, `GetSecretValue`, `PutSecretValue`,
 *    `UpdateSecretVersionStage` on the secret + `GetRandomPassword`).
 * 3. Provisions the {@link RotationSchedule} configuring the secret's
 *    rotation to invoke this function — threaded through the Permission so
 *    Secrets Manager's invoke-permission validation passes.
 *
 * At runtime it narrows incoming invocations to rotation events for the
 * bound secret and forwards them to the supplied handler.
 * @binding
 * @section Rotating Secrets
 * @example Handle Rotation Steps
 * ```typescript
 * yield* SecretsManager.onSecretRotation(
 *   secret,
 *   { rotationRules: { automaticallyAfter: "30 days" } },
 *   (event) => rotate(event).pipe(Effect.orDie),
 * );
 * ```
 */
export const SecretRotationEventSource = Layer.effect(
  SecretsManagerRotationEventSource,
  // The impl resolves plan-time services (Permission, RotationSchedule)
  // whereas RotationEventSourceService erases the requirement channel to
  // `never`.
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const host = yield* Lambda.Function;
    const Permission = yield* LambdaPermission;
    const Rotation = yield* RotationSchedule;

    return Effect.fn(function* <Req = never>(
      secret: Secret,
      props: RotationEventSourceProps,
      process: (event: SecretRotationEvent) => Effect.Effect<void, never, Req>,
    ) {
      // Resolving the ARN also registers it on the host environment;
      // re-yield per invocation inside the listener below.
      const SecretArn = yield* secret.secretArn;

      // Deploy-time: grant the invoke permission, the rotation-protocol IAM
      // actions, and provision the rotation schedule. Skipped once running
      // inside the deployed Function (the global guard), where the only work
      // is registering the runtime handler below. Namespaced under the host
      // so the sub-resources' logical identity is stable per host function.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* host.bind`Allow(${host}, AWS.SecretsManager.RotationEventSource(${secret}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: [
                      "secretsmanager:DescribeSecret",
                      "secretsmanager:GetSecretValue",
                      "secretsmanager:PutSecretValue",
                      "secretsmanager:UpdateSecretVersionStage",
                    ],
                    Resource: [secret.secretArn],
                  },
                  {
                    Effect: "Allow",
                    Action: ["secretsmanager:GetRandomPassword"],
                    Resource: ["*"],
                  },
                ],
              },
            );

            // Secrets Manager VALIDATES it can invoke the rotation function
            // when `RotateSecret` configures the schedule, so the Permission
            // must exist BEFORE the RotationSchedule. Rotation invocations
            // carry no SourceArn — scope by account per the Secrets Manager
            // confused-deputy guidance.
            const { accountId } =
              yield* AWSEnvironment.current as unknown as Effect.Effect<{
                accountId: string;
              }>;
            const permission = yield* Permission(
              `${secret.LogicalId}-Rotation-Permission`,
              {
                action: "lambda:InvokeFunction",
                functionName: host.functionArn,
                principal: "secretsmanager.amazonaws.com",
                sourceAccount: accountId,
              },
            );

            // The Permission echoes the `functionName` prop (the function
            // ARN) as an attribute — threading it as the rotation Lambda ARN
            // makes the schedule reconcile only AFTER the invoke permission
            // exists.
            yield* Rotation(`${secret.LogicalId}-RotationSchedule`, {
              secretId: secret.secretArn,
              rotationLambdaArn: permission.functionName,
              rotationRules: props.rotationRules,
              rotateImmediately: props.rotateImmediately,
            });
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const secretArn = yield* SecretArn;

          return (event: any) => {
            if (isSecretRotationEvent(event) && event.SecretId === secretArn) {
              return process(event).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as RotationEventSourceService;
  }),
);
