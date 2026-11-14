import * as Output from "alchemy/Output";
import { unpackEnvValue } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { CacheCluster } from "./CacheCluster.ts";
import {
  ConnectCacheCluster,
  cacheClusterConnectEnvPrefix,
  type ConnectCacheClusterOptions,
} from "./ConnectCacheCluster.ts";

export const ConnectCacheClusterHttp = Layer.effect(
  ConnectCacheCluster,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (cluster: CacheCluster, options?: ConnectCacheClusterOptions) {
      const prefix = cacheClusterConnectEnvPrefix(cluster.LogicalId);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ElastiCache.ConnectCacheCluster(${cluster})`({
          env: {
            [`${prefix}_ENDPOINTS`]: Output.map(cluster.endpoints, JSON.stringify),
            [`${prefix}_TLS`]: Output.map(cluster.transitEncryptionEnabled, (tls) =>
              String(tls ?? false),
            ),
          },
        });
        if (options?.subnetIds || options?.securityGroupIds) {
          yield* AWSBindings.bindVpc`AWS.ElastiCache.ConnectCacheCluster(${cluster})`({
            subnetIds: options?.subnetIds ?? [],
            securityGroupIds: options?.securityGroupIds ?? [],
          });
        }
      }
      return Effect.gen(function* () {
        const endpoints = unpackEnvValue<Array<{ address: string; port: number }>>(
          process.env[`${prefix}_ENDPOINTS`],
        );
        if (endpoints !== undefined) {
          if (!endpoints.length) {
            return yield* Effect.die(
              `Memcached endpoints for '${cluster.LogicalId}' are not available`,
            );
          }
          return {
            endpoints,
            tls: unpackEnvValue<boolean>(process.env[`${prefix}_TLS`]) ?? false,
          };
        }
        const clusterEndpoints = yield* yield* cluster.endpoints;
        if (!clusterEndpoints.length) {
          return yield* Effect.die(
            `Memcached endpoints for '${cluster.LogicalId}' are not available yet`,
          );
        }
        return {
          endpoints: clusterEndpoints,
          tls: yield* yield* cluster.transitEncryptionEnabled,
        };
      });
    });
  }),
);
