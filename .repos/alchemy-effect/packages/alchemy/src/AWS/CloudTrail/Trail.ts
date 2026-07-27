import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * A data-event resource selection inside a basic event selector. Mirrors the
 * CloudTrail `DataResource` wire shape.
 */
export interface TrailDataResource {
  /** The resource type, e.g. `AWS::S3::Object` or `AWS::Lambda::Function`. */
  type: string;
  /** ARNs (or ARN prefixes) of the resources to log data events for. */
  values?: string[];
}

/**
 * A basic event selector controlling which management/data events the trail
 * logs. Mirrors the CloudTrail `EventSelector` wire shape.
 */
export interface TrailEventSelector {
  /**
   * Whether to log read-only events, write-only events, or all.
   * @default "All"
   */
  readWriteType?: "ReadOnly" | "WriteOnly" | "All";
  /**
   * Whether the selector includes management events.
   * @default true
   */
  includeManagementEvents?: boolean;
  /** Data-event resources to log (S3 objects, Lambda functions, …). */
  dataResources?: TrailDataResource[];
  /**
   * Management event sources to exclude (`kms.amazonaws.com`,
   * `rdsdata.amazonaws.com`).
   */
  excludeManagementEventSources?: string[];
}

/**
 * A field selector inside an advanced event selector. Mirrors the CloudTrail
 * `AdvancedFieldSelector` wire shape.
 */
export interface TrailFieldSelector {
  /**
   * The event record field to select on (e.g. `eventCategory`,
   * `resources.type`).
   */
  field: string;
  /** Exact-match values. */
  equals?: string[];
  /** Prefix-match values. */
  startsWith?: string[];
  /** Suffix-match values. */
  endsWith?: string[];
  /** Exact-mismatch values. */
  notEquals?: string[];
  /** Prefix-mismatch values. */
  notStartsWith?: string[];
  /** Suffix-mismatch values. */
  notEndsWith?: string[];
}

/**
 * An advanced event selector controlling which events the trail logs.
 * Advanced and basic event selectors are mutually exclusive.
 */
export interface TrailAdvancedEventSelector {
  /** Descriptive name for the selector. */
  name?: string;
  /** Field selectors that events must match to be logged. */
  fieldSelectors: TrailFieldSelector[];
}

/**
 * An Insights selector enabling anomaly detection on the trail's events.
 */
export interface TrailInsightSelector {
  /** The type of Insights to enable. */
  insightType: "ApiCallRateInsight" | "ApiErrorRateInsight";
}

export interface TrailProps {
  /**
   * Name of the trail. Must be 3-128 characters, contain only letters,
   * numbers, periods, underscores, and dashes, and start and end with a
   * letter or number.
   * @default ${app}-${stage}-${id}
   */
  trailName?: string;
  /**
   * Name of the Amazon S3 bucket designated for publishing log files.
   * The bucket policy must grant `cloudtrail.amazonaws.com` the
   * `s3:GetBucketAcl` and `s3:PutObject` permissions, scoped with an
   * `aws:SourceArn` condition on the trail's ARN.
   */
  s3BucketName: string;
  /**
   * Amazon S3 key prefix that follows the name of the bucket designated
   * for log file delivery.
   */
  s3KeyPrefix?: string;
  /**
   * Whether the trail publishes events from global services such as IAM
   * to the log files.
   * @default true
   */
  includeGlobalServiceEvents?: boolean;
  /**
   * Whether the trail applies to all Regions or only the Region in which
   * it was created.
   * @default false
   */
  isMultiRegionTrail?: boolean;
  /**
   * Whether log file validation (SHA-256 digest files) is enabled.
   * @default false
   */
  enableLogFileValidation?: boolean;
  /**
   * ARN of the CloudWatch Logs log group to which CloudTrail delivers
   * events. Requires `cloudWatchLogsRoleArn`.
   */
  cloudWatchLogsLogGroupArn?: string;
  /**
   * Role ARN that CloudTrail assumes to write to the CloudWatch Logs
   * log group. Requires `cloudWatchLogsLogGroupArn`.
   */
  cloudWatchLogsRoleArn?: string;
  /**
   * KMS key ID (ID, alias, or ARN) used to encrypt the log files
   * delivered by CloudTrail. Compared verbatim against the observed
   * trail's key, so prefer the full key ARN to avoid a perpetual diff.
   */
  kmsKeyId?: string;
  /**
   * Name of the Amazon SNS topic notified of new log file delivery.
   */
  snsTopicName?: string;
  /**
   * Whether the trail is created for all accounts in an organization,
   * or only for the current account.
   * @default false
   */
  isOrganizationTrail?: boolean;
  /**
   * Whether the trail is actively logging. Synced via `StartLogging` /
   * `StopLogging`.
   * @default true
   */
  isLogging?: boolean;
  /**
   * Basic event selectors, synced via `PutEventSelectors`. Mutually
   * exclusive with `advancedEventSelectors`. When omitted, the trail's
   * selectors are left untouched; pass `[]`-free defaults explicitly to
   * converge them.
   */
  eventSelectors?: TrailEventSelector[];
  /**
   * Advanced event selectors, synced via `PutEventSelectors`. Mutually
   * exclusive with `eventSelectors`. When omitted, the trail's selectors
   * are left untouched.
   */
  advancedEventSelectors?: TrailAdvancedEventSelector[];
  /**
   * Insights selectors, synced via `PutInsightSelectors`. Pass `[]` to
   * disable Insights; when omitted, the trail's Insights configuration is
   * left untouched.
   */
  insightSelectors?: TrailInsightSelector[];
  /**
   * Tags to apply to the trail. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Trail extends Resource<
  "AWS.CloudTrail.Trail",
  TrailProps,
  {
    /** Physical name of the trail. */
    trailName: string;
    /** ARN of the trail. */
    trailArn: string;
    /** The region in which the trail was created. */
    homeRegion: string;
    /** S3 bucket the trail delivers log files to. */
    s3BucketName: string;
    /** Whether the trail is currently logging. */
    isLogging: boolean;
  },
  never,
  Providers
