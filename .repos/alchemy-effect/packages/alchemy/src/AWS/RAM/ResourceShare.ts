import * as ram from "@distilled.cloud/aws/ram";
import * as Array from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ResourceShareProps {
  /**
   * Name of the resource share. Must be unique within your account. If omitted,
   * Alchemy generates a deterministic name from the stack, stage, and logical ID.
   * Max 128 characters.
   */
  shareName?: string;

  /**
   * ARNs of the resources to share (for example a Subnet, License, or Resolver
   * rule ARN). Resources can be added or removed on update.
   */
  resourceArns?: string[];

  /**
   * Principals to share with. Each principal is one of: a 12-digit account ID,
   * an organization ARN, an organizational unit (OU) ARN, an IAM role ARN, or an
   * IAM user ARN. Principals can be added or removed on update.
   */
  principals?: string[];

  /**
   * Source accounts or ARNs whose resources are shared through this share.
   * Used by service-managed shares. Sources can be added or removed on update.
   */
  sources?: string[];

  /**
   * Whether principals outside your AWS organization are allowed. When sharing
   * with accounts or OUs inside your organization (with RAM organization sharing
   * enabled) set this to `false` so shares are auto-accepted.
   * @default true
   */
  allowExternalPrincipals?: boolean;

  /**
   * ARNs of the RAM managed permissions to associate with the share at creation
   * time. Changing this list replaces the resource share.
   */
  permissionArns?: string[];

  /**
   * Tags applied to the resource share.
   */
  tags?: Record<string, string>;
}

export interface ResourceShare extends Resource<
  "AWS.RAM.ResourceShare",
  ResourceShareProps,
  {
    /** ARN of the resource share. */
    resourceShareArn: string;
    /** Name of the resource share. */
    name: string;
    /** Account ID that owns the resource share. */
    owningAccountId: string | undefined;
    /** Whether principals outside the organization are allowed. */
    allowExternalPrincipals: boolean | undefined;
    /** Current lifecycle status (`ACTIVE`, `PENDING`, `FAILED`, ...). */
    status: string | undefined;
    /** Tags applied to the resource share. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Resource Access Manager (RAM) resource share.
 *
 * A resource share grants principals (accounts, organizational units, or IAM
 * identities) access to a set of shared resources identified by ARN.
 *
 * @resource
 * @section Creating a Resource Share
 * @example Share subnets with an organizational unit
 * ```typescript
 * const share = yield* ResourceShare("NetworkShare", {
 *   resourceArns: [subnet.subnetArn],
 *   principals: [ou.ouArn],
 *   allowExternalPrincipals: false,
 * });
 * ```
 *
 * @example Share with an external account
 * ```typescript
 * const share = yield* ResourceShare("ExternalShare", {
 *   resourceArns: [resolverRule.arn],
 *   principals: ["123456789012"],
 *   allowExternalPrincipals: true,
 *   tags: { team: "platform" },
 * });
 * ```
 */
export const ResourceShare = Resource<ResourceShare>("AWS.RAM.ResourceShare");

const toName = (id: string, props: { shareName?: string } = {}) =>
  props.shareName
    ? Effect.succeed(props.shareName)
    : createPhysicalName({ id, maxLength: 128 });

/** RAM's inline `{ key, value }` tag list → a plain `Record`. */
const tagsToRecord = (
  tags: readonly ram.Tag[] | undefined,
): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.key !== undefined && tag.value !== undefined) {
      record[tag.key] = tag.value;
    }
  }
  return record;
};

/** A resource share is "live" only while it is not deleting/deleted. */
const isLive = (status: string | undefined): boolean =>
  status !== "DELETING" && status !== "DELETED";

const toAttrs = (share: ram.ResourceShare): ResourceShare["Attributes"] => ({
  resourceShareArn: share.resourceShareArn!,
  name: share.name!,
  owningAccountId: share.owningAccountId,
  allowExternalPrincipals: share.allowExternalPrincipals,
  status: share.status,
  tags: tagsToRecord(share.tags),
});

/** Read a single share by ARN; returns undefined if missing or deleted. */
const readByArn = Effect.fn(function* (arn: string) {
  const shares = yield* ram
    .getResourceShares({ resourceOwner: "SELF", resourceShareArns: [arn] })
    .pipe(
      Effect.map((r) => r.resourceShares ?? []),
      Effect.catchTag("UnknownResourceException", () => Effect.succeed([])),
    );
  const share = shares.find(
    (s) => s.resourceShareArn === arn && isLive(s.status),
  );
  return share ? toAttrs(share) : undefined;
});

/** Find a live share owned by us with the given name. */
const readByName = Effect.fn(function* (name: string) {
  const shares = yield* ram
    .getResourceShares({ resourceOwner: "SELF", name })
    .pipe(
      Effect.map((r) => r.resourceShares ?? []),
      Effect.catchTag("UnknownResourceException", () => Effect.succeed([])),
    );
  const share = shares.find((s) => s.name === name && isLive(s.status));
  return share ? toAttrs(share) : undefined;
});

/**
 * Collect the associated entities of a given type that are currently attached
 * (associating/associated), so we can diff against the desired set.
 */
const readAssociations = Effect.fn(function* (
  arn: string,
  associationType: "PRINCIPAL" | "RESOURCE",
) {
  const associations = yield* ram.getResourceShareAssociations
    .pages({ resourceShareArns: [arn], associationType })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.fromIterable(chunk).flatMap(
          (page) => page.resourceShareAssociations ?? [],
        ),
      ),
      Effect.catchTag("UnknownResourceException", () => Effect.succeed([])),
    );
  return associations
    .filter((a) => a.status === "ASSOCIATED" || a.status === "ASSOCIATING")
    .map((a) => a.associatedEntity)
    .filter((entity): entity is string => entity !== undefined);
});

