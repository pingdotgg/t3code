import type * as NFW from "@distilled.cloud/aws/network-firewall";
import * as nfw from "@distilled.cloud/aws/network-firewall";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { nfwTagsToRecord, recordToNfwTags } from "./internal.ts";

export interface FirewallProps {
  /**
   * Name of the firewall. Must be 1-128 alphanumeric characters or hyphens.
   * If omitted, a deterministic physical name is generated. Changing the
   * name replaces the firewall.
   */
  firewallName?: string;
  /**
   * ARN of the {@link FirewallPolicy} that defines the firewall's traffic
   * inspection behavior. Updated in place via `AssociateFirewallPolicy`.
   */
  firewallPolicyArn: string;
  /**
   * ID of the VPC the firewall protects. Changing the VPC replaces the
   * firewall.
   */
  vpcId: string;
  /**
   * The public subnets (one per Availability Zone) that Network Firewall
   * provisions firewall endpoints into. Uses raw Network Firewall API
   * structures (`{ SubnetId, IPAddressType? }`). Updated in place via
   * `AssociateSubnets` / `DisassociateSubnets`.
   */
  subnetMappings: NFW.SubnetMapping[];
  /**
   * Whether the firewall is protected against deletion. The provider
   * automatically clears this flag before deleting the firewall.
   * @default false
   */
  deleteProtection?: boolean;
  /**
   * Whether the firewall is protected against changes to its subnet
   * associations.
   * @default false
   */
  subnetChangeProtection?: boolean;
  /**
   * Whether the firewall is protected against a change of firewall policy.
   * @default false
   */
  firewallPolicyChangeProtection?: boolean;
  /**
   * Human-readable description of the firewall.
   */
  description?: string;
  /**
   * Tags to apply to the firewall. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Firewall extends Resource<
  "AWS.NetworkFirewall.Firewall",
  FirewallProps,
  {
    /** Name of the firewall. */
    firewallName: string;
    /** ARN of the firewall. */
    firewallArn: string;
    /** Server-assigned unique id of the firewall. */
    firewallId: string;
    /** ID of the VPC the firewall is provisioned into. */
    vpcId: string;
    /**
     * The VPC endpoint IDs of the provisioned firewall endpoints, one per
     * subnet mapping, sorted for determinism. Use these as route targets.
     */
    endpointIds: string[];
  },
  never,
  Providers
> {}

/**
 * An AWS Network Firewall firewall — provisions managed firewall endpoints
 * into your VPC subnets and inspects traffic according to an associated
 * {@link FirewallPolicy}.
 *
 * Endpoint provisioning takes several minutes (typically 5-10), and deleting
 * a firewall waits for the endpoints to deprovision.
 * @resource
 * @section Creating Firewalls
 * @example Firewall in a VPC
 * ```typescript
 * import * as EC2 from "alchemy/AWS/EC2";
 * import * as NetworkFirewall from "alchemy/AWS/NetworkFirewall";
 *
 * const vpc = yield* EC2.Vpc("Vpc", { cidrBlock: "10.0.0.0/16" });
 * const subnet = yield* EC2.Subnet("FirewallSubnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 * });
 *
 * const policy = yield* NetworkFirewall.FirewallPolicy("Policy", {
 *   firewallPolicy: {
 *     StatelessDefaultActions: ["aws:pass"],
 *     StatelessFragmentDefaultActions: ["aws:pass"],
 *   },
 * });
 *
 * const firewall = yield* NetworkFirewall.Firewall("Firewall", {
 *   firewallPolicyArn: policy.firewallPolicyArn,
 *   vpcId: vpc.vpcId,
 *   subnetMappings: [{ SubnetId: subnet.subnetId }],
 * });
 * ```
 */
export const Firewall = Resource<Firewall>("AWS.NetworkFirewall.Firewall");

/** Raised (internally, for bounded retry) while a firewall is provisioning. */
export class FirewallNotReady extends Data.TaggedError("FirewallNotReady")<{
  message: string;
}> {}

/** Raised (internally, for bounded retry) while a firewall is deleting. */
export class FirewallNotDeleted extends Data.TaggedError("FirewallNotDeleted")<{
  message: string;
}> {}

// Explicitly-typed pipeable retry helpers (see internal.ts for why these are
// not inlined).
const retryWhileNotReady = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "FirewallNotReady",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(60)]),
  });

