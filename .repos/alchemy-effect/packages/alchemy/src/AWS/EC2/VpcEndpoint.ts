import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import type { RouteTableId } from "./RouteTable.ts";
import type { SecurityGroupId } from "./SecurityGroup.ts";
import type { SubnetId } from "./Subnet.ts";
import type { VpcId } from "./Vpc.ts";

export type VpcEndpointId<ID extends string = string> = `vpce-${ID}`;
export const VpcEndpointId = <ID extends string>(
  id: ID,
): ID & VpcEndpointId<ID> => `vpce-${id}` as ID & VpcEndpointId<ID>;

export type VpcEndpointArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:vpc-endpoint/${VpcEndpointId}`;

export interface VpcEndpointProps {
  /**
   * The VPC to create the endpoint in.
   */
  vpcId: VpcId;

  /**
   * The service name.
   * For AWS services, use the format: com.amazonaws.<region>.<service>
   * @example "com.amazonaws.us-east-1.s3"
   */
  serviceName: string;

  /**
   * The type of endpoint.
   * - Gateway: For S3 and DynamoDB (route table based)
   * - Interface: For most other AWS services (ENI based)
   * - GatewayLoadBalancer: For Gateway Load Balancer endpoints
   * @default "Gateway"
   */
  vpcEndpointType?: EC2.VpcEndpointType;

  /**
   * The IDs of route tables for a Gateway endpoint.
   * Required for Gateway endpoints.
   */
  routeTableIds?: RouteTableId[];

  /**
   * The IDs of subnets for an Interface endpoint.
   * Required for Interface endpoints.
   */
  subnetIds?: SubnetId[];

  /**
   * The IDs of security groups for an Interface endpoint.
   * Required for Interface endpoints.
   */
  securityGroupIds?: SecurityGroupId[];

  /**
   * Whether to associate a private hosted zone with the VPC.
   * Only applicable for Interface endpoints.
   * @default true
   */
  privateDnsEnabled?: boolean;

  /**
   * A policy to attach to the endpoint that controls access to the service.
   * The policy document must be in JSON format.
   */
  policyDocument?: string;

  /**
   * The IP address type for the endpoint.
   */
  ipAddressType?: EC2.IpAddressType;

  /**
   * The DNS options for the endpoint.
   */
  dnsOptions?: {
    dnsRecordIpType?: EC2.DnsRecordIpType;
    privateDnsOnlyForInboundResolverEndpoint?: boolean;
  };

  /**
   * Tags to assign to the VPC endpoint.
   */
  tags?: Record<string, string>;
}

export interface VpcEndpoint extends Resource<
  "AWS.EC2.VpcEndpoint",
  VpcEndpointProps,
  {
    /**
     * The ID of the VPC endpoint.
     */
    vpcEndpointId: VpcEndpointId;

    /**
     * The Amazon Resource Name (ARN) of the VPC endpoint.
     */
    vpcEndpointArn: VpcEndpointArn;

    /**
     * The type of endpoint.
     */
    vpcEndpointType: EC2.VpcEndpointType;

    /**
     * The ID of the VPC.
     */
    vpcId: VpcId;

    /**
     * The service name.
     */
    serviceName: string;

    /**
     * The current state of the VPC endpoint.
     */
    state: EC2.State;

    /**
     * The policy document associated with the endpoint.
     */
    policyDocument?: string;

    /**
     * The IDs of the route tables associated with the endpoint.
     */
    routeTableIds?: string[];

    /**
     * The IDs of the subnets associated with the endpoint.
     */
    subnetIds?: string[];

    /**
     * Information about the security groups associated with the network interfaces.
     */
    groups?: Array<{
      groupId: string;
      groupName: string;
    }>;

    /**
     * Whether private DNS is enabled.
     */
    privateDnsEnabled?: boolean;

    /**
     * Whether the VPC endpoint is being managed by its service.
     */
    requesterManaged?: boolean;

    /**
     * The IDs of the network interfaces for the endpoint.
     */
    networkInterfaceIds?: string[];

    /**
     * The DNS entries for the endpoint.
     */
    dnsEntries?: Array<{
      dnsName?: string;
      hostedZoneId?: string;
    }>;

    /**
     * The date and time the VPC endpoint was created.
     */
    creationTimestamp?: string;

    /**
     * The ID of the AWS account that owns the VPC endpoint.
     */
    ownerId?: string;

    /**
     * The IP address type for the endpoint.
     */
    ipAddressType?: EC2.IpAddressType;

    /**
     * The DNS options for the endpoint.
     */
    dnsOptions?: {
      dnsRecordIpType?: EC2.DnsRecordIpType;
      privateDnsOnlyForInboundResolverEndpoint?: boolean;
    };

    /**
     * The last error that occurred for VPC endpoint.
     */
    lastError?: {
      code?: string;
      message?: string;
    };
  },
  never,
  Providers
> {}
/**
 * A VPC endpoint that connects your VPC privately to an AWS service (or a
 * service behind a Gateway Load Balancer) without traversing the public
 * internet, a NAT gateway, or an internet gateway.
 *
 * The `vpcEndpointType` selects how the connection is realized:
 * - `"Gateway"` — for S3 and DynamoDB; traffic is directed by adding routes to
 *   the route tables in `routeTableIds` (no hourly cost).
 * - `"Interface"` — for most other AWS services; provisions elastic network
 *   interfaces in `subnetIds`, guarded by `securityGroupIds`, and optionally
 *   resolves the service's public DNS name privately via `privateDnsEnabled`.
 * - `"GatewayLoadBalancer"` — routes traffic through a third-party appliance
 *   fleet fronted by a Gateway Load Balancer.
 *
 * Changing `vpcId`, `serviceName`, or `vpcEndpointType` replaces the endpoint;
 * route tables, subnets, security groups, DNS, and the policy update in place.
 *
 * @resource
 * @section Gateway Endpoints
 * Gateway endpoints target S3 and DynamoDB and work by injecting a prefix-list
 * route into each route table you list, so requests to the service stay on the
 * AWS network.
 * @example S3 Gateway Endpoint
 * ```typescript
 * const s3Endpoint = yield* AWS.EC2.VpcEndpoint("S3Endpoint", {
 *   vpcId: vpc.vpcId,
 *   serviceName: "com.amazonaws.us-east-1.s3",
 *   vpcEndpointType: "Gateway",
 *   routeTableIds: [privateRouteTable.routeTableId],
 *   tags: { Name: "s3-endpoint" },
 * });
 * ```
 * Listing the private subnets' route tables in `routeTableIds` lets those
 * subnets reach S3 directly, removing NAT data-processing charges for S3 traffic
 * and keeping it off the public internet.
 *
 * @section Interface Endpoints
 * Interface endpoints place an ENI in each chosen subnet and are reached over
 * private IPs; enabling private DNS lets existing SDK calls resolve to the
 * endpoint transparently.
 * @example Secrets Manager Interface Endpoint
 * ```typescript
 * const secretsEndpoint = yield* AWS.EC2.VpcEndpoint("SecretsEndpoint", {
 *   vpcId: vpc.vpcId,
 *   serviceName: "com.amazonaws.us-east-1.secretsmanager",
 *   vpcEndpointType: "Interface",
 *   subnetIds: [privateSubnet.subnetId],
 *   securityGroupIds: [endpointSecurityGroup.groupId],
 *   privateDnsEnabled: true,
 *   ipAddressType: "ipv4",
 *   dnsOptions: {
 *     dnsRecordIpType: "ipv4",
 *   },
 * });
 * ```
 * The endpoint gets an interface in each `subnetIds` entry, `securityGroupIds`
 * controls who may reach those interfaces, and `privateDnsEnabled: true` makes
 * the service's default DNS name resolve to the endpoint; `ipAddressType` and
 * `dnsOptions` tune the IP family used for the interfaces and their DNS records.
 *
 * @section Restricting Access with a Policy
 * @example Endpoint Policy Limiting Access to One Bucket
 * ```typescript
 * const s3Endpoint = yield* AWS.EC2.VpcEndpoint("RestrictedS3Endpoint", {
 *   vpcId: vpc.vpcId,
 *   serviceName: "com.amazonaws.us-east-1.s3",
 *   vpcEndpointType: "Gateway",
 *   routeTableIds: [privateRouteTable.routeTableId],
 *   policyDocument: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: "*",
 *         Action: ["s3:GetObject"],
 *         Resource: ["arn:aws:s3:::my-bucket/*"],
 *       },
 *     ],
 *   }),
 * });
 * ```
 * `policyDocument` attaches an endpoint policy (JSON) that constrains which
 * service actions and resources can be reached through the endpoint; omit it to
 * allow full access to the service.
 */
export const VpcEndpoint = Resource<VpcEndpoint>("AWS.EC2.VpcEndpoint");

export const VpcEndpointProvider = () =>
  Provider.effect(
    VpcEndpoint,
    Effect.gen(function* () {
      const createTags = Effect.fn(function* (
        id: string,
        tags?: Record<string, string>,
      ) {
        return {
          Name: id,
          ...(yield* createInternalTags(id)),
          ...tags,
        };
      });

      const describeVpcEndpoint = (vpcEndpointId: string) =>
        ec2.describeVpcEndpoints({ VpcEndpointIds: [vpcEndpointId] }).pipe(
          // describe-after-write eventual consistency: an endpoint we just
          // created (or modified) may not be visible to describe yet. The id
          // is known-valid at every call site, so a bounded retry converges.
          Effect.retry({
            while: (e) => e._tag === "InvalidVpcEndpointId.NotFound",
            schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(10)]),
          }),
          Effect.map((r) => r.VpcEndpoints?.[0]),
          Effect.flatMap((ep) =>
            ep
              ? Effect.succeed(ep)
              : Effect.fail(
                  new Error(`VPC Endpoint ${vpcEndpointId} not found`),
                ),
          ),
        );

      const toAttrs = Effect.fn(function* (ep: ec2.VpcEndpoint) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return {
          vpcEndpointId: ep.VpcEndpointId as VpcEndpointId,
          vpcEndpointArn:
            `arn:aws:ec2:${region}:${accountId}:vpc-endpoint/${ep.VpcEndpointId}` as VpcEndpointArn,
          vpcEndpointType: ep.VpcEndpointType!,
          vpcId: ep.VpcId as VpcId,
          serviceName: ep.ServiceName!,
          state: ep.State!,
          policyDocument: ep.PolicyDocument,
          routeTableIds: ep.RouteTableIds,
          subnetIds: ep.SubnetIds,
          groups: ep.Groups?.map((g) => ({
            groupId: g.GroupId!,
            groupName: g.GroupName!,
          })),
          privateDnsEnabled: ep.PrivateDnsEnabled,
          requesterManaged: ep.RequesterManaged,
          networkInterfaceIds: ep.NetworkInterfaceIds,
          dnsEntries: ep.DnsEntries?.map((d) => ({
            dnsName: d.DnsName,
            hostedZoneId: d.HostedZoneId,
          })),
          creationTimestamp:
            ep.CreationTimestamp instanceof Date
              ? ep.CreationTimestamp.toISOString()
              : (ep.CreationTimestamp as string | undefined),
          ownerId: ep.OwnerId,
          ipAddressType: ep.IpAddressType,
          dnsOptions: ep.DnsOptions
            ? {
                dnsRecordIpType: ep.DnsOptions.DnsRecordIpType,
                privateDnsOnlyForInboundResolverEndpoint:
                  ep.DnsOptions.PrivateDnsOnlyForInboundResolverEndpoint,
              }
            : undefined,
          lastError: ep.LastError
            ? {
                code: ep.LastError.Code,
                message: ep.LastError.Message,
              }
            : undefined,
        } satisfies VpcEndpoint["Attributes"];
      });

      return {
        stables: ["vpcEndpointId", "vpcEndpointArn", "ownerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          // No consistency retry here: an endpoint deleted out-of-band should
          // read as missing immediately, not after a retry window.
          const lookup = yield* ec2
            .describeVpcEndpoints({ VpcEndpointIds: [output.vpcEndpointId] })
            .pipe(
              Effect.catchTag("InvalidVpcEndpointId.NotFound", () =>
                Effect.succeed({ VpcEndpoints: [] }),
              ),
            );
          const ep = lookup.VpcEndpoints?.[0];
          if (!ep || ep.State === "deleted" || ep.State === "deleting") {
            return undefined;
          }
          return yield* toAttrs(ep);
        }),

        list: () =>
          Effect.gen(function* () {
            const endpoints = yield* ec2.describeVpcEndpoints.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.VpcEndpoints ?? []).filter(
                    (ep): ep is ec2.VpcEndpoint & { VpcEndpointId: string } =>
                      ep.VpcEndpointId != null,
                  ),
                ),
              ),
            );
            return yield* Effect.forEach(endpoints, (ep) => toAttrs(ep));
          }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Core properties require replacement
          if (
            news.vpcId !== olds.vpcId ||
            news.serviceName !== olds.serviceName ||
            news.vpcEndpointType !== olds.vpcEndpointType
          ) {
            return { action: "replace" };
          }
          // Other properties can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the VPC endpoint via cached id, else fall through
          // to create.
          let ep: ec2.VpcEndpoint | undefined;
          if (output?.vpcEndpointId) {
            const lookup = yield* ec2
              .describeVpcEndpoints({
                VpcEndpointIds: [output.vpcEndpointId],
              })
              .pipe(
                Effect.catchTag("InvalidVpcEndpointId.NotFound", () =>
                  Effect.succeed({ VpcEndpoints: [] }),
                ),
              );
            ep = lookup.VpcEndpoints?.[0];
            if (ep && (ep.State === "deleted" || ep.State === "deleting")) {
              ep = undefined;
            }
          }

          // Ensure — create the endpoint when missing.
          if (ep === undefined) {
            yield* session.note(
              `Creating VPC Endpoint for ${news.serviceName}...`,
            );
            const result = yield* ec2.createVpcEndpoint({
              VpcId: news.vpcId as string,
              ServiceName: news.serviceName,
              VpcEndpointType: news.vpcEndpointType ?? "Gateway",
              RouteTableIds: news.routeTableIds as string[] | undefined,
              SubnetIds: news.subnetIds as string[] | undefined,
              SecurityGroupIds: news.securityGroupIds as string[] | undefined,
              PrivateDnsEnabled: news.privateDnsEnabled,
              PolicyDocument: news.policyDocument,
              IpAddressType: news.ipAddressType,
              DnsOptions: news.dnsOptions
                ? {
                    DnsRecordIpType: news.dnsOptions.dnsRecordIpType,
                    PrivateDnsOnlyForInboundResolverEndpoint:
                      news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint,
                  }
                : undefined,
              TagSpecifications: [
                {
                  ResourceType: "vpc-endpoint",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const newEpId = result.VpcEndpoint!.VpcEndpointId!;
            yield* session.note(`VPC Endpoint created: ${newEpId}`);
            // Wait for every endpoint type: the wait loop also absorbs the
            // describe-after-create eventual-consistency window during which
            // the fresh id is not yet visible (Gateway endpoints go
            // `available` almost immediately, so this costs nothing there).
            ep = yield* waitForVpcEndpointAvailable(newEpId, session);
          }

          const vpcEndpointId = ep.VpcEndpointId!;
          const observedType = ep.VpcEndpointType ?? news.vpcEndpointType;

          // Sync mutable configuration — diff observed cloud state against
          // desired, then issue a single modifyVpcEndpoint call carrying only
          // the deltas.
          const modifications: Parameters<typeof ec2.modifyVpcEndpoint>[0] = {
            VpcEndpointId: vpcEndpointId,
            DryRun: false,
          };
          let hasModifications = false;

          if (observedType === "Gateway") {
            const observedRtIds = new Set(ep.RouteTableIds ?? []);
            const desiredRtIds = new Set(
              (news.routeTableIds as string[] | undefined) ?? [],
            );
            const addRouteTableIds = [...desiredRtIds].filter(
              (rt) => !observedRtIds.has(rt),
            );
            const removeRouteTableIds = [...observedRtIds].filter(
              (rt) => !desiredRtIds.has(rt),
            );
            if (addRouteTableIds.length > 0) {
              modifications.AddRouteTableIds = addRouteTableIds;
              hasModifications = true;
            }
            if (removeRouteTableIds.length > 0) {
              modifications.RemoveRouteTableIds = removeRouteTableIds;
              hasModifications = true;
            }
          }

          if (
            observedType === "Interface" ||
            observedType === "GatewayLoadBalancer"
          ) {
            const observedSubnetIds = new Set(ep.SubnetIds ?? []);
            const desiredSubnetIds = new Set(
              (news.subnetIds as string[] | undefined) ?? [],
            );
            const addSubnetIds = [...desiredSubnetIds].filter(
              (s) => !observedSubnetIds.has(s),
            );
            const removeSubnetIds = [...observedSubnetIds].filter(
              (s) => !desiredSubnetIds.has(s),
            );
            if (addSubnetIds.length > 0) {
              modifications.AddSubnetIds = addSubnetIds;
              hasModifications = true;
            }
            if (removeSubnetIds.length > 0) {
              modifications.RemoveSubnetIds = removeSubnetIds;
              hasModifications = true;
            }

            const observedSgIds = new Set(
              (ep.Groups ?? [])
                .map((g) => g.GroupId)
                .filter((g): g is string => Boolean(g)),
            );
            const desiredSgIds = new Set(
              (news.securityGroupIds as string[] | undefined) ?? [],
            );
            const addSecurityGroupIds = [...desiredSgIds].filter(
              (g) => !observedSgIds.has(g),
            );
            const removeSecurityGroupIds = [...observedSgIds].filter(
              (g) => !desiredSgIds.has(g),
            );
            if (addSecurityGroupIds.length > 0) {
              modifications.AddSecurityGroupIds = addSecurityGroupIds;
              hasModifications = true;
            }
            if (removeSecurityGroupIds.length > 0) {
              modifications.RemoveSecurityGroupIds = removeSecurityGroupIds;
              hasModifications = true;
            }

            if (
              news.privateDnsEnabled !== undefined &&
              ep.PrivateDnsEnabled !== news.privateDnsEnabled
            ) {
              modifications.PrivateDnsEnabled = news.privateDnsEnabled;
              hasModifications = true;
            }
          }

          const observedPolicy = ep.PolicyDocument ?? undefined;
          if (news.policyDocument !== undefined) {
            if (!policyDocumentEquals(observedPolicy, news.policyDocument)) {
              // AWS rejects passing both a policy document and the reset flag
              // in the same call — choose exactly one.
              modifications.PolicyDocument = news.policyDocument;
              hasModifications = true;
            }
          } else if (!isFullAccessEndpointPolicy(observedPolicy)) {
            // An absent `policyDocument` means "the default full-access
            // policy". AWS attaches exactly that default to every fresh
            // endpoint, so only reset when a custom policy is actually
            // present — issuing a ResetPolicy no-op immediately after create
            // races the new endpoint id's propagation and previously failed
            // the whole reconcile with InvalidVpcEndpointId.NotFound.
            modifications.ResetPolicy = true;
            hasModifications = true;
          }

          // An unspecified `ipAddressType`/`dnsOptions` means "AWS default" —
          // the observed value on a fresh endpoint (e.g. "not-specified", or
          // populated DNS defaults) must not be diffed against `undefined`,
          // which previously caused a spurious modify on every reconcile.
          if (
            news.ipAddressType !== undefined &&
            ep.IpAddressType !== news.ipAddressType
          ) {
            modifications.IpAddressType = news.ipAddressType;
            hasModifications = true;
          }

          if (news.dnsOptions !== undefined) {
            const observedDnsRecordIpType = ep.DnsOptions?.DnsRecordIpType;
            const observedPrivateDnsOnly =
              ep.DnsOptions?.PrivateDnsOnlyForInboundResolverEndpoint;
            if (
              (news.dnsOptions.dnsRecordIpType !== undefined &&
                observedDnsRecordIpType !== news.dnsOptions.dnsRecordIpType) ||
              (news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint !==
                undefined &&
                observedPrivateDnsOnly !==
                  news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint)
            ) {
              modifications.DnsOptions = {
                DnsRecordIpType: news.dnsOptions.dnsRecordIpType,
                PrivateDnsOnlyForInboundResolverEndpoint:
                  news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint,
              };
              hasModifications = true;
            }
          }

          if (hasModifications) {
            yield* ec2.modifyVpcEndpoint(modifications).pipe(
              // The endpoint id is known-valid here (we just observed or
              // created it) — NotFound is describe/modify-plane propagation
              // lag, not a missing endpoint.
              Effect.retry({
                while: (e) => e._tag === "InvalidVpcEndpointId.NotFound",
                schedule: Schedule.max([
                  Schedule.fixed(2000),
                  Schedule.recurs(10),
                ]),
              }),
            );
            yield* session.note("Updated VPC Endpoint configuration");
            if (
              observedType === "Interface" ||
              observedType === "GatewayLoadBalancer"
            ) {
              yield* waitForVpcEndpointAvailable(vpcEndpointId, session);
            }
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (ep.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [vpcEndpointId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [vpcEndpointId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // Re-read final state.
          const final = yield* describeVpcEndpoint(vpcEndpointId);
          return yield* toAttrs(final);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const vpcEndpointId = output.vpcEndpointId;

          yield* session.note(`Deleting VPC Endpoint: ${vpcEndpointId}`);

          yield* ec2
            .deleteVpcEndpoints({
              VpcEndpointIds: [vpcEndpointId],
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidVpcEndpointId.NotFound",
                () => Effect.void,
              ),
            );

          // Wait for deletion
          yield* waitForVpcEndpointDeleted(vpcEndpointId, session);

          // Interface/GatewayLoadBalancer endpoints release their network
          // interfaces asynchronously after the endpoint itself reports
          // deleted. The parent VPC (and subnets/security groups) cannot be
          // deleted while those ENIs linger, so wait until they are gone.
          const eniIds = output.networkInterfaceIds ?? [];
          if (eniIds.length > 0) {
            yield* waitForEndpointEnisReleased(eniIds, session);
          }

          yield* session.note(`VPC Endpoint ${vpcEndpointId} deleted`);
        }),
      };
    }),
  );

// Retryable error: VPC Endpoint is still pending
class VpcEndpointPending extends Data.TaggedError("VpcEndpointPending")<{
  vpcEndpointId: string;
  state: string;
}> {}

// Terminal error: VPC Endpoint creation failed
class VpcEndpointFailed extends Data.TaggedError("VpcEndpointFailed")<{
  vpcEndpointId: string;
  errorCode?: string;
  errorMessage?: string;
}> {}

// Retryable error: VPC Endpoint is still deleting
class VpcEndpointDeleting extends Data.TaggedError("VpcEndpointDeleting")<{
  vpcEndpointId: string;
  state: string;
}> {}

// Retryable error: endpoint network interfaces are still being released
class VpcEndpointEnisLingering extends Data.TaggedError(
  "VpcEndpointEnisLingering",
)<{
  networkInterfaceIds: string[];
}> {}

/**
 * Wait for VPC Endpoint to be in available state.
 *
 * Only ever called with an id we just created or observed, so a NotFound (or
 * an empty describe result) is describe-after-create eventual consistency and
 * is retried as "pending" rather than treated as terminal.
 */
const waitForVpcEndpointAvailable = (
  vpcEndpointId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeVpcEndpoints({ VpcEndpointIds: [vpcEndpointId] })
      .pipe(
        Effect.catchTag("InvalidVpcEndpointId.NotFound", () =>
          Effect.succeed({ VpcEndpoints: [] }),
        ),
      );
    const ep = result.VpcEndpoints?.[0];

    if (!ep) {
      // Fresh id not visible to describe yet — retry.
      return yield* new VpcEndpointPending({
        vpcEndpointId,
        state: "propagating",
      });
    }

    if (ep.State === "available") {
      return ep;
    }

    if (ep.State === "failed" || ep.State === "rejected") {
      return yield* new VpcEndpointFailed({
        vpcEndpointId,
        errorCode: ep.LastError?.Code,
        errorMessage: ep.LastError?.Message,
      });
    }

    // Still pending - this is the only retryable case
    return yield* new VpcEndpointPending({ vpcEndpointId, state: ep.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VpcEndpointPending",
      schedule: Schedule.max([Schedule.fixed(3000), Schedule.recurs(60)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for VPC Endpoint to be available... (${attempt * 3}s)`,
          ),
        ),
      ),
    }),
  );

