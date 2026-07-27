import * as datasync from "@distilled.cloud/aws/datasync";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  findLocationArnByUri,
  readObservedTags,
  retryWhileRoleNotAssumable,
  syncTags,
} from "./internal.ts";

export interface LocationS3Props {
  /**
   * ARN of the S3 bucket this location points at, e.g.
   * `arn:aws:s3:::my-bucket`. Cannot be changed after creation (replacement).
   */
  s3BucketArn: string;
  /**
   * ARN of the IAM role DataSync assumes to access the bucket. The role's
   * trust policy must allow `datasync.amazonaws.com` and grant the relevant
   * S3 permissions. Cannot be changed after creation (replacement).
   */
  bucketAccessRoleArn: string;
  /**
   * Prefix within the bucket to sync, e.g. `/data`. Cannot be changed after
   * creation (replacement).
   * @default "/" (the bucket root)
   */
  subdirectory?: string;
  /**
   * S3 storage class DataSync writes objects as when this location is a
   * transfer destination. Cannot be changed after creation (replacement).
   * @default "STANDARD"
   */
  s3StorageClass?: datasync.S3StorageClass;
  /**
   * ARNs of DataSync agents used to connect to an S3-on-Outposts bucket.
   * Omit for standard S3 buckets.
   */
  agentArns?: string[];
  /**
   * Tags to apply to the location. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface LocationS3 extends Resource<
  "AWS.DataSync.LocationS3",
  LocationS3Props,
  {
    /** ARN of the DataSync location. */
    locationArn: string;
    /** URI of the location (`s3://…`). */
    locationUri: string;
  },
  {},
  Providers
> {}

/**
 * A DataSync location backed by an Amazon S3 bucket. Locations are the
 * source and destination endpoints referenced by a {@link Task}.
 *
 * S3 locations are immutable apart from their tags: any change to the
 * bucket, subdirectory, storage class, or access role replaces the location.
 * Reconcile is idempotent across state loss — the location is re-discovered
 * by its deterministic `s3://…` URI.
 *
 * @resource
 * @section Creating S3 Locations
 * @example Bucket root
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const source = yield* AWS.DataSync.LocationS3("Source", {
 *   s3BucketArn: bucket.bucketArn,
 *   bucketAccessRoleArn: role.roleArn,
 * });
 * ```
 *
 * @example Prefix + storage class
 * ```typescript
 * const dest = yield* AWS.DataSync.LocationS3("Dest", {
 *   s3BucketArn: bucket.bucketArn,
 *   bucketAccessRoleArn: role.roleArn,
 *   subdirectory: "/archive",
 *   s3StorageClass: "STANDARD_IA",
 * });
 * ```
 */
export const LocationS3 = Resource<LocationS3>("AWS.DataSync.LocationS3");

const bucketNameOf = (bucketArn: string) => bucketArn.split(":::")[1] ?? "";

const expectedUriOf = (props: LocationS3Props): string => {
  const name = bucketNameOf(props.s3BucketArn);
  const sub = props.subdirectory ?? "/";
  const normalized = sub.startsWith("/") ? sub : `/${sub}`;
  return `s3://${name}${normalized}`;
};

export const LocationS3Provider = () =>
  Provider.effect(
    LocationS3,
    Effect.gen(function* () {
      const describe = Effect.fn(function* (locationArn: string) {
        return yield* datasync
          .describeLocationS3({ LocationArn: locationArn })
          .pipe(
            Effect.catchTag("LocationNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return LocationS3.Provider.of({
        stables: ["locationArn", "locationUri"],

        list: () =>
          datasync.listLocations.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((p) => p.Locations ?? [])
                .filter((l) => l.LocationUri?.startsWith("s3://"))
                .map((l) => ({
                  locationArn: l.LocationArn!,
                  locationUri: l.LocationUri!,
                })),
            ),
          ),

        read: Effect.fn(function* ({ olds, output }) {
          const arn =
            output?.locationArn ??
            (yield* findLocationArnByUri(expectedUriOf(olds)));
          if (arn === undefined) return undefined;
          const loc = yield* describe(arn);
          if (loc === undefined) return undefined;
          return {
            locationArn: loc.LocationArn!,
            locationUri: loc.LocationUri!,
          };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          const replaced =
            news.s3BucketArn !== olds.s3BucketArn ||
            news.bucketAccessRoleArn !== olds.bucketAccessRoleArn ||
            (news.subdirectory ?? "/") !== (olds.subdirectory ?? "/") ||
            (news.s3StorageClass ?? "STANDARD") !==
              (olds.s3StorageClass ?? "STANDARD");
          if (replaced) return { action: "replace" } as const;
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — output cache, else re-discover by deterministic URI.
          let arn =
            output?.locationArn ??
            (yield* findLocationArnByUri(expectedUriOf(news)));
          let loc = arn ? yield* describe(arn) : undefined;

          // 2. ENSURE — create if missing.
          if (loc === undefined) {
            const created = yield* retryWhileRoleNotAssumable(
              datasync.createLocationS3({
                S3BucketArn: news.s3BucketArn,
                S3Config: { BucketAccessRoleArn: news.bucketAccessRoleArn },
                Subdirectory: news.subdirectory,
                S3StorageClass: news.s3StorageClass,
                AgentArns: news.agentArns,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            );
            arn = created.LocationArn!;
            loc = yield* describe(arn);
          }

          // 3. SYNC tags against observed cloud state.
          const observed = yield* readObservedTags(arn!);
          yield* syncTags(arn!, observed, desiredTags);

          yield* session.note(arn!);
          return {
            locationArn: loc!.LocationArn!,
            locationUri: loc!.LocationUri!,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* datasync
            .deleteLocation({ LocationArn: output.locationArn })
            .pipe(Effect.catchTag("LocationNotFound", () => Effect.void));
        }),
      });
    }),
  );
