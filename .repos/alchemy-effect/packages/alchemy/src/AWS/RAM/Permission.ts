import * as ram from "@distilled.cloud/aws/ram";
import * as Array from "effect/Array";
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

/**
 * The policy template of a customer managed permission — the actions a
 * resource share grants to principals for the permission's resource type.
 * RAM policy templates only support `Effect: "Allow"` with `Action` and an
 * optional `Condition`; the `Principal` and `Resource` are supplied by the
 * resource share at association time.
 */
export interface PermissionPolicyTemplate {
  /**
   * Actions granted to principals the resource share is shared with. Must be
   * a subset of the actions RAM supports for the permission's `resourceType`
   * (for example `appsync:SourceGraphQL` for `appsync:Apis`).
   */
  actions: string[];

  /**
   * Optional IAM condition block constraining when the actions are granted.
   */
  condition?: Record<string, unknown>;
}

export interface PermissionProps {
  /**
   * Name of the customer managed permission. Must be unique within your
   * account and Region. If omitted, Alchemy generates a deterministic name
   * from the stack, stage, and logical ID. Max 36 characters.
   * Changing the name replaces the permission.
   */
  permissionName?: string;

  /**
   * The resource type this permission applies to, in `service:Type` format —
   * for example `appsync:Apis`. Only some resource types support customer
   * managed permissions (others, like `ec2:Subnet`, only allow the AWS
   * managed default permission).
   * Changing the resource type replaces the permission.
   */
  resourceType: string;

  /**
   * The policy template granted by resource shares using this permission.
   * Changing the template creates a new permission version and promotes it
   * to the default; the previous default version is deleted when it is no
   * longer attached to any resource share.
   */
  policyTemplate: PermissionPolicyTemplate;

  /**
   * Tags applied to the permission.
   */
  tags?: Record<string, string>;
}

export interface Permission extends Resource<
  "AWS.RAM.Permission",
  PermissionProps,
  {
    /** ARN of the customer managed permission. */
    permissionArn: string;
    /** Name of the permission. */
    name: string;
    /** The resource type the permission applies to. */
    resourceType: string;
    /** The default version number of the permission. */
    version: string | undefined;
    /** Current status (`ATTACHABLE`, `UNATTACHABLE`, `DELETING`, ...). */
    status: string | undefined;
    /** Tags applied to the permission. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Resource Access Manager (RAM) customer managed permission.
 *
 * A customer managed permission precisely controls which actions principals
 * receive on resources of a given type when you attach the permission to a
 * {@link ResourceShare} via `permissionArns`.
 *
 * @resource
 * @section Creating a Permission
 * @example Least-privilege AppSync API sharing
 * ```typescript
 * const permission = yield* Permission("SourceGraphQLOnly", {
 *   resourceType: "appsync:Apis",
 *   policyTemplate: {
 *     actions: ["appsync:SourceGraphQL"],
 *   },
 * });
 * ```
 *
 * @example Attach a permission to a resource share
 * ```typescript
 * const share = yield* ResourceShare("ApiShare", {
 *   resourceArns: [api.apiArn],
 *   principals: ["123456789012"],
 *   permissionArns: [permission.permissionArn],
 * });
 * ```
 *
 * @section Updating the Policy
 * @example Add an action (creates a new default version)
 * ```typescript
 * const permission = yield* Permission("SourceGraphQLOnly", {
 *   resourceType: "appsync:Apis",
 *   policyTemplate: {
 *     actions: ["appsync:SourceGraphQL", "appsync:GraphQL"],
 *   },
 * });
 * ```
 */
export const Permission = Resource<Permission>("AWS.RAM.Permission");

const toName = (id: string, props: { permissionName?: string } = {}) =>
  props.permissionName
    ? Effect.succeed(props.permissionName)
    : createPhysicalName({ id, maxLength: 36 });

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

/** A permission is "live" only while it is not deleting/deleted. */
const isLive = (status: string | undefined): boolean =>
  status !== "DELETING" && status !== "DELETED";

/** Serialize the declared policy template to RAM's JSON wire format. */
const renderPolicyTemplate = (template: PermissionPolicyTemplate): string =>
  JSON.stringify({
    Effect: "Allow",
    Action: [...template.actions].sort(),
    ...(template.condition ? { Condition: template.condition } : {}),
  });

/** Parse an observed policy document into a comparable canonical string. */
const canonicalizePolicy = (policy: string | undefined): string => {
  if (policy === undefined) return "";
  try {
    const parsed = JSON.parse(policy) as {
      Effect?: string;
      Action?: string | string[];
      Condition?: Record<string, unknown>;
    };
    const actions =
      typeof parsed.Action === "string"
        ? [parsed.Action]
        : (parsed.Action ?? []);
    return JSON.stringify({
      Effect: parsed.Effect ?? "Allow",
      Action: [...actions].sort(),
      ...(parsed.Condition ? { Condition: parsed.Condition } : {}),
    });
  } catch {
    return policy;
  }
};

const toAttrs = (
  permission:
    | ram.ResourceSharePermissionSummary
    | ram.ResourceSharePermissionDetail,
): Permission["Attributes"] => ({
  permissionArn: permission.arn!,
  name: permission.name!,
  resourceType: permission.resourceType!,
  version: permission.version,
  status: permission.status,
  tags: tagsToRecord(permission.tags),
});

/** Read the default version of a permission by ARN; undefined if missing. */
const readDetail = Effect.fn(function* (arn: string) {
  const detail = yield* ram.getPermission({ permissionArn: arn }).pipe(
    Effect.map((r) => r.permission),
    Effect.catchTag("UnknownResourceException", () =>
      Effect.succeed(undefined),
    ),
  );
  return detail && isLive(detail.status) ? detail : undefined;
});

/** Find a live customer managed permission owned by us with the given name. */
const readByName = Effect.fn(function* (name: string) {
  const permissions = yield* ram.listPermissions
    .pages({ permissionType: "CUSTOMER_MANAGED" })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.fromIterable(chunk).flatMap((page) => page.permissions ?? []),
      ),
    );
  const summary = permissions.find((p) => p.name === name && isLive(p.status));
  return summary?.arn ? yield* readDetail(summary.arn) : undefined;
});

