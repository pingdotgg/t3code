import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { gunzipSync } from "node:zlib";

import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { LogGroup } from "../Logs/LogGroup.ts";
import {
  LogGroupEventSource as LogsLogGroupEventSource,
  type CloudWatchLogsEvent,
  type LogEventRecord,
  type LogGroupEventSourceProps,
  type LogGroupEventSourceService,
  type LogsSubscriptionPayload,
} from "../Logs/LogGroupEventSource.ts";
import { SubscriptionFilter } from "../Logs/SubscriptionFilter.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

/**
 * Narrow an arbitrary Lambda invocation payload to a CloudWatch Logs
 * subscription event.
 */
export const isCloudWatchLogsEvent = (
  event: any,
): event is CloudWatchLogsEvent => typeof event?.awslogs?.data === "string";

/**
 * Decode the gzipped, base64-encoded CloudWatch Logs subscription payload.
 */
export const decodeCloudWatchLogsEvent = (
  event: CloudWatchLogsEvent,
): Effect.Effect<LogsSubscriptionPayload, Error> =>
  Effect.try({
    try: () =>
      JSON.parse(
        gunzipSync(Buffer.from(event.awslogs.data, "base64")).toString("utf8"),
      ) as LogsSubscriptionPayload,
    catch: (cause) =>
      new Error("failed to decode CloudWatch Logs subscription payload", {
        cause,
      }),
  });

/**
 * Lambda runtime implementation for `AWS.Logs.consumeLogEvents(...)`.
 *
 * This layer does two things:
 *
 * 1. At deploy time it creates the backing `AWS.Logs.SubscriptionFilter`
 *    targeting the current Lambda function plus the `lambda:InvokeFunction`
 *    permission for `logs.amazonaws.com`.
 * 2. At runtime it decodes the gzipped/base64 `awslogs.data` payload of
 *    incoming invocations and forwards each log event into the supplied
 *    handler as a typed `LogEventRecord` stream.
 * @binding
 * @section Consuming Log Events
 * @example Forward Another Function's Error Logs
 * ```typescript
 * yield* AWS.Logs.consumeLogEvents(
 *   logGroup,
 *   { filterPattern: "?ERROR ?Error" },
 *   (events) =>
 *     Stream.runForEach(events, (event) =>
 *       Effect.log(`${event.logStream}: ${event.message}`),
 *     ),
 * );
 * ```
 */
export const LogGroupEventSource = Layer.effect(
  LogsLogGroupEventSource,
  // The impl resolves plan-time services (SubscriptionFilter, Permission)
  // whereas LogGroupEventSourceService erases the requirement channel to
  // `never`.
  // @effect-diagnostics-next-line missingEffectContext:off
  Effect.gen(function* () {
    const host = yield* Lambda.Function;
    const Permission = yield* LambdaPermission;
    const Filter = yield* SubscriptionFilter;

    return Effect.fn(function* <Req = never>(
      logGroup: LogGroup,
      props: LogGroupEventSourceProps,
      process: (
        events: Stream.Stream<LogEventRecord>,
      ) => Effect.Effect<void, never, Req>,
    ) {
      // this adds it to the Lambda Function's environment variables
      const LogGroupName = yield* logGroup.logGroupName;

      // Deploy-time: grant CloudWatch Logs permission to invoke this function
      // and create the subscription filter targeting it. Skipped once running
      // inside the deployed Function (the global guard), where the only work
      // is registering the runtime handler below. Namespaced under the host so
      // the sub-resources' logical identity is stable per host function.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* Permission(
              `AWS.Logs.InvokePermission(${logGroup.LogicalId})`,
              {
                action: "lambda:InvokeFunction",
                functionName: host.functionName,
                principal: "logs.amazonaws.com",
                sourceArn: Output.interpolate`${logGroup.logGroupArn}:*`,
              },
            );
            yield* Filter(
              `AWS.Logs.SubscriptionFilter(${logGroup.LogicalId})`,
              {
                logGroupName: logGroup.logGroupName,
                filterName: props.filterName,
                filterPattern: props.filterPattern ?? "",
                destinationArn: host.functionArn,
              },
            );
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          const logGroupName = yield* LogGroupName;
          return (event: any) => {
            if (isCloudWatchLogsEvent(event)) {
              return Effect.gen(function* () {
                const payload = yield* decodeCloudWatchLogsEvent(event);
                if (
                  payload.messageType !== "DATA_MESSAGE" ||
                  payload.logGroup !== logGroupName
                ) {
                  return;
                }
                yield* process(
                  Stream.fromArray(
                    payload.logEvents.map(
                      (logEvent): LogEventRecord => ({
                        id: logEvent.id,
                        timestamp: logEvent.timestamp,
                        message: logEvent.message,
                        logGroup: payload.logGroup,
                        logStream: payload.logStream,
                        owner: payload.owner,
                        subscriptionFilters: payload.subscriptionFilters,
                      }),
                    ),
                  ),
                );
              }).pipe(Effect.orDie);
            }
          };
        }),
      );
    }) as LogGroupEventSourceService;
  }),
);
