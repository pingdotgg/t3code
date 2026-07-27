import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RotationRules } from "./RotationSchedule.ts";
import type { Secret } from "./Secret.ts";

/** A step of the Secrets Manager rotation protocol. */
export type RotationStep =
  | "createSecret"
  | "setSecret"
  | "testSecret"
  | "finishSecret";

/**
 * The payload Secrets Manager sends the rotation function on each step of a
 * rotation.
 */
export interface SecretRotationEvent {
  /** Which step of the rotation protocol to perform. */
  Step: RotationStep;
  /** ARN of the secret being rotated. */
  SecretId: string;
  /**
   * Request token that becomes the `VersionId` of the new secret version —
   * pass it as `ClientRequestToken` to `PutSecretValue` and as
   * `MoveToVersionId` to `UpdateSecretVersionStage`.
   */
  ClientRequestToken: string;
}

export interface RotationEventSourceProps {
  /**
   * When the rotation runs. Provide `scheduleExpression` or
   * `automaticallyAfter`.
   */
  rotationRules?: RotationRules;
  /**
   * Rotate the secret immediately at deploy time. If `false`, Secrets
   * Manager only validates the configuration by invoking the `testSecret`
   * step.
   * @default false
   */
  rotateImmediately?: boolean;
}

export type RotationEventSourceService = <Req = never>(
  secret: Secret,
  props: RotationEventSourceProps,
  process: (event: SecretRotationEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Register the current Lambda function as the rotation function for a
 * Secrets Manager {@link Secret}.
 *
 * @param secret The secret to rotate.
 * @param props Optional rotation schedule configuration.
 * @param process The handler invoked once per rotation step (last argument).
 *
 * @example
 * ```typescript
 * yield* SecretsManager.onSecretRotation(secret, (event) =>
 *   Effect.gen(function* () {
 *     switch (event.Step) {
 *       case "createSecret": // stage a new AWSPENDING value
 *       case "setSecret":    // apply it to the downstream system
 *       case "testSecret":   // verify the new credential works
 *       case "finishSecret": // move AWSCURRENT onto the new version
 *     }
 *   }).pipe(Effect.orDie),
 * );
 * ```
 *
 * @example With a rotation schedule
 * ```typescript
 * yield* SecretsManager.onSecretRotation(
 *   secret,
 *   { rotationRules: { automaticallyAfter: "30 days" } },
 *   handleRotation,
 * );
 * ```
 */
export function onSecretRotation<S extends Secret, Req = never>(
  secret: S,
  process: (event: SecretRotationEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, RotationEventSource>;
export function onSecretRotation<S extends Secret, Req = never>(
  secret: S,
  props: RotationEventSourceProps,
  process: (event: SecretRotationEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, RotationEventSource>;
export function onSecretRotation<S extends Secret, Req = never>(
  secret: S,
  propsOrProcess:
    | RotationEventSourceProps
    | ((event: SecretRotationEvent) => Effect.Effect<void, never, Req>),
  maybeProcess?: (
    event: SecretRotationEvent,
  ) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, RotationEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as RotationEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return RotationEventSource.use((source) => source(secret, props, process));
}

/**
 * Event source connecting a Secrets Manager {@link Secret}'s rotation to the
 * hosting Lambda function.
 *
 * The contract is a `Binding.Service`; the Lambda implementation layer is
 * `Lambda.SecretRotationEventSource` — at deploy time it grants Secrets
 * Manager permission to invoke the function, attaches the rotation-protocol
 * IAM actions for the secret, and provisions the
 * {@link RotationSchedule}; at runtime it narrows incoming invocations to
 * rotation events for the bound secret. Consume it through the
 * {@link onSecretRotation} helper.
 * @binding
 * @section Rotating Secrets
 * @example Rotation Function in a Lambda
 * ```typescript
 * export default RotationFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const secret = yield* SecretsManager.Secret("DbPassword", {
 *       secretString: Redacted.make("initial"),
 *     });
 *     const getValue = yield* SecretsManager.GetSecretValue(secret);
 *     const putValue = yield* SecretsManager.PutSecretValue(secret);
 *     const updateStage = yield* SecretsManager.UpdateSecretVersionStage(secret);
 *     const describe = yield* SecretsManager.DescribeSecret(secret);
 *     const randomPassword = yield* SecretsManager.GetRandomPassword();
 *
 *     yield* SecretsManager.onSecretRotation(
 *       secret,
 *       { rotationRules: { automaticallyAfter: "30 days" } },
 *       (event) => rotate(event).pipe(Effect.orDie),
 *     );
 *   }).pipe(Effect.provide(Lambda.SecretRotationEventSource)),
 * );
 * ```
 */
export interface RotationEventSource extends Binding.Service<
  RotationEventSource,
  "AWS.SecretsManager.RotationEventSource",
  RotationEventSourceService
> {}

export const RotationEventSource = Binding.Service<RotationEventSource>(
  "AWS.SecretsManager.RotationEventSource",
);