export const PermissionProvider = () =>
  Provider.effect(
    Permission,
    Effect.gen(function* () {
      return {
        stables: ["permissionArn"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          // Name and resource type are fixed at creation (RAM has no
          // rename/retype API for permissions).
          if (olds !== undefined) {
            if (news.permissionName !== olds.permissionName) {
              return { action: "replace" } as const;
            }
            if (news.resourceType !== olds.resourceType) {
              return { action: "replace" } as const;
            }
          }
        }),
        list: () =>
          ram.listPermissions
            .pages({ permissionType: "CUSTOMER_MANAGED" })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.fromIterable(chunk)
                  .flatMap((page) => page.permissions ?? [])
                  .filter(
                    (p) =>
                      isLive(p.status) &&
                      p.arn !== undefined &&
                      p.name !== undefined,
                  )
                  .map(toAttrs),
              ),
            ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const detail = output?.permissionArn
            ? yield* readDetail(output.permissionArn)
            : yield* readByName(yield* toName(id, olds ?? {}));
          if (!detail) return undefined;
          const state = toAttrs(detail);
          return (yield* hasAlchemyTags(id, state.tags))
            ? state
            : Unowned(state);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };
          const desiredPolicy = renderPolicyTemplate(news.policyTemplate);

          // 1. OBSERVE — output ARN is only a cache; re-read live state.
          let detail = output?.permissionArn
            ? yield* readDetail(output.permissionArn)
            : yield* readByName(name);

          // 2. ENSURE — create if missing. PermissionAlreadyExists is a
          //    race with a concurrent create; fall through to observation.
          if (!detail) {
            const created = yield* ram
              .createPermission({
                name,
                resourceType: news.resourceType,
                policyTemplate: desiredPolicy,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
              .pipe(
                Effect.map((r) => r.permission),
                Effect.catchTag("PermissionAlreadyExistsException", () =>
                  Effect.succeed(undefined),
                ),
              );
            // Prefer the ARN from the create response; on the AlreadyExists
            // race fall back to the (briefly eventually consistent) list.
            detail = created?.arn
              ? yield* readDetail(created.arn)
              : yield* readByName(name);
            if (!detail?.arn) {
              if (created?.arn) {
                yield* session.note(created.arn);
                return { ...toAttrs(created), tags: desiredTags };
              }
              return yield* Effect.fail(
                new Error(`permission '${name}' not found after create`),
              );
            }
            yield* session.note(detail.arn);
            return toAttrs(detail);
          }

          const arn = detail.arn!;
          const previousVersion = detail.version;

          // 3a. SYNC policy — diff the observed default version's policy
          //     against the desired template; publish a new default version
          //     on drift, then drop the superseded version (RAM caps a
          //     permission at 5 versions).
          if (canonicalizePolicy(detail.permission) !== desiredPolicy) {
            // createPermissionVersion automatically becomes the default.
            yield* ram.createPermissionVersion({
              permissionArn: arn,
              policyTemplate: desiredPolicy,
            });
            if (previousVersion !== undefined) {
              // The old version may still be attached to an existing share;
              // that's fine — leave it and converge on a later reconcile.
              yield* ram
                .deletePermissionVersion({
                  permissionArn: arn,
                  permissionVersion: Number(previousVersion),
                })
                .pipe(
                  Effect.catchTag(
                    [
                      "OperationNotPermittedException",
                      "InvalidParameterException",
                    ],
                    () => Effect.void,
                  ),
                );
            }
          }

          // 3b. SYNC tags — diff against observed cloud tags.
          const { upsert, removed } = diffTags(
            tagsToRecord(detail.tags),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* ram.tagResource({
              resourceArn: arn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* ram.untagResource({ resourceArn: arn, tagKeys: removed });
          }

          // 4. RETURN fresh state.
          const updated = yield* readDetail(arn);
          yield* session.note(arn);
          return updated
            ? toAttrs(updated)
            : { ...toAttrs(detail), tags: desiredTags };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A permission cannot be deleted while attached to a resource
          // share; shares delete asynchronously, so retry briefly on
          // OperationNotPermitted before giving up.
          yield* ram
            .deletePermission({ permissionArn: output.permissionArn })
            .pipe(
              Effect.retry({
                while: (e): boolean =>
                  e._tag === "OperationNotPermittedException",
                schedule: Schedule.exponential("2 seconds"),
                times: 8,
              }),
              Effect.catchTag("UnknownResourceException", () => Effect.void),
            );
        }),
      };
    }),
  );
