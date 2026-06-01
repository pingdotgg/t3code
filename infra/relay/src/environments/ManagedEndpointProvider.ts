// @effect-diagnostics nodeBuiltinImport:off

import type {
  RelayManagedEndpoint,
  RelayManagedEndpointOrigin,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as RelayConfiguration from "../Config.ts";

export class ManagedEndpointProvisioningNotConfigured extends Data.TaggedError(
  "ManagedEndpointProvisioningNotConfigured",
)<{}> {}

export class ManagedEndpointProvisioningFailed extends Data.TaggedError(
  "ManagedEndpointProvisioningFailed",
)<{
  readonly cause: unknown;
}> {}

export class ManagedEndpointOriginNotAllowed extends Data.TaggedError(
  "ManagedEndpointOriginNotAllowed",
)<{
  readonly host: string;
  readonly port: number;
}> {}

export type ManagedEndpointProviderError =
  | ManagedEndpointProvisioningNotConfigured
  | ManagedEndpointProvisioningFailed
  | ManagedEndpointOriginNotAllowed;

export interface ManagedEndpointProvisioningResult {
  readonly endpoint: RelayManagedEndpoint;
  readonly runtime: RelayManagedEndpointRuntimeConfig;
}

export interface ManagedEndpointProviderShape {
  readonly provision: (input: {
    readonly environmentId: string;
    readonly origin: RelayManagedEndpointOrigin;
  }) => Effect.Effect<ManagedEndpointProvisioningResult, ManagedEndpointProviderError>;
}

export class ManagedEndpointProvider extends Context.Service<
  ManagedEndpointProvider,
  ManagedEndpointProviderShape
>()("t3code-relay/environments/ManagedEndpointProvider") {}

const CloudflareTunnelCreateResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
});

const CloudflareTunnelListResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
    }),
  ),
});

const CloudflareTunnelTokenResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.String,
});

const CloudflareDnsRecordResponse = Schema.Struct({
  success: Schema.Boolean,
});

const CloudflareDnsRecordListResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
    }),
  ),
});

const requireCloudflareSettings = Effect.fnUntraced(function* (
  settings: RelayConfiguration.RelayConfigurationShape,
) {
  if (
    !settings.managedEndpointBaseDomain ||
    !settings.cloudflareAccountId ||
    !settings.cloudflareZoneId ||
    !settings.cloudflareApiToken
  ) {
    return yield* new ManagedEndpointProvisioningNotConfigured();
  }
  return {
    accountId: settings.cloudflareAccountId,
    zoneId: settings.cloudflareZoneId,
    apiToken: Redacted.value(settings.cloudflareApiToken),
    baseDomain: settings.managedEndpointBaseDomain,
  };
});

