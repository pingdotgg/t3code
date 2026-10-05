import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  compactStringMap,
  getGroup,
  getGroupByKey,
  lastSegment,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeCustomer,
  replaceOnIdentity,
  sameJson,
  sameText,
  toGroupKeyId,
  toPhysicalId,
  typeLabels,
  updateMaskOf,
} from "./internal.ts";
import {
  resourceNameFromOperation,
  waitForOperation,
  waitUntilPresent,
} from "./operations.ts";

export type GroupEntityKey = {
  /** Email address (Google-managed) or identity-source id. */
  id?: string;
  /** `identitysources/{identity_source}` for external-mapped groups. */
  namespace?: string;
};

export type GroupDynamicGroupQuery = {
  /** Resource type for the query. Currently `USER`. */
  resourceType?:
    | cloudidentity.DynamicGroupQueryResourceTypeEnum
    | (string & {});
  /** CEL membership query. */
  query?: string;
};

export type GroupDynamicGroupMetadata = {
  /** Membership queries. Only one `USER` query is supported. */
  queries?: GroupDynamicGroupQuery[];
};

export type GroupProps = {
  /**
   * Cloud Identity customer or identity source, as
   * `customers/{customer}` (the id must start with `C`) or
   * `identitysources/{identity_source}`. `customers/my_customer`
   * refers to the caller's customer. Immutable — changing it replaces
   * the group.
   * @default "customers/my_customer"
   */
  parent?: string;
  /**
   * Group email (`group@example.com`) or identity-source id. If
   * omitted, a unique local part is generated and combined with
   * `domain` when set. Immutable — changing it replaces the group.
   */
  groupKeyId?: string;
  /**
   * Entity-key namespace for external-identity-mapped groups
   * (`identitysources/{identity_source}`).
   */
  groupKeyNamespace?: string;
  /**
   * Domain used to build `groupKeyId` when that prop is omitted
   * (`{generated}@{domain}`).
   */
  domain?: string;
  /**
   * Display name shown to members.
   */
  displayName?: string;
  /**
   * Extended description shown to members (max 4,096 characters).
   */
  description?: string;
  /**
   * Cloud Identity type labels (empty values). Google Groups need
   * `cloudidentity.googleapis.com/groups.discussion_forum`. Adding
   * `cloudidentity.googleapis.com/groups.security` is immutable.
   */
  labels?: Record<string, string>;
  /**
   * Initial membership config on create.
   * @default "EMPTY"
   */
  initialGroupConfig?:
    | cloudidentity.CreateGroupsInitialGroupConfigEnum
    | (string & {});
  /**
   * Dynamic group queries. Sets the dynamic type label.
   */
  dynamicGroupMetadata?: GroupDynamicGroupMetadata;
};

