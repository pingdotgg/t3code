import * as appsync from "@distilled.cloud/aws/appsync";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import {
  retryConcurrentModification,
  retryWhileRolePropagates,
  sanitizeAppSyncName,
} from "./common.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/** The data source types supported by the resource. */
export type DataSourceType =
  | "NONE"
  | "AWS_LAMBDA"
  | "AMAZON_DYNAMODB"
  | "HTTP"
  | "AMAZON_EVENTBRIDGE";

export interface LambdaDataSourceConfig {
  /** ARN of the Lambda function this data source invokes. */
  lambdaFunctionArn: string;
}

export interface DynamodbDataSourceConfig {
  /** Name of the DynamoDB table. */
  tableName: string;
  /**
   * Region the table lives in.
   * @default the ambient AWS region
   */
  awsRegion?: string;
  /** Use the caller's credentials instead of the service role. */
  useCallerCredentials?: boolean;
  /** Whether conflict detection (versioning) is enabled. */
  versioned?: boolean;
}

export interface HttpDataSourceConfig {
  /** The HTTP endpoint, e.g. `https://api.example.com`. */
  endpoint: string;
}

export interface DataSourceProps {
  /**
   * ID of the GraphQL API this data source belongs to. Usually derived
   * from `api.apiId` by the {@link DataSource} wrapper.
   */
  apiId: string;
  /**
   * Name of the data source (`[_A-Za-z][_0-9A-Za-z]*` — no dashes). If
   * omitted, a deterministic name is generated from the app, stage, and
   * logical ID (dashes sanitized to underscores). Changing the name
   * triggers a replacement.
   */
  name?: string;
  /** Description of the data source. */
  description?: string;
  /**
   * The data source type. `NONE` (local compute), `AWS_LAMBDA`,
   * `AMAZON_DYNAMODB`, `HTTP`, or `AMAZON_EVENTBRIDGE`.
   */
  type: DataSourceType;
  /**
   * The ARN of an existing IAM role AppSync assumes to access the target.
   * When omitted (and the type needs one), a service role is created
   * automatically with `appsync.amazonaws.com` trust and least-privilege
   * access to the configured target.
   */
  serviceRoleArn?: string;
  /**
   * Additional IAM policy statements attached to the auto-created service
   * role (ignored when {@link DataSourceProps.serviceRoleArn} is provided).
   */
  policyStatements?: PolicyStatement[];
  /** Lambda target — required when `type` is `AWS_LAMBDA`. */
  lambdaConfig?: LambdaDataSourceConfig;
  /** DynamoDB target — required when `type` is `AMAZON_DYNAMODB`. */
  dynamodbConfig?: DynamodbDataSourceConfig;
  /** HTTP target — required when `type` is `HTTP`. */
  httpConfig?: HttpDataSourceConfig;
}

export interface AppSyncDataSource extends Resource<
  "AWS.AppSync.DataSource",
  DataSourceProps,
  {
    /** The API this data source belongs to. */
    apiId: string;
    /** The data source name (referenced by resolvers and functions). */
    name: string;
    /** The data source ARN. */
    dataSourceArn: string;
    /** The data source type. */
    type: DataSourceType;
    /** The service role AppSync assumes, if any. */
    serviceRoleArn: string | undefined;
    /**
     * Name of the auto-created service role. `undefined` when an explicit
     * {@link DataSourceProps.serviceRoleArn} is used or no role is needed.
     */
    roleName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AppSync data source — the target a resolver reads from or writes to.
 *
 * For `AWS_LAMBDA` and `AMAZON_DYNAMODB` targets a least-privilege service
 * role is created automatically (unless an explicit `serviceRoleArn` is
 * given): `lambda:InvokeFunction` on the function, or the DynamoDB
 * read/write actions on the table and its indexes.
 * @resource
 * @section Creating Data Sources
 * @example Lambda data source (auto-created invoke role)
 * ```typescript
 * const ds = yield* AppSync.DataSource("LambdaDS", {
 *   api,
 *   type: "AWS_LAMBDA",
 *   lambdaConfig: { lambdaFunctionArn: fn.functionArn },
 * });
 * ```
 *
 * @example NONE data source (local compute)
 * ```typescript
 * const local = yield* AppSync.DataSource("Local", {
 *   api,
 *   type: "NONE",
 * });
 * ```
 *
 * @example DynamoDB data source
 * ```typescript
 * const ds = yield* AppSync.DataSource("TableDS", {
 *   api,
 *   type: "AMAZON_DYNAMODB",
 *   dynamodbConfig: { tableName: table.tableName },
 * });
 * ```
 */
export const DataSourceResource = Resource<AppSyncDataSource>(
  "AWS.AppSync.DataSource",
);

export interface DataSourceInputProps extends Omit<
  {
    [K in keyof DataSourceProps]?: Input<DataSourceProps[K]>;
  },
  "apiId" | "type"
> {
  /**
   * The `GraphqlApi` this data source belongs to (preferred). Alternatively
   * pass a raw `apiId`.
   */
  api?: GraphqlApi;
  apiId?: Input<string>;
  type: Input<DataSourceType>;
}

/**
 * User-facing wrapper for the DataSource resource. Accepts `api: GraphqlApi`
 * as the idiomatic way to attach a data source to an API.
 */
export const DataSource = (id: string, props: DataSourceInputProps) =>
  Effect.gen(function* () {
    const { api, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "DataSource requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    return yield* DataSourceResource(id, { ...rest, apiId } as any);
  });

export const DataSourceProvider = () =>
  Provider.effect(
    DataSourceResource,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<DataSourceProps, "name">,
      ) {
        return (
          props.name ??
          sanitizeAppSyncName(yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getDataSourceSafe = (apiId: string, name: string) =>
        appsync.getDataSource({ apiId, name }).pipe(
          Effect.map((response) => response.dataSource),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );

      /**
       * Least-privilege statements for the auto-created service role,
       * derived from the configured target.
       */
      const buildRolePolicyStatements = (
        news: DataSourceProps,
        region: string,
        accountId: string,
      ): PolicyStatement[] => {
        const statements: PolicyStatement[] = [];
        if (news.type === "AWS_LAMBDA" && news.lambdaConfig !== undefined) {
          const arn = news.lambdaConfig.lambdaFunctionArn;
          statements.push({
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: /:function:[^:]+:/.test(arn) ? [arn] : [arn, `${arn}:*`],
          });
        }
        if (
          news.type === "AMAZON_DYNAMODB" &&
          news.dynamodbConfig !== undefined
        ) {
          const tableRegion = news.dynamodbConfig.awsRegion ?? region;
          const tableArn = `arn:aws:dynamodb:${tableRegion}:${accountId}:table/${news.dynamodbConfig.tableName}`;
          statements.push({
            Effect: "Allow",
            Action: [
              "dynamodb:BatchGetItem",
              "dynamodb:BatchWriteItem",
              "dynamodb:ConditionCheckItem",
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:Scan",
              "dynamodb:UpdateItem",
            ],
            Resource: [tableArn, `${tableArn}/index/*`],
          });
        }
        statements.push(...(news.policyStatements ?? []));
        return statements;
      };

      const needsServiceRole = (news: DataSourceProps): boolean =>
        news.type === "AWS_LAMBDA" ||
        news.type === "AMAZON_DYNAMODB" ||
        news.type === "AMAZON_EVENTBRIDGE";

      /**
       * Ensure the auto-created service role exists with the
       * `appsync.amazonaws.com` trust policy and the desired inline
       * policy. Idempotent across reconciles.
       */
      const ensureServiceRole = Effect.fn(function* ({
        id,
        roleName,
        statements,
      }: {
        id: string;
        roleName: string;
        statements: PolicyStatement[];
      }) {
        const tags = yield* createInternalTags(id);
        const role = yield* iam
          .createRole({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "appsync.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () =>
              iam.getRole({ RoleName: roleName }),
            ),
          );

        if (statements.length > 0) {
          yield* iam.putRolePolicy({
            RoleName: roleName,
            PolicyName: `${roleName}-policy`,
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: statements,
            }),
          });
        } else {
          yield* iam
            .deleteRolePolicy({
              RoleName: roleName,
              PolicyName: `${roleName}-policy`,
            })
            .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        }

        return role.Role.Arn;
      });

      /** Delete the auto-created service role and its inline policies. */
      const deleteServiceRole = Effect.fn(function* (roleName: string) {
        yield* iam.listRolePolicies.items({ RoleName: roleName }).pipe(
          Stream.mapEffect((policyName) =>
            iam
              .deleteRolePolicy({
                RoleName: roleName,
                PolicyName: policyName,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              ),
          ),
          Stream.runDrain,
          Effect.catchTag("NoSuchEntityException", () => Effect.void),
        );
        yield* iam
          .deleteRole({ RoleName: roleName })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
      });

      const toWireConfigs = (news: DataSourceProps, region: string) => ({
        lambdaConfig: news.lambdaConfig,
        dynamodbConfig:
          news.dynamodbConfig === undefined
            ? undefined
            : {
                tableName: news.dynamodbConfig.tableName,
                awsRegion: news.dynamodbConfig.awsRegion ?? region,
                useCallerCredentials: news.dynamodbConfig.useCallerCredentials,
                versioned: news.dynamodbConfig.versioned,
              },
        httpConfig: news.httpConfig,
      });

      const toAttributes = (
        apiId: string,
        ds: appsync.DataSource,
        roleName: string | undefined,
      ): AppSyncDataSource["Attributes"] => ({
        apiId,
        name: ds.name!,
        dataSourceArn: ds.dataSourceArn!,
        type: ds.type as DataSourceType,
        serviceRoleArn: ds.serviceRoleArn,
        roleName,
      });

      return DataSourceResource.Provider.of({
        stables: ["apiId", "name", "dataSourceArn"],

        // Sub-resource keyed entirely by its GraphQL API (apiId) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const apiId = output?.apiId ?? olds?.apiId;
          if (apiId === undefined) return undefined;
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const ds = yield* getDataSourceSafe(apiId, name);
          if (ds?.name == null) return undefined;
          return toAttributes(apiId, ds, output?.roleName);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (news.apiId !== olds.apiId || oldName !== newName) {
            return { action: "replace" } as const;
          }
          // type/config/role converge via updateDataSource
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { region, accountId } = yield* AWSEnvironment.current;
          const apiId = output?.apiId ?? news.apiId;
          const name = output?.name ?? (yield* createName(id, news));
          const configs = toWireConfigs(news, region);

          // Ensure the service role first — the data source cannot point
          // at a Lambda/DynamoDB target without one.
          let serviceRoleArn = news.serviceRoleArn;
          let roleName: string | undefined;
          if (serviceRoleArn === undefined && needsServiceRole(news)) {
            roleName = yield* createPhysicalName({ id, maxLength: 64 });
            serviceRoleArn = yield* ensureServiceRole({
              id,
              roleName,
              statements: buildRolePolicyStatements(news, region, accountId),
            });
          }

          // 1. OBSERVE
          let observed = yield* getDataSourceSafe(apiId, name);

          // 2. ENSURE — a fresh role can take a few seconds to become
          //    assumable by AppSync.
          if (observed?.name == null) {
            const created = yield* retryWhileRolePropagates(
              retryConcurrentModification(
                appsync.createDataSource({
                  apiId,
                  name,
                  description: news.description,
                  type: news.type,
                  serviceRoleArn,
                  ...configs,
                }),
              ),
            );
            observed = created.dataSource!;
            yield* session.note(`Created data source ${name}`);
          } else {
            // 3. SYNC — single update when the observed surface drifted.
            const surface = (ds: {
              description?: string;
              type?: string;
              serviceRoleArn?: string;
              lambdaConfig?: appsync.LambdaDataSourceConfig;
              dynamodbConfig?: appsync.DynamodbDataSourceConfig;
              httpConfig?: appsync.HttpDataSourceConfig;
            }) =>
              JSON.parse(
                JSON.stringify({
                  description: ds.description,
                  type: ds.type,
                  serviceRoleArn: ds.serviceRoleArn,
                  lambdaConfig: ds.lambdaConfig,
                  // AWS normalizes optional booleans into the response;
                  // mirror the defaults so no-ops stay no-ops.
                  dynamodbConfig:
                    ds.dynamodbConfig === undefined
                      ? undefined
                      : {
                          tableName: ds.dynamodbConfig.tableName,
                          awsRegion: ds.dynamodbConfig.awsRegion,
                          useCallerCredentials:
                            ds.dynamodbConfig.useCallerCredentials ?? false,
                          versioned: ds.dynamodbConfig.versioned ?? false,
                        },
                  httpConfig: ds.httpConfig,
                }),
              );
            const desired = surface({
              description: news.description,
              type: news.type,
              serviceRoleArn,
              ...configs,
            });
            if (!deepEqual(surface(observed), desired)) {
              const updated = yield* retryWhileRolePropagates(
                retryConcurrentModification(
                  appsync.updateDataSource({
                    apiId,
                    name,
                    description: news.description,
                    type: news.type,
                    serviceRoleArn,
                    ...configs,
                  }),
                ),
              );
              observed = updated.dataSource ?? observed;
              yield* session.note(`Updated data source ${name}`);
            }
          }

          yield* session.note(name);
          return toAttributes(apiId, observed, roleName);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrentModification(
            appsync
              .deleteDataSource({ apiId: output.apiId, name: output.name })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
          if (output.roleName !== undefined) {
            yield* deleteServiceRole(output.roleName);
          }
        }),
      });
    }),
  );
