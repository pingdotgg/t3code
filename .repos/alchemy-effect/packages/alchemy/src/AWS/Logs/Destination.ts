import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { PolicyDocument } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";

export interface DestinationProps {
  /**
   * Name of the destination. The destination name is its identity within the
   * account and region (put semantics upsert by name). If omitted, a unique
   * name is generated. Changing this value replaces the destination.
   */
  destinationName?: string;
  /**
   * ARN of the physical target that receives the log events — a Kinesis
   * stream in this account.
   */
  targetArn: string;
  /**
   * ARN of an IAM role that CloudWatch Logs assumes to write to the target.
   * The role must trust `logs.amazonaws.com`.
   */
  roleArn: string;
  /**
   * Access policy governing which accounts may create subscription filters
   * against this destination, either as a JSON string or a structured
   * document. Required before another account can subscribe.
   */
  accessPolicy?: PolicyDocument | string;
}

export interface Destination extends Resource<
  "AWS.Logs.Destination",
  DestinationProps,
  {
    destinationName: string;
    destinationArn: string;
    targetArn: string;
    roleArn: string;
    accessPolicy?: string;
  },
  never,
  Providers
> {}

/**
 * A CloudWatch Logs destination — a cross-account subscription target that
 * forwards log events to a Kinesis stream. Producers in other accounts create
 * subscription filters whose `destinationArn` points at this destination;
 * the `accessPolicy` controls which accounts may subscribe.
 * @resource
 * @section Cross-Account Log Fan-Out
 * @example Kinesis-Backed Destination
 * ```typescript
 * const destination = yield* Destination("CentralLogs", {
 *   targetArn: stream.streamArn,
 *   roleArn: role.roleArn,
 *   accessPolicy: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { AWS: "123456789012" },
 *         Action: ["logs:PutSubscriptionFilter"],
 *         Resource: "*",
 *       },
 *     ],
 *   },
 * });
 * ```
 */
export const Destination = Resource<Destination>("AWS.Logs.Destination");

/**
 * `putDestination` validates that CloudWatch Logs can assume the delivery role
 * at call time; when the role was created in the same deploy this fails with
 * `InvalidParameterException` until IAM propagates. Bounded retry.
 *
 * NOTE: explicit return annotation is load-bearing — an inlined `Effect.retry`
 * in provider lifecycle code widens the provider layer during declaration emit
 * (see PATTERNS.md §7).
 */
const retryThroughRolePropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InvalidParameterException" ||
      e._tag === "OperationAbortedException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(9)]),
  });

export const DestinationProvider = () =>
  Provider.effect(
    Destination,
    Effect.gen(function* () {
      const toDestinationName = (
        id: string,
        props: { destinationName?: string } = {},
      ) =>
        props.destinationName
          ? Effect.succeed(props.destinationName)
          : createPhysicalName({ id, maxLength: 512 });

      const toPolicyString = (policy: PolicyDocument | string | undefined) =>
        policy === undefined
          ? undefined
          : typeof policy === "string"
            ? policy
            : JSON.stringify(policy);

      const observe = Effect.fn(function* (destinationName: string) {
        return yield* logs.describeDestinations
          .items({ DestinationNamePrefix: destinationName })
          .pipe(
            Stream.filter(
              (destination) => destination.destinationName === destinationName,
            ),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
      });

      return {
        stables: ["destinationName", "destinationArn"],
        list: () =>
          logs.describeDestinations.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.destinations ?? [])
                .filter(
                  (
                    destination,
                  ): destination is logs.Destination & {
                    destinationName: string;
                    arn: string;
                  } =>
                    destination.destinationName != null &&
                    destination.arn != null,
                )
                .map((destination) => ({
                  destinationName: destination.destinationName,
                  destinationArn: destination.arn,
                  targetArn: destination.targetArn ?? "",
                  roleArn: destination.roleArn ?? "",
                  accessPolicy: destination.accessPolicy,
                })),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toDestinationName(id, olds)) !==
            (yield* toDestinationName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const destinationName =
            output?.destinationName ??
            (yield* toDestinationName(id, olds ?? {}));
          const observed = yield* observe(destinationName);
          if (!observed?.arn) return undefined;
          return {
            destinationName,
            destinationArn: observed.arn,
            targetArn: observed.targetArn ?? "",
            roleArn: observed.roleArn ?? "",
            accessPolicy: observed.accessPolicy,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const destinationName =
            output?.destinationName ?? (yield* toDestinationName(id, news));
          const desiredPolicy = toPolicyString(news.accessPolicy);

          // Observe — putDestination upserts by name; skip when target/role
          // already match.
          let observed = yield* observe(destinationName);
          if (
            observed?.targetArn !== news.targetArn ||
            observed?.roleArn !== news.roleArn
          ) {
            const put = yield* retryThroughRolePropagation(
              logs.putDestination({
                destinationName,
                targetArn: news.targetArn,
                roleArn: news.roleArn,
              }),
            );
            observed = put.destination ?? (yield* observe(destinationName));
          }

          // Sync access policy against the observed policy.
          if (
            desiredPolicy !== undefined &&
            observed?.accessPolicy !== desiredPolicy
          ) {
            yield* retryThroughRolePropagation(
              logs.putDestinationPolicy({
                destinationName,
                accessPolicy: desiredPolicy,
              }),
            );
          }

          yield* session.note(destinationName);

          return {
            destinationName,
            destinationArn: observed?.arn ?? "",
            targetArn: news.targetArn,
            roleArn: news.roleArn,
            accessPolicy: desiredPolicy,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* logs
            .deleteDestination({ destinationName: output.destinationName })
            .pipe(
              Effect.retry({
                while: (error) =>
                  error._tag === "OperationAbortedException" ||
                  error._tag === "ServiceUnavailableException",
                schedule: Schedule.exponential(100),
                times: 8,
              }),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