const retryWhileNotDeleted = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "FirewallNotDeleted",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(80)]),
  });

const retryWhileFirewallBusy = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "InvalidOperationException",
    schedule: Schedule.max([Schedule.fixed("15 seconds"), Schedule.recurs(20)]),
  });

export const FirewallProvider = () =>
  Provider.effect(
    Firewall,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { firewallName?: string },
      ) {
        return (
          props.firewallName ??
          (yield* createPhysicalName({ id, maxLength: 128 }))
        );
      });

      const endpointIds = (status: NFW.FirewallStatus | undefined): string[] =>
        Object.values(status?.SyncStates ?? {})
          .map((state) => state?.Attachment?.EndpointId)
          .filter((id): id is string => id !== undefined)
          .sort();

      const toAttrs = (
        firewall: NFW.Firewall,
        status: NFW.FirewallStatus | undefined,
      ): Firewall["Attributes"] => ({
        firewallName: firewall.FirewallName ?? "",
        firewallArn: firewall.FirewallArn ?? "",
        firewallId: firewall.FirewallId,
        vpcId: firewall.VpcId,
        endpointIds: endpointIds(status),
      });

      const describe = Effect.fn(function* (name: string) {
        return yield* nfw
          .describeFirewall({ FirewallName: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      // Bounded readiness wait. Endpoint provisioning typically completes in
      // 5-10 minutes; budget ~15 min (60 * 15s).
      const waitForReady = Effect.fn(function* (name: string) {
        return yield* Effect.gen(function* () {
          const response = yield* describe(name);
          if (response?.Firewall === undefined) {
            return yield* Effect.fail(
              new FirewallNotReady({ message: `firewall '${name}' not found` }),
            );
          }
          if (response.FirewallStatus?.Status !== "READY") {
            return yield* Effect.fail(
              new FirewallNotReady({
                message: `firewall '${name}' not ready (status: ${response.FirewallStatus?.Status})`,
              }),
            );
          }
          return response;
        }).pipe(retryWhileNotReady);
      });

      return Firewall.Provider.of({
        stables: ["firewallName", "firewallArn", "firewallId", "vpcId"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* nfw.listFirewalls
              .pages({})
              .pipe(Stream.runCollect);
            const metas = Array.from(pages).flatMap(
              (page) => page.Firewalls ?? [],
            );
            const items = yield* Effect.forEach(
              metas,
              (meta) =>
                nfw.describeFirewall({ FirewallArn: meta.FirewallArn }).pipe(
                  Effect.map((r) =>
                    r.Firewall !== undefined
                      ? toAttrs(r.Firewall, r.FirewallStatus)
                      : undefined,
                  ),
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 5 },
            );
            return items.filter(
              (item): item is Firewall["Attributes"] => item !== undefined,
            );
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.firewallName ?? (yield* createName(id, olds ?? {}));
          const found = yield* describe(name);
          if (found?.Firewall === undefined) return undefined;
          const attrs = toAttrs(found.Firewall, found.FirewallStatus);
          const tags = nfwTagsToRecord(found.Firewall.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName || olds.vpcId !== news.vpcId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.firewallName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags: Record<string, string> = {
            ...news.tags,
            ...internalTags,
          };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* describe(name);

          // 2. Ensure — create if missing, then wait for READY so mutation
          // calls below don't race endpoint provisioning.
          if (observed?.Firewall === undefined) {
            yield* session.note(`creating firewall ${name} (5-10 minutes)`);
            yield* nfw.createFirewall({
              FirewallName: name,
              FirewallPolicyArn: news.firewallPolicyArn,
              VpcId: news.vpcId,
              SubnetMappings: news.subnetMappings,
              DeleteProtection: news.deleteProtection ?? false,
              SubnetChangeProtection: news.subnetChangeProtection ?? false,
              FirewallPolicyChangeProtection:
                news.firewallPolicyChangeProtection ?? false,
              Description: news.description,
              Tags: recordToNfwTags(desiredTags),
            });
          }
          observed = yield* waitForReady(name);
          let firewall = observed.Firewall!;

          // 3. Sync — each mutable aspect re-reads for a fresh UpdateToken,
          // diffs OBSERVED against desired, and applies only the delta.
          const refresh = Effect.fn(function* () {
            observed = yield* waitForReady(name);
            firewall = observed.Firewall!;
          });

          // 3a. Firewall policy association.
          if (firewall.FirewallPolicyArn !== news.firewallPolicyArn) {
            yield* nfw.associateFirewallPolicy({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              FirewallPolicyArn: news.firewallPolicyArn,
            });
            yield* refresh();
          }

          // 3b. Subnet associations.
          const observedSubnetIds = new Set(
            firewall.SubnetMappings.map((m) => m.SubnetId),
          );
          const desiredSubnetIds = new Set(
            news.subnetMappings.map((m) => m.SubnetId),
          );
          const toAssociate = news.subnetMappings.filter(
            (m) => !observedSubnetIds.has(m.SubnetId),
          );
          const toDisassociate = [...observedSubnetIds].filter(
            (subnetId) => !desiredSubnetIds.has(subnetId),
          );
          if (toAssociate.length > 0) {
            yield* nfw.associateSubnets({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              SubnetMappings: toAssociate,
            });
            yield* refresh();
          }
          if (toDisassociate.length > 0) {
            yield* nfw.disassociateSubnets({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              SubnetIds: toDisassociate,
            });
            yield* refresh();
          }

          // 3c. Description.
          if ((news.description ?? undefined) !== firewall.Description) {
            yield* nfw.updateFirewallDescription({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              Description: news.description,
            });
            yield* refresh();
          }

          // 3d. Protection flags.
          const desiredDeleteProtection = news.deleteProtection ?? false;
          if (
            (firewall.DeleteProtection ?? false) !== desiredDeleteProtection
          ) {
            yield* nfw.updateFirewallDeleteProtection({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              DeleteProtection: desiredDeleteProtection,
            });
            yield* refresh();
          }
          const desiredSubnetChangeProtection =
            news.subnetChangeProtection ?? false;
          if (
            (firewall.SubnetChangeProtection ?? false) !==
            desiredSubnetChangeProtection
          ) {
            yield* nfw.updateSubnetChangeProtection({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              SubnetChangeProtection: desiredSubnetChangeProtection,
            });
            yield* refresh();
          }
          const desiredPolicyChangeProtection =
            news.firewallPolicyChangeProtection ?? false;
          if (
            (firewall.FirewallPolicyChangeProtection ?? false) !==
            desiredPolicyChangeProtection
          ) {
            yield* nfw.updateFirewallPolicyChangeProtection({
              UpdateToken: observed.UpdateToken,
              FirewallName: name,
              FirewallPolicyChangeProtection: desiredPolicyChangeProtection,
            });
            yield* refresh();
          }

          // 3e. Tags — diff against OBSERVED cloud tags.
          const observedTags = nfwTagsToRecord(firewall.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          const arn = firewall.FirewallArn!;
          if (upsert.length > 0) {
            yield* nfw.tagResource({ ResourceArn: arn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* nfw.untagResource({ ResourceArn: arn, TagKeys: removed });
          }

          yield* session.note(name);
          return toAttrs(firewall, observed.FirewallStatus);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const name = output.firewallName;
          const observed = yield* nfw
            .describeFirewall({ FirewallName: name })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (observed === undefined) return;

          // Clear delete protection first — DeleteFirewall requires it off.
          if (observed.Firewall?.DeleteProtection) {
            yield* nfw
              .updateFirewallDeleteProtection({
                UpdateToken: observed.UpdateToken,
                FirewallName: name,
                DeleteProtection: false,
              })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }

          yield* session.note(
            `deleting firewall ${name} (endpoints deprovision over several minutes)`,
          );
          yield* nfw.deleteFirewall({ FirewallName: name }).pipe(
            retryWhileFirewallBusy,
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );

          // Wait until the firewall (and its endpoints) are fully gone so
          // dependent deletions (subnets, VPC) don't hit DependencyViolations.
          yield* Effect.gen(function* () {
            const remaining = yield* nfw
              .describeFirewall({ FirewallName: name })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
            if (remaining !== undefined) {
              return yield* Effect.fail(
                new FirewallNotDeleted({
                  message: `firewall '${name}' still deleting (status: ${remaining.FirewallStatus?.Status})`,
                }),
              );
            }
          }).pipe(retryWhileNotDeleted);
        }),
      });
    }),
  );
