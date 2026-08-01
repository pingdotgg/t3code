import * as ec2 from "@distilled.cloud/aws/ec2";
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

export type PrefixListId<ID extends string = string> = `pl-${ID}`;
export const PrefixListId = <ID extends string>(
  id: ID,
): ID & PrefixListId<ID> => `pl-${id}` as ID & PrefixListId<ID>;

export type PrefixListArn<ID extends PrefixListId = PrefixListId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:prefix-list/${ID}`;

/**
 * A single CIDR entry in a managed prefix list.
 */
export interface PrefixListEntry {
  /**
   * The CIDR block for this entry. Must match the list's `addressFamily`
   * (an IPv4 CIDR for `IPv4`, an IPv6 CIDR for `IPv6`).
   */
  cidr: string;
  /**
   * An optional description for the entry (up to 255 characters).
   */
  description?: string;
}

export interface PrefixListProps {
  /**
   * A name for the prefix list. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Up to 255 characters. Mutable.
   */
  prefixListName?: string;

  /**
   * The IP address family of the prefix list. Determines the CIDR format
   * accepted in `entries`. Immutable — changing it replaces the list.
   * @default "IPv4"
   */
  addressFamily?: "IPv4" | "IPv6";

  /**
   * The maximum number of entries the prefix list can hold. Required by AWS.
   * Can be increased in place (not decreased) — a decrease replaces the list.
   */
  maxEntries: number;

  /**
   * The CIDR entries in the prefix list. Added/removed in place via versioned
   * modifications.
   * @default []
   */
  entries?: PrefixListEntry[];

  /**
   * Tags to assign to the prefix list.
   */
  tags?: Record<string, string>;
}

export interface PrefixList extends Resource<
  "AWS.EC2.PrefixList",
  PrefixListProps,
  {
    /**
     * The ID of the prefix list (prefixed `pl-`).
     */
    prefixListId: PrefixListId;

    /**
     * The Amazon Resource Name (ARN) of the prefix list.
     */
    prefixListArn: PrefixListArn;

    /**
     * The name of the prefix list.
     */
    prefixListName: string;

    /**
     * The IP address family of the prefix list.
     */
    addressFamily: "IPv4" | "IPv6";

    /**
     * The maximum number of entries the prefix list can hold.
     */
    maxEntries: number;

    /**
     * The current version of the prefix list. Incremented on every entry
     * modification.
     */
    version: number;

    /**
     * The AWS account ID of the prefix list owner.
     */
    ownerId: string;
  },
  never,
  Providers
> {}

/**
 * A managed prefix list is a named, reusable set of CIDR blocks that you
 * reference by ID from security group rules and route tables. Instead of
 * duplicating the same IP ranges across many rules, you maintain them in one
 * place and every rule that references the list picks up changes automatically.
 *
 * The list is versioned: each entry modification bumps `version`, and AWS
 * limits a list to `maxEntries` CIDRs (you provision headroom up front and can
 * only grow it, never shrink it, in place). `addressFamily` fixes whether the
 * list holds IPv4 or IPv6 CIDRs and is immutable.
 *
 * @resource
 * @section Creating a Prefix List
 * @example Basic IPv4 Prefix List
 * ```typescript
 * const corpNetworks = yield* AWS.EC2.PrefixList("CorpNetworks", {
 *   maxEntries: 10,
 *   entries: [
 *     { cidr: "10.0.0.0/16", description: "vpc-a" },
 *     { cidr: "10.1.0.0/16", description: "vpc-b" },
 *   ],
 * });
 * ```
 * Creates a prefix list with two IPv4 CIDRs. The resulting `prefixListId`
 * (prefixed `pl-`) can be referenced from security group rules and routes.
 *
 * @example IPv6 Prefix List
 * ```typescript
 * const ipv6List = yield* AWS.EC2.PrefixList("Ipv6List", {
 *   addressFamily: "IPv6",
 *   maxEntries: 5,
 *   entries: [{ cidr: "2001:db8::/32" }],
 * });
 * ```
 * `addressFamily: "IPv6"` makes the list accept IPv6 CIDRs. Because the family
 * is intrinsic to the list, changing it later replaces the resource.
 *
 * @section Referencing a Prefix List from a Security Group Rule
 * @example Allow Inbound from a Prefix List
 * ```typescript
 * const corpNetworks = yield* AWS.EC2.PrefixList("CorpNetworks", {
 *   maxEntries: 10,
 *   entries: [{ cidr: "10.0.0.0/16" }],
 * });
 *
 * const rule = yield* AWS.EC2.SecurityGroupRule("AllowCorp", {
 *   groupId: sg.groupId,
 *   type: "ingress",
 *   ipProtocol: "tcp",
 *   fromPort: 443,
 *   toPort: 443,
 *   prefixListId: corpNetworks.prefixListId,
 * });
 * ```
 * The rule allows HTTPS from every CIDR in the list. Editing the list's
 * `entries` updates what the rule permits without touching the rule itself.
 */
export const PrefixList = Resource<PrefixList>("AWS.EC2.PrefixList");

// A prefix list is stable (safe to modify/delete) only when its state ends in
// "-complete". "-in-progress" states are transient; "-failed" is terminal.
const isStableState = (state: string | undefined) =>
  state === undefined || state.endsWith("-complete");

export const PrefixListProvider = () =>
  Provider.effect(
    PrefixList,
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

      const describePrefixList = (prefixListId: string) =>
        ec2.describeManagedPrefixLists({ PrefixListIds: [prefixListId] }).pipe(
          Effect.map((r) => r.PrefixLists?.[0]),
          Effect.catchTag("InvalidPrefixListID.NotFound", () =>
            Effect.succeed(undefined),
          ),
        );

      // Poll until the list leaves any "-in-progress" state.
      const waitStable = (prefixListId: string) =>
        describePrefixList(prefixListId).pipe(
          Effect.flatMap((pl) =>
            isStableState(pl?.State)
              ? Effect.succeed(pl)
              : Effect.fail(new PrefixListNotStable()),
          ),
          Effect.retry({
            while: (e) => e instanceof PrefixListNotStable,
            schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(30)]),
          }),
        );

      const getEntries = (prefixListId: string) =>
        ec2.getManagedPrefixListEntries
          .pages({ PrefixListId: prefixListId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Entries ?? []),
            ),
          );

      const toAttrs = (pl: ec2.ManagedPrefixList) =>
        AWSEnvironment.current.pipe(
          Effect.map((env) => ({
            prefixListId: pl.PrefixListId as PrefixListId,
            prefixListArn:
              (pl.PrefixListArn as PrefixListArn) ??
              (`arn:aws:ec2:${env.region}:${env.accountId}:prefix-list/${pl.PrefixListId}` as PrefixListArn),
            prefixListName: pl.PrefixListName!,
            addressFamily: pl.AddressFamily as "IPv4" | "IPv6",
            maxEntries: pl.MaxEntries!,
            version: pl.Version!,
            ownerId: pl.OwnerId!,
          })),
        );

      return {
        stables: ["prefixListId", "prefixListArn", "addressFamily", "ownerId"],

        list: () =>
          Effect.gen(function* () {
            const env = yield* AWSEnvironment.current;
            const items = yield* ec2.describeManagedPrefixLists.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.PrefixLists ?? [])
                    // Skip AWS-managed lists (e.g. com.amazonaws.*), which
                    // are owned by "AWS" and have no PrefixListName we set.
                    .filter(
                      (
                        pl,
                      ): pl is ec2.ManagedPrefixList & {
                        PrefixListId: string;
                      } => pl.PrefixListId != null && pl.OwnerId !== "AWS",
                    )
                    .map((pl) => ({
                      prefixListId: pl.PrefixListId as PrefixListId,
                      prefixListArn:
                        (pl.PrefixListArn as PrefixListArn) ??
                        (`arn:aws:ec2:${env.region}:${env.accountId}:prefix-list/${pl.PrefixListId}` as PrefixListArn),
                      prefixListName: pl.PrefixListName!,
                      addressFamily: pl.AddressFamily as "IPv4" | "IPv6",
                      maxEntries: pl.MaxEntries!,
                      version: pl.Version!,
                      ownerId: pl.OwnerId!,
                    })),
                ),
              ),
            );
            return items satisfies PrefixList["Attributes"][];
          }),

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const pl = yield* describePrefixList(output.prefixListId);
          if (!pl) return undefined;
          return yield* toAttrs(pl);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          const oldFamily = olds.addressFamily ?? "IPv4";
          const newFamily = news.addressFamily ?? "IPv4";
          if (oldFamily !== newFamily) {
            return { action: "replace" };
          }
          // MaxEntries can only be increased in place; a decrease requires
          // replacement.
          if (news.maxEntries < olds.maxEntries) {
            return { action: "replace" };
          }
          // prefixListName, maxEntries (increase), entries, tags → in-place.
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const desiredTags = yield* createTags(id, news.tags);
          const desiredName =
            news.prefixListName ?? output?.prefixListName ?? id;
          const desiredFamily = news.addressFamily ?? "IPv4";
          const desiredEntries = news.entries ?? [];

          // Observe — find the list via the cached id, else fall through.
          let pl: ec2.ManagedPrefixList | undefined;
          if (output?.prefixListId) {
            pl = yield* describePrefixList(output.prefixListId);
          }

          // Ensure — create if missing.
          if (pl === undefined) {
            yield* session.note("Creating managed prefix list...");
            const result = yield* ec2.createManagedPrefixList({
              PrefixListName: desiredName,
              AddressFamily: desiredFamily,
              MaxEntries: news.maxEntries,
              Entries: desiredEntries.map((e) => ({
                Cidr: e.cidr,
                Description: e.description,
              })),
              TagSpecifications: [
                {
                  ResourceType: "prefix-list",
                  Tags: createTagsList(desiredTags),
                },
              ],
            });
            const created = result.PrefixList!;
            yield* session.note(
              `Managed prefix list created: ${created.PrefixListId}`,
            );
            pl = yield* waitStable(created.PrefixListId!);
          }

          const prefixListId = pl!.PrefixListId!;

          // Sync max-entries — an increase is a standalone modify (AWS forbids
          // changing size and entries in the same call).
          pl = yield* waitStable(prefixListId);
          if ((pl?.MaxEntries ?? 0) < news.maxEntries) {
            yield* session.note(
              `Increasing prefix list max entries to ${news.maxEntries}...`,
            );
            yield* ec2.modifyManagedPrefixList({
              PrefixListId: prefixListId,
              CurrentVersion: pl!.Version,
              MaxEntries: news.maxEntries,
            });
            pl = yield* waitStable(prefixListId);
          }

          // Sync entries + name — diff observed entries against desired.
          const currentEntries = yield* getEntries(prefixListId);
          const currentByCidr = new Map(
            currentEntries.map((e) => [e.Cidr!, e.Description ?? ""]),
          );
          const desiredByCidr = new Map(
            desiredEntries.map((e) => [e.cidr, e.description ?? ""]),
          );

          const addEntries = desiredEntries
            .filter(
              (e) =>
                !currentByCidr.has(e.cidr) ||
                currentByCidr.get(e.cidr) !== (e.description ?? ""),
            )
            .map((e) => ({ Cidr: e.cidr, Description: e.description }));
          const removeEntries = currentEntries
            .filter((e) => !desiredByCidr.has(e.Cidr!))
            .map((e) => ({ Cidr: e.Cidr! }));
          const nameChanged = (pl?.PrefixListName ?? "") !== desiredName;

          if (
            addEntries.length > 0 ||
            removeEntries.length > 0 ||
            nameChanged
          ) {
            yield* session.note("Updating managed prefix list entries...");
            yield* ec2.modifyManagedPrefixList({
              PrefixListId: prefixListId,
              CurrentVersion: pl!.Version,
              ...(nameChanged ? { PrefixListName: desiredName } : {}),
              ...(addEntries.length > 0 ? { AddEntries: addEntries } : {}),
              ...(removeEntries.length > 0
                ? { RemoveEntries: removeEntries }
                : {}),
            });
            pl = yield* waitStable(prefixListId);
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags =
            (yield* ec2
              .describeTags({
                Filters: [
                  { Name: "resource-id", Values: [prefixListId] },
                  { Name: "resource-type", Values: ["prefix-list"] },
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
              Resources: [prefixListId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({ Resources: [prefixListId], Tags: upsert });
          }

          const final = yield* describePrefixList(prefixListId);
          return yield* toAttrs(final!);
        }),

        delete: Effect.fn(function* ({ output, session }) {
          const prefixListId = output.prefixListId;
          yield* session.note(`Deleting managed prefix list: ${prefixListId}`);
          yield* ec2
            .deleteManagedPrefixList({ PrefixListId: prefixListId })
            .pipe(
              Effect.catchTag(
                "InvalidPrefixListID.NotFound",
                () => Effect.void,
              ),
              // Routes / SG rules still referencing the list surface as a
              // DependencyViolation while they tear down.
              Effect.retry({
                while: (e: { _tag: string }) =>
                  e._tag === "DependencyViolation",
                schedule: Schedule.max([
                  Schedule.fixed(5000),
                  Schedule.recurs(20),
                ]),
              }),
            );
        }),
      };
    }),
  );

class PrefixListNotStable {
  readonly _tag = "PrefixListNotStable";
}
