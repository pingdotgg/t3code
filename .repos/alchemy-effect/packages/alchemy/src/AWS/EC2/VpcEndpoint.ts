import type * as EC2 from "@distilled.cloud/aws/ec2";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

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
export const VpcEndpoint = Resource<VpcEndpoint>("AWS.EC2.VpcEndpoint");

export const VpcEndpointProvider = () =>
  Provider.effect(
    VpcEndpoint,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;

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
          Effect.map((r) => r.VpcEndpoints?.[0]),
          Effect.flatMap((ep) =>
            ep
              ? Effect.succeed(ep)
              : Effect.fail(
                  new Error(`VPC Endpoint ${vpcEndpointId} not found`),
                ),
          ),
        );

      const toAttrs = (ep: ec2.VpcEndpoint): VpcEndpoint["Attributes"] => ({
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
      });

      return {
        stables: ["vpcEndpointId", "vpcEndpointArn", "ownerId"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const ep = yield* describeVpcEndpoint(output.vpcEndpointId);
          return toAttrs(ep);
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
            if (
              news.vpcEndpointType === "Interface" ||
              news.vpcEndpointType === "GatewayLoadBalancer"
            ) {
              yield* waitForVpcEndpointAvailable(newEpId, session);
            }
            ep = yield* describeVpcEndpoint(newEpId);
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

            if (ep.PrivateDnsEnabled !== news.privateDnsEnabled) {
              modifications.PrivateDnsEnabled = news.privateDnsEnabled;
              hasModifications = true;
            }
          }

          if ((ep.PolicyDocument ?? undefined) !== news.policyDocument) {
            modifications.PolicyDocument = news.policyDocument ?? "";
            modifications.ResetPolicy = !news.policyDocument;
            hasModifications = true;
          }

          if (ep.IpAddressType !== news.ipAddressType) {
            modifications.IpAddressType = news.ipAddressType;
            hasModifications = true;
          }

          const observedDnsRecordIpType = ep.DnsOptions?.DnsRecordIpType;
          const observedPrivateDnsOnly =
            ep.DnsOptions?.PrivateDnsOnlyForInboundResolverEndpoint;
          if (
            observedDnsRecordIpType !== news.dnsOptions?.dnsRecordIpType ||
            observedPrivateDnsOnly !==
              news.dnsOptions?.privateDnsOnlyForInboundResolverEndpoint
          ) {
            modifications.DnsOptions = news.dnsOptions
              ? {
                  DnsRecordIpType: news.dnsOptions.dnsRecordIpType,
                  PrivateDnsOnlyForInboundResolverEndpoint:
                    news.dnsOptions.privateDnsOnlyForInboundResolverEndpoint,
                }
              : undefined;
            hasModifications = true;
          }

          if (hasModifications) {
            yield* ec2.modifyVpcEndpoint(modifications);
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
          return toAttrs(final);
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

// Terminal error: VPC Endpoint not found
class VpcEndpointNotFound extends Data.TaggedError("VpcEndpointNotFound")<{
  vpcEndpointId: string;
}> {}

// Retryable error: VPC Endpoint is still deleting
class VpcEndpointDeleting extends Data.TaggedError("VpcEndpointDeleting")<{
  vpcEndpointId: string;
  state: string;
}> {}

/**
 * Wait for VPC Endpoint to be in available state
 */
const waitForVpcEndpointAvailable = (
  vpcEndpointId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeVpcEndpoints({
      VpcEndpointIds: [vpcEndpointId],
    });
    const ep = result.VpcEndpoints?.[0];

    if (!ep) {
      return yield* new VpcEndpointNotFound({ vpcEndpointId });
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
      schedule: Schedule.fixed(3000).pipe(
        Schedule.both(Schedule.recurs(60)), // Max 3 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for VPC Endpoint to be available... (${(attempt + 1) * 3}s)`,
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
      schedule: Schedule.fixed(3000).pipe(
        Schedule.both(Schedule.recurs(60)), // Max 3 minutes
        Schedule.tapOutput(([, attempt]) =>
          session.note(
            `Waiting for VPC Endpoint deletion... (${(attempt + 1) * 3}s)`,
          ),
        ),
      ),
    }),
  );