/**
 * Wait for VPC Endpoint to be deleted
 */
const waitForVpcEndpointDeleted = (
  vpcEndpointId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeVpcEndpoints({ VpcEndpointIds: [vpcEndpointId] })
      .pipe(
        Effect.catchTag("InvalidVpcEndpointId.NotFound", () =>
          Effect.succeed({ VpcEndpoints: [] }),
        ),
      );

    const ep = result.VpcEndpoints?.[0];

    if (!ep || ep.State === "deleted") {
      return; // Successfully deleted
    }

    // Still deleting - this is the only retryable case
    return yield* new VpcEndpointDeleting({ vpcEndpointId, state: ep.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VpcEndpointDeleting",
      schedule: Schedule.max([Schedule.fixed(3000), Schedule.recurs(60)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for VPC Endpoint deletion... (${attempt * 3}s)`,
          ),
        ),
      ),
    }),
  );

/**
 * Wait for the endpoint's network interfaces to be released after deletion.
 *
 * Uses a filter (not `NetworkInterfaceIds`) so already-released interfaces
 * simply drop out of the result instead of failing the whole describe with
 * `InvalidNetworkInterfaceID.NotFound`.
 */
const waitForEndpointEnisReleased = (
  networkInterfaceIds: string[],
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const remaining = yield* ec2.describeNetworkInterfaces
      .items({
        Filters: [
          { Name: "network-interface-id", Values: networkInterfaceIds },
        ],
      })
      .pipe(
        Stream.map((eni) => eni.NetworkInterfaceId),
        Stream.filter((id): id is string => Boolean(id)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      );
    if (remaining.length > 0) {
      return yield* new VpcEndpointEnisLingering({
        networkInterfaceIds: remaining,
      });
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VpcEndpointEnisLingering",
      schedule: Schedule.max([Schedule.fixed(3000), Schedule.recurs(20)]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for endpoint network interfaces to release... (${attempt * 3}s)`,
          ),
        ),
      ),
    }),
  );

