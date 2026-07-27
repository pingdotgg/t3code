import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, createTagsList, diffTags } from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { getDefaultVpcScope } from "./defaultVpcScope.ts";
import type { VpcId } from "./Vpc.ts";

export type DhcpOptionsId<ID extends string = string> = `dopt-${ID}`;

export type DhcpOptionsArn<ID extends DhcpOptionsId = DhcpOptionsId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:dhcp-options/${ID}`;

export interface DhcpOptionsProps {
  /**
   * The domain name for hosts in the VPC (e.g. `example.internal`). Immutable —
   * a DHCP options set cannot be edited, so any change replaces it.
   */
  domainName?: string;

  /**
   * The IP addresses (up to four) of the domain name servers, or
   * `AmazonProvidedDNS`. Immutable.
   */
  domainNameServers?: string[];

  /**
   * The IP addresses (up to four) of the NTP servers. Immutable.
   */
  ntpServers?: string[];

  /**
   * The IP addresses (up to four) of the NetBIOS name servers. Immutable.
   */
  netbiosNameServers?: string[];

  /**
   * The NetBIOS node type (1, 2, 4, or 8). AWS recommends 2. Immutable.
   */
  netbiosNodeType?: "1" | "2" | "4" | "8";

  /**
   * The ID of a VPC to associate this DHCP options set with. When set, the VPC
   * is associated on create/update; on delete (or when this is cleared) the VPC
   * is re-associated with the account's default options set. Mutable.
   */
  vpcId?: VpcId;

  /**
   * Tags to assign to the DHCP options set.
   */
  tags?: Record<string, string>;
}

export interface DhcpOptions extends Resource<
  "AWS.EC2.DhcpOptions",
  DhcpOptionsProps,
  {
    /**
     * The ID of the DHCP options set (prefixed `dopt-`).
     */
    dhcpOptionsId: DhcpOptionsId;

    /**
     * The Amazon Resource Name (ARN) of the DHCP options set.
     */
    dhcpOptionsArn: DhcpOptionsArn;

    /**
     * The AWS account ID of the DHCP options set owner.
     */
    ownerId: string;

    /**
     * The ID of the VPC this options set is associated with, if any.
     */
    vpcId?: VpcId;
  },
  never,
  Providers
> {}

/**
 * A DHCP options set configures the DHCP parameters (domain name, DNS servers,
 * NTP servers, NetBIOS settings) that a VPC hands out to the instances launched
 * inside it. Attach a custom set to a VPC to override the AWS defaults — for
 * example to point instances at your own DNS or an internal search domain.
 *
 * A DHCP options set is immutable: AWS provides no edit API, so changing any
 * DHCP parameter replaces the set. Setting `vpcId` associates the set with a
 * VPC; clearing it (or deleting the resource) re-associates the VPC with the
 * account's default options set, since a set must be disassociated from every
 * VPC before it can be deleted.
 *
 * @resource
 * @section Creating a DHCP Options Set
 * @example Custom DNS and Search Domain
 * ```typescript
 * const dhcp = yield* AWS.EC2.DhcpOptions("CorpDhcp", {
 *   domainName: "corp.internal",
 *   domainNameServers: ["10.0.0.2", "AmazonProvidedDNS"],
 *   vpcId: myVpc.vpcId,
 * });
 * ```
 * Creates the options set and associates it with the VPC in one step.
 * Instances launched into the VPC receive the `corp.internal` search domain and
 * the listed DNS servers.
 *
 * @example NTP and NetBIOS Configuration
 * ```typescript
 * const dhcp = yield* AWS.EC2.DhcpOptions("Dhcp", {
 *   ntpServers: ["169.254.169.123"],
 *   netbiosNameServers: ["10.0.0.5"],
 *   netbiosNodeType: "2",
 * });
 * ```
 * Creates an unassociated options set that you can associate later by setting
 * `vpcId`.
 */
export const DhcpOptions = Resource<DhcpOptions>("AWS.EC2.DhcpOptions");

class DhcpOptionsStillVisible extends Data.TaggedError(
  "DhcpOptionsStillVisible",
)<{
  dhcpOptionsId: string;
}> {}

// Build the NewDhcpConfiguration list AWS expects from the flat props.
const buildConfigurations = (
  props: DhcpOptionsProps,
): ec2.NewDhcpConfiguration[] => {
  const configs: ec2.NewDhcpConfiguration[] = [];
  if (props.domainName !== undefined) {
    configs.push({ Key: "domain-name", Values: [props.domainName] });
  }
  if (props.domainNameServers !== undefined) {
    configs.push({
      Key: "domain-name-servers",
      Values: props.domainNameServers,
    });
  }
  if (props.ntpServers !== undefined) {
    configs.push({ Key: "ntp-servers", Values: props.ntpServers });
  }
  if (props.netbiosNameServers !== undefined) {
    configs.push({
      Key: "netbios-name-servers",
      Values: props.netbiosNameServers,
    });
  }
  if (props.netbiosNodeType !== undefined) {
    configs.push({
      Key: "netbios-node-type",
      Values: [props.netbiosNodeType],
    });
  }
  return configs;
};

export const DhcpOptionsProvider = () =>
  Provider.effect(
    DhcpOptions,
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

      const describeDhcpOptions = (dhcpOptionsId: string) =>
        ec2.describeDhcpOptions({ DhcpOptionsIds: [dhcpOptionsId] }).pipe(
          Effect.map((r) => r.DhcpOptions?.[0]),
          Effect.catchTag("InvalidDhcpOptionID.NotFound", () =>
            Effect.succeed(undefined),
          ),
          Effect.catchTag("InvalidDhcpOptionsID.NotFound", () =>
            Effect.succeed(undefined),
          ),
        );

      const waitUntilDhcpOptionsGone = (dhcpOptionsId: string) =>
        describeDhcpOptions(dhcpOptionsId).pipe(
          Effect.flatMap((options) =>
            options === undefined
              ? Effect.void
              : Effect.fail(new DhcpOptionsStillVisible({ dhcpOptionsId })),
          ),
          Effect.retry({
            while: (error) => error._tag === "DhcpOptionsStillVisible",
            schedule: Schedule.max([Schedule.fixed(1000), Schedule.recurs(15)]),
          }),
        );

      // Which VPC (if any) currently points at this options set.
      const findAssociatedVpc = (dhcpOptionsId: string) =>
        ec2
          .describeVpcs({
            Filters: [{ Name: "dhcp-options-id", Values: [dhcpOptionsId] }],
          })
          .pipe(Effect.map((r) => r.Vpcs?.[0]?.VpcId as VpcId | undefined));

      const toAttrs = (opts: ec2.DhcpOptions, vpcId?: VpcId) =>
        AWSEnvironment.current.pipe(
          Effect.map((env) => ({
            dhcpOptionsId: opts.DhcpOptionsId as DhcpOptionsId,
            dhcpOptionsArn:
              `arn:aws:ec2:${env.region}:${env.accountId}:dhcp-options/${opts.DhcpOptionsId}` as DhcpOptionsArn,
            ownerId: opts.OwnerId!,
            vpcId,
          })),
        );

      return {
        stables: ["dhcpOptionsId", "dhcpOptionsArn", "ownerId"],

        list: () =>
          Effect.gen(function* () {
            const env = yield* AWSEnvironment.current;
            // The options set the default VPC references is the account
            // default AWS provisions; never census/nuke it.
            const defaultVpc = yield* getDefaultVpcScope;
            const items = yield* ec2.describeDhcpOptions.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.DhcpOptions ?? [])
                    .filter(
                      (o): o is ec2.DhcpOptions & { DhcpOptionsId: string } =>
                        o.DhcpOptionsId != null,
                    )
                    .filter(
                      (o) =>
                        defaultVpc.dhcpOptionsId === undefined ||
                        o.DhcpOptionsId !== defaultVpc.dhcpOptionsId,
                    )
                    .map((o) => ({
                      dhcpOptionsId: o.DhcpOptionsId as DhcpOptionsId,
                      dhcpOptionsArn:
                        `arn:aws:ec2:${env.region}:${env.accountId}:dhcp-options/${o.DhcpOptionsId}` as DhcpOptionsArn,
                      ownerId: o.OwnerId!,
                      vpcId: undefined,
                    })),
                ),
              ),
            );
            return items satisfies DhcpOptions["Attributes"][];
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const opts = yield* describeDhcpOptions(output.dhcpOptionsId);
          if (!opts) return undefined;
          const vpcId = yield* findAssociatedVpc(output.dhcpOptionsId);
          return yield* toAttrs(opts, vpcId);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // The DHCP configuration itself is immutable — a change replaces.
          const eq = (a?: string[], b?: string[]) =>
            JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
          if (
            news.domainName !== olds.domainName ||
            !eq(news.domainNameServers, olds.domainNameServers) ||
            !eq(news.ntpServers, olds.ntpServers) ||
            !eq(news.netbiosNameServers, olds.netbiosNameServers) ||
            news.netbiosNodeType !== olds.netbiosNodeType
          ) {
            return { action: "replace" };
          }
          // vpcId association and tags are mutable in place.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);

          // Observe — find the options set via the cached id, else create.
          let opts: ec2.DhcpOptions | undefined;
          if (output?.dhcpOptionsId) {
            opts = yield* describeDhcpOptions(output.dhcpOptionsId);
          }

          // Ensure — create if missing.
          if (opts === undefined) {
            yield* session.note("Creating DHCP options set...");
            const result = yield* ec2.createDhcpOptions({
              DhcpConfigurations: buildConfigurations(news),
              TagSpecifications: [
                {
                  ResourceType: "dhcp-options",
                  Tags: createTagsList(desiredTags),
                },
              ],
            });
            opts = result.DhcpOptions!;
            yield* session.note(
              `DHCP options set created: ${opts.DhcpOptionsId}`,
            );
          }

          const dhcpOptionsId = opts.DhcpOptionsId!;

          // Sync association — associate the desired VPC, and detach any VPC we
          // previously associated that is no longer desired (re-point it at the
          // default options set).
          const previousVpc = output?.vpcId;
          if (news.vpcId) {
            yield* ec2.associateDhcpOptions({
              DhcpOptionsId: dhcpOptionsId,
              VpcId: news.vpcId as string,
            });
          }
          if (previousVpc && previousVpc !== news.vpcId) {
            yield* ec2.associateDhcpOptions({
              DhcpOptionsId: "default",
              VpcId: previousVpc as string,
            });
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [dhcpOptionsId] },
                  { Name: "resource-type", Values: ["dhcp-options"] },
                ],
              })
              .pipe(
                Effect.map(
                  (r) =>
                    Object.fromEntries(
                      r.Tags?.map((t) => [t.Key!, t.Value!]) ?? [],
                    ) as Record<string, string>,
                ),
              )) ?? {};
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [dhcpOptionsId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [dhcpOptionsId],
              Tags: upsert,
            });
          }

          return yield* toAttrs(opts, news.vpcId);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const dhcpOptionsId = output.dhcpOptionsId;

          // Disassociate any VPC first — a set cannot be deleted while attached.
          if (output.vpcId) {
            yield* session.note(
              `Restoring default DHCP options on ${output.vpcId}...`,
            );
            yield* ec2
              .associateDhcpOptions({
                DhcpOptionsId: "default",
                VpcId: output.vpcId as string,
              })
              .pipe(
                Effect.catchTag("InvalidVpcID.NotFound", () => Effect.void),
              );
          }

          yield* session.note(`Deleting DHCP options set: ${dhcpOptionsId}`);
          yield* ec2.deleteDhcpOptions({ DhcpOptionsId: dhcpOptionsId }).pipe(
            Effect.catchTag("InvalidDhcpOptionID.NotFound", () => Effect.void),
            Effect.catchTag("InvalidDhcpOptionsID.NotFound", () => Effect.void),
            // A VPC association may still be clearing.
            Effect.retry({
              while: (e: { _tag: string }) => e._tag === "DependencyViolation",
              schedule: Schedule.max([
                Schedule.fixed(3000),
                Schedule.recurs(20),
              ]),
            }),
          );
          yield* waitUntilDhcpOptionsGone(dhcpOptionsId);
        }),
      };
    }),
  );