> {}

/**
 * An AWS CloudTrail trail that records AWS API activity and delivers log
 * files to an S3 bucket.
 *
 * The destination bucket must carry a bucket policy that allows the
 * `cloudtrail.amazonaws.com` service principal to call `s3:GetBucketAcl`
 * on the bucket and `s3:PutObject` under `AWSLogs/{accountId}/*`, both
 * scoped with an `aws:SourceArn` condition on the trail's ARN.
 * @resource
 * @section Creating Trails
 * @example Basic Trail
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const bucket = yield* AWS.S3.Bucket("TrailLogs", {
 *   bucketName: `audit-logs-${accountId}`,
 *   forceDestroy: true,
 *   policy: [
 *     {
 *       Effect: "Allow",
 *       Principal: { Service: "cloudtrail.amazonaws.com" },
 *       Action: ["s3:GetBucketAcl"],
 *       Resource: `arn:aws:s3:::audit-logs-${accountId}`,
 *       Condition: { StringEquals: { "aws:SourceArn": trailArn } },
 *     },
 *     {
 *       Effect: "Allow",
 *       Principal: { Service: "cloudtrail.amazonaws.com" },
 *       Action: ["s3:PutObject"],
 *       Resource: `arn:aws:s3:::audit-logs-${accountId}/AWSLogs/${accountId}/*`,
 *       Condition: {
 *         StringEquals: {
 *           "s3:x-amz-acl": "bucket-owner-full-control",
 *           "aws:SourceArn": trailArn,
 *         },
 *       },
 *     },
 *   ],
 * });
 *
 * const trail = yield* AWS.CloudTrail.Trail("Audit", {
 *   trailName: "audit-trail",
 *   s3BucketName: bucket.bucketName,
 * });
 * ```
 *
 * @example Multi-Region Trail with Log File Validation
 * ```typescript
 * const trail = yield* AWS.CloudTrail.Trail("Audit", {
 *   trailName: "org-audit-trail",
 *   s3BucketName: bucket.bucketName,
 *   isMultiRegionTrail: true,
 *   enableLogFileValidation: true,
 * });
 * ```
 *
 * @section Controlling Logging
 * @example Pause logging without deleting the trail
 * ```typescript
 * const trail = yield* AWS.CloudTrail.Trail("Audit", {
 *   trailName: "audit-trail",
 *   s3BucketName: bucket.bucketName,
 *   isLogging: false,
 * });
 * ```
 *
 * @section Selecting Events
 * @example Advanced Event Selectors and Insights
 * ```typescript
 * const trail = yield* AWS.CloudTrail.Trail("Audit", {
 *   trailName: "audit-trail",
 *   s3BucketName: bucket.bucketName,
 *   advancedEventSelectors: [
 *     {
 *       name: "Management events only",
 *       fieldSelectors: [
 *         { field: "eventCategory", equals: ["Management"] },
 *       ],
 *     },
 *   ],
 *   insightSelectors: [{ insightType: "ApiCallRateInsight" }],
 * });
 * ```
 */
export const Trail = Resource<Trail>("AWS.CloudTrail.Trail");