/**
 * Structural check for the default full-access endpoint policy that AWS
 * attaches to every freshly created VPC endpoint. An absent `policyDocument`
 * prop is equivalent to this default, so observing it must not trigger a
 * `ResetPolicy` modification.
 */
const isFullAccessEndpointPolicy = (doc: string | undefined): boolean => {
  if (!doc) return true;
  try {
    const parsed = JSON.parse(doc) as {
      Statement?: Array<{
        Effect?: unknown;
        Principal?: unknown;
        Action?: unknown;
        Resource?: unknown;
        Condition?: unknown;
      }>;
    };
    const statements = parsed.Statement ?? [];
    if (statements.length !== 1) return false;
    const s = statements[0];
    const isStar = (value: unknown) =>
      value === "*" ||
      (Array.isArray(value) && value.length === 1 && value[0] === "*") ||
      (typeof value === "object" &&
        value !== null &&
        (value as { AWS?: unknown }).AWS === "*");
    return (
      s.Effect === "Allow" &&
      isStar(s.Principal) &&
      isStar(s.Action) &&
      isStar(s.Resource) &&
      s.Condition === undefined
    );
  } catch {
    return false;
  }
};

/**
 * Compare two endpoint policy documents structurally (AWS normalizes the JSON
 * it stores, so raw string comparison would report a perpetual diff).
 */
const policyDocumentEquals = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return a === b;
  }
};
