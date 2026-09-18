import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { unpackEnvValue } from "../../RuntimeContext.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ConnectReplicationGroup,
  replicationGroupConnectEnvPrefix,
  type ConnectReplicationGroupOptions,
} from "./ConnectReplicationGroup.ts";
import type { ReplicationGroup } from "./ReplicationGroup.ts";

export const ConnectReplicationGroupHttp = Layer.effect(
  ConnectReplicationGroup,
  Effect.gen(function* () {
    return Effect.fn(function* (
      group: ReplicationGroup,
      options?: ConnectReplicationGroupOptions,
    ) {
      const prefix = replicationGroupConnectEnvPrefix(group.LogicalId);
      // Outputs yield a deferred runtime effect. Keep the Output expressions
      // for deploy-time bindings, where Apply resolves them before Lambda's
      // API call, and use the deferred values only in the runtime closure.
      const configurationHost = group.configurationEndpointAddress;
      const primaryHost = group.primaryEndpointAddress;
      const configurationPort = group.configurationEndpointPort;
      const primaryPort = group.primaryEndpointPort;
      const endpointHost = Output.flatMap(configurationHost, (host) =>
        host === undefined ? primaryHost : Output.asOutput(host),
      );
      const endpointPort = Output.flatMap(configurationPort, (port) =>
        port === undefined ? primaryPort : Output.asOutput(port),
      );
      const readerHost = Output.map(
        group.readerEndpointAddress,
        (host) => host ?? "",
      );
      const readerPort = Output.map(group.readerEndpointPort, (port) =>
        port === undefined ? "" : String(port),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ElastiCache.ConnectReplicationGroup(${group}))`(
            {
              env: {
                [`${prefix}_HOST`]: endpointHost,
                [`${prefix}_PORT`]: Output.interpolate`${endpointPort}`,
                [`${prefix}_TLS`]: Output.map(
                  group.transitEncryptionEnabled,
                  String,
                ),
                [`${prefix}_READER_HOST`]: readerHost,
                [`${prefix}_READER_PORT`]: readerPort,
              },
              ...(options?.subnetIds || options?.securityGroupIds
                ? {
                    vpc: {
                      subnetIds: options?.subnetIds ?? [],
                      securityGroupIds: options?.securityGroupIds ?? [],
                    },
                  }
                : {}),
            },
          );
        }
      }
      return Effect.gen(function* () {
        const host = unpackEnvValue<string>(process.env[`${prefix}_HOST`]);
        if (host !== undefined) {
          const port = unpackEnvValue<number>(process.env[`${prefix}_PORT`]);
          const tls = unpackEnvValue<boolean>(process.env[`${prefix}_TLS`]);
          const readerHost = unpackEnvValue<string>(
            process.env[`${prefix}_READER_HOST`],
          );
          const readerPort = unpackEnvValue<number>(
            process.env[`${prefix}_READER_PORT`],
          );
          if (!host || port === undefined) {
            return yield* Effect.die(
              `ElastiCache endpoint for '${group.LogicalId}' is not available`,
            );
          }
          return {
            host,
            port,
            readerHost: readerHost || undefined,
            readerPort: readerHost ? readerPort : undefined,
            tls: tls ?? true,
          };
        }
        const endpoint = yield* yield* endpointHost;
        const port = yield* yield* endpointPort;
        if (!endpoint || port === undefined) {
          return yield* Effect.die(
            `ElastiCache endpoint for '${group.LogicalId}' is not available yet`,
          );
        }
        return {
          host: endpoint,
          port,
          readerHost: yield* yield* group.readerEndpointAddress,
          readerPort: yield* yield* group.readerEndpointPort,
          tls: yield* yield* group.transitEncryptionEnabled,
        };
      });
    });
  }),
);