/**
 * S3 bucket-policy propagation is eventually consistent: `CreateTrail` /
 * `UpdateTrail` can transiently reject a bucket whose policy was written
 * moments earlier with `InsufficientS3BucketPolicyException` (or
 * `S3BucketDoesNotExistException` right after bucket creation).
 *
 * Expressed as an explicitly-typed helper: inlining `Effect.retry` here
 * leaves `Retry.Return`'s conditional type unresolved in the provider's
 * inferred layer type, which TypeScript's declaration emit widens to an
 * `unknown` R — poisoning the whole `AWS.providers()` union for every
 * downstream consumer.
 */
const retryThroughBucketPropagation = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "InsufficientS3BucketPolicyException" ||
      e._tag === "S3BucketDoesNotExistException" ||
      e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

/**
 * Trail deletion right after a Start/StopLogging call (or another
 * concurrent mutation) can raise a transient `ConflictException`.
 */
const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

const toWireEventSelectors = (
  selectors: TrailEventSelector[],
): cloudtrail.EventSelector[] =>
  selectors.map((s) => ({
    ReadWriteType: s.readWriteType,
    IncludeManagementEvents: s.includeManagementEvents,
    DataResources: s.dataResources?.map((r) => ({
      Type: r.type,
      Values: r.values,
    })),
    ExcludeManagementEventSources: s.excludeManagementEventSources,
  }));

const toWireAdvancedSelectors = (
  selectors: TrailAdvancedEventSelector[],
): cloudtrail.AdvancedEventSelector[] =>
  selectors.map((s) => ({
    Name: s.name,
    FieldSelectors: s.fieldSelectors.map((f) => ({
      Field: f.field,
      Equals: f.equals,
      StartsWith: f.startsWith,
      EndsWith: f.endsWith,
      NotEquals: f.notEquals,
      NotStartsWith: f.notStartsWith,
      NotEndsWith: f.notEndsWith,
    })),
  }));

