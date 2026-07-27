import * as ivschat from "@distilled.cloud/aws/ivschat";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  retryWhileConflict,
  retryWhileThrottled,
  syncIvsChatTags,
  toTagRecord,
} from "./internal.ts";

export interface LoggingConfigurationDestination {
  /**
   * Deliver chat logs to an S3 bucket. Exactly one destination must be
   * specified.
   */
  s3?: { bucketName: string };
  /**
   * Deliver chat logs to a CloudWatch Logs log group. Exactly one
   * destination must be specified.
   */
  cloudWatchLogs?: { logGroupName: string };
  /**
   * Deliver chat logs to a Kinesis Data Firehose delivery stream.
   * Exactly one destination must be specified.
   */
  firehose?: { deliveryStreamName: string };
}

export interface LoggingConfigurationProps {
  /**
   * Where chat messages are delivered: exactly one of `s3`,
   * `cloudWatchLogs`, or `firehose`.
   */
  destinationConfiguration: LoggingConfigurationDestination;
  /**
   * Name of the logging configuration (not unique). If omitted, a
   * deterministic physical name is generated. Mutable — changing the
   * name updates the configuration in place.
   */
  loggingConfigurationName?: string;
  /**
   * Tags to apply to the logging configuration. Merged with internal
   * Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface LoggingConfiguration extends Resource<
  "AWS.IVSChat.LoggingConfiguration",
  LoggingConfigurationProps,
  {
    /**
     * The logging configuration's physical name.
     */
    loggingConfigurationName: string;
    /**
     * ARN of the logging configuration.
     */
    loggingConfigurationArn: string;
    /**
     * Unique ID of the logging configuration.
     */
    loggingConfigurationId: string;
    /**
     * Lifecycle state reported by IVS Chat (e.g. `ACTIVE`).
     */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon IVS Chat logging configuration — records the chat messages of
 * the rooms it is attached to into S3, CloudWatch Logs, or a Kinesis
 * Data Firehose delivery stream.
 * @resource
 * @section Creating Logging Configurations
 * @example CloudWatch Logs Destination
 * ```typescript
 * import * as IVSChat from "alchemy/AWS/IVSChat";
 * import * as Logs from "alchemy/AWS/Logs";
 *
 * const logGroup = yield* Logs.LogGroup("ChatLogGroup");
 * const logging = yield* IVSChat.LoggingConfiguration("ChatLogs", {
 *   destinationConfiguration: {
 *     cloudWatchLogs: { logGroupName: logGroup.logGroupName },
 *   },
 * });
 * ```
 *
 * @example S3 Destination
 * ```typescript
 * const logging = yield* IVSChat.LoggingConfiguration("ChatLogs", {
 *   destinationConfiguration: {
 *     s3: { bucketName: bucket.bucketName },
 *   },
 * });
 * ```
 *
 * @section Attaching to Rooms
 * @example Log a Room's Messages
 * ```typescript
 * const room = yield* IVSChat.Room("LiveChat", {
 *   loggingConfigurationIdentifiers: [logging.loggingConfigurationArn],
 * });
 * ```
 */
export const LoggingConfiguration = Resource<LoggingConfiguration>(
  "AWS.IVSChat.LoggingConfiguration",
);

/**
 * Raised when a `LoggingConfiguration` does not specify exactly one of
 * `s3`, `cloudWatchLogs`, or `firehose`, or when the API returns a
 * configuration missing its identifiers.
 */
export class IvsChatLoggingConfigurationInvalid extends Data.TaggedError(
  "IvsChatLoggingConfigurationInvalid",
)<{ message: string }> {}

/** Narrow the plain destination prop to the exactly-one wire union. */
const toWireDestination = (
  destination: LoggingConfigurationDestination,
): Effect.Effect<
  ivschat.DestinationConfiguration,
  IvsChatLoggingConfigurationInvalid
> => {
  const specified = [
    destination.s3,
    destination.cloudWatchLogs,
    destination.firehose,
  ].filter((d) => d !== undefined);
  if (specified.length !== 1) {
    return Effect.fail(
      new IvsChatLoggingConfigurationInvalid({
        message:
          "destinationConfiguration must specify exactly one of s3, cloudWatchLogs, or firehose",
      }),
    );
  }
  if (destination.s3) return Effect.succeed({ s3: destination.s3 });
  if (destination.cloudWatchLogs) {
    return Effect.succeed({ cloudWatchLogs: destination.cloudWatchLogs });
  }
  return Effect.succeed({ firehose: destination.firehose! });
};

/**
 * Explicitly-typed pipeable poll helper: repeat a read until the
 * configuration reaches a settled state (bounded — ~60s).
 */
const pollUntilSettled = <
  A extends { state?: string | undefined } | undefined,
  E,
  R,
>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    until: (config) =>
      config === undefined ||
      (config.state !== "CREATING" && config.state !== "UPDATING"),
    schedule: Schedule.fixed("2 seconds"),
    times: 30,
  });

