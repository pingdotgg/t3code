import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { retryClientVpn } from "./ClientVpnWait.ts";

export type ClientVpnEndpointId = `cvpn-endpoint-${string}`;

export interface ClientVpnAuthenticationOptions {
  /** The authentication method. Changing authentication replaces the endpoint. */
  type:
    | "certificate-authentication"
    | "directory-service-authentication"
    | "federated-authentication";
  /** AWS Directory Service authentication settings. */
  activeDirectory?: {
    /** ID of the directory used to authenticate clients. */
    directoryId: string;
  };
  /** Mutual TLS authentication settings. */
  mutualAuthentication?: {
    /** ACM ARN containing the client root certificate chain. */
    clientRootCertificateChainArn: string;
  };
  /** SAML authentication settings. */
  federatedAuthentication?: {
    /** ARN of the IAM SAML identity provider. */
    samlProviderArn: string;
    /** ARN of the IAM SAML provider for the self-service portal. */
    selfServiceSamlProviderArn?: string;
  };
}

export interface ClientVpnEndpointProps {
  /** IPv4 CIDR allocated to clients, with a /12 through /22 prefix. Required for IPv4 traffic; omit for IPv6-only traffic. Must not overlap target networks. Changing it replaces the endpoint. */
  clientCidrBlock?: string;
  /** ARN of the ACM server certificate in the endpoint's region. */
  serverCertificateArn: string;
  /** One or two authentication methods. Changing these replaces the endpoint. */
  authenticationOptions: ClientVpnAuthenticationOptions[];
  /** Connection logging configuration. Omission disables logging. */
  connectionLogOptions?: {
    /** Whether connection logging is enabled. */
    enabled: boolean;
    /** CloudWatch Logs group receiving connection logs. Required when enabled. */
    cloudwatchLogGroup?: string;
    /** Optional stream receiving connection logs. */
    cloudwatchLogStream?: string;
  };
  /** Endpoint description. Omission clears the description. */
  description?: string;
  /** Up to two custom DNS servers. Omission or an empty array disables custom DNS. */
  dnsServers?: string[];
  /** Transport protocol. Changing it replaces the endpoint. @default "udp" */
  transportProtocol?: "udp" | "tcp";
  /** VPN port, either 443 or 1194. @default 443 */
  vpnPort?: 443 | 1194;
  /** Route only configured destinations through the VPN. @default false */
  splitTunnel?: boolean;
  /** VPC for security groups. Changing or removing it replaces the endpoint. */
  vpcId?: string;
  /** Security groups to apply. Omission restores the VPC's default security group. Requires a VPC. */
  securityGroupIds?: string[];
  /** Whether clients can download their configuration through the self-service portal. @default "disabled" */
  selfServicePortal?: "enabled" | "disabled";
  /** Maximum session duration in hours. @default 24 */
  sessionTimeoutHours?: 8 | 10 | 12 | 24;
  /** Disconnect clients when their session expires. @default false */
  disconnectOnSessionTimeout?: boolean;
  /** Lambda connection handler. Omission disables the handler. */
  clientConnectOptions?: {
    /** Whether to invoke the connection handler. */
    enabled: boolean;
    /** ARN of the Lambda connection handler. Required when enabled. */
    lambdaFunctionArn?: string;
  };
  /** Client login banner. Omission disables the banner. */
  clientLoginBannerOptions?: {
    /** Whether the banner is enabled. */
    enabled: boolean;
    /** Text displayed to connecting clients. Required when enabled. */
    bannerText?: string;
  };
  /** Enforce endpoint routes on clients. @default false */
  clientRouteEnforcement?: boolean;
  /** Endpoint address family. Changing it replaces the endpoint. @default "ipv4" */
  endpointIpAddressType?: "ipv4" | "ipv6" | "dual-stack";
  /** Traffic address family. Changing it replaces the endpoint. @default "ipv4" */
  trafficIpAddressType?: "ipv4" | "ipv6" | "dual-stack";
  /** User tags. Alchemy ownership tags cannot be overridden. */
  tags?: Record<string, string>;
}