export const ResourceShareProvider = () =>
  Provider.effect(
    ResourceShare,
    Effect.gen(function* () {
      return {
        stables: ["resourceShareArn", "owningAccountId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // permissionArns are fixed at creation; changing the set replaces.
          const oldPerms = [...(olds?.permissionArns ?? [])].sort();
          const newPerms = [...(news.permissionArns ?? [])].sort();
          if (
            oldPerms.length !== newPerms.length ||
            oldPerms.some((p, i) => p !== newPerms[i])
          ) {
            return { action: "replace" } as const;
          }
        }),
        list: () =>
          ram.getResourceShares.pages({ resourceOwner: "SELF" }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.fromIterable(chunk)
                .flatMap((page) => page.resourceShares ?? [])
                .filter(
                  (s) =>
                    isLive(s.status) &&
                    s.resourceShareArn !== undefined &&
                    s.name !== undefined,
                )
                .map(toAttrs),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const state = output?.resourceShareArn
            ? yield* readByArn(output.resourceShareArn)
            : yield* readByName(yield* toName(id, olds ?? {}));
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const tagList = Object.entries(desiredTags).map(([key, value]) => ({
            key,
            value,
          }));

          const desiredPrincipals = news.principals ?? [];
          const desiredResources = news.resourceArns ?? [];
          const desiredSources = news.sources ?? [];

          // 1. OBSERVE — output ARN is only a cache; re-read live state.
          let state = output?.resourceShareArn
            ? yield* readByArn(output.resourceShareArn)
            : yield* readByName(name);

          // 2. ENSURE — create if missing. On create RAM attaches the initial
          //    resources, principals, sources, permissions, and tags directly.
          if (!state) {
            const created = yield* ram.createResourceShare({
              name,
              resourceArns:
                desiredResources.length > 0 ? desiredResources : undefined,
              principals:
                desiredPrincipals.length > 0 ? desiredPrincipals : undefined,
              sources: desiredSources.length > 0 ? desiredSources : undefined,
              allowExternalPrincipals: news.allowExternalPrincipals,
              permissionArns:
                news.permissionArns && news.permissionArns.length > 0
                  ? news.permissionArns
                  : undefined,
              tags: tagList,
            });
            const share = created.resourceShare;
            if (!share?.resourceShareArn) {
              return yield* Effect.fail(
                new Error(`resource share '${name}' missing ARN after create`),
              );
            }
            yield* session.note(share.resourceShareArn);
            return toAttrs(share);
          }

          const arn = state.resourceShareArn;

          // 3a. SYNC settings — name / allowExternalPrincipals via update.
          if (
            state.name !== name ||
            (news.allowExternalPrincipals !== undefined &&
              state.allowExternalPrincipals !== news.allowExternalPrincipals)
          ) {
            yield* ram.updateResourceShare({
              resourceShareArn: arn,
              name,
              allowExternalPrincipals: news.allowExternalPrincipals,
            });
          }

          // 3b. SYNC associations — diff observed vs desired for principals,
          //     resources, and sources; associate/disassociate the delta.
          const currentPrincipals = yield* readAssociations(arn, "PRINCIPAL");
          const currentResources = yield* readAssociations(arn, "RESOURCE");

          const principalsToAdd = desiredPrincipals.filter(
            (p) => !currentPrincipals.includes(p),
          );
          const principalsToRemove = currentPrincipals.filter(
            (p) => !desiredPrincipals.includes(p),
          );
          const resourcesToAdd = desiredResources.filter(
            (r) => !currentResources.includes(r),
          );
          const resourcesToRemove = currentResources.filter(
            (r) => !desiredResources.includes(r),
          );

          if (principalsToAdd.length > 0 || resourcesToAdd.length > 0) {
            yield* ram.associateResourceShare({
              resourceShareArn: arn,
              principals:
                principalsToAdd.length > 0 ? principalsToAdd : undefined,
              resourceArns:
                resourcesToAdd.length > 0 ? resourcesToAdd : undefined,
            });
          }
          if (principalsToRemove.length > 0 || resourcesToRemove.length > 0) {
            yield* ram.disassociateResourceShare({
              resourceShareArn: arn,
              principals:
                principalsToRemove.length > 0 ? principalsToRemove : undefined,
              resourceArns:
                resourcesToRemove.length > 0 ? resourcesToRemove : undefined,
            });
          }

          // 3c. SYNC tags — diff against observed cloud tags.
          const { upsert, removed } = diffTags(state.tags, desiredTags);
          if (upsert.length > 0) {
            yield* ram.tagResource({
              resourceShareArn: arn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ram.untagResource({
              resourceShareArn: arn,
              tagKeys: removed,
            });
          }

          // 4. RETURN fresh state.
          const updated = yield* readByArn(arn);
          yield* session.note(arn);
          return updated ?? { ...state, name, tags: desiredTags };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* ram
            .deleteResourceShare({
              resourceShareArn: output.resourceShareArn,
            })
            .pipe(
              Effect.catchTag("UnknownResourceException", () => Effect.void),
              // Already transitioning to DELETED from a prior attempt.
              Effect.catchTag(
                "InvalidStateTransitionException",
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
