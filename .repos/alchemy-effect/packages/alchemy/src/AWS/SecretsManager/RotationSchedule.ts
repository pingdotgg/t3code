import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toWireDays, toWireHours } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

export interface RotationRules {
  /**
   * Rotate automatically after this interval (e.g. `"30 days"`). Rounded to
   * whole days on the wire (`AutomaticallyAfterDays`).
   */
  automaticallyAfter?: Duration.Input;
  /**
   * Length of the rotation window (e.g. `"3 hours"`). Rounded to whole
   * hours on the wire (`Duration`, `"3h"`).
   */
  window?: Duration.Input;
  /**
   * A `rate()` or `cron()` schedule expression, e.g. `"rate(4 hours)"` or
   * `"cron(0 8 1 * ? *)"`. Mutually exclusive with `automaticallyAfter`.
   */
  scheduleExpression?: string;
}

/** Convert the typed {@link RotationRules} to the wire shape. */
export const toWireRotationRules = (
  rules: RotationRules | undefined,
): secretsmanager.RotationRulesType | undefined => {
  if (rules === undefined) {
    return undefined;
  }
  const hours = toWireHours(rules.window);
  return {
    AutomaticallyAfterDays: toWireDays(rules.automaticallyAfter),
    Duration: hours === undefined ? undefined : `${hours}h`,
    ScheduleExpression: rules.scheduleExpression,
  };
};

export interface RotationScheduleProps {
  /**
   * ARN (preferred) or name of the secret whose rotation is being
   * configured.
   */
  secretId: string;
  /**
   * ARN of the Lambda function that implements the rotation protocol
   * (`createSecret`/`setSecret`/`testSecret`/`finishSecret`).
   */
  rotationLambdaArn?: string;
  /**
   * When the rotation runs. Provide `scheduleExpression` or
   * `automaticallyAfter`.
   */
  rotationRules?: RotationRules;
  /**
   * Rotate the secret immediately when the schedule is created/updated. If
   * `false`, Secrets Manager only tests the rotation configuration by
   * running the `testSecret` step of the rotation function.
   * @default false
   */
  rotateImmediately?: boolean;
}

export interface RotationSchedule extends Resource<
  "AWS.SecretsManager.RotationSchedule",
  RotationScheduleProps,
  {
    /**
     * ARN of the secret the rotation is configured on.
     */
    secretArn: string;
    /**
     * Name of the secret.
     */
    secretName: string;
    /**
     * ARN of the rotation Lambda function.
     */
    rotationLambdaArn: string | undefined;
    /**
     * Whether automatic rotation is enabled on the secret.
     */
    rotationEnabled: boolean;
  },
  never,
  Providers
> {}

/**
 * Configures automatic rotation on a Secrets Manager secret
 * (`RotateSecret` with a rotation Lambda + rules; `CancelRotateSecret` on
 * delete).
 *
 * Usually created for you by {@link onSecretRotation}, which also wires the
 * invoke permission and the runtime handler — reach for the resource
 * directly only when the rotation function is managed outside the current
 * stack.
 * @resource
 * @section Scheduling Rotation
 * @example Rotate Every 30 Days
 * ```typescript
 * const schedule = yield* RotationSchedule("DbSecretRotation", {
 *   secretId: secret.secretArn,
 *   rotationLambdaArn: rotationFunctionArn,
 *   rotationRules: { automaticallyAfter: "30 days" },
 * });
 * ```
 *
 * @example Cron Schedule with a Rotation Window
 * ```typescript
 * const schedule = yield* RotationSchedule("DbSecretRotation", {
 *   secretId: secret.secretArn,
 *   rotationLambdaArn: rotationFunctionArn,
 *   rotationRules: {
 *     scheduleExpression: "cron(0 8 1 * ? *)",
 *     window: "3 hours",
 *   },
 * });
 * ```
 */
export const RotationSchedule = Resource<RotationSchedule>(
  "AWS.SecretsManager.RotationSchedule",
);