export interface ClientVpnEndpoint extends Resource<
  "AWS.EC2.ClientVpnEndpoint",
  ClientVpnEndpointProps,
  {
    /** AWS-assigned endpoint ID. */
    clientVpnEndpointId: ClientVpnEndpointId;
    /** Amazon Resource Name of the endpoint. */
    clientVpnEndpointArn: string;
    /** DNS name clients connect to. */
    dnsName: string;
    /** Current status. An endpoint without target networks is pending-associate. */
    status: EC2.ClientVpnEndpointStatusCode;
    /** Observed description. */
    description: string;
    /** Client IPv4 address range, absent for IPv6-only traffic. */
    clientCidrBlock: string | undefined;
    /** ACM server certificate ARN. */
    serverCertificateArn: string;
    /** Observed DNS servers. */
    dnsServers: string[];
    /** Whether split tunneling is enabled. */
    splitTunnel: boolean;
    /** Listening port. */
    vpnPort: number;
    /** Transport protocol. */
    transportProtocol: string;
    /** VPC associated with the endpoint. */
    vpcId: string | undefined;
    /** Applied security groups. */
    securityGroupIds: string[];
    /** Maximum session duration in hours. */
    sessionTimeoutHours: number;
    /** Whether clients disconnect at session expiry. */
    disconnectOnSessionTimeout: boolean;
    /** Self-service configuration download URL, when enabled. */
    selfServicePortalUrl: string | undefined;
    /** Observed connection logging settings. */
    connectionLogOptions: NonNullable<
      ClientVpnEndpointProps["connectionLogOptions"]
    >;
    /** Observed connection handler settings. */
    clientConnectOptions: NonNullable<
      ClientVpnEndpointProps["clientConnectOptions"]
    >;
    /** Observed login banner settings. */
    clientLoginBannerOptions: NonNullable<
      ClientVpnEndpointProps["clientLoginBannerOptions"]
    >;
    /** Observed tags, including ownership tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Client VPN endpoint for authenticated remote access to a VPC.
 * Create target network associations, authorization rules, and routes separately.
 * An endpoint is usable only after a target network has finished associating.
 * Client address range, authentication, transport, address families, and VPC
 * changes replace the endpoint. Other settings update in place; omitted optional
 * settings restore the documented defaults rather than leaving drift unmanaged.
 *
 * Readiness waits default to 30 minutes. Set `AWS_CLIENT_VPN_TIMEOUT` to a
 * positive finite duration, such as `45 minutes`, to override this deadline.
 *
 * ### Creating an Endpoint
 * **Example:** Mutual TLS with split tunneling
 * ```typescript
 * const endpoint = yield* AWS.EC2.ClientVpnEndpoint("Vpn", {
 *   clientCidrBlock: "172.20.0.0/22",
 *   serverCertificateArn: certificate.certificateArn,
 *   authenticationOptions: [{
 *     type: "certificate-authentication",
 *     mutualAuthentication: {
 *       clientRootCertificateChainArn: certificate.certificateArn,
 *     },
 *   }],
 *   splitTunnel: true,
 *   vpcId: vpc.vpcId,
 * });
 * ```
 *
 * ### Logging Connections
 * **Example:** Send connection logs to CloudWatch
 * ```typescript
 * const endpoint = yield* AWS.EC2.ClientVpnEndpoint("LoggedVpn", {
 *   clientCidrBlock: "172.20.0.0/22",
 *   serverCertificateArn: certificate.certificateArn,
 *   authenticationOptions: [{
 *     type: "directory-service-authentication",
 *     activeDirectory: { directoryId: "d-0123456789" },
 *   }],
 *   connectionLogOptions: {
 *     enabled: true,
 *     cloudwatchLogGroup: logGroup.logGroupName,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ClientVpnEndpoint = Resource<ClientVpnEndpoint>(
  "AWS.EC2.ClientVpnEndpoint",
);

class ClientVpnEndpointNotReady extends Data.TaggedError(
  "ClientVpnEndpointNotReady",
)<{
  endpointId: string;
  status: string;
  pendingSettings?: string[];
}> {
  get message() {
    return `Client VPN endpoint ${this.endpointId} is ${this.status}${
      this.pendingSettings?.length
        ? `; waiting for ${this.pendingSettings.join(", ")}`
        : ""
    }`;
  }
}

const gone = (endpoint: EC2.ClientVpnEndpoint) =>
  endpoint.Status?.Code === "deleted";
const usable = (endpoint: EC2.ClientVpnEndpoint) =>
  endpoint.Status?.Code === "pending-associate" ||
  endpoint.Status?.Code === "available";

const describe = (endpointId: string) =>
  EC2.describeClientVpnEndpoints({ ClientVpnEndpointIds: [endpointId] }).pipe(
    Effect.map((result) =>
      result.ClientVpnEndpoints?.find((endpoint) => !gone(endpoint)),
    ),
    Effect.catchTag("InvalidClientVpnEndpointId.NotFound", () =>
      Effect.succeed(undefined),
    ),
  );

const authentication = (
  options: ClientVpnAuthenticationOptions[],
): EC2.ClientVpnAuthenticationRequest[] =>
  options.map((option) => ({
    Type: option.type,
    ActiveDirectory: option.activeDirectory && {
      DirectoryId: option.activeDirectory.directoryId,
    },
    MutualAuthentication: option.mutualAuthentication && {
      ClientRootCertificateChainArn:
        option.mutualAuthentication.clientRootCertificateChainArn,
    },
    FederatedAuthentication: option.federatedAuthentication && {
      SAMLProviderArn: option.federatedAuthentication.samlProviderArn,
      SelfServiceSAMLProviderArn:
        option.federatedAuthentication.selfServiceSamlProviderArn,
    },
  }));

const settings = (props: ClientVpnEndpointProps) => ({
  ServerCertificateArn: props.serverCertificateArn,
  Description: props.description ?? "",
  SplitTunnel: props.splitTunnel ?? false,
  VpnPort: props.vpnPort ?? 443,
  SelfServicePortal: props.selfServicePortal ?? "disabled",
  SessionTimeoutHours: props.sessionTimeoutHours ?? 24,
  DisconnectOnSessionTimeout: props.disconnectOnSessionTimeout ?? false,
  ConnectionLogOptions: props.connectionLogOptions?.enabled
    ? {
        Enabled: true,
        CloudwatchLogGroup: props.connectionLogOptions.cloudwatchLogGroup,
        CloudwatchLogStream: props.connectionLogOptions.cloudwatchLogStream,
      }
    : { Enabled: false },
  ClientConnectOptions: props.clientConnectOptions?.enabled
    ? {
        Enabled: true,
        LambdaFunctionArn: props.clientConnectOptions.lambdaFunctionArn,
      }
    : { Enabled: false },
  ClientLoginBannerOptions: props.clientLoginBannerOptions?.enabled
    ? {
        Enabled: true,
        BannerText: props.clientLoginBannerOptions.bannerText,
      }
    : { Enabled: false },
  ClientRouteEnforcementOptions: {
    Enforced: props.clientRouteEnforcement ?? false,
  },
});

const observedSettings = (
  endpoint: EC2.ClientVpnEndpoint,
  props: ClientVpnEndpointProps,
) => ({
  ServerCertificateArn: endpoint.ServerCertificateArn,
  Description: endpoint.Description ?? "",
  SplitTunnel: endpoint.SplitTunnel ?? false,
  VpnPort: endpoint.VpnPort ?? 443,
  SelfServicePortal: endpoint.SelfServicePortalUrl ? "enabled" : "disabled",
  SessionTimeoutHours: endpoint.SessionTimeoutHours ?? 24,
  DisconnectOnSessionTimeout: endpoint.DisconnectOnSessionTimeout ?? false,
  ConnectionLogOptions: endpoint.ConnectionLogOptions?.Enabled
    ? {
        Enabled: true,
        CloudwatchLogGroup: endpoint.ConnectionLogOptions.CloudwatchLogGroup,
        // AWS chooses the stream when only a log group is requested.
        CloudwatchLogStream:
          props.connectionLogOptions?.cloudwatchLogStream === undefined
            ? undefined
            : endpoint.ConnectionLogOptions.CloudwatchLogStream,
      }
    : { Enabled: false },
  ClientConnectOptions: endpoint.ClientConnectOptions?.Enabled
    ? {
        Enabled: true,
        LambdaFunctionArn: endpoint.ClientConnectOptions.LambdaFunctionArn,
      }
    : { Enabled: false },
  ClientLoginBannerOptions: endpoint.ClientLoginBannerOptions?.Enabled
    ? {
        Enabled: true,
        BannerText: endpoint.ClientLoginBannerOptions.BannerText,
      }
    : { Enabled: false },
  ClientRouteEnforcementOptions: {
    Enforced: endpoint.ClientRouteEnforcementOptions?.Enforced ?? false,
  },
});

const toAttrs = Effect.fn(function* (endpoint: EC2.ClientVpnEndpoint) {
  const { region, accountId } = yield* AWSEnvironment.current;
  return {
    clientVpnEndpointId: endpoint.ClientVpnEndpointId as ClientVpnEndpointId,
    clientVpnEndpointArn: `arn:aws:ec2:${region}:${accountId}:client-vpn-endpoint/${endpoint.ClientVpnEndpointId}`,
    dnsName: endpoint.DnsName ?? "",
    status: endpoint.Status?.Code ?? "pending-associate",
    description: endpoint.Description ?? "",
    clientCidrBlock: endpoint.ClientCidrBlock,
    serverCertificateArn: endpoint.ServerCertificateArn!,
    dnsServers: endpoint.DnsServers ?? [],
    splitTunnel: endpoint.SplitTunnel ?? false,
    vpnPort: endpoint.VpnPort ?? 443,
    transportProtocol: endpoint.TransportProtocol ?? "udp",
    vpcId: endpoint.VpcId,
    securityGroupIds: endpoint.SecurityGroupIds ?? [],
    sessionTimeoutHours: endpoint.SessionTimeoutHours ?? 24,
    disconnectOnSessionTimeout: endpoint.DisconnectOnSessionTimeout ?? false,
    selfServicePortalUrl: endpoint.SelfServicePortalUrl,
    connectionLogOptions: {
      enabled: endpoint.ConnectionLogOptions?.Enabled ?? false,
      cloudwatchLogGroup: endpoint.ConnectionLogOptions?.CloudwatchLogGroup,
      cloudwatchLogStream: endpoint.ConnectionLogOptions?.CloudwatchLogStream,
    },
    clientConnectOptions: {
      enabled: endpoint.ClientConnectOptions?.Enabled ?? false,
      lambdaFunctionArn: endpoint.ClientConnectOptions?.LambdaFunctionArn,
    },
    clientLoginBannerOptions: {
      enabled: endpoint.ClientLoginBannerOptions?.Enabled ?? false,
      bannerText: endpoint.ClientLoginBannerOptions?.BannerText,
    },
    tags: tagRecord(
      endpoint.Tags?.map((tag) => ({ Key: tag.Key!, Value: tag.Value! })),
    ),
  } satisfies ClientVpnEndpoint["Attributes"];
});

const changesFor = Effect.fn(function* (
  news: ClientVpnEndpointProps,
  endpoint: EC2.ClientVpnEndpoint,
) {
  const desired = settings(news);
  const observed = observedSettings(endpoint, news);
  const changes: EC2.ModifyClientVpnEndpointRequest = {
    ...Object.fromEntries(
      Object.entries(desired).filter(
        ([key, value]) =>
          !deepEqual(value, observed[key as keyof typeof observed]),
      ),
    ),
  };
  if (!deepEqual(news.dnsServers ?? [], endpoint.DnsServers ?? [])) {
    changes.DnsServers = {
      Enabled: !!news.dnsServers?.length,
      CustomDnsServers: news.dnsServers?.length ? news.dnsServers : undefined,
    };
  }
  const vpcId = news.vpcId ?? endpoint.VpcId;
  let groups = news.securityGroupIds;
  if (vpcId && !groups?.length) {
    const defaults = yield* EC2.describeSecurityGroups({
      Filters: [
        { Name: "vpc-id", Values: [vpcId] },
        { Name: "group-name", Values: ["default"] },
      ],
    });
    groups = defaults.SecurityGroups?.map((group) => group.GroupId!);
  }
  if (
    vpcId &&
    groups?.length &&
    !deepEqual(
      [...groups].sort(),
      [...(endpoint.SecurityGroupIds ?? [])].sort(),
    )
  ) {
    changes.VpcId = vpcId;
    changes.SecurityGroupIds = groups;
  }
  return { changes, desired, groups };
});

export const ClientVpnEndpointProvider = () =>
  Provider.effect(
    ClientVpnEndpoint,
    Effect.gen(function* () {
      const recover = Effect.fn(function* (id: string, instanceId: string) {
        const endpoints = yield* EC2.describeClientVpnEndpoints
          .items({
            Filters: [
              ...(yield* createAlchemyTagFilters(id)),
              { Name: "tag:alchemy::instance", Values: [instanceId] },
            ],
          })
          .pipe(Stream.runCollect);
        return endpoints.find((endpoint) => !gone(endpoint));
      });

      return {
        stables: ["clientVpnEndpointId", "clientVpnEndpointArn"],
        nuke: {
          dependsOn: [
            "AWS.EC2.VPC",
            "AWS.EC2.SecurityGroup",
            "AWS.ACM.Certificate",
          ],
        },
        diff: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
          if (!("authenticationOptions" in news)) return { action: "replace" };
          for (const key of [
            "clientCidrBlock",
            "authenticationOptions",
            "transportProtocol",
            "vpcId",
            "endpointIpAddressType",
            "trafficIpAddressType",
          ] as const) {
            if (
              !isResolved<ClientVpnEndpointProps[typeof key]>(news[key]) ||
              !deepEqual(news[key], olds[key])
            )
              return { action: "replace" };
          }
          if (!isResolved<ClientVpnEndpointProps>(news))
            return { action: "update" };
          if (!output) return;
          const endpoint = yield* describe(output.clientVpnEndpointId);
          if (!endpoint || endpoint.Status?.Code === "deleting")
            return { action: "update", stables: [] };
          if (!usable(endpoint)) return { action: "update" };
          const { changes } = yield* changesFor(news, endpoint);
          const tags = {
            ...news.tags,
            ...(yield* createInternalTags(id)),
            "alchemy::instance": instanceId,
          };
          const { removed, upsert } = diffTags(
            tagRecord(
              endpoint.Tags?.map((tag) => ({
                Key: tag.Key!,
                Value: tag.Value!,
              })),
            ),
            tags,
          );
          if (Object.keys(changes).length || removed.length || upsert.length)
            return { action: "update" };
        }),
        read: Effect.fn(function* ({ id, instanceId, output }) {
          const endpoint = output
            ? yield* describe(output.clientVpnEndpointId)
            : yield* recover(id, instanceId);
          if (!endpoint) return undefined;
          const attrs = yield* toAttrs(endpoint);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),
        list: Effect.fn(function* () {
          const endpoints = yield* EC2.describeClientVpnEndpoints
            .items({})
            .pipe(Stream.runCollect);
          return yield* Effect.forEach(
            endpoints.filter((endpoint) => !gone(endpoint)),
            toAttrs,
          );
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const tags = {
            ...news.tags,
            ...(yield* createInternalTags(id)),
            "alchemy::instance": instanceId,
          };
          let endpoint = output
            ? yield* describe(output.clientVpnEndpointId)
            : undefined;
          endpoint ??= yield* recover(id, instanceId);
          if (endpoint?.Status?.Code === "deleting") {
            const endpointId = endpoint.ClientVpnEndpointId!;
            yield* describe(endpointId).pipe(
              Effect.flatMap((value) =>
                value
                  ? Effect.fail(
                      new ClientVpnEndpointNotReady({
                        endpointId,
                        status: value.Status?.Code ?? "unknown",
                      }),
                    )
                  : Effect.void,
              ),
              (effect) =>
                retryClientVpn(
                  effect,
                  (error) => error._tag === "ClientVpnEndpointNotReady",
                ),
            );
            endpoint = undefined;
          }
          if (!endpoint) {
            const created = yield* EC2.createClientVpnEndpoint({
              ...settings(news),
              ClientToken: `${instanceId}-${output?.clientVpnEndpointId.slice(-17) ?? "initial"}`,
              ClientCidrBlock: news.clientCidrBlock,
              AuthenticationOptions: authentication(news.authenticationOptions),
              TransportProtocol: news.transportProtocol ?? "udp",
              DnsServers: news.dnsServers?.length ? news.dnsServers : undefined,
              VpcId: news.vpcId,
              SecurityGroupIds: news.securityGroupIds,
              EndpointIpAddressType: news.endpointIpAddressType ?? "ipv4",
              TrafficIpAddressType: news.trafficIpAddressType ?? "ipv4",
              TagSpecifications: [
                {
                  ResourceType: "client-vpn-endpoint",
                  Tags: createTagsList(tags),
                },
              ],
            });
            const endpointId = created.ClientVpnEndpointId!;
            endpoint = yield* describe(endpointId).pipe(
              Effect.flatMap((value) =>
                value && usable(value)
                  ? Effect.succeed(value)
                  : Effect.fail(
                      new ClientVpnEndpointNotReady({
                        endpointId,
                        status: value?.Status?.Code ?? "missing",
                      }),
                    ),
              ),
              (effect) =>
                retryClientVpn(
                  effect,
                  (error) => error._tag === "ClientVpnEndpointNotReady",
                ),
            );
          }
          const endpointId = endpoint.ClientVpnEndpointId!;
          const { changes, desired, groups } = yield* changesFor(
            news,
            endpoint,
          );
          if (Object.keys(changes).length) {
            yield* EC2.modifyClientVpnEndpoint({
              ClientVpnEndpointId: endpointId,
              ...changes,
            });
            endpoint = yield* describe(endpointId).pipe(
              Effect.flatMap((value) => {
                const current = value && observedSettings(value, news);
                const matches =
                  current &&
                  Object.entries(desired).every(([key, expected]) =>
                    deepEqual(current[key as keyof typeof current], expected),
                  );
                return value &&
                  matches &&
                  deepEqual(value.DnsServers ?? [], news.dnsServers ?? []) &&
                  (!groups ||
                    deepEqual(
                      [...(value.SecurityGroupIds ?? [])].sort(),
                      [...groups].sort(),
                    )) &&
                  // Disabled hooks can remain "applying" before a subnet is associated.
                  (!news.clientConnectOptions?.enabled ||
                    value.ClientConnectOptions?.Status?.Code !== "applying")
                  ? Effect.succeed(value)
                  : Effect.fail(
                      new ClientVpnEndpointNotReady({
                        endpointId,
                        status: value?.Status?.Code ?? "missing",
                        pendingSettings: Object.entries(desired)
                          .filter(
                            ([key, expected]) =>
                              !current ||
                              !deepEqual(
                                current[key as keyof typeof current],
                                expected,
                              ),
                          )
                          .map(([key]) => key),
                      }),
                    );
              }),
              (effect) =>
                retryClientVpn(
                  effect,
                  (error) => error._tag === "ClientVpnEndpointNotReady",
                ),
            );
          }
          const { removed, upsert } = diffTags(
            tagRecord(
              endpoint.Tags?.map((tag) => ({
                Key: tag.Key!,
                Value: tag.Value!,
              })),
            ),
            tags,
          );
          if (removed.length)
            yield* EC2.deleteTags({
              Resources: [endpointId],
              Tags: removed.map((Key) => ({ Key })),
            });
          if (upsert.length)
            yield* EC2.createTags({ Resources: [endpointId], Tags: upsert });
          const final = yield* describe(endpointId);
          if (!final)
            return yield* Effect.fail(
              new ClientVpnEndpointNotReady({ endpointId, status: "missing" }),
            );
          return yield* toAttrs(final);
        }),
        delete: Effect.fn(function* ({ output }) {
          const endpointId = output.clientVpnEndpointId;
          const endpoint = yield* describe(endpointId);
          if (!endpoint) return;
          if (endpoint.Status?.Code !== "deleting") {
            yield* EC2.deleteClientVpnEndpoint({
              ClientVpnEndpointId: endpointId,
            }).pipe(
              Effect.catchTag(
                "InvalidClientVpnEndpointId.NotFound",
                () => Effect.void,
              ),
            );
          }
          yield* describe(endpointId).pipe(
            Effect.flatMap((value) =>
              value
                ? Effect.fail(
                    new ClientVpnEndpointNotReady({
                      endpointId,
                      status: value.Status?.Code ?? "unknown",
                    }),
                  )
                : Effect.void,
            ),
            (effect) =>
              retryClientVpn(
                effect,
                (error) => error._tag === "ClientVpnEndpointNotReady",
              ),
          );
        }),
      };
    }),
  );
