import * as cur from "@distilled.cloud/aws/cost-and-usage-report-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { Region } from "../Region.ts";

// The Cost and Usage Report API (`cur`) is a global service hosted only in
// us-east-1 (the report's delivery bucket may live in any region — that is
// what `s3Region` describes). Every control-plane call is pinned there
// regardless of the ambient stack region. The distilled Region service value
// is `Effect<RegionName>`, not a raw string, hence Effect.succeed.
const CUR_REGION = "us-east-1";
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(CUR_REGION)));

// PutReportDefinition validates that the delivery bucket's policy grants
// billingreports.amazonaws.com access. A policy applied moments earlier (the
// usual case — the bucket is deployed in the same stack) can still be
// propagating, surfacing as a bucket-mentioning ValidationException (patched
// in distilled into the typed ReportBucketNotVerified tag). Bounded retry:
// 8 recurrences x 3s ≈ 24s. Explicit return annotation so the Retry.Return
// conditional type never leaks into declaration emit.
const retryBucketVerification = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ReportBucketNotVerified",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
  });

export interface ReportDefinitionProps {
  /**
   * Name of the report (also the prefix of the report files in S3). Must be
   * unique in the account; up to 256 characters of `A-Za-z0-9!\-_.*'()`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID.
   *
   * Changing the name replaces the report definition.
   */
  reportName?: string;
  /**
   * The granularity of line items in the report.
   */
  timeUnit: "HOURLY" | "DAILY" | "MONTHLY" | (string & {});
  /**
   * The format the report files are generated in.
   */
  format: "textORcsv" | "Parquet" | (string & {});
  /**
   * The compression applied to the report files. Must be `Parquet` when
   * `format` is `Parquet`.
   */
  compression: "ZIP" | "GZIP" | "Parquet" | (string & {});
  /**
   * Additional detail included in the report, e.g. `["RESOURCES"]` to include
   * individual resource IDs.
   * @default []
   */
  additionalSchemaElements?: (
    | "RESOURCES"
    | "SPLIT_COST_ALLOCATION_DATA"
    | "MANUAL_DISCOUNT_COMPATIBILITY"
    | (string & {})
  )[];
  /**
   * Name of the S3 bucket the report is delivered to. The bucket policy must
   * allow `billingreports.amazonaws.com` to call `s3:GetBucketAcl`,
   * `s3:GetBucketPolicy`, and `s3:PutObject`.
   */
  s3Bucket: string;
  /**
   * S3 key prefix the report files are delivered under.
   */
  s3Prefix: string;
  /**
   * The region the delivery bucket lives in, e.g. `us-east-1`.
   */
  s3Region: string;
  /**
   * Artifacts AWS additionally prepares the report for (`REDSHIFT`,
   * `QUICKSIGHT`, or `ATHENA`). `ATHENA` requires Parquet format/compression
   * and `OVERWRITE_REPORT` versioning, and cannot be combined with the other
   * artifacts.
   */
  additionalArtifacts?: (
    | "REDSHIFT"
    | "QUICKSIGHT"
    | "ATHENA"
    | (string & {})
  )[];
  /**
   * Whether AWS updates previously delivered reports when charges are applied
   * retroactively (refunds, credits, RI fees).
   * @default true
   */
  refreshClosedReports?: boolean;
  /**
   * Whether each report update overwrites the previous version
   * (`OVERWRITE_REPORT`) or is delivered alongside it (`CREATE_NEW_REPORT`).
   * @default "CREATE_NEW_REPORT"
   */
  reportVersioning?: "CREATE_NEW_REPORT" | "OVERWRITE_REPORT" | (string & {});
  /**
   * ARN of the billing view the report is scoped to. Omit for the account's
   * primary billing view.
   *
   * Changing the billing view replaces the report definition.
   */
  billingViewArn?: string;
  /**
   * Tags to apply to the report definition.
   */
  tags?: Record<string, string>;
}

