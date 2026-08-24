import { Region } from "@distilled.cloud/aws/Region";
import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface MultiRegionAccessPointProps {
  /**
   * Name of the Multi-Region Access Point (3-50 characters, lowercase
   * letters, numbers and hyphens). If omitted, a unique name is generated
   * from the app, stage and logical ID.
   *
   * Changing the name replaces the Multi-Region Access Point.
   * @default ${app}-${stage}-${id}
   */
  multiRegionAccessPointName?: string;
  /**
   * The buckets (at most one per region, up to 20 regions) the
   * Multi-Region Access Point routes requests to.
   *
   * Changing the regions replaces the Multi-Region Access Point.
   */
  regions: {
    /** Name of the bucket in one of the member regions. */
    bucket: string;
    /** Account ID that owns the bucket, for cross-account buckets. */
    bucketAccountId?: string;
  }[];
  /**
   * Block-public-access settings. AWS defaults every flag to `true` for
   * Multi-Region Access Points when omitted.
   *
   * Changing these settings replaces the Multi-Region Access Point.
   */
  publicAccessBlock?: {
    /** Block new public ACLs and uploading public objects. @default true */
    blockPublicAcls?: boolean;
    /** Ignore all public ACLs. @default true */
    ignorePublicAcls?: boolean;
    /** Block new policies that grant public access. @default true */
    blockPublicPolicy?: boolean;
    /** Restrict public policies to AWS principals. @default true */
    restrictPublicBuckets?: boolean;
  };
}

export interface MultiRegionAccessPoint extends Resource<
  "AWS.S3Control.MultiRegionAccessPoint",
  MultiRegionAccessPointProps,
  {
    /**
     * Name of the Multi-Region Access Point.
     */
    multiRegionAccessPointName: string;
    /**
     * ARN of the Multi-Region Access Point (regionless, alias-addressed).
     */
    multiRegionAccessPointArn: string;
    /**
     * The S3-assigned alias of the Multi-Region Access Point. Requests are
     * addressed to `${alias}.accesspoint.s3-global.amazonaws.com`.
     */
    alias: string | undefined;
    /**
     * Provisioning status of the Multi-Region Access Point at the time of
     * the last deploy (`READY` once fully provisioned).
     */
    status: s3control.MultiRegionAccessPointStatus | undefined;
    /**
     * AWS account ID that owns the Multi-Region Access Point.
     */
    accountId: AccountID;
  },
  never,
  Providers
> {}

/**
 * An Amazon S3 Multi-Region Access Point — a single global endpoint that
 * routes requests to buckets in multiple regions over the AWS global
 * network.
 *
 * Provisioning is asynchronous and slow (several minutes); the provider
 * submits the request and waits until the access point reaches `READY`.
 * All control-plane requests are routed through `us-west-2`, as required
 * by the Multi-Region Access Point API.
 * @resource
 * @section Creating Multi-Region Access Points
 * @example Route between two regional buckets
 * ```typescript
 * import * as S3Control from "alchemy/AWS/S3Control";
 *
 * const mrap = yield* S3Control.MultiRegionAccessPoint("global", {
 *   regions: [
 *     { bucket: usWestBucket.bucketName },
 *     { bucket: euCentralBucket.bucketName },
 *   ],
 * });
 * ```
 *
 * @example Single-region Multi-Region Access Point
 * ```typescript
 * const mrap = yield* S3Control.MultiRegionAccessPoint("global", {
 *   regions: [{ bucket: bucket.bucketName }],
 * });
 * ```
 */
export const MultiRegionAccessPoint = Resource<MultiRegionAccessPoint>(
  "AWS.S3Control.MultiRegionAccessPoint",
);

/**
 * Raised while a Multi-Region Access Point is still provisioning — retried
 * by {@link retryWhileMrapTransitions} until it reaches `READY`.
 */
export class MultiRegionAccessPointNotReady extends Data.TaggedError(
  "MultiRegionAccessPointNotReady",
)<{ name: string; status: string | undefined }> {}

/**
 * Raised while a Multi-Region Access Point deletion is still in flight —
 * retried by {@link retryWhileMrapTransitions} until the report disappears.
 */
export class MultiRegionAccessPointNotDeleted extends Data.TaggedError(
  "MultiRegionAccessPointNotDeleted",
)<{ name: string; status: string | undefined }> {}

/**
 * Multi-Region Access Point provisioning/deletion legitimately takes
 * several minutes — poll every 15 seconds for up to ~20 minutes.
 *
 * Explicitly typed at module scope — inlining `Effect.retry` in a lifecycle
 * op leaks `Retry.Return`'s conditional type into declaration emit, widening
 * the provider layer to `unknown` and poisoning `AWS.providers()`.
 */
const retryWhileMrapTransitions = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "MultiRegionAccessPointNotReady" ||
      e._tag === "MultiRegionAccessPointNotDeleted",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(80)]),
  });

/**
 * All Multi-Region Access Point control-plane requests are routed to the
 * US West (Oregon) region regardless of the ambient region.
 */
const inMrapRegion = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Region>> =>
  self.pipe(Effect.provideService(Region, Effect.succeed("us-west-2")));