function cloudflareRequest(input: {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly apiToken: string;
  readonly body?: unknown;
}): Effect.Effect<HttpClientRequest.HttpClientRequest, ManagedEndpointProvisioningFailed> {
  const base =
    input.method === "GET"
      ? HttpClientRequest.get(input.url)
      : input.method === "POST"
        ? HttpClientRequest.post(input.url)
        : HttpClientRequest.put(input.url);

  const request = base.pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${input.apiToken}`),
    HttpClientRequest.setHeader("content-type", "application/json"),
  );
  return input.body === undefined
    ? Effect.succeed(request)
    : request.pipe(
        HttpClientRequest.bodyJson(input.body),
        Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })),
      );
}

const MANAGED_ENDPOINT_HOST_PREFIX = "tunnels";
const DNS_LABEL_MAX_LENGTH = 63;
const MANAGED_ENDPOINT_HASH_LENGTH = 16;
const MANAGED_ENDPOINT_SAFE_ID_LENGTH =
  DNS_LABEL_MAX_LENGTH - MANAGED_ENDPOINT_HOST_PREFIX.length - 2 - MANAGED_ENDPOINT_HASH_LENGTH;

function managedHostname(environmentId: string, baseDomain: string, hash: string): string {
  const safeId = environmentId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, MANAGED_ENDPOINT_SAFE_ID_LENGTH);
  const prefix = safeId.length > 0 ? safeId : "env";
  return `${MANAGED_ENDPOINT_HOST_PREFIX}-${prefix}-${hash.slice(0, MANAGED_ENDPOINT_HASH_LENGTH)}.${baseDomain.replace(/^\.+|\.+$/g, "")}`;
}

function managedTunnelName(environmentId: string, hash: string): string {
  const safeId = environmentId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
  return `t3-code-${safeId.length > 0 ? safeId : "env"}-${hash.slice(0, 16)}`;
}

function formatOriginService(origin: RelayManagedEndpointOrigin): string {
  const host = origin.localHttpHost.includes(":")
    ? `[${origin.localHttpHost.replace(/^\[(.*)\]$/u, "$1")}]`
    : origin.localHttpHost;
  return `http://${host}:${origin.localHttpPort}`;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLoopbackOrigin(origin: RelayManagedEndpointOrigin): boolean {
  const hostname = normalizeHostname(origin.localHttpHost);
  return (
    (hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost") &&
    Number.isInteger(origin.localHttpPort) &&
    origin.localHttpPort > 0 &&
    origin.localHttpPort <= 65_535
  );
}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  const requireCloudflareSuccess = (
    json: unknown,
  ): Effect.Effect<void, ManagedEndpointProvisioningFailed> =>
    typeof json === "object" &&
    json !== null &&
    "success" in json &&
    (json as { readonly success: unknown }).success === false
      ? Effect.fail(new ManagedEndpointProvisioningFailed({ cause: json }))
      : Effect.void;

  const executeJson = Effect.fnUntraced(function* <A>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Schema<A>,
  ) {
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })));
    if (response.status < 200 || response.status >= 300) {
      return yield* new ManagedEndpointProvisioningFailed({ cause: response.status });
    }
    const json = yield* response.json.pipe(
      Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })),
    );
    const isSchema = Schema.is(schema);
    if (!isSchema(json)) {
      return yield* new ManagedEndpointProvisioningFailed({ cause: json });
    }
    yield* requireCloudflareSuccess(json);
    return json;
  });

  return ManagedEndpointProvider.of({
    provision: Effect.fn("relay.managed_endpoint_provider.provision")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.managed_endpoint.origin_host": input.origin.localHttpHost,
        "relay.managed_endpoint.origin_port": input.origin.localHttpPort,
      });
      if (!isLoopbackOrigin(input.origin)) {
        return yield* new ManagedEndpointOriginNotAllowed({
          host: input.origin.localHttpHost,
          port: input.origin.localHttpPort,
        });
      }
      const cf = yield* requireCloudflareSettings(config);
      const environmentHash = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.environmentId))
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError((cause) => new ManagedEndpointProvisioningFailed({ cause })),
        );
      const hostname = managedHostname(input.environmentId, cf.baseDomain, environmentHash);
      const tunnelName = managedTunnelName(input.environmentId, environmentHash);
      const existingTunnels = yield* cloudflareRequest({
        method: "GET",
        url: `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/cfd_tunnel?${new URLSearchParams(
          [
            ["name", tunnelName],
            ["is_deleted", "false"],
          ],
        ).toString()}`,
        apiToken: cf.apiToken,
      }).pipe(Effect.flatMap((request) => executeJson(request, CloudflareTunnelListResponse)));
      const existingTunnel = existingTunnels.result.find((tunnel) => tunnel.name === tunnelName);
      const tunnel =
        existingTunnel ??
        (yield* cloudflareRequest({
          method: "POST",
          url: `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/cfd_tunnel`,
          apiToken: cf.apiToken,
          body: {
            name: tunnelName,
            config_src: "cloudflare",
          },
        }).pipe(
          Effect.flatMap((request) => executeJson(request, CloudflareTunnelCreateResponse)),
          Effect.map((response) => response.result),
        ));

      yield* cloudflareRequest({
        method: "PUT",
        url: `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/cfd_tunnel/${tunnel.id}/configurations`,
        apiToken: cf.apiToken,
        body: {
          config: {
            ingress: [
              {
                hostname,
                service: formatOriginService(input.origin),
              },
              { service: "http_status:404" },
            ],
          },
        },
      }).pipe(
        Effect.flatMap((request) =>
          executeJson(request, Schema.Struct({ success: Schema.Boolean })),
        ),
      );

      const dnsRecords = yield* cloudflareRequest({
        method: "GET",
        url: `https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records?${new URLSearchParams(
          [
            ["type", "CNAME"],
            ["name", hostname],
          ],
        ).toString()}`,
        apiToken: cf.apiToken,
      }).pipe(Effect.flatMap((request) => executeJson(request, CloudflareDnsRecordListResponse)));
      const existingDnsRecordId = dnsRecords.result[0]?.id;
      yield* cloudflareRequest({
        method: existingDnsRecordId ? "PUT" : "POST",
        url: existingDnsRecordId
          ? `https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records/${existingDnsRecordId}`
          : `https://api.cloudflare.com/client/v4/zones/${cf.zoneId}/dns_records`,
        apiToken: cf.apiToken,
        body: {
          type: "CNAME",
          name: hostname,
          content: `${tunnel.id}.cfargotunnel.com`,
          proxied: true,
        },
      }).pipe(Effect.flatMap((request) => executeJson(request, CloudflareDnsRecordResponse)));

      const token = yield* cloudflareRequest({
        method: "GET",
        url: `https://api.cloudflare.com/client/v4/accounts/${cf.accountId}/cfd_tunnel/${tunnel.id}/token`,
        apiToken: cf.apiToken,
      }).pipe(Effect.flatMap((request) => executeJson(request, CloudflareTunnelTokenResponse)));

      return {
        endpoint: {
          httpBaseUrl: `https://${hostname}/`,
          wsBaseUrl: `wss://${hostname}/ws`,
          providerKind: "cloudflare_tunnel",
        },
        runtime: {
          providerKind: "cloudflare_tunnel",
          connectorToken: token.result,
          tunnelId: tunnel.id,
          tunnelName: tunnel.name,
        },
      } satisfies ManagedEndpointProvisioningResult;
    }),
  });
});

export const layer = Layer.effect(ManagedEndpointProvider, make);
