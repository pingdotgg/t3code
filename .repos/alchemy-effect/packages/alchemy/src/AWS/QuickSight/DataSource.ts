import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  readQuickSightTags,
  syncQuickSightTags,
  toWireTags,
  waitForSettled,
} from "./internal.ts";

/**
 * Properties for an Amazon QuickSight data source — a connection to an
 * external data store (Athena, S3, Redshift, an RDS engine, etc.) that
 * datasets read from.
 */
export interface DataSourceProps {
  /**
   * Unique id of the data source within the account. Stable — changing it
   * replaces the data source. If omitted, a unique id is generated.
   */
  dataSourceId?: string;

  /**
   * Display name of the data source.
   */
  name: string;

  /**
   * Type of the underlying data store (e.g. `ATHENA`, `S3`, `REDSHIFT`,
   * `POSTGRESQL`). Immutable — changing the type replaces the data source.
   */
  type: quicksight.DataSourceType;

  /**
   * Connection parameters specific to the data source `type` (e.g.
   * `AthenaParameters.WorkGroup`, `S3Parameters.ManifestFileLocation`).
   */
  dataSourceParameters?: quicksight.DataSourceParameters;

  /**
   * Credentials QuickSight uses to connect. Only required for stores that
   * authenticate with a username/password or a Secrets Manager secret.
   * Not required for `ATHENA`/`S3` sources that rely on the QuickSight IAM
   * role.
   */
  credentials?: quicksight.DataSourceCredentials;

  /**
   * Resource-level permissions granting QuickSight principals access to the
   * data source.
   */
  permissions?: quicksight.ResourcePermission[];

  /**
   * VPC connection used to reach a data store inside a VPC.
   */
  vpcConnectionProperties?: quicksight.VpcConnectionProperties;

  /**
   * SSL options for the connection.
   */
  sslProperties?: quicksight.SslProperties;

  /**
   * Tags to apply to the data source.
   */
  tags?: Record<string, string>;
}

export interface DataSource extends Resource<
  "AWS.QuickSight.DataSource",
  DataSourceProps,
  {
    /** Unique id of the data source within the account. */
    dataSourceId: string;
    /** ARN of the data source. */
    arn: string;
    /** Display name of the data source. */
    name: string;
    /** Type of the underlying data store. */
    type: quicksight.DataSourceType;
    /** Current lifecycle status (e.g. `CREATION_SUCCESSFUL`). */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon QuickSight data source — a connection to an external data store
 * that datasets read from.
 *
 * QuickSight requires an active account subscription in the region. Without
 * one, create operations fail with the typed `QuickSightSubscriptionRequired`
 * error.
 *
 * @section Creating a Data Source
 * @example Athena Data Source
 * ```typescript
 * const source = yield* DataSource("analytics", {
 *   name: "Athena Analytics",
 *   type: "ATHENA",
 *   dataSourceParameters: { AthenaParameters: { WorkGroup: "primary" } },
 * });
 * ```
 *
 * @example S3 Manifest Data Source
 * ```typescript
 * const source = yield* DataSource("s3-source", {
 *   name: "S3 Sales Data",
 *   type: "S3",
 *   dataSourceParameters: {
 *     S3Parameters: {
 *       ManifestFileLocation: { Bucket: "my-bucket", Key: "manifest.json" },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataSource = Resource<DataSource>("AWS.QuickSight.DataSource");

export const DataSourceProvider = () =>
  Provider.effect(
    DataSource,
    Effect.gen(function* () {
      const toId = (id: string, props: Partial<DataSourceProps>) =>
        props.dataSourceId
          ? Effect.succeed(props.dataSourceId)
          : createPhysicalName({ id, maxLength: 64 });

      const readSource = Effect.fn(function* (
        accountId: string,
        dataSourceId: string,
      ) {
        const response = yield* quicksight
          .describeDataSource({
            AwsAccountId: accountId,
            DataSourceId: dataSourceId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const source = response?.DataSource;
        if (source === undefined || source.Status === "DELETED") {
          return undefined;
        }
        return source;
      });

      const toAttrs = (source: quicksight.DataSource) => ({
        dataSourceId: source.DataSourceId!,
        arn: source.Arn!,
        name: source.Name ?? "",
        type: source.Type ?? "",
        status: source.Status ?? "",
      });

      return DataSource.Provider.of({
        stables: ["dataSourceId", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toId(id, olds)) !== (yield* toId(id, news))) {
            return { action: "replace" } as const;
          }
          if ((olds.type ?? undefined) !== (news.type ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds = {}, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const dataSourceId = output?.dataSourceId ?? (yield* toId(id, olds));
          const source = yield* readSource(accountId, dataSourceId);
          if (source === undefined) return undefined;
          const attrs = toAttrs(source);
          const tags = yield* readQuickSightTags(attrs.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const dataSourceId = output?.dataSourceId ?? (yield* toId(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readSource(accountId, dataSourceId);

          // 2. Ensure — create if missing; tolerate an AlreadyExists race.
          if (observed === undefined) {
            yield* quicksight
              .createDataSource({
                AwsAccountId: accountId,
                DataSourceId: dataSourceId,
                Name: news.name,
                Type: news.type,
                DataSourceParameters: news.dataSourceParameters,
                Credentials: news.credentials,
                Permissions: news.permissions,
                VpcConnectionProperties: news.vpcConnectionProperties,
                SslProperties: news.sslProperties,
                Tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.catchTag("ResourceExistsException", () => Effect.void),
              );
            observed = yield* waitForSettled(
              dataSourceId,
              readSource(accountId, dataSourceId).pipe(
                Effect.map((s) =>
                  s === undefined ? undefined : { ...s, status: s.Status },
                ),
              ),
            );
            if (observed === undefined) {
              return yield* Effect.fail(
                new Error(
                  `QuickSight data source '${dataSourceId}' disappeared while creating`,
                ),
              );
            }
          } else {
            // 3. Sync — apply mutable settings via an idempotent update.
            yield* quicksight.updateDataSource({
              AwsAccountId: accountId,
              DataSourceId: dataSourceId,
              Name: news.name,
              DataSourceParameters: news.dataSourceParameters,
              Credentials: news.credentials,
              VpcConnectionProperties: news.vpcConnectionProperties,
              SslProperties: news.sslProperties,
            });
            observed = yield* waitForSettled(
              dataSourceId,
              readSource(accountId, dataSourceId).pipe(
                Effect.map((s) =>
                  s === undefined ? undefined : { ...s, status: s.Status },
                ),
              ),
            );
            if (observed === undefined) {
              return yield* Effect.fail(
                new Error(
                  `QuickSight data source '${dataSourceId}' disappeared while updating`,
                ),
              );
            }
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncQuickSightTags(observed.Arn!, desiredTags);

          yield* session.note(dataSourceId);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* quicksight
            .deleteDataSource({
              AwsAccountId: accountId,
              DataSourceId: output.dataSourceId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            return yield* quicksight.listDataSources
              .pages({ AwsAccountId: accountId })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.DataSources ?? [])
                    .flatMap((s) =>
                      s.DataSourceId !== undefined &&
                      s.Arn !== undefined &&
                      s.Status !== "DELETED"
                        ? [
                            {
                              dataSourceId: s.DataSourceId,
                              arn: s.Arn,
                              name: s.Name ?? "",
                              type: s.Type ?? "",
                              status: s.Status ?? "",
                            },
                          ]
                        : [],
                    ),
                ),
              );
          }),
      });
    }),
  );