export type Group = Resource<
  "GCP.CloudIdentity.Group",
  GroupProps,
  {
    /** Resource name `groups/{group}`. */
    name: string;
    /** Group id (last path segment). */
    groupId: string;
    /** Customer or identity-source parent. */
    parent: string;
    /** Group entity key id (email). */
    groupKeyId: string;
    /** Entity-key namespace, if any. */
    groupKeyNamespace: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Cloud Identity type labels. */
    labels: Record<string, string>;
    /** Additional group keys. */
    additionalGroupKeys: GroupEntityKey[] | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Identity / Google Group.
 *
 * Groups have no user labels, so Alchemy identifies a group by its key
 * (email): a group found under the generated key is adopted, one found
 * under an explicit `groupKeyId` without state is reported as unowned.
 * `parent` and `groupKeyId` are identity; display name, description, and labels update in place.
 *
 * ### Creating a Group
 * **Example:** Generated email on a Workspace domain
 * ```typescript
 * const group = yield* GCP.CloudIdentity.Group("Eng", {
 *   parent: "customers/my_customer",
 *   domain: "example.com",
 *   displayName: "Engineering",
 * });
 * ```
 *
 * **Example:** Explicit group key
 * ```typescript
 * const group = yield* GCP.CloudIdentity.Group("Eng", {
 *   parent: "customers/C046psxkn",
 *   groupKeyId: "eng@example.com",
 *   displayName: "Engineering",
 *   description: "product engineering",
 * });
 * ```
 *
 * ### Updating a Group
 * **Example:** Rename
 * ```typescript
 * const group = yield* GCP.CloudIdentity.Group("Eng", {
 *   groupKeyId: "eng@example.com",
 *   displayName: "Engineering 2026",
 * });
 * ```
 *
 * @resource
 * @category CloudIdentity
 */
export const Group = Resource<Group>("GCP.CloudIdentity.Group");

export class GroupNotResolved extends Data.TaggedError(
  "GCP.CloudIdentity.GroupNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (group: cloudidentity.Group) => {
  const name = group.name ?? "";
  return {
    name,
    groupId: lastSegment(name),
    parent: group.parent ?? "",
    groupKeyId: group.groupKey?.id ?? "",
    groupKeyNamespace: group.groupKey?.namespace,
    displayName: group.displayName,
    description: group.description,
    labels: compactStringMap(group.labels),
    additionalGroupKeys: group.additionalGroupKeys?.map((key) => ({
      id: key.id,
      namespace: key.namespace,
    })),
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const observeGroup = (input: {
  id: string;
  name?: string;
  groupKeyId?: string;
  groupKeyNamespace?: string;
  parent?: string;
}) =>
  Effect.gen(function* () {
    const byName = yield* getGroup(input.name ?? "");
    if (byName !== undefined) return byName;
    const byKey = yield* getGroupByKey(
      input.groupKeyId ?? "",
      input.groupKeyNamespace,
    );
    return byKey;
  });

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["name", "groupId", "parent", "groupKeyId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent =
        news.parent !== undefined
          ? normalizeCustomer(news.parent)
          : previousParent;
      const previousKey = olds?.groupKeyId ?? output?.groupKeyId;
      return replaceOnIdentity({
        previousId: previousKey,
        nextId: news.groupKeyId,
        previousParent,
        nextParent,
        extra:
          news.groupKeyNamespace !== undefined &&
          output?.groupKeyNamespace !== undefined &&
          news.groupKeyNamespace !== output.groupKeyNamespace,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const groupKeyId = yield* toGroupKeyId(
        id,
        olds?.groupKeyId,
        output?.groupKeyId,
        olds?.domain,
      );
      const existing = yield* observeGroup({
        id,
        name: output?.name,
        groupKeyId,
        groupKeyNamespace: olds?.groupKeyNamespace ?? output?.groupKeyNamespace,
        parent: olds?.parent ?? output?.parent,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      // State or the generated group key proves ownership.
      return output !== undefined || olds?.groupKeyId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const parent = normalizeCustomer(news.parent ?? output?.parent);
      const groupKeyId = yield* toGroupKeyId(
        id,
        news.groupKeyId,
        output?.groupKeyId,
        news.domain,
      );
      const groupKeyNamespace =
        news.groupKeyNamespace ?? output?.groupKeyNamespace;
      const displayName = yield* toPhysicalId(
        id,
        news.displayName,
        output?.displayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const description = news.description;
      const labels = typeLabels(news.labels);
      const desired: cloudidentity.Group = {
        parent,
        groupKey: {
          id: groupKeyId,
          namespace: groupKeyNamespace,
        },
        displayName,
        description,
        labels,
        dynamicGroupMetadata: news.dynamicGroupMetadata,
      };

      let current = yield* observeGroup({
        id,
        name: output?.name,
        groupKeyId,
        groupKeyNamespace,
        parent,
      });

      if (current === undefined) {
        const created = yield* cloudidentity
          .createGroups({
            initialGroupConfig: news.initialGroupConfig ?? "EMPTY",
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<cloudidentity.Operation | undefined>(undefined),
            ),
          );
        if (created !== undefined) {
          yield* waitForOperation(created).pipe(
            Effect.catchTag(
              "GCP.CloudIdentity.OperationPending",
              () => Effect.void,
            ),
          );
          const createdName = resourceNameFromOperation(created);
          if (createdName !== undefined) {
            current = yield* getGroup(createdName);
          }
        }
        if (current === undefined) {
          current = yield* waitUntilPresent(
            observeGroup({
              id,
              name: output?.name,
              groupKeyId,
              groupKeyNamespace,
              parent,
            }),
            groupKeyId,
          ).pipe(
            Effect.catchTag("GCP.CloudIdentity.OperationPending", () =>
              observeGroup({
                id,
                groupKeyId,
                groupKeyNamespace,
                parent,
              }),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new GroupNotResolved({
          name: output?.name ?? groupKeyId,
        });
      }

      const name = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const labelsChanged = !sameJson(compactStringMap(current.labels), labels);

      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        descriptionChanged ? "description" : undefined,
        labelsChanged ? "labels" : undefined,
      );

      if (updateMask.length > 0 && name.length > 0) {
        const patched = yield* cloudidentity.patchGroups({
          name,
          updateMask,
          body: {
            displayName,
            description,
            labels,
          },
        });
        yield* waitForOperation(patched).pipe(
          Effect.catchTag(
            "GCP.CloudIdentity.OperationPending",
            () => Effect.void,
          ),
        );
        current = (yield* getGroup(name)) ?? current;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      const deleted = yield* cloudidentity
        .deleteGroups({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed<cloudidentity.Operation | undefined>(undefined),
          ),
        );
      if (deleted !== undefined) {
        yield* waitForOperation(deleted, { notFoundOk: true });
      }
    }),
  });
