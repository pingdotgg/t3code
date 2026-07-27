import * as s3control from "@distilled.cloud/aws/s3-control";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export interface ObjectLambdaAccessPointProps {
  /**
   * Name of the Object Lambda Access Point (3-45 characters, lowercase
   * letters, numbers and hyphens). If omitted, a unique name is generated
   * from the app, stage and logical ID.
   *
   * Changing the name replaces the access point.
   * @default ${app}-${stage}-${id}
   */
  objectLambdaAccessPointName?: string;
  /**
   * ARN of the standard (supporting) access point that the Object Lambda
   * Access Point reads through.
   */
  supportingAccessPoint: string;
  /**
   * The transformations to apply: which S3 actions to intercept
   * (`GetObject`, `HeadObject`, `ListObjects`, `ListObjectsV2`) and the
   * Lambda function that transforms them.
   */
  transformationConfigurations: s3control.ObjectLambdaTransformationConfiguration[];
  /**
   * Features the Lambda is allowed to pass through untransformed (e.g.
   * `GetObject-Range`, `GetObject-PartNumber`, `HeadObject-Range`).
   */
  allowedFeatures?: s3control.ObjectLambdaAllowedFeature[];
  /**
   * Whether CloudWatch request metrics are enabled for the access point.
   * @default false
   */
  cloudWatchMetricsEnabled?: boolean;
}

export interface ObjectLambdaAccessPoint extends Resource<
  "AWS.S3Control.ObjectLambdaAccessPoint",
  ObjectLambdaAccessPointProps,
  {
    /**
     * Name of the Object Lambda Access Point.
     */
    objectLambdaAccessPointName: string;
    /**
     * ARN of the Object Lambda Access Point
     * (service `s3-object-lambda`).
     */
    objectLambdaAccessPointArn: string;
    /**
     * The S3-assigned alias of the Object Lambda Access Point. The alias
     * can be used anywhere a bucket name is accepted.
     */
    alias: string | undefined;
    /**
     * AWS region of the access point.
     */
    region: RegionID;
    /**
     * AWS account ID that owns the access point.
     */
    accountId: AccountID;
  },
  never,
  Providers
> {}

/**
 * An S3 Object Lambda Access Point — intercepts S3 `GetObject` /
 * `HeadObject` / `ListObjects` requests through a supporting access point
 * and transforms responses with a Lambda function (redaction, resizing,
 * format conversion, ...).
 * @resource
 * @section Creating Object Lambda Access Points
 * @example Transform GetObject responses with a Lambda
 * ```typescript
 * import * as S3Control from "alchemy/AWS/S3Control";
 *
 * const accessPoint = yield* S3Control.AccessPoint("data-ap", {
 *   bucket: bucket.bucketName,
 * });
 *
 * const olap = yield* S3Control.ObjectLambdaAccessPoint("transform-ap", {
 *   supportingAccessPoint: accessPoint.accessPointArn,
 *   transformationConfigurations: [
 *     {
 *       Actions: ["GetObject"],
 *       ContentTransformation: {
 *         AwsLambda: { FunctionArn: transformer.functionArn },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @example Pass Range/PartNumber through and enable metrics
 * ```typescript
 * const olap = yield* S3Control.ObjectLambdaAccessPoint("transform-ap", {
 *   supportingAccessPoint: accessPoint.accessPointArn,
 *   allowedFeatures: ["GetObject-Range", "GetObject-PartNumber"],
 *   cloudWatchMetricsEnabled: true,
 *   transformationConfigurations: [
 *     {
 *       Actions: ["GetObject"],
 *       ContentTransformation: {
 *         AwsLambda: { FunctionArn: transformer.functionArn },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export const ObjectLambdaAccessPoint = Resource<ObjectLambdaAccessPoint>(
  "AWS.S3Control.ObjectLambdaAccessPoint",
);

/**
 * Retry while a freshly-created Object Lambda Access Point has not
 * propagated to reads yet.
 *
 * Explicitly typed at module scope — inlining `Effect.retry` in a lifecycle
 * op leaks `Retry.Return`'s conditional type into declaration emit, widening
 * the provider layer to `unknown` and poisoning `AWS.providers()`.
 */
const retryWhileObjectLambdaPropagates = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "NoSuchAccessPoint",
    schedule: Schedule.max([Schedule.fixed("1 second"), Schedule.recurs(10)]),
  });

