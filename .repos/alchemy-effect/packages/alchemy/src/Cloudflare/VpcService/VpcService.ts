import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type VpcServiceProps = {
  /**
   * Display name for the VPC service. If omitted, a unique name is generated.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Service protocol. Currently only `"http"` is supported.
   *
   * @default "http"
   */
  serviceType?: "http";
  /**
   * Port that Workers should reach for plain HTTP traffic.
   */
  httpPort?: number;
  /**
   * Port that Workers should reach for HTTPS traffic.
   */
  httpsPort?: number;
  /**
   * Host the service is reachable at -- IPv4, IPv6, dual stack, or hostname.
   */
  host: VpcService.Host;
  /**
   * Whether to adopt an existing VPC service with the same name when create
   * fails because of a name conflict.
   *
   * @default false
   */
  adopt?: boolean;
};

export declare namespace VpcService {
  /**
   * Host the VPC service is reachable at.
   */
  export type Host = IPv4Host | IPv6Host | DualStackHost | HostnameHost;
  export interface IPv4Host {
    ipv4: string;
    network: Network;
  }
  export interface IPv6Host {
    ipv6: string;
    network: Network;
  }
  export interface DualStackHost {
    ipv4: string;
    ipv6: string;
    network: Network;
  }
  export interface HostnameHost {
    hostname: string;
    resolverNetwork: ResolverNetwork;
  }
  export interface Network {
    tunnelId: string;
  }
  export interface ResolverNetwork extends Network {
    resolverIps?: string[];
  }
}

export type VpcServiceAttributes = {
  serviceId: string;
  serviceName: string;
  serviceType: "http" | "tcp";
  httpPort: number | undefined;
  httpsPort: number | undefined;
  host: VpcService.Host;
  accountId: string;
  createdAt: number | undefined;
  updatedAt: number | undefined;
};

export type VpcService = Resource<
  "Cloudflare.VpcService",
  VpcServiceProps,
  VpcServiceAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare VPC service that exposes a private host (IP or hostname)
 * reachable through a Cloudflare Tunnel for Workers VPC.
 *
 * @section Creating a VPC Service
 * @example Hostname through a tunnel
 * ```typescript
 * const tunnel = yield* Cloudflare.Tunnel("MyTunnel");
 * const service = yield* Cloudflare.VpcService("Internal", {
 *   host: {
 *     hostname: "internal.example.com",
 *     resolverNetwork: { tunnelId: tunnel.tunnelId, resolverIps: ["10.0.0.53"] },
 *   },
 * });
 * ```
 *
 * @example IPv4 with explicit ports
 * ```typescript
 * const service = yield* Cloudflare.VpcService("DevServer", {
 *   httpPort: 5173,
 *   host: { ipv4: "192.168.1.100", network: { tunnelId: tunnel.tunnelId } },
 * });
 * ```
 */
export const VpcService = Resource<VpcService>("Cloudflare.VpcService");