type LoggingConfigurationState = {
  arn?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  destinationConfiguration?: ivschat.DestinationConfiguration | undefined;
  state?: string | undefined;
  tags?: { [key: string]: string | undefined } | undefined;
};

export const LoggingConfigurationProvider = () =>
  Provider.effect(
    LoggingConfiguration,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { loggingConfigurationName?: string | undefined },
      ) =>
        props.loggingConfigurationName
          ? Effect.succeed(props.loggingConfigurationName)
          : createPhysicalName({ id, maxLength: 128 });

      const toAttrs = Effect.fn(function* (config: LoggingConfigurationState) {
        if (!config.arn || !config.id || !config.name) {
          return yield* Effect.fail(
            new IvsChatLoggingConfigurationInvalid({
              message:
                "IVS Chat logging configuration is missing its ARN, ID, or name",
            }),
          );
        }
        return {
          loggingConfigurationName: config.name,
          loggingConfigurationArn: config.arn,
          loggingConfigurationId: config.id,
          state: config.state,
        };
      });

      const getByIdentifier = Effect.fn(function* (identifier: string) {
        return yield* ivschat.getLoggingConfiguration({ identifier }).pipe(
          retryWhileThrottled,
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      });

      /** No name filter on ListLoggingConfigurations — enumerate + match. */
      const findByName = Effect.fn(function* (name: string) {
        const summaries = yield* ivschat.listLoggingConfigurations
          .pages({})
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.loggingConfigurations),
            ),
            retryWhileThrottled,
          );
        const match = summaries.find((s) => s.name === name && s.arn);
        return match?.arn ? yield* getByIdentifier(match.arn) : undefined;
      });

      return {
        stables: ["loggingConfigurationArn", "loggingConfigurationId"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const config = output?.loggingConfigurationArn
            ? yield* getByIdentifier(output.loggingConfigurationArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (config === undefined) return undefined;
          const attrs = yield* toAttrs(config);
          return (yield* hasAlchemyTags(id, toTagRecord(config.tags)))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news }) {
          if (!isResolved(news)) return undefined;
          // Validate the exactly-one destination shape before any AWS call.
          yield* toWireDestination(news.destinationConfiguration);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredDestination = yield* toWireDestination(
            news.destinationConfiguration,
          );

          // 1. Observe — and wait out any in-flight state transition so
          // the sync step below is allowed to mutate.
          let observed = output?.loggingConfigurationArn
            ? yield* pollUntilSettled(
                getByIdentifier(output.loggingConfigurationArn),
              )
            : yield* findByName(name);

          // 2. Ensure — create if missing, then wait for ACTIVE (a
          // configuration is created in state CREATING).
          if (observed === undefined) {
            const created = yield* ivschat
              .createLoggingConfiguration({
                name,
                destinationConfiguration: desiredDestination,
                tags: desiredTags,
              })
              .pipe(retryWhileThrottled);
            if (created.arn !== undefined) {
              observed = yield* pollUntilSettled(getByIdentifier(created.arn));
            }
          }
          const arn = observed?.arn;
          if (observed === undefined || arn === undefined) {
            return yield* Effect.fail(
              new IvsChatLoggingConfigurationInvalid({
                message: "IVS Chat CreateLoggingConfiguration returned no ARN",
              }),
            );
          }

          // 3. Sync — name and destination are mutable via
          // UpdateLoggingConfiguration (allowed only in a settled state;
          // Conflict retried through a bounded window).
          const patch: Partial<ivschat.UpdateLoggingConfigurationRequest> = {};
          if (observed.name !== name) patch.name = name;
          if (
            JSON.stringify(observed.destinationConfiguration) !==
            JSON.stringify(desiredDestination)
          ) {
            patch.destinationConfiguration = desiredDestination;
          }
          if (Object.keys(patch).length > 0) {
            yield* ivschat
              .updateLoggingConfiguration({ identifier: arn, ...patch })
              .pipe(retryWhileThrottled, retryWhileConflict);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncIvsChatTags(arn, desiredTags);

          // 4. Return fresh, settled attributes.
          const final = yield* pollUntilSettled(getByIdentifier(arn));
          if (final === undefined) {
            return yield* Effect.fail(
              new IvsChatLoggingConfigurationInvalid({
                message: `IVS Chat logging configuration '${arn}' vanished during reconcile`,
              }),
            );
          }
          yield* session.note(arn);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deleting mid-transition raises ConflictException — retry
          // through a bounded window, then tolerate already-gone.
          yield* ivschat
            .deleteLoggingConfiguration({
              identifier: output.loggingConfigurationArn,
            })
            .pipe(
              retryWhileThrottled,
              retryWhileConflict,
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          ivschat.listLoggingConfigurations.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.loggingConfigurations),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  toAttrs(summary).pipe(
                    // Tolerate a malformed/deleted summary — drop it.
                    Effect.catchTag("IvsChatLoggingConfigurationInvalid", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
                { concurrency: 5 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
