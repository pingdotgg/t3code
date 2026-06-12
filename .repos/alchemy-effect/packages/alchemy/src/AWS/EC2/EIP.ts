import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type EIPArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:elastic-ip/${AllocationId}`;

export type AllocationId<ID extends string = string> = `eipalloc-${ID}`;
export const AllocationId = <ID extends string>(
  id: ID,
): ID & AllocationId<ID> => `eipalloc-${id}` as ID & AllocationId<ID>;

export interface EIPProps {
  /**
   * Indicates whether the Elastic IP address is for use with instances in a VPC or EC2-Classic.
   * @default "vpc"
   */
  domain?: "vpc" | "standard";

  /**
   * The ID of an address pool that you own.
   * Use this parameter to let Amazon EC2 select an address from the address pool.
   */
  publicIpv4Pool?: string;

  /**
   * A unique set of Availability Zones, Local Zones, or Wavelength Zones
   * from which AWS advertises IP addresses.
   */
  networkBorderGroup?: string;

  /**
   * The ID of a customer-owned address pool.
   * Use this parameter to let Amazon EC2 select an address from the address pool.
   */
  customerOwnedIpv4Pool?: string;

  /**
   * Tags to assign to the Elastic IP.
   * These will be merged with alchemy auto-tags.
   */
  tags?: Record<string, string>;
}

export interface EIP extends Resource<
  "AWS.EC2.EIP",
  EIPProps,
  {
    /**
     * The allocation ID for the Elastic IP address.
     */
    allocationId: AllocationId;

    /**
     * The Amazon Resource Name (ARN) of the Elastic IP.
     */
    eipArn: `arn:aws:ec2:${RegionID}:${AccountID}:elastic-ip/${string}`;

    /**
     * The Elastic IP address.
     */
    publicIp: string;

    /**
     * The ID of an address pool.
     */
    publicIpv4Pool?: string;

    /**
     * Indicates whether the Elastic IP address is for use with instances in a VPC or EC2-Classic.
     */
    domain: "vpc" | "standard";

    /**
     * The network border group.
     */
    networkBorderGroup?: string;

    /**
     * The customer-owned IP address.
     */
    customerOwnedIp?: string;

    /**
     * The ID of the customer-owned address pool.
     */
    customerOwnedIpv4Pool?: string;

    /**
     * The carrier IP address associated with the network interface.
     */
    carrierIp?: string;
  },
  never,
  Providers
> {}
export const EIP = Resource<EIP>("AWS.EC2.EIP");

export const EIPProvider = () =>
  Provider.effect(
    EIP,
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

      return {
        stables: ["allocationId", "eipArn", "publicIp"],

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const result = yield* ec2.describeAddresses({
            AllocationIds: [output.allocationId],
          });

          const address = result.Addresses?.[0];
          if (!address) {
            return yield* Effect.fail(
              new Error(`EIP ${output.allocationId} not found`),
            );
          }

          return {
            allocationId: address.AllocationId as AllocationId,
            eipArn:
              `arn:aws:ec2:${region}:${accountId}:elastic-ip/${address.AllocationId}` as EIPArn,
            publicIp: address.PublicIp!,
            publicIpv4Pool: address.PublicIpv4Pool,
            domain: (address.Domain as "vpc" | "standard") ?? "vpc",
            networkBorderGroup: address.NetworkBorderGroup,
            customerOwnedIp: address.CustomerOwnedIp,
            customerOwnedIpv4Pool: address.CustomerOwnedIpv4Pool,
            carrierIp: address.CarrierIp,
          } satisfies EIP["Attributes"];
        }),

        diff: Effect.fn(function* ({ news = {}, olds = {} }) {
          if (!isResolved(news)) return;
          // EIPs are immutable - any change to core properties requires replacement
          if (
            news.publicIpv4Pool !== olds.publicIpv4Pool ||
            news.networkBorderGroup !== olds.networkBorderGroup ||
            news.customerOwnedIpv4Pool !== olds.customerOwnedIpv4Pool
          ) {
            return { action: "replace" };
          }
          // Tags can be updated in-place
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — try to find an existing EIP via the cached allocationId.
          // If it was released out-of-band, fall through to allocate.
          let address: ec2.Address | undefined;
          if (output?.allocationId) {
            const lookup = yield* ec2
              .describeAddresses({ AllocationIds: [output.allocationId] })
              .pipe(
                Effect.catchTag("InvalidAllocationID.NotFound", () =>
                  Effect.succeed({ Addresses: [] }),
                ),
              );
            address = lookup.Addresses?.[0];
          }

          // Ensure — allocate a new EIP when none was observed.
          if (address === undefined) {
            yield* session.note("Allocating Elastic IP address...");
            const result = yield* ec2.allocateAddress({
              Domain: news.domain ?? "vpc",
              PublicIpv4Pool: news.publicIpv4Pool,
              NetworkBorderGroup: news.networkBorderGroup,
              CustomerOwnedIpv4Pool: news.customerOwnedIpv4Pool,
              TagSpecifications: [
                {
                  ResourceType: "elastic-ip",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const allocationId = result.AllocationId! as AllocationId;
            yield* session.note(`Elastic IP allocated: ${allocationId}`);
            const lookup = yield* ec2.describeAddresses({
              AllocationIds: [allocationId],
            });
            address = lookup.Addresses?.[0];
            if (!address) {
              return yield* Effect.fail(
                new Error(`EIP ${allocationId} disappeared after allocation`),
              );
            }
          }

          const allocationId = address.AllocationId! as AllocationId;

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (address.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [allocationId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [allocationId],
              Tags: upsert,
              DryRun: false,
            });
          }

          return {
            allocationId,
            eipArn:
              `arn:aws:ec2:${region}:${accountId}:elastic-ip/${allocationId}` as EIPArn,
            publicIp: address.PublicIp!,
            publicIpv4Pool: address.PublicIpv4Pool,
            domain: (address.Domain as "vpc" | "standard") ?? "vpc",
            networkBorderGroup: address.NetworkBorderGroup,
            customerOwnedIp: address.CustomerOwnedIp,
            customerOwnedIpv4Pool: address.CustomerOwnedIpv4Pool,
            carrierIp: address.CarrierIp,
          } satisfies EIP["Attributes"];
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const allocationId = output.allocationId;

          yield* session.note(`Releasing Elastic IP: ${allocationId}`);

          yield* ec2
            .releaseAddress({
              AllocationId: allocationId,
              DryRun: false,
            })
            .pipe(
              Effect.catchTag(
                "InvalidAllocationID.NotFound",
                () => Effect.void,
              ),
              Effect.catchTag("AuthFailure", () => Effect.void),
              Effect.tapError(Effect.logDebug),
              // Retry when EIP is still in use (e.g., NAT Gateway being deleted)
              Effect.retry({
                while: (e) => {
                  return (
                    // TODO(sam): not sure if the API will actually throw this
                    // e._tag === "DependencyViolation" ||
                    // this throws if the address hasn't been disassociated from all resources
                    // we will retry it assuming that another resource provider is dissassociating it (e.g. a NAT Gateway resource is being deleted)
                    e._tag === "InvalidIPAddress.InUse"
                  );
                },
                schedule: Schedule.exponential(1000, 1.5).pipe(
                  Schedule.both(Schedule.recurs(20)),
                  Schedule.tapOutput(([, attempt]) =>
                    session.note(
                      `EIP still in use, waiting for release... (attempt ${attempt + 1})`,
                    ),
                  ),
                ),
              }),
            );

          yield* session.note(`Elastic IP ${allocationId} released`);
        }),
      };
    }),
  );