/**
 * Bounded retry while Secrets Manager can't yet invoke the rotation Lambda
 * (`InvalidRequestException` — the `lambda:InvokeFunction` permission for
 * principal `secretsmanager.amazonaws.com` propagates asynchronously right
 * after it is created).
 *
 * Explicitly-typed helper: inlining `Effect.retry` here leaves
 * `Retry.Return`'s conditional type unresolved in the provider's inferred
 * layer type, which declaration emit widens to an `unknown` R — poisoning
 * `AWS.providers()` for every consumer (same shape as in `Secret.ts`).
 */
const retryWhileInvokePermissionPropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidRequestException" &&
      ((e as { Message?: string }).Message?.includes("Lambda") ?? false),
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

export const RotationScheduleProvider = () =>
  Provider.effect(
    RotationSchedule,
    Effect.gen(function* () {
      const readRotation = Effect.fn(function* (secretId: string) {
        return yield* secretsmanager
          .describeSecret({ SecretId: secretId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return {
        stables: ["secretArn", "secretName"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          if (olds && olds.secretId !== news.secretId) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const secretId = output?.secretArn ?? olds?.secretId;
          if (secretId === undefined) {
            return undefined;
          }
          const described = yield* readRotation(secretId);
          if (
            !described?.ARN ||
            !described.Name ||
            !described.RotationEnabled
          ) {
            return undefined;
          }
          return {
            secretArn: described.ARN,
            secretName: described.Name,
            rotationLambdaArn: described.RotationLambdaARN,
            rotationEnabled: described.RotationEnabled === true,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const secretId = output?.secretArn ?? news.secretId;

          // Configure (or reconverge) rotation. `rotateSecret` is a true
          // upsert of the rotation configuration; with
          // `RotateImmediately: false` Secrets Manager only validates the
          // config by invoking the rotation function's `testSecret` step.
          // Right after the invoke permission is created Secrets Manager may
          // not see it yet — retry through that propagation window.
          const rotated = yield* retryWhileInvokePermissionPropagates(
            secretsmanager.rotateSecret({
              SecretId: secretId,
              RotationLambdaARN: news.rotationLambdaArn,
              RotationRules: toWireRotationRules(news.rotationRules),
              RotateImmediately: news.rotateImmediately ?? false,
            }),
          );

          const secretArn = rotated.ARN ?? secretId;
          const described = yield* readRotation(secretArn);
          yield* session.note(secretArn);
          return {
            secretArn: described?.ARN ?? secretArn,
            secretName: described?.Name ?? rotated.Name ?? secretId,
            rotationLambdaArn:
              described?.RotationLambdaARN ?? news.rotationLambdaArn,
            rotationEnabled: described?.RotationEnabled === true,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // `CancelRotateSecret` turns off automatic rotation (and cancels
          // any rotation in progress). Idempotent: missing secret or
          // rotation-not-configured are treated as already-deleted.
          yield* secretsmanager
            .cancelRotateSecret({ SecretId: output.secretArn })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "InvalidRequestException"],
                () => Effect.void,
              ),
            );
        }),
        // A rotation schedule is configuration on a secret, not a separately
        // enumerable object — `listSecrets` surfaces the rotation state
        // (`RotationEnabled`, `RotationLambdaARN`) inline, so hydrate the
        // exact `read` Attributes shape for every secret that has rotation
        // enabled.
        list: () =>
          secretsmanager.listSecrets.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.SecretList ?? [])
                  .filter(
                    (
                      entry,
                    ): entry is secretsmanager.SecretListEntry & {
                      ARN: string;
                      Name: string;
                    } =>
                      entry.ARN != null &&
                      entry.Name != null &&
                      entry.RotationEnabled === true,
                  )
                  .map((entry) => ({
                    secretArn: entry.ARN,
                    secretName: entry.Name,
                    rotationLambdaArn: entry.RotationLambdaARN,
                    rotationEnabled: true,
                  })),
              ),
            ),
          ),
      };
    }),
  );
