import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DBCluster } from "./DBCluster.ts";
import {
  Connect,
  connectEnvPrefix,
  type ConnectOptions,
  formatMongoConnectionUrl,
} from "./Connect.ts";

export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const getSecretValue = yield* secretsmanager.getSecretValue;

    return Effect.fn(function* (cluster: DBCluster, options?: ConnectOptions) {
      const Host = yield* cluster.endpoint;
      const Port = yield* cluster.port;
      // Default credential source: the cluster's managed master user secret
      // (`manageMasterUserPassword: true`). An explicit Secrets Manager
      // secret overrides it.
      const SecretArn = options?.secret
        ? yield* options.secret.secretArn
        : yield* cluster.masterUserSecretArn;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // DocumentDB is VPC-only — request the host's VPC attachment
          // declaratively through the `vpc` binding channel.
          const vpc =
            options?.subnetIds !== undefined ||
            options?.securityGroupIds !== undefined
              ? {
                  vpc: {
                    subnetIds: options?.subnetIds ?? [],
                    securityGroupIds: options?.securityGroupIds ?? [],
                  },
                }
              : {};
          const secretResource = options?.secret
            ? options.secret.secretArn
            : Output.map(cluster.masterUserSecretArn, (arn) => {
                if (arn === undefined) {
                  throw new Error(
                    `AWS.DocDB.Connect(${cluster.LogicalId}): the cluster has no managed master user secret — ` +
                      `set manageMasterUserPassword: true on the cluster or pass options.secret`,
                  );
                }
                return arn;
              });
          const prefix = connectEnvPrefix(cluster.LogicalId);
          yield* host.bind`Allow(${host}, AWS.DocDB.Connect(${cluster}))`({
            env: {
              [`${prefix}_HOST`]: cluster.endpoint,
              // Lambda environment variables are strings — stringify the port.
              [`${prefix}_PORT`]: Output.interpolate`${cluster.port}`,
            },
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "secretsmanager:GetSecretValue",
                  "secretsmanager:DescribeSecret",
                ],
                Resource: [secretResource],
              },
            ],
            ...vpc,
          });
        }
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = yield* Port;
        const secretArn = yield* SecretArn;

        if (!host) {
          return yield* Effect.die(
            `DocumentDB endpoint for '${cluster.LogicalId}' is not available yet`,
          );
        }
        if (!secretArn) {
          return yield* Effect.die(
            `AWS.DocDB.Connect(${cluster.LogicalId}): the cluster has no managed master user secret — ` +
              `set manageMasterUserPassword: true on the cluster or pass options.secret`,
          );
        }

        const value = yield* getSecretValue({ SecretId: secretArn });
        const secretString = value.SecretString
          ? typeof value.SecretString === "string"
            ? value.SecretString
            : Redacted.value(value.SecretString)
          : "{}";
        const secret = JSON.parse(secretString) as {
          username?: string;
          password?: string;
        };

        const resolvedPort = options?.port ?? port ?? 27017;
        const tls = options?.tls ?? true;
        const password =
          secret.password !== undefined
            ? Redacted.make(secret.password)
            : undefined;

        return {
          host,
          port: resolvedPort,
          database: options?.database,
          username: secret.username,
          password,
          tls,
          url: formatMongoConnectionUrl({
            host,
            port: resolvedPort,
            database: options?.database,
            username: secret.username,
            password,
            tls,
          }),
        };
      });
    });
  }),
);
