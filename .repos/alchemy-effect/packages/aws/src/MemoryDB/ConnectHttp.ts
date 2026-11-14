import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Cluster } from "./Cluster.ts";
import { Connect, connectEnvPrefix, type ConnectOptions } from "./Connect.ts";

/**
 * Implementation of {@link Connect}. At deploy time it publishes the cluster
 * endpoint as `MEMORYDB_{LOGICAL_ID}_{HOST,PORT,TLS}` environment variables
 * on the host Function and grants `memorydb:Connect` on the cluster ARN plus
 * any IAM-auth users' ARNs; at runtime it resolves the same values into a
 * typed connection descriptor. The valkey/redis data plane itself is reached
 * over the VPC network — password auth needs no IAM, while IAM auth
 * additionally requires the `memorydb:Connect` grant this binding attaches.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (cluster: Cluster, options?: ConnectOptions) {
      const Host = yield* cluster.endpointAddress;
      const Port = yield* cluster.endpointPort;
      const Tls = yield* cluster.tlsEnabled;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // MemoryDB is VPC-only: attach the host to the cluster's VPC.
        const vpc =
          options?.subnetIds !== undefined || options?.securityGroupIds !== undefined
            ? {
                subnetIds: options?.subnetIds ?? [],
                securityGroupIds: options?.securityGroupIds ?? [],
              }
            : undefined;
        const prefix = connectEnvPrefix(cluster.LogicalId);
        yield* bind`AWS.MemoryDB.Connect(${cluster})`({
          env: {
            [`${prefix}_HOST`]: cluster.endpointAddress,
            // Lambda environment variables are strings — stringify the port.
            [`${prefix}_PORT`]: Output.interpolate`${cluster.endpointPort}`,
            [`${prefix}_TLS`]: Output.map(cluster.tlsEnabled, (tls) => String(tls ?? true)),
          },
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["memorydb:Connect"],
              // IAM auth authorizes against both the cluster and the user.
              Resource: [
                Output.interpolate`${cluster.clusterArn}`,
                ...(options?.users ?? []).map((user) => Output.interpolate`${user.userArn}`),
              ],
            },
          ],
        });
        if (vpc !== undefined) {
          yield* AWSBindings.bindVpc`AWS.MemoryDB.Connect(${cluster})`(vpc);
        }
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = yield* Port;
        const tls = yield* Tls;
        if (!host || port === undefined) {
          return yield* Effect.die(
            `MemoryDB endpoint for '${cluster.LogicalId}' is not available yet`,
          );
        }
        return {
          host,
          port,
          tls: tls ?? true,
        };
      });
    });
  }),
);