export const MultiRegionAccessPointProvider = () =>
  Provider.effect(
    MultiRegionAccessPoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<MultiRegionAccessPointProps, "multiRegionAccessPointName">,
      ) {
        // Multi-Region Access Point names: 3-50 chars, lowercase.
        return (
          props.multiRegionAccessPointName ??
          (yield* createPhysicalName({ id, maxLength: 50, lowercase: true }))
        );
      });

      const mrapArn = (accountId: string, alias: string | undefined) =>
        `arn:aws:s3::${accountId}:accesspoint/${alias ?? ""}`;

      const observeMrap = (accountId: string, name: string) =>
        inMrapRegion(
          s3control
            .getMultiRegionAccessPoint({ AccountId: accountId, Name: name })
            .pipe(
              Effect.map((r) => r.AccessPoint),
              Effect.catchTag("NoSuchMultiRegionAccessPoint", () =>
                Effect.succeed(undefined),
              ),
            ),
        );

      const toAttrs = (
        name: string,
        accountId: AccountID,
        report: s3control.MultiRegionAccessPointReport | undefined,
      ) => ({
        multiRegionAccessPointName: name,
        multiRegionAccessPointArn: mrapArn(accountId, report?.Alias),
        alias: report?.Alias,
        status: report?.Status,
        accountId,
      });

      // Wait until the Multi-Region Access Point reaches READY. A report
      // that is briefly missing right after the async create request is
      // treated the same as a transitioning one.
      const awaitReady = (accountId: string, name: string) =>
        retryWhileMrapTransitions(
          observeMrap(accountId, name).pipe(
            Effect.flatMap((report) =>
              report?.Status === "READY"
                ? Effect.succeed(report)
                : Effect.fail(
                    new MultiRegionAccessPointNotReady({
                      name,
                      status: report?.Status,
                    }),
                  ),
            ),
          ),
        );

      const awaitGone = (accountId: string, name: string) =>
        retryWhileMrapTransitions(
          observeMrap(accountId, name).pipe(
            Effect.flatMap((report) =>
              report === undefined
                ? Effect.void
                : Effect.fail(
                    new MultiRegionAccessPointNotDeleted({
                      name,
                      status: report.Status,
                    }),
                  ),
            ),
          ),
        );

      const canonProps = (props: MultiRegionAccessPointProps) =>
        JSON.stringify({
          regions: [...props.regions]
            .map((r) => ({
              bucket: r.bucket,
              account: r.bucketAccountId ?? null,
            }))
            .sort((a, b) => a.bucket.localeCompare(b.bucket)),
          pab: {
            a: props.publicAccessBlock?.blockPublicAcls ?? true,
            i: props.publicAccessBlock?.ignorePublicAcls ?? true,
            p: props.publicAccessBlock?.blockPublicPolicy ?? true,
            r: props.publicAccessBlock?.restrictPublicBuckets ?? true,
          },
        });

      return MultiRegionAccessPoint.Provider.of({
        stables: [
          "multiRegionAccessPointName",
          "multiRegionAccessPointArn",
          "alias",
          "accountId",
        ],
        // Multi-Region Access Points do not support tags; the deterministic
        // name is the ownership scope.
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const pages = yield* inMrapRegion(
              s3control.listMultiRegionAccessPoints
                .pages({ AccountId: accountId })
                .pipe(Stream.runCollect),
            );
            return Array.from(pages).flatMap((page) =>
              (page.AccessPoints ?? []).flatMap((report) =>
                report.Name !== undefined
                  ? [toAttrs(report.Name, accountId, report)]
                  : [],
              ),
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name =
            output?.multiRegionAccessPointName ??
            (yield* createName(id, olds ?? {}));
          const report = yield* observeMrap(accountId, name);
          if (report === undefined) return undefined;
          return toAttrs(name, accountId, report);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds !== undefined && canonProps(olds) !== canonProps(news))
          ) {
            // Every property of a Multi-Region Access Point is create-only.
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name =
            output?.multiRegionAccessPointName ?? (yield* createName(id, news));

          // 1. OBSERVE — cloud state is authoritative.
          const report = yield* observeMrap(accountId, name);

          // 2. ENSURE — submit the async create when missing. The client
          //    token only needs to be unique per submission; idempotency
          //    across crashed runs comes from observing before creating.
          if (report === undefined) {
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            yield* session.note(
              `Creating Multi-Region Access Point ${name} (takes several minutes)...`,
            );
            yield* inMrapRegion(
              s3control.createMultiRegionAccessPoint({
                AccountId: accountId,
                ClientToken: clientToken,
                Details: {
                  Name: name,
                  Regions: news.regions.map((r) => ({
                    Bucket: r.bucket,
                    BucketAccountId: r.bucketAccountId,
                  })),
                  PublicAccessBlock: news.publicAccessBlock
                    ? {
                        BlockPublicAcls: news.publicAccessBlock.blockPublicAcls,
                        IgnorePublicAcls:
                          news.publicAccessBlock.ignorePublicAcls,
                        BlockPublicPolicy:
                          news.publicAccessBlock.blockPublicPolicy,
                        RestrictPublicBuckets:
                          news.publicAccessBlock.restrictPublicBuckets,
                      }
                    : undefined,
                },
              }),
            );
          }

          // 3. WAIT — converge to READY (also covers resuming a reconcile
          //    that crashed while a previous create was still in flight).
          const ready = yield* awaitReady(accountId, name);

          yield* session.note(name);
          return toAttrs(name, accountId, ready);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output.multiRegionAccessPointName;

          const report = yield* observeMrap(accountId, name);
          if (report === undefined) return;

          // Deletion is also asynchronous; only submit when the access
          // point is not already being torn down.
          if (report.Status !== "DELETING") {
            const clientToken = yield* Effect.sync(() => crypto.randomUUID());
            yield* session.note(
              `Deleting Multi-Region Access Point ${name} (takes several minutes)...`,
            );
            yield* inMrapRegion(
              s3control
                .deleteMultiRegionAccessPoint({
                  AccountId: accountId,
                  ClientToken: clientToken,
                  Details: { Name: name },
                })
                .pipe(
                  Effect.catchTag(
                    "NoSuchMultiRegionAccessPoint",
                    () => Effect.void,
                  ),
                ),
            );
          }

          yield* awaitGone(accountId, name);
        }),
      });
    }),
  );