export interface ReportDefinition extends Resource<
  "AWS.CostAndUsageReport.ReportDefinition",
  ReportDefinitionProps,
  {
    /** Name of the report definition. */
    reportName: string;
    /** ARN of the report definition. */
    reportArn: string;
    /** Granularity of the report (`HOURLY`, `DAILY`, `MONTHLY`). */
    timeUnit: string;
    /** File format of the report (`textORcsv` or `Parquet`). */
    format: string;
    /** Compression applied to report files (`ZIP`, `GZIP`, `Parquet`). */
    compression: string;
    /** Name of the S3 bucket the report is delivered to. */
    s3Bucket: string;
    /** S3 key prefix the report is delivered under. */
    s3Prefix: string;
    /** Region of the delivery S3 bucket. */
    s3Region: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Cost and Usage Report (CUR) definition — the most granular billing
 * data AWS offers, delivered as CSV or Parquet files to an S3 bucket you own.
 *
 * The CUR API is a global service hosted only in `us-east-1`; this resource
 * pins every control-plane call there regardless of the stack region. The
 * delivery bucket may live in any region (declared via `s3Region`) but its
 * bucket policy must grant `billingreports.amazonaws.com` the
 * `s3:GetBucketAcl`, `s3:GetBucketPolicy`, and `s3:PutObject` permissions —
 * report creation fails validation otherwise.
 *
 * Report definitions are free; you pay only for the S3 storage of delivered
 * reports.
 *
 * @resource
 * @section Creating a Report
 * @example Daily CSV report with resource IDs
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const bucket = yield* AWS.S3.Bucket("ReportBucket", {
 *   bucketName: "my-cur-reports",
 *   policy: [
 *     {
 *       Effect: "Allow",
 *       Principal: { Service: "billingreports.amazonaws.com" },
 *       Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
 *       Resource: "arn:aws:s3:::my-cur-reports",
 *     },
 *     {
 *       Effect: "Allow",
 *       Principal: { Service: "billingreports.amazonaws.com" },
 *       Action: ["s3:PutObject"],
 *       Resource: "arn:aws:s3:::my-cur-reports/*",
 *     },
 *   ],
 * });
 *
 * const report = yield* AWS.CostAndUsageReport.ReportDefinition("Costs", {
 *   timeUnit: "DAILY",
 *   format: "textORcsv",
 *   compression: "GZIP",
 *   additionalSchemaElements: ["RESOURCES"],
 *   s3Bucket: bucket.bucketName,
 *   s3Prefix: "cur",
 *   s3Region: bucket.region,
 * });
 * ```
 *
 * @example Athena-ready Parquet report
 * ```typescript
 * const report = yield* AWS.CostAndUsageReport.ReportDefinition("Athena", {
 *   timeUnit: "HOURLY",
 *   format: "Parquet",
 *   compression: "Parquet",
 *   additionalArtifacts: ["ATHENA"],
 *   reportVersioning: "OVERWRITE_REPORT",
 *   s3Bucket: bucket.bucketName,
 *   s3Prefix: "athena-cur",
 *   s3Region: bucket.region,
 * });
 * ```
 */
export const ReportDefinition = Resource<ReportDefinition>(
  "AWS.CostAndUsageReport.ReportDefinition",
);

const toTagRecord = (tags: cur.Tag[] | undefined): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

const setEquals = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => {
  const l = [...(left ?? [])].sort();
  const r = [...(right ?? [])].sort();
  return l.length === r.length && l.every((v, i) => v === r[i]);
};

export const ReportDefinitionProvider = () =>
  Provider.effect(
    ReportDefinition,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { reportName?: string | undefined },
      ) {
        return (
          props.reportName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const reportArn = (accountId: string, name: string) =>
        `arn:aws:cur:${CUR_REGION}:${accountId}:definition/${name}`;

      // There is no Get operation — observe by scanning the (small,
      // account-max ~10 entries) paginated list.
      const findReport = Effect.fn(function* (name: string) {
        const pages = yield* pin(
          cur.describeReportDefinitions.pages({}).pipe(Stream.runCollect),
        );
        return Array.from(pages)
          .flatMap((page) => page.ReportDefinitions ?? [])
          .find((r) => r.ReportName === name);
      });

      const readTags = (name: string) =>
        pin(cur.listTagsForResource({ ReportName: name })).pipe(
          Effect.map((r) => toTagRecord(r.Tags)),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const buildDefinition = (
        name: string,
        props: ReportDefinitionProps,
      ): cur.ReportDefinition => ({
        ReportName: name,
        TimeUnit: props.timeUnit,
        Format: props.format,
        Compression: props.compression,
        AdditionalSchemaElements: props.additionalSchemaElements ?? [],
        S3Bucket: props.s3Bucket,
        S3Prefix: props.s3Prefix,
        S3Region: props.s3Region,
        AdditionalArtifacts: props.additionalArtifacts,
        RefreshClosedReports: props.refreshClosedReports,
        ReportVersioning: props.reportVersioning,
        BillingViewArn: props.billingViewArn,
      });

      const needsModify = (
        observed: cur.ReportDefinition,
        desired: cur.ReportDefinition,
      ): boolean =>
        observed.TimeUnit !== desired.TimeUnit ||
        observed.Format !== desired.Format ||
        observed.Compression !== desired.Compression ||
        observed.S3Bucket !== desired.S3Bucket ||
        observed.S3Prefix !== desired.S3Prefix ||
        observed.S3Region !== desired.S3Region ||
        !setEquals(
          observed.AdditionalSchemaElements,
          desired.AdditionalSchemaElements,
        ) ||
        !setEquals(observed.AdditionalArtifacts, desired.AdditionalArtifacts) ||
        (desired.RefreshClosedReports !== undefined &&
          observed.RefreshClosedReports !== desired.RefreshClosedReports) ||
        (desired.ReportVersioning !== undefined &&
          observed.ReportVersioning !== desired.ReportVersioning);

      const toAttributes = (
        accountId: string,
        observed: cur.ReportDefinition,
      ) => ({
        reportName: observed.ReportName,
        reportArn: reportArn(accountId, observed.ReportName),
        timeUnit: observed.TimeUnit,
        format: observed.Format,
        compression: observed.Compression,
        s3Bucket: observed.S3Bucket,
        s3Prefix: observed.S3Prefix,
        s3Region: observed.S3Region,
      });

      const syncTags = Effect.fn(function* (
        name: string,
        desiredTags: Record<string, string>,
      ) {
        // Diff against OBSERVED cloud tags — adoption may bring foreign tags.
        const observedTags = yield* readTags(name);
        const { upsert, removed } = diffTags(observedTags, desiredTags);
        if (upsert.length > 0) {
          yield* pin(cur.tagResource({ ReportName: name, Tags: upsert }));
        }
        if (removed.length > 0) {
          yield* pin(cur.untagResource({ ReportName: name, TagKeys: removed }));
        }
      });

      return ReportDefinition.Provider.of({
        stables: ["reportName", "reportArn"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const pages = yield* pin(
              cur.describeReportDefinitions.pages({}).pipe(Stream.runCollect),
            );
            return Array.from(pages)
              .flatMap((page) => page.ReportDefinitions ?? [])
              .map((r) => toAttributes(accountId, r));
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name =
            output?.reportName ?? (yield* createName(id, olds ?? {}));
          const observed = yield* findReport(name);
          if (!observed) return undefined;
          const attrs = toAttributes(accountId, observed);
          const tags = yield* readTags(name);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if (olds && olds.billingViewArn !== news.billingViewArn) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output?.reportName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desired = buildDefinition(name, news);

          // OBSERVE — cloud state is authoritative; output is only a name cache.
          const observed = yield* findReport(name);

          if (!observed) {
            // ENSURE — create; tolerate the duplicate-name race by converging
            // through modify instead.
            yield* retryBucketVerification(
              pin(
                cur.putReportDefinition({
                  ReportDefinition: desired,
                  Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                    Key,
                    Value,
                  })),
                }),
              ),
            ).pipe(
              Effect.catchTag("DuplicateReportNameException", () =>
                pin(
                  cur.modifyReportDefinition({
                    ReportName: name,
                    ReportDefinition: desired,
                  }),
                ),
              ),
            );
          } else if (needsModify(observed, desired)) {
            // SYNC — apply the delta only; skip the API entirely on no-op.
            yield* retryBucketVerification(
              pin(
                cur.modifyReportDefinition({
                  ReportName: name,
                  ReportDefinition: desired,
                }),
              ),
            );
          }

          // SYNC TAGS — against observed cloud tags.
          yield* syncTags(name, desiredTags);

          yield* session.note(name);
          const final = yield* findReport(name);
          return toAttributes(accountId, final ?? desired);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent: DeleteReportDefinition's error semantics for a missing
          // report are undocumented, so observe first and treat absent as done.
          const observed = yield* findReport(output.reportName);
          if (!observed) return;
          yield* pin(
            cur.deleteReportDefinition({ ReportName: output.reportName }),
          );
        }),
      });
    }),
  );
