import * as turso from "@distilled.cloud/turso/turso";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { organization } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

export class GroupUnexpectedResponse extends Data.TaggedError("GroupUnexpectedResponse")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A Turso location code, e.g. `"aws-us-east-1"`. List the locations
 * available to your organization with `turso db locations`.
 */
export type Location =
  | "aws-ap-northeast-1"
  | "aws-ap-south-1"
  | "aws-ap-southeast-2"
  | "aws-ca-central-1"
  | "aws-eu-north-1"
  | "aws-eu-west-1"
  | "aws-sa-east-1"
  | "aws-us-east-1"
  | "aws-us-east-2"
  | "aws-us-west-2"
  | (string & {});

export interface GroupProps {
  /**
   * Group name, unique within the organization. Lowercase letters,
   * numbers, and dashes. If omitted, a unique name is generated from the
   * stack, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Primary location of the group. Every database in the group lives here.
   * Changing it replaces the group (and every database in it).
   * @default "aws-us-east-1"
   */
  location?: Location;
  /**
   * Additional replica locations. Reconciled in place by adding and
   * removing locations. AWS-hosted groups do not support replication, so
   * this only applies to organizations with legacy Fly-hosted groups.
   */
  replicas?: Location[];
  /**
   * SQLite extensions enabled for the group's databases: `"all"`, or a list
   * of extension names. Set at creation; changing it replaces the group.
   */
  extensions?: "all" | string[];
  /**
   * Prevent the group (and its databases) from being deleted. While
   * enabled, destroying or replacing the group fails; set it to `false`
   * and deploy before deleting.
   * @default false
   */
  deleteProtection?: boolean;
}

export interface GroupAttributes {
  /** Group name. */
  name: string;
  /** Group UUID. */
  uuid: string;
  /** The organization slug that owns the group. */
  organization: string;
  /** Primary location of the group. */
  location: string;
  /** Every location the group runs in (primary first). */
  locations: string[];
  /** The libSQL server version the group's databases run. */
  version: string;
  /** Whether delete protection is enabled. */
  deleteProtection: boolean;
}

export type Group = Resource<"Turso.Group", GroupProps, GroupAttributes, never, Providers>;

/**
 * A Turso group. Every Turso database belongs to one group, and the group
 * decides where its databases run.
 * @see https://docs.turso.tech/concepts#groups
 *
 * ### Creating a Group
 * **Example:** Group in a single location
 * ```typescript
 * const group = yield* Turso.Group("Group", {
 *   location: "aws-us-east-1",
 * });
 * ```
 *
 * **Example:** Protected group with all extensions enabled
 * ```typescript
 * const group = yield* Turso.Group("Group", {
 *   name: "production",
 *   location: "aws-eu-west-1",
 *   extensions: "all",
 *   deleteProtection: true,
 * });
 * ```
 *
 * ### Adding databases
 * **Example:** Create a database in the group
 * ```typescript
 * const db = yield* Turso.Database("Db", { group: group.name });
 * ```
 *
 * @resource
 * @product Group
 */
export const Group = Resource<Group>("Turso.Group");

const DEFAULT_LOCATION = "aws-us-east-1";

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      const groupName = (id: string, name: string | undefined) =>
        name
          ? Effect.succeed(name)
          : createPhysicalName({ id, lowercase: true, maxLength: 32, delimiter: "-" });

      const observe = (org: string, name: string) =>
        turso.getGroup({ organizationSlug: org, groupName: name }).pipe(
          Effect.map((res) => res.group),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      const toAttrs = (
        org: string,
        group: turso.Group,
        deleteProtection: boolean,
      ): GroupAttributes => ({
        name: group.name!,
        uuid: group.uuid ?? "",
        organization: org,
        location: group.primary ?? "",
        locations: group.locations ?? [],
        version: group.version ?? "",
        deleteProtection,
      });

      return {
        stables: ["name", "uuid", "organization", "location"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* groupName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) {
            return { action: "replace" } as const;
          }
          if ((news.location ?? DEFAULT_LOCATION) !== (olds?.location ?? DEFAULT_LOCATION)) {
            return { action: "replace", deleteFirst: news.name !== undefined } as const;
          }
          if (!deepEqual(news.extensions, olds?.extensions)) {
            return { action: "replace", deleteFirst: news.name !== undefined } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const org = output?.organization ?? (yield* organization);
          const name = output?.name ?? (yield* groupName(id, olds?.name));
          const group = yield* observe(org, name);
          if (!group) return undefined;
          const attrs = toAttrs(org, group, group.delete_protection ?? false);
          // Turso has no tags: a group found under an explicit, user-chosen
          // name without prior state may belong to someone else — unless it
          // is the generation a delete-first replacement is about to free.
          const ours =
            output !== undefined ||
            olds?.name === undefined ||
            (previous?.organization === org && previous.name === name);
          return ours ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const org = output?.organization ?? (yield* organization);
          const name = output?.name ?? (yield* groupName(id, news.name));
          const location = news.location ?? DEFAULT_LOCATION;

          // Observe
          let group = yield* observe(org, name);

          // Ensure
          if (!group) {
            yield* session.note(`Creating group ${name}...`);
            group = yield* turso
              .createGroup({
                organizationSlug: org,
                name,
                location,
                extensions: news.extensions,
              })
              .pipe(
                Effect.map((res) => res.group),
                Effect.catchTag("Conflict", () => observe(org, name)),
              );
            if (!group) {
              return yield* new GroupUnexpectedResponse({
                message: `Turso group ${name} vanished after create`,
              });
            }
          }

          // Sync replica locations against the observed set.
          const primary = group.primary ?? location;
          const desired = new Set([primary, ...(news.replicas ?? [])]);
          const observed = new Set(group.locations ?? [primary]);
          for (const loc of desired) {
            if (!observed.has(loc)) {
              yield* session.note(`Adding location ${loc}...`);
              group =
                (yield* turso.addLocationToGroup({
                  organizationSlug: org,
                  groupName: name,
                  location: loc,
                })).group ?? group;
            }
          }
          for (const loc of observed) {
            if (!desired.has(loc)) {
              yield* session.note(`Removing location ${loc}...`);
              group =
                (yield* turso.removeLocationFromGroup({
                  organizationSlug: org,
                  groupName: name,
                  location: loc,
                })).group ?? group;
            }
          }

          // Sync configuration.
          const config = yield* turso.getGroupConfiguration({
            organizationSlug: org,
            groupName: name,
          });
          let deleteProtection = config.delete_protection ?? false;
          const desiredProtection = news.deleteProtection ?? false;
          if (deleteProtection !== desiredProtection) {
            const updated = yield* turso.updateGroupConfiguration({
              organizationSlug: org,
              groupName: name,
              delete_protection: desiredProtection,
            });
            deleteProtection = updated.delete_protection ?? desiredProtection;
          }

          return toAttrs(org, group, deleteProtection);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* turso
            .deleteGroup({ organizationSlug: output.organization, groupName: output.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const org = yield* organization;
          const { groups } = yield* turso.listGroups({ organizationSlug: org });
          return (groups ?? [])
            .filter((group) => group.name !== undefined)
            .map((group) => toAttrs(org, group, group.delete_protection ?? false));
        }),
      };
    }),
  );
