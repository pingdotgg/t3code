import * as glue from "@distilled.cloud/aws/glue";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { connectionArn, fetchObservedTags, syncTags } from "./internal.ts";

export type GlueConnectionType =
  | "JDBC"
  | "SFTP"
  | "MONGODB"
  | "KAFKA"
  | "NETWORK"
  | "MARKETPLACE"
  | "CUSTOM"
  | (string & {});

export interface ConnectionProps {
  /**
   * Name of the connection. If omitted, a unique name is generated. Changing
   * the name replaces the connection.
   * @default a generated physical name
   */
  connectionName?: string;
  /**
   * The type of connection. `JDBC` is the common relational case.
   */
  connectionType: GlueConnectionType;
  /**
   * A description of the connection.
   */
  description?: string;
  /**
   * Connection-type-specific properties, e.g. for `JDBC`:
   * `{ JDBC_CONNECTION_URL, USERNAME, PASSWORD }`. Secret values (e.g.
   * `PASSWORD`) should be wrapped with `Redacted.make(...)` so they are
   * kept out of logs and state output.
   */
  connectionProperties: Record<string, string | Redacted.Redacted<string>>;
  /**
   * Criteria used to match connections (for MATCH_CRITERIA lookups).
   */
  matchCriteria?: string[];
  /**
   * VPC networking requirements — required for connections that reach into a
   * VPC (e.g. JDBC to an RDS instance).
   */
  physicalConnectionRequirements?: {
    /** The subnet the connection uses. */
    subnetId?: string;
    /** Security group IDs applied to the connection's ENI. */
    securityGroupIdList?: string[];
    /** The availability zone (must match the subnet). */
    availabilityZone?: string;
  };
  /**
   * The AWS account ID of the Data Catalog. Changing it replaces the
   * connection.
   * @default the caller's account (the default Data Catalog)
   */
  catalogId?: string;
  /**
   * Tags to apply to the connection. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Connection extends Resource<
  "AWS.Glue.Connection",
  ConnectionProps,
  {
    /** The name of the connection. */
    connectionName: string;
    /** The ARN of the connection. */
    connectionArn: string;
    /** The connection type, e.g. `JDBC`. */
    connectionType: string;
    /** The AWS account ID of the Data Catalog the connection lives in. */
    catalogId: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue connection — stores the connection details (JDBC URL, VPC
 * networking, credentials) that crawlers and jobs use to reach a data store.
 * @resource
 * @section Creating Connections
 * @example JDBC Connection
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import * as Redacted from "effect/Redacted";
 *
 * const connection = yield* AWS.Glue.Connection("Warehouse", {
 *   connectionType: "JDBC",
 *   connectionProperties: {
 *     JDBC_CONNECTION_URL: "jdbc:postgresql://db.example.com:5432/warehouse",
 *     USERNAME: "glue",
 *     PASSWORD: Redacted.make("secret"),
 *   },
 *   physicalConnectionRequirements: {
 *     subnetId: subnet.subnetId,
 *     securityGroupIdList: [securityGroup.groupId],
 *     availabilityZone: "us-west-2a",
 *   },
 * });
 * ```
 */
export const Connection = Resource<Connection>("AWS.Glue.Connection");

export const ConnectionProvider = () =>
  Provider.effect(
    Connection,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { connectionName?: string | undefined },
      ) {
        return (
          props.connectionName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const observe = Effect.fn(function* (
        name: string,
        catalogId: string | undefined,
      ) {
        return yield* glue
          .getConnection({
            Name: name,
            CatalogId: catalogId,
            HidePassword: true,
          })
          .pipe(
            Effect.map((r) => r.Connection),
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const buildInput = (name: string, props: ConnectionProps) => ({
        Name: name,
        ConnectionType: props.connectionType,
        Description: props.description,
        ConnectionProperties: Object.fromEntries(
          Object.entries(props.connectionProperties).map(([key, value]) => [
            key,
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          ]),
        ),
        MatchCriteria: props.matchCriteria,
        PhysicalConnectionRequirements: props.physicalConnectionRequirements
          ? {
              SubnetId: props.physicalConnectionRequirements.subnetId,
              SecurityGroupIdList:
                props.physicalConnectionRequirements.securityGroupIdList,
              AvailabilityZone:
                props.physicalConnectionRequirements.availabilityZone,
            }
          : undefined,
      });

      return Connection.Provider.of({
        stables: ["connectionName", "connectionArn", "catalogId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* glue.getConnections
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.ConnectionList ?? [])
              .filter((c) => c.Name !== undefined)
              .map((c) => ({
                connectionName: c.Name!,
                connectionArn: connectionArn(region, accountId, c.Name!),
                connectionType: c.ConnectionType ?? "",
                catalogId: accountId,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const catalogId = output?.catalogId ?? olds?.catalogId ?? accountId;
          const name =
            output?.connectionName ?? (yield* createName(id, olds ?? {}));
          const connection = yield* observe(name, catalogId);
          if (connection?.Name === undefined) return undefined;
          const arn = connectionArn(region, accountId, connection.Name);
          const attrs = {
            connectionName: connection.Name,
            connectionArn: arn,
            connectionType: connection.ConnectionType ?? "",
            catalogId,
          };
          const tags = yield* fetchObservedTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          if ((olds.catalogId ?? undefined) !== (news.catalogId ?? undefined)) {
            return { action: "replace" } as const;
          }
          // type / properties / networking / description → update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const catalogId = news.catalogId ?? output?.catalogId ?? accountId;
          const name = output?.connectionName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const arn = connectionArn(region, accountId, name);
          const input = buildInput(name, news);

          // 1. OBSERVE
          const existing = yield* observe(name, catalogId);

          // 2. ENSURE / 3. SYNC
          if (existing === undefined) {
            yield* glue
              .createConnection({
                CatalogId: catalogId,
                ConnectionInput: input,
                Tags: desiredTags,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () => Effect.void),
              );
          } else {
            yield* glue.updateConnection({
              CatalogId: catalogId,
              Name: name,
              ConnectionInput: input,
            });
          }

          // 3b. SYNC TAGS
          const observedTags = yield* fetchObservedTags(arn);
          yield* syncTags(arn, observedTags, desiredTags);

          yield* session.note(name);
          return {
            connectionName: name,
            connectionArn: arn,
            connectionType: news.connectionType,
            catalogId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* glue
            .deleteConnection({
              ConnectionName: output.connectionName,
              CatalogId: output.catalogId,
            })
            .pipe(
              Effect.catchTag("EntityNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );
