import * as pipes from "@distilled.cloud/aws/pipes";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * The state you want the pipe to be in after reconciliation.
 *
 * - `RUNNING` — the pipe polls the source and delivers to the target.
 * - `STOPPED` — the pipe exists but does not poll the source.
 */
export type PipeDesiredState = "RUNNING" | "STOPPED";

export interface PipeProps {
  /**
   * Name of the pipe (1-64 characters). If omitted, a deterministic
   * physical name is generated from the app, stage, and logical ID.
   */
  pipeName?: string;
  /**
   * A description of the pipe.
   */
  description?: string;
  /**
   * The state the pipe should be in.
   * @default "RUNNING"
   */
  desiredState?: PipeDesiredState;
  /**
   * The ARN of the source resource (SQS queue, Kinesis stream, DynamoDB
   * stream, etc.). Changing the source triggers a **replacement** — the
   * EventBridge Pipes API does not allow updating a pipe's source.
   */
  source: string;
  /**
   * Source-specific parameters (batching, starting position, filter
   * criteria). `FilterCriteria` holds EventBridge event-pattern strings
   * that select which source events reach the enrichment/target.
   * Changing a stream source's `StartingPosition` triggers a replacement.
   */
  sourceParameters?: pipes.PipeSourceParameters;
  /**
   * The ARN of the enrichment resource (Lambda function, Step Functions
   * state machine, or API destination) invoked between source and target.
   */
  enrichment?: string;
  /**
   * Parameters for the enrichment step (input template, HTTP parameters).
   */
  enrichmentParameters?: pipes.PipeEnrichmentParameters;
  /**
   * The ARN of the target resource (Lambda function, SQS queue, Kinesis
   * stream, EventBridge bus, CloudWatch Logs group, ECS task, etc.).
   */
  target: string;
  /**
   * Target-specific invocation parameters (input template, invocation
   * type, partition key, message group, etc.).
   */
  targetParameters?: pipes.PipeTargetParameters;
  /**
   * The ARN of the IAM role that EventBridge Pipes assumes to read from
   * the source and deliver to the target (and invoke the enrichment).
   * Must trust the `pipes.amazonaws.com` service principal. Use
   * `Pipes.from(source).toLambda(fn)` to have the role synthesized
   * automatically.
   */
  roleArn: string;
  /**
   * Pipe execution log configuration (CloudWatch Logs, Firehose, or S3).
   */
  logConfiguration?: pipes.PipeLogConfigurationParameters;
  /**
   * The identifier of the KMS customer managed key used to encrypt pipe
   * data at rest.
   */
  kmsKeyIdentifier?: string;
  /**
   * Tags to apply to the pipe. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Pipe extends Resource<
  "AWS.Pipes.Pipe",
  PipeProps,
  {
    /**
     * Name of the pipe.
     */
    pipeName: string;
    /**
     * ARN of the pipe.
     */
    pipeArn: string;
    /**
     * Observed state of the pipe (e.g. `RUNNING`, `STOPPED`).
     */
    currentState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon EventBridge Pipe — point-to-point source→(filter)→(enrich)→target
 * plumbing between AWS services without glue code.
 *
 * `Pipe` owns the lifecycle of an EventBridge Pipe. Reconcile waits (bounded)
 * for the pipe to leave its `CREATING`/`UPDATING` transitional states, and a
 * pipe that lands in a `*_FAILED` state surfaces as a typed {@link PipeFailed}
 * error rather than hanging. Prefer the {@link from} builder for the common
 * pairs — it synthesizes the `pipes.amazonaws.com` execution role with
 * source-read and target-invoke policies for you.
 * @resource
 * @section Creating Pipes
 * @example SQS to Lambda (builder — role synthesized automatically)
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const queue = yield* AWS.SQS.Queue("OrdersQueue");
 * const pipe = yield* AWS.Pipes.from(queue, { batchSize: 1 }).toLambda(fn);
 * ```
 *
 * @example SQS to SQS (canonical resource with an explicit role)
 * ```typescript
 * const pipe = yield* AWS.Pipes.Pipe("OrdersPipe", {
 *   source: source.queueArn,
 *   target: target.queueArn,
 *   roleArn: role.roleArn,
 *   sourceParameters: {
 *     SqsQueueParameters: { BatchSize: 1 },
 *   },
 * });
 * ```
 *
 * @section Filtering
 * @example Only deliver matching events
 * ```typescript
 * const pipe = yield* AWS.Pipes.from(queue)
 *   .filter(JSON.stringify({ body: { type: ["order.created"] } }))
 *   .toLambda(fn);
 * ```
 *
 * @section Enrichment
 * @example Enrich events with a Lambda function before delivery
 * ```typescript
 * const pipe = yield* AWS.Pipes.from(queue)
 *   .enrich(enricherFn)
 *   .toQueue(target);
 * ```
 *
 * @section Stream Sources
 * @example Kinesis stream source
 * ```typescript
 * const pipe = yield* AWS.Pipes.from(stream, {
 *   startingPosition: "TRIM_HORIZON",
 *   batchSize: 10,
 * }).toLambda(fn);
 * ```
 *
 * @example Stop a pipe without deleting it
 * ```typescript
 * const pipe = yield* AWS.Pipes.Pipe("OrdersPipe", {
 *   source: source.queueArn,
 *   target: target.queueArn,
 *   roleArn: role.roleArn,
 *   desiredState: "STOPPED",
 * });
 * ```
 */
export const Pipe = Resource<Pipe>("AWS.Pipes.Pipe");

/**
 * Raised when a pipe lands in a terminal failed state
 * (`CREATE_FAILED`, `UPDATE_FAILED`, `START_FAILED`, `STOP_FAILED`,
 * `DELETE_FAILED`, ...). Carries the pipe's `StateReason` so the
 * misconfiguration (usually IAM) is visible in the failure.
 */
export class PipeFailed extends Data.TaggedError("PipeFailed")<{
  pipeName: string;
  state: string;
  stateReason: string | undefined;
}> {}

/**
 * Raised when a pipe does not settle out of a transitional state
 * (`CREATING`, `UPDATING`, `STARTING`, `STOPPING`, `DELETING`) within the
 * bounded wait (~60s). Surfaces the
 * last observed state instead of hanging the deploy.
 */
export class PipeStateTimeout extends Data.TaggedError("PipeStateTimeout")<{
  pipeName: string;
  state: string | undefined;
  message: string;
}> {}

/** Internal poll signal: the pipe is still in a transitional state. */
class PipeStillTransitioning extends Data.TaggedError(
  "PipeStillTransitioning",
)<{ pipeName: string; state: string }> {}

/** Internal poll signal: the pipe still exists after a delete. */
class PipeStillPresent extends Data.TaggedError("PipeStillPresent")<{
  pipeName: string;
  state: string | undefined;
}> {}

const TRANSITIONAL_STATES: ReadonlySet<string> = new Set([
  "CREATING",
  "UPDATING",
  "STARTING",
  "STOPPING",
  "DELETING",
]);

const isFailedState = (state: string) => state.includes("FAILED");

const unwrap = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

const unwrapTags = (
  tags:
    | { [key: string]: string | Redacted.Redacted<string> | undefined }
    | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    const plain = unwrap(value);
    if (plain !== undefined) out[key] = plain;
  }
  return out;
};

/**
 * Bounded retry helpers with EXPLICIT `Effect.Effect<A, E, R>` annotations.
 * Inlining `Effect.retry` with options in provider lifecycle code leaves
 * `Retry.Return`'s conditional type unresolved in the provider's inferred
 * layer type, which declaration emit widens to an `unknown` R — poisoning
 * `AWS.providers()` for every downstream consumer (see
 * `retryThroughDeletionWindow` in AWS/SecretsManager/Secret.ts).
 */
const retryWhileTransitioning = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "PipeStillTransitioning",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

const retryWhilePresent = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "PipeStillPresent",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(30)]),
  });

/**
 * EventBridge Pipes validates that the execution role is assumable by
 * `pipes.amazonaws.com` at create/update time. A freshly-created IAM role
 * can take a minute to propagate, surfacing as a `ValidationException`
 * mentioning role assumption. Retry (bounded) until propagation completes.
 */
const retryUntilRoleAssumable = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => {
      if (e._tag !== "ValidationException") return false;
      const message = (e as { message?: unknown }).message;
      return (
        typeof message === "string" &&
        (message.includes("assume") || message.includes("trust"))
      );
    },
    schedule: Schedule.max([Schedule.spaced("3 seconds"), Schedule.recurs(20)]),
  });

/**
 * Pipe mutations racing an in-flight transition surface as
 * `ConflictException`. Retry on a bounded schedule so a delete/update
 * issued while the pipe is still `CREATING`/`UPDATING` converges.
 */
const retryWhileConflicting = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(20)]),
  });

/**
 * `true` when every DEFINED field of `desired` deep-equals the observed
 * value (Redacted values are unwrapped on both sides). Undefined desired
 * fields are skipped — AWS fills unspecified parameter fields with
 * defaults, so only user-specified values participate in drift detection.
 */
const subsetMatches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  const want = Redacted.isRedacted(desired) ? Redacted.value(desired) : desired;
  const have = Redacted.isRedacted(observed)
    ? Redacted.value(observed)
    : observed;
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || have.length !== want.length) return false;
    return want.every((item, i) => subsetMatches(item, have[i]));
  }
  if (typeof want === "object" && want !== null) {
    if (typeof have !== "object" || have === null) return false;
    return Object.entries(want).every(([key, value]) =>
      subsetMatches(value, (have as Record<string, unknown>)[key]),
    );
  }
  return want === have;
};

const filterPatternsOf = (
  criteria: pipes.FilterCriteria | undefined,
): string[] =>
  (criteria?.Filters ?? [])
    .map((filter) => unwrap(filter.Pattern))
    .filter((pattern): pattern is string => pattern !== undefined);

const sameFilters = (a: string[], b: string[]) =>
  a.length === b.length && a.every((pattern, i) => pattern === b[i]);

const startingPositionOf = (params: pipes.PipeSourceParameters | undefined) =>
  params?.KinesisStreamParameters?.StartingPosition ??
  params?.DynamoDBStreamParameters?.StartingPosition;

/**
 * Convert create-shape source parameters into the update shape. Stream
 * starting positions are immutable (replacement — see `diff`), so they are
 * stripped. `FilterCriteria` is always sent (defaulting to no filters) so
 * removing a filter from props converges: EventBridge resets unspecified
 * fields inside `SourceParameters` to their defaults on update.
 */
const toUpdateSourceParameters = (
  params: pipes.PipeSourceParameters | undefined,
): pipes.UpdatePipeSourceParameters => ({
  FilterCriteria: params?.FilterCriteria ?? { Filters: [] },
  SqsQueueParameters: params?.SqsQueueParameters,
  KinesisStreamParameters: params?.KinesisStreamParameters
    ? {
        BatchSize: params.KinesisStreamParameters.BatchSize,
        DeadLetterConfig: params.KinesisStreamParameters.DeadLetterConfig,
        OnPartialBatchItemFailure:
          params.KinesisStreamParameters.OnPartialBatchItemFailure,
        MaximumBatchingWindowInSeconds:
          params.KinesisStreamParameters.MaximumBatchingWindowInSeconds,
        MaximumRecordAgeInSeconds:
          params.KinesisStreamParameters.MaximumRecordAgeInSeconds,
        MaximumRetryAttempts:
          params.KinesisStreamParameters.MaximumRetryAttempts,
        ParallelizationFactor:
          params.KinesisStreamParameters.ParallelizationFactor,
      }
    : undefined,
  DynamoDBStreamParameters: params?.DynamoDBStreamParameters
    ? {
        BatchSize: params.DynamoDBStreamParameters.BatchSize,
        DeadLetterConfig: params.DynamoDBStreamParameters.DeadLetterConfig,
        OnPartialBatchItemFailure:
          params.DynamoDBStreamParameters.OnPartialBatchItemFailure,
        MaximumBatchingWindowInSeconds:
          params.DynamoDBStreamParameters.MaximumBatchingWindowInSeconds,
        MaximumRecordAgeInSeconds:
          params.DynamoDBStreamParameters.MaximumRecordAgeInSeconds,
        MaximumRetryAttempts:
          params.DynamoDBStreamParameters.MaximumRetryAttempts,
        ParallelizationFactor:
          params.DynamoDBStreamParameters.ParallelizationFactor,
      }
    : undefined,
});

/**
 * Source parameters with `FilterCriteria` removed — filters get dedicated
 * removal-sensitive comparison, everything else uses `subsetMatches`.
 */
const sourceParametersSansFilters = (
  params: pipes.PipeSourceParameters | undefined,
): Record<string, unknown> | undefined => {
  if (params === undefined) return undefined;
  const { FilterCriteria: _filters, ...rest } = params;
  return rest;
};

export const PipeProvider = () =>
  Provider.effect(
    Pipe,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { pipeName?: string | undefined },
      ) {
        return (
          props.pipeName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const describeOrUndefined = (pipeName: string) =>
        pipes
          .describePipe({ Name: pipeName })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      /**
       * Poll (bounded, ~60s) until the pipe leaves its transitional state.
       * A `*_FAILED` terminal state surfaces as a typed `PipeFailed`; a pipe
       * still transitioning after the bounded wait surfaces as a typed
       * `PipeStateTimeout` — never a hang.
       */
      const awaitSettled = Effect.fn(function* (pipeName: string) {
        const described = yield* describeOrUndefined(pipeName).pipe(
          Effect.flatMap((d) =>
            d?.CurrentState !== undefined &&
            TRANSITIONAL_STATES.has(d.CurrentState)
              ? Effect.fail(
                  new PipeStillTransitioning({
                    pipeName,
                    state: d.CurrentState,
                  }),
                )
              : Effect.succeed(d),
          ),
          retryWhileTransitioning,
          Effect.catchTag("PipeStillTransitioning", (e) =>
            Effect.fail(
              new PipeStateTimeout({
                pipeName,
                state: e.state,
                message: `Pipe '${pipeName}' did not settle within the bounded wait (last state: ${e.state})`,
              }),
            ),
          ),
        );
        if (
          described?.CurrentState !== undefined &&
          isFailedState(described.CurrentState)
        ) {
          return yield* Effect.fail(
            new PipeFailed({
              pipeName,
              state: described.CurrentState,
              stateReason: described.StateReason,
            }),
          );
        }
        return described;
      });

      /** Poll (bounded, ~60s) until `describePipe` returns NotFound. */
      const awaitGone = Effect.fn(function* (pipeName: string) {
        yield* pipes.describePipe({ Name: pipeName }).pipe(
          Effect.flatMap((d) =>
            Effect.fail(
              new PipeStillPresent({ pipeName, state: d.CurrentState }),
            ),
          ),
          Effect.catchTag("NotFoundException", () => Effect.void),
          retryWhilePresent,
          Effect.catchTag("PipeStillPresent", (e) =>
            Effect.fail(
              new PipeStateTimeout({
                pipeName,
                state: e.state,
                message: `Pipe '${pipeName}' did not finish deleting within the bounded wait (last state: ${e.state})`,
              }),
            ),
          ),
        );
      });

      return Pipe.Provider.of({
        stables: ["pipeName", "pipeArn"],

        list: () =>
          Effect.gen(function* () {
            const summaries = yield* pipes.listPipes.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Pipes ?? []),
              ),
            );
            return summaries
              .filter(
                (p): p is pipes.Pipe & { Name: string; Arn: string } =>
                  p.Name !== undefined && p.Arn !== undefined,
              )
              .map((p) => ({
                pipeName: p.Name,
                pipeArn: p.Arn,
                currentState: p.CurrentState,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const pipeName =
            output?.pipeName ?? (yield* createName(id, olds ?? {}));
          const described = yield* describeOrUndefined(pipeName);
          if (!described?.Arn) return undefined;
          const attrs = {
            pipeName,
            pipeArn: described.Arn,
            currentState: described.CurrentState,
          };
          const tags = unwrapTags(described.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The Pipes API has no way to change a pipe's source.
          if (olds.source !== undefined && olds.source !== news.source) {
            return { action: "replace" } as const;
          }
          // Stream starting positions are create-only.
          if (
            startingPositionOf(olds.sourceParameters) !==
            startingPositionOf(news.sourceParameters)
          ) {
            return { action: "replace" } as const;
          }
          // fall through: undefined → default update path
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const pipeName = output?.pipeName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };
          const desiredState = news.desiredState ?? "RUNNING";

          // 1. OBSERVE — settle any in-flight transition first; cloud state
          //    is authoritative, `output` is only a name cache. A pipe stuck
          //    in a `*_FAILED` state can't be repaired in place (the failure
          //    is usually IAM propagation from a crashed prior run), so it
          //    is deleted and recreated below.
          let observed = yield* awaitSettled(pipeName).pipe(
            Effect.catchTag("PipeFailed", (e) =>
              Effect.gen(function* () {
                yield* session.note(
                  `Pipe '${pipeName}' is in failed state ${e.state} (${e.stateReason ?? "no reason"}); deleting and recreating`,
                );
                yield* pipes.deletePipe({ Name: pipeName }).pipe(
                  retryWhileConflicting,
                  Effect.catchTag("NotFoundException", () => Effect.void),
                );
                yield* awaitGone(pipeName);
                return undefined;
              }),
            ),
          );

          // 2. ENSURE — create if missing; tolerate the concurrent-create
          //    race and retry while a freshly-created IAM role propagates.
          if (observed?.Arn === undefined) {
            yield* pipes
              .createPipe({
                Name: pipeName,
                Description: news.description,
                DesiredState: desiredState,
                Source: news.source,
                SourceParameters: news.sourceParameters,
                Enrichment: news.enrichment,
                EnrichmentParameters: news.enrichmentParameters,
                Target: news.target,
                TargetParameters: news.targetParameters,
                RoleArn: news.roleArn,
                Tags: desiredTags,
                LogConfiguration: news.logConfiguration,
                KmsKeyIdentifier: news.kmsKeyIdentifier,
              })
              .pipe(
                retryUntilRoleAssumable,
                Effect.catchTag("ConflictException", () => Effect.void),
              );
            observed = yield* awaitSettled(pipeName);
          }

          if (observed?.Arn === undefined) {
            return yield* Effect.fail(
              new PipeFailed({
                pipeName,
                state: "MISSING",
                stateReason: `describePipe returned no pipe after createPipe('${pipeName}') succeeded`,
              }),
            );
          }

          // 3. SYNC — diff OBSERVED cloud state against desired and update
          //    only on drift. Filters/desired-state/target/enrichment are
          //    removal-sensitive; parameter objects compare user-specified
          //    fields only (AWS fills the rest with defaults).
          const needsUpdate =
            (news.description !== undefined &&
              unwrap(observed.Description) !== news.description) ||
            (observed.DesiredState ?? "RUNNING") !== desiredState ||
            observed.Target !== news.target ||
            (observed.Enrichment !== undefined && observed.Enrichment !== ""
              ? observed.Enrichment
              : undefined) !== news.enrichment ||
            observed.RoleArn !== news.roleArn ||
            (news.kmsKeyIdentifier !== undefined &&
              observed.KmsKeyIdentifier !== news.kmsKeyIdentifier) ||
            !sameFilters(
              filterPatternsOf(observed.SourceParameters?.FilterCriteria),
              filterPatternsOf(news.sourceParameters?.FilterCriteria),
            ) ||
            !subsetMatches(
              sourceParametersSansFilters(news.sourceParameters),
              observed.SourceParameters,
            ) ||
            !subsetMatches(news.targetParameters, observed.TargetParameters) ||
            !subsetMatches(
              news.enrichmentParameters,
              observed.EnrichmentParameters,
            );

          if (needsUpdate) {
            yield* pipes
              .updatePipe({
                Name: pipeName,
                Description: news.description,
                DesiredState: desiredState,
                SourceParameters: toUpdateSourceParameters(
                  news.sourceParameters,
                ),
                // "" clears a previously-configured enrichment.
                Enrichment: news.enrichment ?? "",
                EnrichmentParameters: news.enrichmentParameters,
                Target: news.target,
                TargetParameters: news.targetParameters,
                RoleArn: news.roleArn,
                LogConfiguration: news.logConfiguration,
                KmsKeyIdentifier: news.kmsKeyIdentifier,
              })
              .pipe(retryUntilRoleAssumable, retryWhileConflicting);
            observed = yield* awaitSettled(pipeName);
          }

          if (observed?.Arn === undefined) {
            return yield* Effect.fail(
              new PipeFailed({
                pipeName,
                state: "MISSING",
                stateReason: `Pipe '${pipeName}' disappeared during reconciliation`,
              }),
            );
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges (never against olds/output).
          const observedTags = unwrapTags(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* pipes.tagResource({
              resourceArn: observed.Arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* pipes.untagResource({
              resourceArn: observed.Arn,
              tagKeys: removed,
            });
          }

          // 4. RETURN fresh Attributes.
          yield* session.note(observed.Arn);
          return {
            pipeName,
            pipeArn: observed.Arn,
            currentState: observed.CurrentState,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* pipes.deletePipe({ Name: output.pipeName }).pipe(
            // A delete racing an in-flight CREATE/UPDATE transition
            // returns ConflictException — retry until the pipe settles.
            retryWhileConflicting,
            Effect.catchTag("NotFoundException", () => Effect.void),
          );
          yield* awaitGone(output.pipeName);
        }),
      });
    }),
  );
