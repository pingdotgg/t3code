import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Region from "@distilled.cloud/aws/Region";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { generateDbAuthToken } from "../Connection/DbAuthToken.ts";
import { formatSqlConnectionUrl } from "../Connection/internal.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  Connect,
  type ConnectOptions,
  type ConnectResource,
} from "./Connect.ts";

/**
 * `arn:{partition}:rds-db:{region}:{account}:dbuser:{resourceId}/{username}`
 * derived from another RDS ARN in the same account/region.
 */
const rdsDbUserArn = (
  sourceArn: string,
  resourceId: string,
  username: string,
): string => {
  const [, partition, , region, accountId] = sourceArn.split(":");
  return `arn:${partition}:rds-db:${region}:${accountId}:dbuser:${resourceId}/${username}`;
};

/**
 * The `rds-db:connect` resource for IAM database authentication.
 *
 * - DBCluster — the cluster's `DbClusterResourceId` (`cluster-XXXX`).
 * - DBProxy — the proxy id (`prx-XXXX`), the last segment of the proxy ARN.
 * - DBProxyEndpoint — the parent proxy's `prx-` id is not an endpoint
 *   attribute, so the resource id is wildcarded to the account/region
 *   (still scoped to the exact `username`).
 */
const dbUserArn = (resource: ConnectResource, username: string) => {
  switch (resource.Type) {
    case "AWS.RDS.DBCluster":
      return Output.map(
        Output.all(resource.dbClusterArn, resource.dbClusterResourceId),
        ([arn, resourceId]) => rdsDbUserArn(arn, resourceId ?? "*", username),
      );
    case "AWS.RDS.DBProxy":
      return Output.map(resource.dbProxyArn, (arn) =>
        rdsDbUserArn(arn, arn.split(":")[6] ?? "*", username),
      );
    default:
      return Output.map(resource.dbProxyEndpointArn, (arn) =>
        rdsDbUserArn(arn, "*", username),
      );
  }
};

export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const getSecretValue = yield* secretsmanager.getSecretValue;
    // Ambient AWS identity for the IAM-auth token presign — captured at
    // layer build so the runtime client stays `RuntimeContext`-colored.
    const services = yield* Effect.context<
      Credentials.Credentials | Region.Region
    >();

    return Effect.fn(function* (
      resource: ConnectResource,
      options: ConnectOptions,
    ) {
      const SecretId =
        options.auth === "iam" ? undefined : yield* options.secret.secretArn;
      const Host = yield* resource.endpoint;
      const Port =
        resource.Type === "AWS.RDS.DBCluster"
          ? yield* resource.port
          : undefined;
      // Engine flavor drives the connection-URL scheme. Proxy endpoints
      // carry no engine attribute — they default to postgres below.
      const Engine =
        resource.Type === "AWS.RDS.DBCluster"
          ? yield* resource.engine
          : resource.Type === "AWS.RDS.DBProxy"
            ? yield* resource.engineFamily
            : undefined;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // DECISION #5: VPC attachment is requested declaratively through
          // the host's `vpc` binding channel (and remains available as a
          // plain Function prop for the manual case).
          const vpc =
            options.subnetIds !== undefined ||
            options.securityGroupIds !== undefined
              ? {
                  vpc: {
                    subnetIds: options.subnetIds ?? [],
                    securityGroupIds: options.securityGroupIds ?? [],
                  },
                }
              : {};
          if (options.auth === "iam") {
            yield* host.bind`Allow(${host}, AWS.RDS.Connect(${resource}))`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["rds-db:connect"],
                  Resource: [dbUserArn(resource, options.username)],
                },
              ],
              ...vpc,
            });
          } else {
            yield* host.bind`Allow(${host}, AWS.RDS.Connect(${options.secret}))`(
              {
                policyStatements: [
                  {
                    Effect: "Allow",
                    Action: [
                      "secretsmanager:GetSecretValue",
                      "secretsmanager:DescribeSecret",
                    ],
                    Resource: [options.secret.secretArn],
                  },
                ],
                ...vpc,
              },
            );
          }
        }
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = Port ? yield* Port : undefined;
        const engine = Engine ? yield* Engine : undefined;

        if (!host) {
          return yield* Effect.die(`RDS endpoint is not available yet`);
        }

        const resolvedPort = options.port ?? port ?? 5432;
        const scheme = engine?.toLowerCase().includes("mysql")
          ? "mysql"
          : "postgresql";

        if (options.auth === "iam") {
          // IAM database authentication mandates TLS.
          const ssl = true;
          const mintToken = generateDbAuthToken({
            service: "rds-db",
            hostname: host,
            port: resolvedPort,
            username: options.username,
          }).pipe(Effect.provideContext(services));
          const token = yield* mintToken;
          return {
            host,
            port: resolvedPort,
            database: options.database,
            username: options.username,
            password: Redacted.value(token),
            ssl,
            url: formatSqlConnectionUrl({
              scheme,
              host,
              port: resolvedPort,
              database: options.database,
              username: options.username,
              password: token,
              ssl,
              // RDS certificates chain to a private AWS CA that Node's
              // trust store doesn't carry — `no-verify` keeps TLS on
              // (mandatory for IAM auth) with libpq `require` semantics.
              sslMode: "no-verify",
            }),
            refreshPassword: mintToken,
          };
        }

        const secretId = yield* SecretId!;
        const value = yield* getSecretValue({
          SecretId: secretId,
        });
        const secretString = value.SecretString
          ? typeof value.SecretString === "string"
            ? value.SecretString
            : Redacted.value(value.SecretString)
          : "{}";
        const secret = JSON.parse(secretString) as {
          username?: string;
          password?: string;
        };

        const ssl = options.ssl ?? true;
        return {
          host,
          port: resolvedPort,
          database: options.database,
          username: secret.username,
          password: secret.password,
          ssl,
          url: formatSqlConnectionUrl({
            scheme,
            host,
            port: resolvedPort,
            database: options.database,
            username: secret.username,
            password: secret.password,
            ssl,
            // See the IAM branch — RDS certs chain to a private CA.
            sslMode: "no-verify",
          }),
        };
      });
    });
  }),
);
