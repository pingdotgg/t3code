import * as redshift from "@distilled.cloud/aws/redshift";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { formatSqlConnectionUrl } from "../Connection/internal.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import { Connect, connectEnvPrefix, type ConnectOptions } from "./Connect.ts";

const DEFAULT_PORT = 5439;

const unwrap = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * SDK-backed implementation of {@link Connect}. Deploy half attaches the
 * `redshift:GetClusterCredentials[WithIAM]` policy scoped to the cluster's
 * `dbname`/`dbuser`/`dbgroup` ARNs and publishes
 * `REDSHIFT_{LOGICAL_ID}_{HOST,PORT}` on the host Function; runtime half
 * mints temporary credentials via the corresponding SDK operation and
 * formats a pgwire connection URL.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const getClusterCredentials = yield* redshift.getClusterCredentials;
    const getClusterCredentialsWithIAM =
      yield* redshift.getClusterCredentialsWithIAM;

    return Effect.fn(function* (
      cluster: Cluster,
      options: ConnectOptions = {},
    ) {
      const ClusterIdentifier = yield* cluster.clusterIdentifier;
      const Host = yield* cluster.endpointAddress;
      const Port = yield* cluster.endpointPort;
      const DbName = yield* cluster.dbName;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // `arn:aws:redshift:{region}:{acct}` — the cluster ARN minus its
          // `:cluster:{id}` suffix; base for the dbname/dbuser/dbgroup ARNs
          // that scope the GetClusterCredentials* actions.
          const arnBase = Output.map(cluster.clusterArn, (arn) =>
            arn.slice(0, arn.lastIndexOf(":cluster:")),
          );
          const database = options.database ?? cluster.dbName;
          const dbNameArn = Output.interpolate`${arnBase}:dbname:${cluster.clusterIdentifier}/${database}`;
          const prefix = connectEnvPrefix(cluster.LogicalId);
          yield* host.bind`Allow(${host}, AWS.Redshift.Connect(${cluster}))`({
            policyStatements:
              options.dbUser !== undefined
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [
                        "redshift:GetClusterCredentials",
                        ...(options.autoCreate
                          ? ["redshift:CreateClusterUser"]
                          : []),
                      ],
                      Resource: [
                        Output.interpolate`${arnBase}:dbuser:${cluster.clusterIdentifier}/${options.dbUser}`,
                        dbNameArn,
                      ],
                    },
                    ...(options.dbGroups && options.dbGroups.length > 0
                      ? [
                          {
                            Effect: "Allow" as const,
                            Action: ["redshift:JoinGroup"],
                            Resource: options.dbGroups.map(
                              (group) =>
                                Output.interpolate`${arnBase}:dbgroup:${cluster.clusterIdentifier}/${group}`,
                            ),
                          },
                        ]
                      : []),
                  ]
                : [
                    {
                      Effect: "Allow" as const,
                      Action: ["redshift:GetClusterCredentialsWithIAM"],
                      Resource: [dbNameArn],
                    },
                  ],
            env: {
              [`${prefix}_HOST`]: cluster.endpointAddress,
              // Lambda environment variables are strings — stringify the port.
              [`${prefix}_PORT`]: Output.interpolate`${cluster.endpointPort}`,
            },
          });
        }
      }

      return Effect.gen(function* () {
        const clusterIdentifier = yield* ClusterIdentifier;
        const host = yield* Host;
        const port = (yield* Port) ?? DEFAULT_PORT;
        const database = options.database ?? (yield* DbName);
        if (!host) {
          return yield* Effect.die(
            `Redshift cluster endpoint for '${cluster.LogicalId}' is not available yet`,
          );
        }
        const credentials =
          options.dbUser !== undefined
            ? yield* getClusterCredentials({
                ClusterIdentifier: clusterIdentifier,
                DbUser: options.dbUser,
                DbName: database,
                AutoCreate: options.autoCreate,
                DbGroups: options.dbGroups,
                DurationSeconds: toWireSeconds(options.duration),
              })
            : yield* getClusterCredentialsWithIAM({
                ClusterIdentifier: clusterIdentifier,
                DbName: database,
                DurationSeconds: toWireSeconds(options.duration),
              });
        const username = unwrap(credentials.DbUser);
        const rawPassword = unwrap(credentials.DbPassword);
        const password =
          rawPassword === undefined ? undefined : Redacted.make(rawPassword);
        const ssl = options.ssl ?? true;
        return {
          host,
          port,
          database,
          username,
          password,
          ssl,
          expiration: credentials.Expiration,
          url: formatSqlConnectionUrl({
            host,
            port,
            database,
            username,
            password,
            ssl,
          }),
        };
      });
    });
  }),
);
