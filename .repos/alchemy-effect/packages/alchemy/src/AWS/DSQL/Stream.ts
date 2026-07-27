import * as dsql from "@distilled.cloud/aws/dsql";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface StreamProps {
  /**
   * Identifier of the DSQL cluster whose committed row-level changes the
   * stream captures. The cluster must be in `ACTIVE` status when the stream
   * is created (an `IDLE` cluster rejects `CreateStream` with a validation
   * error). Changing the cluster replaces the stream.
   */
  clusterId: string;
  /**
   * ARN of the Amazon Kinesis data stream that receives the change records.
   * Must be in the same account and region as the cluster. Configure the
   * Kinesis stream with `maxRecordSizeInKiB: 10240` — CDC records can
   * approach 10 MiB and an undersized stream becomes `IMPAIRED` with
   * `KINESIS_OVERSIZE_RECORD`. Changing the target replaces the stream.
   */
  kinesisStreamArn: string;
  /**
   * ARN of the IAM role Aurora DSQL assumes to write records into the
   * Kinesis stream. The role's trust policy must allow the
   * `dsql.amazonaws.com` service principal and its permissions policy must
   * grant `kinesis:PutRecord`, `kinesis:PutRecords`,
   * `kinesis:DescribeStreamSummary` and `kinesis:ListShards` on the target
   * stream. Changing the role replaces the stream.
   */
  roleArn: string;
  /**
   * Record ordering guarantee. Only `UNORDERED` is currently supported —
   * consumers deduplicate and order by `source.ts_ns`.
   * @default "UNORDERED"
   */
  ordering?: dsql.StreamOrdering;
  /**
   * Record serialization format.
   * @default "JSON"
   */
  format?: dsql.StreamFormat;
  /**
   * User-defined tags for the stream.
   */
  tags?: Record<string, string>;
}

export interface Stream extends Resource<
  "AWS.DSQL.Stream",
  StreamProps,
  {
    /** Identifier of the source cluster. */
    clusterId: string;
    /** The unique stream identifier assigned by DSQL. */
    streamId: string;
    /** The ARN of the stream. */
    streamArn: string;
    /** The current status of the stream, e.g. `ACTIVE`. */
    status: string;
    /** Record ordering guarantee. */
    ordering: string;
    /** Record serialization format. */
    format: string;
    /** ARN of the target Kinesis data stream. */
    kinesisStreamArn: string;
    /** ARN of the IAM role DSQL assumes to write to Kinesis. */
    roleArn: string;
  },
  never,
  Providers
> {}

/**
 * A change data capture (CDC) stream on an Aurora DSQL cluster — delivers
 * committed row-level changes (Debezium-shaped JSON envelopes) to an Amazon
 * Kinesis data stream.
 *
 * Creation is asynchronous (`CREATING` -> `ACTIVE`, typically one to three
 * minutes); the provider waits for `ACTIVE` (bounded) before returning. A
 * stream has no update operation — every property except tags replaces it.
 *
 * Functions consume the change records through the existing Kinesis event
 * source on the **target** stream; DSQL itself never invokes compute
 * directly.
 *
 * @resource
 * @section Creating a CDC Stream
 * @example Stream Cluster Changes into Kinesis
 * ```typescript
 * const cluster = yield* DSQL.Cluster("AppDb", {});
 * const target = yield* Kinesis.Stream("Changes", {
 *   streamMode: "ON_DEMAND",
 *   maxRecordSizeInKiB: 10240,
 * });
 * const role = yield* IAM.Role("CdcRole", {
 *   assumeRolePolicyDocument: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "dsql.amazonaws.com" },
 *         Action: "sts:AssumeRole",
 *       },
 *     ],
 *   }),
 *   inlinePolicies: {
 *     kinesis: JSON.stringify({
 *       Version: "2012-10-17",
 *       Statement: [
 *         {
 *           Effect: "Allow",
 *           Action: [
 *             "kinesis:PutRecord",
 *             "kinesis:PutRecords",
 *             "kinesis:DescribeStreamSummary",
 *             "kinesis:ListShards",
 *           ],
 *           Resource: target.streamArn,
 *         },
 *       ],
 *     }),
 *   },
 * });
 * const cdc = yield* DSQL.Stream("Cdc", {
 *   clusterId: cluster.clusterId,
 *   kinesisStreamArn: target.streamArn,
 *   roleArn: role.roleArn,
 * });
 * ```
 *
 * @example Consume Change Records with a Function
 * ```typescript
 * // DSQL delivers into the Kinesis stream; consume it with the
 * // Kinesis event source on the target stream.
 * yield* Kinesis.consume(target, (records) =>
 *   Effect.forEach(records, (record) => handleChange(record)),
 * );
 * ```
 */
export const Stream = Resource<Stream>("AWS.DSQL.Stream");

const defaultOrdering = "UNORDERED";
const defaultFormat = "JSON";

export const StreamProvider = () =>
  Provider.effect(
    Stream,
    Effect.gen(function* () {
      const readStream = Effect.fn(function* (
        clusterIdentifier: string,
        streamIdentifier: string,
      ) {
        return yield* dsql
          .getStream({ clusterIdentifier, streamIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Bounded readiness wait — stream creation typically completes in one
      // to three minutes; budget 5 min (60 x 5s). FAILED is terminal.
      const waitForActive = Effect.fn(function* (
        clusterIdentifier: string,
        streamIdentifier: string,
      ) {
        const policy = Schedule.max([
          Schedule.fixed("5 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* readStream(clusterIdentifier, streamIdentifier).pipe(
          Effect.flatMap((stream) => {
            if (stream === undefined) {
              return Effect.fail(
                new Error(`DSQL stream '${streamIdentifier}' not found`),
              );
            }
            if (stream.status === "FAILED") {
              return Effect.die(
                `DSQL stream '${streamIdentifier}' failed to provision` +
                  (stream.statusReason
                    ? ` (${stream.statusReason.error})`
                    : ""),
              );
            }
            if (stream.status !== "ACTIVE") {
              return Effect.fail(
                new Error(
                  `DSQL stream '${streamIdentifier}' not active (status: ${stream.status})`,
                ),
              );
            }
            return Effect.succeed(stream);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = (stream: dsql.GetStreamOutput) => ({
        clusterId: stream.clusterIdentifier,
        streamId: stream.streamIdentifier,
        streamArn: stream.arn,
        status: stream.status,
        ordering: stream.ordering,
        format: stream.format,
        kinesisStreamArn: stream.targetDefinition?.kinesis.streamArn ?? "",
        roleArn: stream.targetDefinition?.kinesis.roleArn ?? "",
      });

      return {
        stables: ["clusterId", "streamId", "streamArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // There is no UpdateStream — everything except tags replaces.
          if (
            news.clusterId !== olds?.clusterId ||
            news.kinesisStreamArn !== olds?.kinesisStreamArn ||
            news.roleArn !== olds?.roleArn ||
            (news.ordering ?? defaultOrdering) !==
              (olds?.ordering ?? defaultOrdering) ||
            (news.format ?? defaultFormat) !== (olds?.format ?? defaultFormat)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (output?.streamId === undefined) return undefined;
          const stream = yield* readStream(output.clusterId, output.streamId);
          if (stream === undefined || stream.status === "DELETED") {
            return undefined;
          }
          const tags = Object.fromEntries(
            Object.entries(stream.tags ?? {}).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          );
          const attrs = toAttrs(stream);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative; output caches the id.
          let observed =
            output?.streamId === undefined
              ? undefined
              : yield* readStream(output.clusterId, output.streamId);

          // 2. Ensure — create if missing. DSQL assigns the identifier.
          let streamId = observed?.streamIdentifier ?? output?.streamId;
          if (observed === undefined) {
            const created = yield* dsql
              .createStream({
                clusterIdentifier: props.clusterId,
                targetDefinition: {
                  kinesis: {
                    streamArn: props.kinesisStreamArn,
                    roleArn: props.roleArn,
                  },
                },
                ordering: props.ordering ?? defaultOrdering,
                format: props.format ?? defaultFormat,
                tags: desiredTags,
              })
              .pipe(
                // Two transient races surface as typed errors here:
                // - ConflictException while another cluster operation is in
                //   flight;
                // - ValidationException "Aurora DSQL can't access the
                //   specified IAM role ..." while a freshly created service
                //   role propagates through IAM.
                Effect.retry({
                  while: (e): boolean =>
                    e._tag === "ConflictException" ||
                    (e._tag === "ValidationException" &&
                      e.message.includes("IAM role")),
                  schedule: Schedule.max([
                    Schedule.fixed("5 seconds"),
                    Schedule.recurs(24),
                  ]),
                }),
              );
            streamId = created.streamIdentifier;
          }

          // Wait for ACTIVE so consumers observe a delivering stream.
          observed = yield* waitForActive(props.clusterId, streamId!);

          // 3. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = Object.fromEntries(
            Object.entries(observed.tags ?? {}).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          );
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* dsql.tagResource({
              resourceArn: observed.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* dsql.untagResource({
              resourceArn: observed.arn,
              tagKeys: removed,
            });
          }

          yield* session.note(streamId!);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* dsql
            .deleteStream({
              clusterIdentifier: output.clusterId,
              streamIdentifier: output.streamId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // A stream still CREATING rejects delete with a typed
              // conflict; retry briefly until it settles.
              Effect.retry({
                while: (e): boolean => e._tag === "ConflictException",
                schedule: Schedule.max([
                  Schedule.fixed("5 seconds"),
                  Schedule.recurs(24),
                ]),
              }),
            );
          // Wait until fully gone (bounded) so the parent cluster's delete
          // does not trip over a stream still DELETING.
          yield* readStream(output.clusterId, output.streamId).pipe(
            Effect.flatMap((stream) =>
              stream === undefined || stream.status === "DELETED"
                ? Effect.void
                : Effect.fail(
                    new Error(
                      `DSQL stream '${output.streamId}' still ${stream.status}`,
                    ),
                  ),
            ),
            Effect.retry({
              while: (e): boolean => e instanceof Error,
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(36),
              ]),
            }),
            // Best-effort — deletion continues server-side either way.
            Effect.catch(() => Effect.void),
          );
        }),

        list: () =>
          Effect.gen(function* () {
            const clusters = yield* dsql.listClusters.items({}).pipe(
              EStream.runCollect,
              Effect.map((c) => Array.from(c)),
            );
            const nested = yield* Effect.forEach(
              clusters,
              (cluster) =>
                dsql.listStreams
                  .items({ clusterIdentifier: cluster.identifier })
                  .pipe(
                    EStream.runCollect,
                    Effect.map((c) => Array.from(c)),
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed([]),
                    ),
                  ),
              { concurrency: 4 },
            );
            return yield* Effect.forEach(
              nested.flat(),
              (summary) =>
                readStream(
                  summary.clusterIdentifier,
                  summary.streamIdentifier,
                ).pipe(
                  Effect.map((stream) =>
                    stream === undefined || stream.status === "DELETED"
                      ? undefined
                      : toAttrs(stream),
                  ),
                ),
              { concurrency: 4 },
            ).pipe(
              Effect.map((attrs) =>
                attrs.filter(
                  (a): a is NonNullable<typeof a> => a !== undefined,
                ),
              ),
            );
          }),
      };
    }),
  );