export const ObjectLambdaAccessPointProvider = () =>
  Provider.effect(
    ObjectLambdaAccessPoint,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<
          ObjectLambdaAccessPointProps,
          "objectLambdaAccessPointName"
        >,
      ) {
        // Object Lambda Access Point names: 3-45 chars, lowercase.
        return (
          props.objectLambdaAccessPointName ??
          (yield* createPhysicalName({ id, maxLength: 45, lowercase: true }))
        );
      });

      const objectLambdaArn = (
        region: string,
        accountId: string,
        name: string,
      ) =>
        `arn:aws:s3-object-lambda:${region}:${accountId}:accesspoint/${name}`;

      const observeAccessPoint = (accountId: string, name: string) =>
        s3control
          .getAccessPointForObjectLambda({ AccountId: accountId, Name: name })
          .pipe(
            Effect.catchTag("NoSuchAccessPoint", () =>
              Effect.succeed(undefined),
            ),
          );

      const desiredConfiguration = (
        props: ObjectLambdaAccessPointProps,
      ): s3control.ObjectLambdaConfiguration => ({
        SupportingAccessPoint: props.supportingAccessPoint,
        CloudWatchMetricsEnabled: props.cloudWatchMetricsEnabled ?? false,
        AllowedFeatures: props.allowedFeatures,
        TransformationConfigurations: props.transformationConfigurations,
      });

      // Canonical form ignoring member ordering so re-ordering never reads
      // as drift.
      const canon = (cfg: s3control.ObjectLambdaConfiguration) =>
        JSON.stringify({
          supportingAccessPoint: cfg.SupportingAccessPoint,
          metrics: cfg.CloudWatchMetricsEnabled ?? false,
          features: Arr.sort(cfg.AllowedFeatures ?? [], Order.String),
          transformations: Arr.map(
            cfg.TransformationConfigurations,
            (transformation) => ({
              actions: Arr.sort(transformation.Actions, Order.String),
              lambda: transformation.ContentTransformation.AwsLambda,
            }),
          ),
        });

      return ObjectLambdaAccessPoint.Provider.of({
        stables: [
          "objectLambdaAccessPointName",
          "objectLambdaAccessPointArn",
          "alias",
          "region",
          "accountId",
        ],
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* s3control.listAccessPointsForObjectLambda
              .pages({ AccountId: accountId })
              .pipe(Stream.runCollect);
            return Array.from(pages).flatMap((page) =>
              (page.ObjectLambdaAccessPointList ?? []).map((olap) => ({
                objectLambdaAccessPointName: olap.Name,
                objectLambdaAccessPointArn:
                  olap.ObjectLambdaAccessPointArn ??
                  objectLambdaArn(region, accountId, olap.Name),
                alias: olap.Alias?.Value,
                region,
                accountId,
              })),
            );
          }),
        // Object Lambda Access Points do not support tags, so a read hit is
        // treated as ours (ownership is scoped by the deterministic name).
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.objectLambdaAccessPointName ??
            (yield* createName(id, olds ?? {}));
          const live = yield* observeAccessPoint(accountId, name);
          if (live === undefined) return undefined;
          return {
            objectLambdaAccessPointName: name,
            objectLambdaAccessPointArn: objectLambdaArn(
              region,
              accountId,
              name,
            ),
            alias: live.Alias?.Value,
            region,
            accountId,
          };
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // fall through: the configuration converges via
          // PutAccessPointConfigurationForObjectLambda
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.objectLambdaAccessPointName ??
            (yield* createName(id, news));
          const desired = desiredConfiguration(news);

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observeAccessPoint(accountId, name);

          // 2. ENSURE — create when missing; tolerate the AlreadyOwnedByYou
          //    race and wait out read propagation.
          if (live === undefined) {
            yield* s3control
              .createAccessPointForObjectLambda({
                AccountId: accountId,
                Name: name,
                Configuration: desired,
              })
              .pipe(
                Effect.catchTag(
                  "AccessPointAlreadyOwnedByYou",
                  () => Effect.void,
                ),
              );
            live = yield* retryWhileObjectLambdaPropagates(
              s3control.getAccessPointForObjectLambda({
                AccountId: accountId,
                Name: name,
              }),
            );
          }

          // 3. SYNC — diff the OBSERVED configuration against the desired
          //    one; apply only on drift.
          const observedConfig = yield* retryWhileObjectLambdaPropagates(
            s3control.getAccessPointConfigurationForObjectLambda({
              AccountId: accountId,
              Name: name,
            }),
          );
          if (
            observedConfig.Configuration === undefined ||
            canon(observedConfig.Configuration) !== canon(desired)
          ) {
            yield* s3control.putAccessPointConfigurationForObjectLambda({
              AccountId: accountId,
              Name: name,
              Configuration: desired,
            });
          }

          yield* session.note(name);
          return {
            objectLambdaAccessPointName: name,
            objectLambdaAccessPointArn: objectLambdaArn(
              region,
              accountId,
              name,
            ),
            alias: live.Alias?.Value,
            region,
            accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* s3control
            .deleteAccessPointForObjectLambda({
              AccountId: accountId,
              Name: output.objectLambdaAccessPointName,
            })
            .pipe(
              // Idempotent delete — already gone is success.
              Effect.catchTag("NoSuchAccessPoint", () => Effect.void),
            );
        }),
      });
    }),
  );
