import * as codebuild from "@distilled.cloud/aws/codebuild";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";

/**
 * Where CodeBuild exports the raw report data.
 */
export interface ReportGroupExportConfig {
  /**
   * `NO_EXPORT` keeps report data only in CodeBuild (30-day retention);
   * `S3` additionally exports the raw data to a bucket.
   * @default "NO_EXPORT"
   */
  exportConfigType?: "NO_EXPORT" | "S3";
  /**
   * S3 destination for exported report data (for `exportConfigType: "S3"`).
   */
  s3Destination?: {
    /** Name of the destination bucket. */
    bucket?: string;
    /** AWS account that owns the bucket, when not the report's account. */
    bucketOwner?: string;
    /** Path prefix inside the bucket. */
    path?: string;
    /**
     * Whether the exported data is zipped.
     * @default "NONE"
     */
    packaging?: "ZIP" | "NONE";
    /** KMS key used to encrypt the exported data. */
    encryptionKey?: string;
    /** Disable encryption of the exported data. */
    encryptionDisabled?: boolean;
  };
}

export interface ReportGroupProps {
  /**
   * Name of the report group (2-128 chars). Builds address it from the
   * buildspec `reports:` section as `<project-name>-<group-name>` or by this
   * exact name. If omitted a deterministic physical name is generated.
   * Changing the name replaces the report group.
   */
  reportGroupName?: string;
  /**
   * What the group's reports contain: test results or code coverage.
   * Changing the type replaces the report group.
   */
  type: "TEST" | "CODE_COVERAGE";
  /**
   * Where raw report data is exported.
   * @default { exportConfigType: "NO_EXPORT" }
   */
  exportConfig?: ReportGroupExportConfig;
  /**
   * Also delete any reports in the group when the group is destroyed.
   * @default true
   */
  deleteReports?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface ReportGroup extends Resource<
  "AWS.CodeBuild.ReportGroup",
  ReportGroupProps,
  {
    /** Physical name of the report group. */
    reportGroupName: string;
    /** ARN of the report group. */
    reportGroupArn: string;
  }
> {}

/**
 * An AWS CodeBuild report group — a named collection of test or
 * code-coverage reports produced by builds. A build's buildspec `reports:`
 * section uploads its test results into a report group, and the report-read
 * bindings ({@link BatchGetReports}, {@link DescribeTestCases}, …) let
 * runtime code query them.
 *
 * @resource
 * @section Creating a Report Group
 * @example Test Report Group
 * ```typescript
 * const reports = yield* CodeBuild.ReportGroup("UnitTests", {
 *   type: "TEST",
 * });
 * ```
 *
 * @example Coverage Group Exported to S3
 * ```typescript
 * const coverage = yield* CodeBuild.ReportGroup("Coverage", {
 *   type: "CODE_COVERAGE",
 *   exportConfig: {
 *     exportConfigType: "S3",
 *     s3Destination: { bucket: bucket.bucketName, packaging: "ZIP" },
 *   },
 * });
 * ```
 */
export const ReportGroup = Resource<ReportGroup>("AWS.CodeBuild.ReportGroup");

/** Convert a CodeBuild wire tag list into a plain record. */
const toTagRecord = (
  tags: ReadonlyArray<{ key?: string; value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { key: string; value: string } =>
          typeof tag.key === "string" && typeof tag.value === "string",
      )
      .map((tag) => [tag.key, tag.value]),
  );

const toWireTags = (tags: Record<string, string>): codebuild.Tag[] =>
  Object.entries(tags).map(([key, value]) => ({ key, value }));

const toWireExportConfig = (
  exportConfig: ReportGroupExportConfig | undefined,
): codebuild.ReportExportConfig => ({
  exportConfigType: exportConfig?.exportConfigType ?? "NO_EXPORT",
  s3Destination: exportConfig?.s3Destination,
});

/** Builds a report group's ARN from its name in the ambient account/region. */
const reportGroupArn = Effect.fn(function* (name: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:codebuild:${region}:${accountId}:report-group/${name}`;
});

/** Structural comparison for the export-config sync no-op check. */
const sameExportConfig = (
  observed: codebuild.ReportExportConfig | undefined,
  desired: codebuild.ReportExportConfig,
): boolean =>
  (observed?.exportConfigType ?? "NO_EXPORT") === desired.exportConfigType &&
  JSON.stringify(observed?.s3Destination ?? null) ===
    JSON.stringify(desired.s3Destination ?? null);

const sameTags = (
  observed: Record<string, string>,
  desired: Record<string, string>,
): boolean =>
  Object.keys(observed).length === Object.keys(desired).length &&
  Object.entries(desired).every(([k, v]) => observed[k] === v);

export const ReportGroupProvider = () =>
  Provider.effect(
    ReportGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ReportGroupProps>) =>
        props.reportGroupName
          ? Effect.succeed(props.reportGroupName)
          : createPhysicalName({ id, maxLength: 128 });

      /** Read a report group by ARN; missing or DELETING reads as absent. */
      const getReportGroup = Effect.fn(function* (arn: string) {
        const response = yield* codebuild.batchGetReportGroups({
          reportGroupArns: [arn],
        });
        const group = response.reportGroups?.[0];
        return group?.status === "DELETING" ? undefined : group;
      });

      return {
        stables: ["reportGroupName", "reportGroupArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !==
              (yield* toName(id, news ?? {})) ||
            olds?.type !== news.type
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.reportGroupName ?? (yield* toName(id, olds ?? {}));
          const arn = output?.reportGroupArn ?? (yield* reportGroupArn(name));
          const group = yield* getReportGroup(arn);
          if (group === undefined || group.arn === undefined) {
            return undefined;
          }
          const attrs = {
            reportGroupName: group.name ?? name,
            reportGroupArn: group.arn,
          };
          const tags = toTagRecord(group.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.reportGroupName ?? (yield* toName(id, news));
          const arn = output?.reportGroupArn ?? (yield* reportGroupArn(name));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredExport = toWireExportConfig(news.exportConfig);

          // 1. Observe — cloud state is authoritative.
          let observed = yield* getReportGroup(arn);

          // 3. Sync — diff observed export config + tags against desired
          // and skip the API entirely on a no-op. updateReportGroup is a
          // full upsert of both mutable aspects. A delete→redeploy race can
          // leave batchGetReportGroups returning the just-deleted group;
          // updateReportGroup then reports the truth with a typed
          // ResourceNotFoundException — treat it as missing.
          if (
            observed !== undefined &&
            (!sameExportConfig(observed.exportConfig, desiredExport) ||
              !sameTags(toTagRecord(observed.tags), desiredTags))
          ) {
            observed = yield* codebuild
              .updateReportGroup({
                arn,
                exportConfig: desiredExport,
                tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.map((res) => res.reportGroup),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
          }

          // 2. Ensure — create if missing; tolerate the create/create race.
          if (observed === undefined) {
            observed = yield* codebuild
              .createReportGroup({
                name,
                type: news.type,
                exportConfig: desiredExport,
                tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.map((res) => res.reportGroup),
                Effect.catchTag("ResourceAlreadyExistsException", () =>
                  getReportGroup(arn),
                ),
              );
          }

          if (observed === undefined || observed.arn === undefined) {
            return yield* Effect.fail(
              new Error(
                `CodeBuild report group '${name}' disappeared while reconciling`,
              ),
            );
          }

          yield* session.note(name);
          return {
            reportGroupName: observed.name ?? name,
            reportGroupArn: observed.arn,
          };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          // deleteReportGroup is idempotent — deleting a missing group
          // returns success. `deleteReports` clears contained reports first
          // (a non-empty group cannot be deleted otherwise).
          yield* codebuild.deleteReportGroup({
            arn: output.reportGroupArn,
            deleteReports: olds.deleteReports ?? true,
          });
        }),

        list: () =>
          codebuild.listReportGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.reportGroups ?? []),
            ),
            Effect.flatMap((arns) =>
              arns.length === 0
                ? Effect.succeed(
                    [] as { reportGroupName: string; reportGroupArn: string }[],
                  )
                : Effect.forEach(
                    // batchGetReportGroups accepts up to 100 ARNs per call.
                    chunkArns(arns, 100),
                    (batch) =>
                      codebuild
                        .batchGetReportGroups({ reportGroupArns: batch })
                        .pipe(Effect.map((res) => res.reportGroups ?? [])),
                    { concurrency: 2 },
                  ).pipe(
                    Effect.map((results) =>
                      results.flat().flatMap((g) =>
                        g.name !== undefined && g.arn !== undefined
                          ? [
                              {
                                reportGroupName: g.name,
                                reportGroupArn: g.arn,
                              },
                            ]
                          : [],
                      ),
                    ),
                  ),
            ),
          ),
      };
    }),
  );

/** Split a list into fixed-size chunks. */
const chunkArns = (arns: string[], size: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < arns.length; i += size) {
    chunks.push(arns.slice(i, i + size));
  }
  return chunks;
};
