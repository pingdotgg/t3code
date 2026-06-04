import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Secret } from "../SecretsManager/Secret.ts";
import type { DBCluster } from "./DBCluster.ts";
import type { DBProxy } from "./DBProxy.ts";
import type { DBProxyEndpoint } from "./DBProxyEndpoint.ts";

type ConnectResource = DBCluster | DBProxy | DBProxyEndpoint;

export interface ConnectionInfo {
  host: string;
  port: number;
  database?: string;
  username?: string;
  password?: string;
  ssl: boolean;
}

export interface ConnectOptions {
  secret: Secret;
  database?: string;
  port?: number;
  ssl?: boolean;
  subnetIds?: Input<SubnetId[]>;
  securityGroupIds?: Input<SecurityGroupId[]>;
}

/**
 * Runtime binding that resolves connection settings for an Aurora cluster,
 * proxy, or proxy endpoint using a Secrets Manager secret.
 */
export class Connect extends Binding.Service<
  Connect,
  (
    resource: ConnectResource,
    options: ConnectOptions,
  ) => Effect.Effect<
    Effect.Effect<ConnectionInfo, secretsmanager.GetSecretValueError>
  >
>()("AWS.RDS.Connect") {}

export const ConnectLive = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const Policy = yield* ConnectPolicy;
    const getSecretValue = yield* secretsmanager.getSecretValue;

    return Effect.fn(function* (
      resource: ConnectResource,
      options: ConnectOptions,
    ) {
      const SecretId = yield* options.secret.secretArn;
      const Host = yield* resource.endpoint;
      const Port =
        resource.Type === "AWS.RDS.DBCluster"
          ? yield* resource.port
          : undefined;
      yield* Policy(resource, options);

      return Effect.gen(function* () {
        const secretId = yield* SecretId;
        const host = yield* Host;
        const port = Port ? yield* Port : undefined;
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

        if (!host) {
          return yield* Effect.die(`RDS endpoint is not available yet`);
        }

        return {
          host,
          port: options.port ?? port ?? 5432,
          database: options.database,
          username: secret.username,
          password: secret.password,
          ssl: options.ssl ?? true,
        };
      });
    });
  }),
);

export class ConnectPolicy extends Binding.Policy<
  ConnectPolicy,
  (resource: ConnectResource, options: ConnectOptions) => Effect.Effect<void>
>()("AWS.RDS.Connect") {}

export const ConnectPolicyLive = ConnectPolicy.layer.succeed(
  Effect.fn(function* (host, _resource, options) {
    if (isFunction(host)) {
      yield* host.bind`Allow(${host}, AWS.RDS.Connect(${options.secret}))`({
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
      });
    } else {
      return yield* Effect.die(
        `ConnectPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