export const VpcServiceProvider = () =>
  Provider.effect(
    VpcService,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createService = yield* connectivity.createDirectoryService;
      const getService = yield* connectivity.getDirectoryService;
      const updateService = yield* connectivity.updateDirectoryService;
      const deleteService = yield* connectivity.deleteDirectoryService;
      const listServices = connectivity.listDirectoryServices;

      const createServiceName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return yield* createPhysicalName({
            id,
            lowercase: true,
            maxLength: 63,
          });
        });

      const findServiceByName = (name: string) =>
        listServices.items({ accountId }).pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      return {
        stables: ["serviceId", "accountId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          const name = yield* createServiceName(id, news.name);
          const oldName = output?.serviceName
            ? output.serviceName
            : yield* createServiceName(id, olds?.name);
          if (name !== oldName) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = yield* createServiceName(id, news.name);
          const acct = output?.accountId ?? accountId;

          // Observe — re-fetch the cached service; fall back to a name
          // scan so we recover from out-of-band deletes or partial state
          // persistence failures.
          let observed: connectivity.GetDirectoryServiceResponse | undefined;
          if (output?.serviceId) {
            observed = yield* getService({
              accountId: acct,
              serviceId: output.serviceId,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          }
          if (!observed) {
            const match = yield* findServiceByName(name);
            observed = match as
              | connectivity.GetDirectoryServiceResponse
              | undefined;
          }

          // Ensure — create if missing. Cloudflare rejects a duplicate
          // name with a generic error; tolerate by adopting the existing
          // service (when the caller opted in) and re-applying the
          // desired configuration.
          if (!observed || !observed.serviceId) {
            const result = yield* createService({
              accountId: acct,
              name,
              type: news.serviceType ?? "http",
              httpPort: news.httpPort,
              httpsPort: news.httpsPort,
              host: news.host,
            }).pipe(
              Effect.catch((err: unknown) =>
                Effect.gen(function* () {
                  if (!news.adopt) return yield* Effect.fail(err as never);
                  const existing = yield* findServiceByName(name);
                  if (!existing || !existing.serviceId) {
                    return yield* Effect.fail(err as never);
                  }
                  return yield* updateService({
                    accountId: acct,
                    serviceId: existing.serviceId,
                    name,
                    type: news.serviceType ?? "http",
                    httpPort: news.httpPort,
                    httpsPort: news.httpsPort,
                    host: news.host,
                  });
                }),
              ),
            );
            return formatVpcService(result, acct);
          }

          // Sync — the Cloudflare update API replaces all mutable fields
          // (name, ports, host) atomically, so always issue it so
          // adoption and routine updates converge.
          const result = yield* updateService({
            accountId: acct,
            serviceId: observed.serviceId,
            name,
            type: news.serviceType ?? observed.type ?? "http",
            httpPort: news.httpPort,
            httpsPort: news.httpsPort,
            host: news.host,
          });
          return formatVpcService(result, acct);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteService({
            accountId: output.accountId,
            serviceId: output.serviceId,
          }).pipe(Effect.catch(() => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.serviceId) {
            return yield* getService({
              accountId: output.accountId,
              serviceId: output.serviceId,
            }).pipe(
              Effect.map((s) => formatVpcService(s, output.accountId)),
              Effect.catch(() => Effect.succeed(undefined)),
            );
          }
          const name = yield* createServiceName(id, olds?.name);
          const existing = yield* findServiceByName(name);
          if (!existing || !existing.serviceId) return undefined;
          return formatVpcService(existing, accountId);
        }),
      };
    }),
  );

export const formatVpcService = (
  service: {
    serviceId?: string | null;
    name: string;
    // Distilled widened generated string enums to open unions (`string & {}`);
    // the API only ever returns the known variants here.
    type: string;
    createdAt?: string | null;
    updatedAt?: string | null;
    httpPort?: number | null;
    httpsPort?: number | null;
    host: connectivity.GetDirectoryServiceResponse["host"];
  },
  accountId: string,
): VpcServiceAttributes => {
  let host: VpcService.Host;
  if ("hostname" in service.host) {
    host = {
      hostname: service.host.hostname,
      resolverNetwork: {
        tunnelId: service.host.resolverNetwork.tunnelId,
        resolverIps: service.host.resolverNetwork.resolverIps ?? undefined,
      },
    };
  } else if ("ipv4" in service.host && "ipv6" in service.host) {
    host = {
      ipv4: service.host.ipv4,
      ipv6: service.host.ipv6,
      network: { tunnelId: service.host.network.tunnelId },
    };
  } else if ("ipv4" in service.host) {
    host = {
      ipv4: service.host.ipv4,
      network: { tunnelId: service.host.network.tunnelId },
    };
  } else {
    host = {
      ipv6: service.host.ipv6,
      network: { tunnelId: service.host.network.tunnelId },
    };
  }
  return {
    serviceId: service.serviceId!,
    serviceName: service.name,
    serviceType: service.type as "http" | "tcp",
    httpPort: service.httpPort ?? undefined,
    httpsPort: service.httpsPort ?? undefined,
    host,
    accountId,
    createdAt: service.createdAt
      ? new Date(service.createdAt).getTime()
      : undefined,
    updatedAt: service.updatedAt
      ? new Date(service.updatedAt).getTime()
      : undefined,
  };
};
