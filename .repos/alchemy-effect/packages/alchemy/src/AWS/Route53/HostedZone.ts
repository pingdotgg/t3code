import * as route53 from "@distilled.cloud/aws/route-53";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface HostedZoneProps {
  /**
   * Fully qualified domain name for the zone (e.g. `"example.com"`). A trailing
   * dot is added automatically. Changing the name forces replacement.
   */
  name: string;
  /**
   * Optional comment describing the zone. Updated in place.
   */
  comment?: string;
  /**
   * Whether this is a private hosted zone. Requires `vpc`. Changing this forces
   * replacement.
   * @default false
   */
  privateZone?: boolean;
  /**
   * VPC to associate with a private hosted zone at create time. Changing the
   * initial VPC forces replacement.
   */
  vpc?: {
    /** VPC ID. */
    vpcId: string;
    /** Region the VPC lives in. */
    vpcRegion: string;
  };
  /**
   * ID of a reusable delegation set to associate with the zone. Changing this
   * forces replacement.
   */
  delegationSetId?: string;
  /**
   * Whether to delete all non-SOA/NS records before deleting the zone.
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Tags applied to the hosted zone.
   */
  tags?: Record<string, string>;
}

export interface HostedZone extends Resource<
  "AWS.Route53.HostedZone",
  HostedZoneProps,
  {
    /**
     * Hosted zone ID (without the `/hostedzone/` prefix).
     */
    id: string;
    /**
     * Fully qualified zone name (with trailing dot).
     */
    name: string;
    /**
     * Authoritative name servers for the zone.
     */
    nameServers: string[];
    /**
     * Current zone comment.
     */
    comment: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Route 53 hosted zone.
 *
 * `HostedZone` manages the lifecycle of a public or private hosted zone,
 * including its comment and tags. For public zones, the four authoritative
 * name servers are exposed as `nameServers`.
 * @resource
 * @section Creating a Hosted Zone
 * @example Public Hosted Zone
 * ```typescript
 * const zone = yield* HostedZone("MyZone", {
 *   name: "example.com",
 *   comment: "Primary zone",
 * });
 * // zone.nameServers -> the 4 NS records to set at your registrar
 * ```
 *
 * @example Force Destroy
 * ```typescript
 * const zone = yield* HostedZone("MyZone", {
 *   name: "example.com",
 *   forceDestroy: true, // delete leftover records on destroy
 * });
 * ```
 */
export const HostedZone = Resource<HostedZone>("AWS.Route53.HostedZone");

const normalizeId = (id: string) => id.replace(/^\/hostedzone\//, "");

const normalizeName = (name: string) =>
  name.endsWith(".") ? name : `${name}.`;

export const HostedZoneProvider = () =>
  Provider.effect(
    HostedZone,
    Effect.gen(function* () {
      // Poll `getChange` until the change reaches INSYNC. `getChange` is
      // eventually consistent and can briefly return `NoSuchChange` right after
      // submit, so coalesce that to a non-INSYNC status and keep polling.
      // `ChangeInfo.Id` comes back as "/change/C..." but `getChange` only
      // accepts the bare id — the prefixed form returns `NoSuchChange`
      // forever, silently burning the full repeat cap on every change.
      const waitForChange = Effect.fn(function* (changeId: string) {
        return yield* route53
          .getChange({ Id: changeId.replace(/^\/change\//, "") })
          .pipe(
            Effect.map((r) => r.ChangeInfo.Status),
            Effect.catchTag("NoSuchChange", () => Effect.succeed("PENDING")),
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(60),
              ]),
              until: (status) => status === "INSYNC",
            }),
          );
      });

      const findByName = Effect.fn(function* (name: string) {
        const response = yield* route53.listHostedZonesByName({
          DNSName: normalizeName(name),
          MaxItems: 1,
        });
        return (response.HostedZones ?? []).find(
          (zone) => zone.Name === normalizeName(name),
        );
      });

      const observe = Effect.fn(function* (id: string) {
        return yield* route53
          .getHostedZone({ Id: normalizeId(id) })
          .pipe(
            Effect.catchTag("NoSuchHostedZone", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const observedTags = Effect.fn(function* (id: string) {
        const response = yield* route53.listTagsForResource({
          ResourceType: "hostedzone",
          ResourceId: normalizeId(id),
        });
        const record: Record<string, string> = {};
        for (const tag of response.ResourceTagSet.Tags ?? []) {
          if (tag.Key !== undefined && tag.Value !== undefined) {
            record[tag.Key] = tag.Value;
          }
        }
        return record;
      });

      const syncTags = Effect.fn(function* (
        id: string,
        logicalId: string,
        userTags: Record<string, string> | undefined,
      ) {
        const internalTags = yield* createInternalTags(logicalId);
        const newTags = { ...userTags, ...internalTags };
        const oldTags = yield* observedTags(id);
        const { upsert, removed } = diffTags(oldTags, newTags);
        if (upsert.length === 0 && removed.length === 0) {
          return;
        }
        yield* route53.changeTagsForResource({
          ResourceType: "hostedzone",
          ResourceId: normalizeId(id),
          AddTags: upsert.length > 0 ? upsert : undefined,
          RemoveTagKeys: removed.length > 0 ? removed : undefined,
        });
      });

      // Delete every non-SOA/NS record set so the zone can be deleted.
      const purgeRecords = Effect.fn(function* (id: string) {
        const sets: route53.ResourceRecordSet[] = [];
        let request: route53.ListResourceRecordSetsRequest = {
          HostedZoneId: normalizeId(id),
          MaxItems: 300,
        };
        while (true) {
          const response = yield* route53.listResourceRecordSets(request);
          sets.push(...(response.ResourceRecordSets ?? []));
          if (!response.IsTruncated || response.NextRecordName === undefined) {
            break;
          }
          request = {
            HostedZoneId: normalizeId(id),
            StartRecordName: response.NextRecordName,
            StartRecordType: response.NextRecordType,
            StartRecordIdentifier: response.NextRecordIdentifier,
            MaxItems: 300,
          };
        }
        const deletable = sets.filter(
          (set) => set.Type !== "SOA" && set.Type !== "NS",
        );
        if (deletable.length === 0) {
          return;
        }
        yield* route53
          .changeResourceRecordSets({
            HostedZoneId: normalizeId(id),
            ChangeBatch: {
              Comment: "Alchemy HostedZone forceDestroy",
              Changes: deletable.map((set) => ({
                Action: "DELETE" as const,
                ResourceRecordSet: set,
              })),
            },
          })
          .pipe(
            Effect.flatMap((response) => waitForChange(response.ChangeInfo.Id)),
          );
      });

      return {
        stables: ["id", "name"],
        list: () =>
          route53.listHostedZones.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.HostedZones ?? []).map((zone) => ({
                  id: normalizeId(zone.Id),
                  name: zone.Name,
                  nameServers: [] as string[],
                  comment: zone.Config?.Comment,
                })),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Name change → replace, but only when the old name is known — a
          // half-created state row can't round-trip an Output-valued `name`
          // (it deserializes as `undefined`), and an unknown old name must
          // fall through to the create/update recovery path.
          if (
            (olds.name !== undefined &&
              normalizeName(olds.name) !== normalizeName(news.name)) ||
            (olds.privateZone ?? false) !== (news.privateZone ?? false) ||
            olds.delegationSetId !== news.delegationSetId ||
            olds.vpc?.vpcId !== news.vpc?.vpcId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          // Resolve the zone id: prefer the stored output, else look up by name
          // (adoption / state-loss recovery). The persisted `name` may be
          // `undefined` when a `creating` row was written before upstream
          // Outputs resolved — report "not found" and let the engine
          // re-drive the create.
          const zoneId =
            output?.id ??
            (olds?.name !== undefined
              ? (yield* findByName(olds.name))?.Id
              : undefined);
          if (zoneId === undefined) {
            return undefined;
          }
          const detail = yield* observe(zoneId);
          if (!detail) {
            return undefined;
          }
          return {
            id: normalizeId(detail.HostedZone.Id),
            name: detail.HostedZone.Name,
            nameServers: detail.DelegationSet?.NameServers ?? [],
            comment: detail.HostedZone.Config?.Comment,
          };
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          // Observe.
          let zone = output?.id ? yield* observe(output.id) : undefined;

          // Ensure.
          if (!zone) {
            const created = yield* route53
              .createHostedZone({
                Name: normalizeName(news.name),
                CallerReference: instanceId,
                HostedZoneConfig:
                  news.comment !== undefined || news.privateZone
                    ? {
                        Comment: news.comment,
                        PrivateZone: news.privateZone,
                      }
                    : undefined,
                VPC: news.vpc
                  ? { VPCId: news.vpc.vpcId, VPCRegion: news.vpc.vpcRegion }
                  : undefined,
                DelegationSetId: news.delegationSetId,
              })
              .pipe(
                Effect.map((response) => ({
                  HostedZone: response.HostedZone,
                  DelegationSet: response.DelegationSet,
                })),
                // Re-running with the same CallerReference races; re-observe.
                Effect.catchTag("HostedZoneAlreadyExists", () =>
                  Effect.gen(function* () {
                    const existing = yield* findByName(news.name);
                    if (!existing) {
                      return yield* Effect.die(
                        new Error(
                          "hosted zone not found after HostedZoneAlreadyExists",
                        ),
                      );
                    }
                    return yield* observe(existing.Id).pipe(
                      Effect.map((z) =>
                        z
                          ? {
                              HostedZone: z.HostedZone,
                              DelegationSet: z.DelegationSet,
                            }
                          : undefined,
                      ),
                    );
                  }),
                ),
              );
            if (!created) {
              return yield* Effect.die(
                new Error("hosted zone could not be observed after create"),
              );
            }
            zone = {
              HostedZone: created.HostedZone,
              DelegationSet: created.DelegationSet,
              VPCs: undefined,
            };
          }

          const zoneId = zone.HostedZone.Id;

          // Sync comment.
          if ((zone.HostedZone.Config?.Comment ?? undefined) !== news.comment) {
            yield* route53.updateHostedZoneComment({
              Id: normalizeId(zoneId),
              Comment: news.comment ?? "",
            });
          }

          // Sync tags.
          yield* syncTags(zoneId, id, news.tags);

          // Re-read for fresh name servers + comment.
          const detail = yield* observe(zoneId);
          return {
            id: normalizeId(zoneId),
            name: detail?.HostedZone.Name ?? normalizeName(news.name),
            nameServers: detail?.DelegationSet?.NameServers ?? [],
            comment: detail?.HostedZone.Config?.Comment ?? news.comment,
          };
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (olds.forceDestroy) {
            yield* purgeRecords(output.id).pipe(
              Effect.catchTag("NoSuchHostedZone", () => Effect.void),
            );
          }
          yield* route53.deleteHostedZone({ Id: normalizeId(output.id) }).pipe(
            Effect.asVoid,
            Effect.catchTag("NoSuchHostedZone", () => Effect.void),
            // A still-non-empty zone (without forceDestroy) is retried briefly
            // in case a referencing record's delete is still propagating —
            // records looked up by zone NAME (e.g. `ECS.Service`'s `domain`)
            // have no dependency edge on the zone, so their deletes run
            // concurrently with ours (a classic Dependency Violation).
            Effect.retry({
              while: (e) =>
                e._tag === "PriorRequestNotComplete" ||
                e._tag === "HostedZoneNotEmpty",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
        }),
      };
    }),
  );
