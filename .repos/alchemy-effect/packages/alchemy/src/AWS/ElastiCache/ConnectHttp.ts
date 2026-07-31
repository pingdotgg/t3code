import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { Connect, connectEnvPrefix } from "./Connect.ts";
import type { ServerlessCache } from "./ServerlessCache.ts";

/**
 * Environment-only implementation of {@link Connect}. At deploy time it
 * publishes the cache endpoint as `ELASTICACHE_{LOGICAL_ID}_{HOST,PORT,TLS}`
 * environment variables on the host Function; at runtime it resolves the
 * same values into a typed connection descriptor. No IAM policy is attached
 * — the classic valkey/redis/memcached data plane is governed by VPC
 * security groups, not IAM.
 */
export const ConnectHttp = Layer.effect(
  Connect,
  Effect.gen(function* () {
    return Effect.fn(function* (cache: ServerlessCache) {
      const Host = yield* cache.endpointAddress;
      const Port = yield* cache.endpointPort;
      const ReaderHost = yield* cache.readerEndpointAddress;
      const ReaderPort = yield* cache.readerEndpointPort;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const prefix = connectEnvPrefix(cache.LogicalId);
          yield* host.bind`Allow(${host}, AWS.ElastiCache.Connect(${cache}))`({
            env: {
              [`${prefix}_HOST`]: cache.endpointAddress,
              // Lambda environment variables are strings — stringify the port.
              [`${prefix}_PORT`]: Output.interpolate`${cache.endpointPort}`,
              // Serverless caches are TLS-only.
              [`${prefix}_TLS`]: "true",
            },
          });
        }
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = yield* Port;
        const readerHost = yield* ReaderHost;
        const readerPort = yield* ReaderPort;
        if (!host || port === undefined) {
          return yield* Effect.die(
            `ElastiCache endpoint for '${cache.LogicalId}' is not available yet`,
          );
        }
        return {
          host,
          port,
          readerHost,
          readerPort,
          tls: true,
        };
      });
    });
  }),
);