export const TrailProvider = () =>
  Provider.effect(
    Trail,
    Effect.gen(function* () {
      const createTrailName = Effect.fn(function* (
        id: string,
        props: { trailName?: string | undefined },
      ) {
        if (props.trailName) {
          return props.trailName;
        }
        return yield* createPhysicalName({ id, maxLength: 128 });
      });

      const fetchObservedTags = (trailArn: string) =>
        cloudtrail.listTags({ ResourceIdList: [trailArn] }).pipe(
          Effect.map((r) => {
            const tags: Record<string, string> = {};
            for (const t of r.ResourceTagList?.[0]?.TagsList ?? []) {
              tags[t.Key] = t.Value ?? "";
            }
            return tags;
          }),
          Effect.catch(() => Effect.succeed({} as Record<string, string>)),
        );

      const readTrail = (name: string) =>
        cloudtrail.getTrail({ Name: name }).pipe(
          Effect.map((r) => r.Trail),
          Effect.catchTag("TrailNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      const toAttributes = Effect.fn(function* (trail: cloudtrail.Trail) {
        const name = trail.Name!;
        const isLogging = yield* cloudtrail
          .getTrailStatus({ Name: trail.TrailARN ?? name })
          .pipe(
            Effect.map((s) => s.IsLogging ?? false),
            Effect.catchTag("TrailNotFoundException", () =>
              Effect.succeed(false),
            ),
          );
        return {
          trailName: name,
          trailArn: trail.TrailARN!,
          homeRegion: trail.HomeRegion!,
          s3BucketName: trail.S3BucketName!,
          isLogging,
        };
      });

      return Trail.Provider.of({
        stables: ["trailName", "trailArn", "homeRegion"],
        list: () =>
          Effect.gen(function* () {
            const trails = yield* cloudtrail
              .describeTrails({ includeShadowTrails: false })
              .pipe(Effect.map((r) => r.trailList ?? []));
            return yield* Effect.forEach(
              trails.filter(
                (t) => t.Name !== undefined && t.TrailARN !== undefined,
              ),
              (t) => toAttributes(t),
              { concurrency: 5 },
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.trailName ?? (yield* createTrailName(id, olds ?? {}));
          const trail = yield* readTrail(name);
          if (trail === undefined) return undefined;
          const attrs = yield* toAttributes(trail);
          const tags = yield* fetchObservedTags(attrs.trailArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createTrailName(id, olds ?? {});
          const newName = yield* createTrailName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // Everything else is mutable via UpdateTrail / Start/StopLogging.
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.trailName ?? (yield* createTrailName(id, news));
          const internalTags = yield* createInternalTags(id);

          // Desired settings, with AWS defaults made explicit so removing a
          // prop converges back to the default.
          const desired = {
            S3BucketName: news.s3BucketName,
            S3KeyPrefix: news.s3KeyPrefix,
            IncludeGlobalServiceEvents: news.includeGlobalServiceEvents ?? true,
            IsMultiRegionTrail: news.isMultiRegionTrail ?? false,
            EnableLogFileValidation: news.enableLogFileValidation ?? false,
            CloudWatchLogsLogGroupArn: news.cloudWatchLogsLogGroupArn,
            CloudWatchLogsRoleArn: news.cloudWatchLogsRoleArn,
            KmsKeyId: news.kmsKeyId,
            SnsTopicName: news.snsTopicName,
            IsOrganizationTrail: news.isOrganizationTrail ?? false,
          };

          // 1. OBSERVE — cloud state is authoritative.
          let trail = yield* readTrail(name);

          // 2. ENSURE — create if missing; tolerate the AlreadyExists race.
          if (trail === undefined) {
            yield* session.note(`Creating CloudTrail trail ${name}`);
            yield* retryThroughBucketPropagation(
              cloudtrail.createTrail({
                Name: name,
                ...desired,
                TagsList: Object.entries({
                  ...news.tags,
                  ...internalTags,
                }).map(([Key, Value]) => ({ Key, Value })),
              }),
            ).pipe(
              Effect.catchTag("TrailAlreadyExistsException", () => Effect.void),
            );
            trail = yield* readTrail(name);
          }
          if (trail === undefined) {
            // The trail vanished between create and re-read — surface the
            // typed not-found from a direct get instead of inventing one.
            trail = (yield* cloudtrail.getTrail({ Name: name })).Trail!;
          }

          // 3. SYNC settings — diff observed against desired, push only the
          // fields that actually changed (UpdateTrail leaves omitted fields
          // untouched, except booleans which we always pin to desired).
          const settingsDelta: Partial<
            Omit<cloudtrail.UpdateTrailRequest, "Name">
          > = {};
          if (trail.S3BucketName !== desired.S3BucketName) {
            settingsDelta.S3BucketName = desired.S3BucketName;
          }
          if ((trail.S3KeyPrefix ?? "") !== (desired.S3KeyPrefix ?? "")) {
            settingsDelta.S3KeyPrefix = desired.S3KeyPrefix ?? "";
          }
          if (
            (trail.IncludeGlobalServiceEvents ?? true) !==
            desired.IncludeGlobalServiceEvents
          ) {
            settingsDelta.IncludeGlobalServiceEvents =
              desired.IncludeGlobalServiceEvents;
          }
          if (
            (trail.IsMultiRegionTrail ?? false) !== desired.IsMultiRegionTrail
          ) {
            settingsDelta.IsMultiRegionTrail = desired.IsMultiRegionTrail;
          }
          if (
            (trail.LogFileValidationEnabled ?? false) !==
            desired.EnableLogFileValidation
          ) {
            settingsDelta.EnableLogFileValidation =
              desired.EnableLogFileValidation;
          }
          if (
            desired.CloudWatchLogsLogGroupArn !== undefined &&
            trail.CloudWatchLogsLogGroupArn !==
              desired.CloudWatchLogsLogGroupArn
          ) {
            settingsDelta.CloudWatchLogsLogGroupArn =
              desired.CloudWatchLogsLogGroupArn;
            settingsDelta.CloudWatchLogsRoleArn = desired.CloudWatchLogsRoleArn;
          }
          if (
            desired.KmsKeyId !== undefined &&
            trail.KmsKeyId !== desired.KmsKeyId
          ) {
            settingsDelta.KmsKeyId = desired.KmsKeyId;
          }
          if (
            (trail.IsOrganizationTrail ?? false) !== desired.IsOrganizationTrail
          ) {
            settingsDelta.IsOrganizationTrail = desired.IsOrganizationTrail;
          }
          if (
            desired.SnsTopicName !== undefined &&
            trail.SnsTopicName !== desired.SnsTopicName
          ) {
            settingsDelta.SnsTopicName = desired.SnsTopicName;
          }
          if (Object.keys(settingsDelta).length > 0) {
            yield* session.note(
              `Updating trail settings: ${Object.keys(settingsDelta).join(", ")}`,
            );
            yield* retryThroughBucketPropagation(
              cloudtrail.updateTrail({ Name: name, ...settingsDelta }),
            );
            trail = (yield* cloudtrail.getTrail({ Name: name })).Trail ?? trail;
          }

          const trailArn = trail.TrailARN!;

          // 3b. SYNC logging state via Start/StopLogging.
          const desiredLogging = news.isLogging ?? true;
          const observedLogging = yield* cloudtrail
            .getTrailStatus({ Name: trailArn })
            .pipe(Effect.map((s) => s.IsLogging ?? false));
          if (observedLogging !== desiredLogging) {
            if (desiredLogging) {
              yield* session.note(`Starting logging for trail ${name}`);
              yield* retryWhileConflict(
                cloudtrail.startLogging({ Name: trailArn }),
              );
            } else {
              yield* session.note(`Stopping logging for trail ${name}`);
              yield* retryWhileConflict(
                cloudtrail.stopLogging({ Name: trailArn }),
              );
            }
          }

          // 3c. SYNC event selectors — only when declared (undefined leaves
          // the trail's selectors untouched). Basic and advanced selectors
          // are mutually exclusive in the API; observed cloud selectors are
          // the diff baseline.
          if (
            news.eventSelectors !== undefined ||
            news.advancedEventSelectors !== undefined
          ) {
            const observedSelectors = yield* cloudtrail.getEventSelectors({
              TrailName: trailArn,
            });
            if (news.advancedEventSelectors !== undefined) {
              const desiredAdvanced = toWireAdvancedSelectors(
                news.advancedEventSelectors,
              );
              if (
                JSON.stringify(
                  observedSelectors.AdvancedEventSelectors ?? [],
                ) !== JSON.stringify(desiredAdvanced)
              ) {
                yield* session.note(`Updating advanced event selectors`);
                yield* retryWhileConflict(
                  cloudtrail.putEventSelectors({
                    TrailName: trailArn,
                    AdvancedEventSelectors: desiredAdvanced,
                  }),
                );
              }
            } else {
              const desiredBasic = toWireEventSelectors(news.eventSelectors!);
              if (
                JSON.stringify(observedSelectors.EventSelectors ?? []) !==
                JSON.stringify(desiredBasic)
              ) {
                yield* session.note(`Updating event selectors`);
                yield* retryWhileConflict(
                  cloudtrail.putEventSelectors({
                    TrailName: trailArn,
                    EventSelectors: desiredBasic,
                  }),
                );
              }
            }
          }

          // 3d. SYNC Insights selectors — only when declared. `[]` disables
          // Insights; a trail with Insights disabled reads as [] (the typed
          // InsightNotEnabledException).
          if (news.insightSelectors !== undefined) {
            const observedInsights = yield* cloudtrail
              .getInsightSelectors({ TrailName: trailArn })
              .pipe(
                Effect.map((r) => r.InsightSelectors ?? []),
                Effect.catchTag("InsightNotEnabledException", () =>
                  Effect.succeed([] as cloudtrail.InsightSelector[]),
                ),
              );
            const desiredInsights = news.insightSelectors.map((s) => ({
              InsightType: s.insightType,
            }));
            if (
              JSON.stringify(
                observedInsights.map((s) => s.InsightType).sort(),
              ) !==
              JSON.stringify(desiredInsights.map((s) => s.InsightType).sort())
            ) {
              yield* session.note(`Updating Insights selectors`);
              yield* retryWhileConflict(
                cloudtrail.putInsightSelectors({
                  TrailName: trailArn,
                  InsightSelectors: desiredInsights,
                }),
              );
            }
          }

          // 3e. SYNC tags against OBSERVED cloud tags (adoption-safe).
          const observedTags = yield* fetchObservedTags(trailArn);
          const { upsert, removed } = diffTags(observedTags, {
            ...news.tags,
            ...internalTags,
          });
          if (upsert.length > 0) {
            yield* cloudtrail.addTags({
              ResourceId: trailArn,
              TagsList: upsert.map((t) => ({ Key: t.Key, Value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* cloudtrail.removeTags({
              ResourceId: trailArn,
              TagsList: removed.map((Key) => ({ Key })),
            });
          }

          yield* session.note(trailArn);
          return {
            trailName: name,
            trailArn,
            homeRegion: trail.HomeRegion!,
            s3BucketName: trail.S3BucketName!,
            isLogging: desiredLogging,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* retryWhileConflict(
            cloudtrail.deleteTrail({ Name: output.trailArn }),
          ).pipe(
            Effect.catchTag("TrailNotFoundException", () => Effect.void),
            // A stale ARN whose trail is already gone can also surface as an
            // invalid-ARN complaint; both mean "nothing left to delete".
            Effect.catchTag("CloudTrailARNInvalidException", () => Effect.void),
          );
        }),
      });
    }),
  );
