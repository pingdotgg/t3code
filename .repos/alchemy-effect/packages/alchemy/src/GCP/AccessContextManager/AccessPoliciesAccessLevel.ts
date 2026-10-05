import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  encodeOwnershipLine,
  jsonEqual,
  listOwnedPolicies,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  policyNameOf,
  replaceOnIdentity,
  resourceNameOf,
  toAcmId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type AccessLevelOsConstraint = acm.OsConstraint;
export type AccessLevelDevicePolicy = acm.DevicePolicy;
export type AccessLevelVpcNetworkSource = acm.VpcNetworkSource;
export type AccessLevelCondition = acm.Condition;
export type AccessLevelBasic = acm.BasicLevel;
export type AccessLevelCustom = acm.CustomLevel;

export type AccessPoliciesAccessLevelProps = {
  /**
   * Parent access policy (`accessPolicies/{policy}` or the policy id).
   * Immutable — changing it replaces the access level.
   */
  policy: string;
  /**
   * Access level id (the `{access_level}` segment). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Must begin
   * with a letter, then alphanumeric or `_`, max 50 characters.
   * Immutable — changing it replaces the access level.
   */
  accessLevelId?: string;
  /**
   * Human-readable title. Must be unique within the policy.
   */
  title?: string;
  /**
   * Description of the access level. Access levels have no labels, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
  /**
   * Basic level composed of conditions. Mutually exclusive with
   * `custom`.
   */
  basic?: AccessLevelBasic;
  /**
   * Custom CEL level. Mutually exclusive with `basic`.
   */
  custom?: AccessLevelCustom;
};

export type AccessPoliciesAccessLevel = Resource<
  "GCP.AccessContextManager.AccessPoliciesAccessLevel",
  AccessPoliciesAccessLevelProps,
  {
    /** Resource name `accessPolicies/{policy}/accessLevels/{accessLevel}`. */
    name: string;
    /** Access level id (last path segment). */
    accessLevelId: string;
    /** Parent policy name `accessPolicies/{policy}`. */
    policy: string;
    /** User title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Basic level, if set. */
    basic: AccessLevelBasic | undefined;
    /** Custom CEL level, if set. */
    custom: AccessLevelCustom | undefined;
  },
  never,
  Providers
>;

/**
 * An Access Context Manager access level.
 *
 * Access levels label requests to Google Cloud services with a set of
 * requirements (IP ranges, device policy, members, regions, or a custom
 * CEL expression). They live under an {@link AccessPolicy}.
 *
 * Access levels have no labels. Alchemy stamps ownership into
 * `description` so `list` / `pnpm nuke:gcp` can find them. `policy` and
 * `accessLevelId` are immutable — changing them replaces the level.
 * Title, description, `basic`, and `custom` update in place.
 *
 * ### Creating an Access Level
 * **Example:** Basic level that allows the US
 * ```typescript
 * const policy = yield* GCP.AccessContextManager.AccessPolicy("Corp", {
 *   scopes: ["projects/123456789"],
 * });
 * const level = yield* GCP.AccessContextManager.AccessPoliciesAccessLevel(
 *   "CorpUsers",
 *   {
 *     policy: policy.name,
 *     title: "corp users",
 *     basic: { conditions: [{ regions: ["US"] }] },
 *   },
 * );
 * ```
 *
 * **Example:** Custom CEL level
 * ```typescript
 * const level = yield* GCP.AccessContextManager.AccessPoliciesAccessLevel(
 *   "Employees",
 *   {
 *     policy: policy.name,
 *     title: "employees",
 *     custom: {
 *       expr: { expression: "request.time.getHours() >= 9" },
 *     },
 *   },
 * );
 * ```
 *
 * ### Updating an Access Level
 * **Example:** Add an IP condition
 * ```typescript
 * const level = yield* GCP.AccessContextManager.AccessPoliciesAccessLevel(
 *   "CorpUsers",
 *   {
 *     policy: policy.name,
 *     title: "corp users",
 *     basic: {
 *       conditions: [{ ipSubnetworks: ["203.0.113.0/24"] }],
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category AccessContextManager
 */
export const AccessPoliciesAccessLevel = Resource<AccessPoliciesAccessLevel>(
  "GCP.AccessContextManager.AccessPoliciesAccessLevel",
);

export class AccessPoliciesAccessLevelNotResolved extends Data.TaggedError(
  "GCP.AccessContextManager.AccessPoliciesAccessLevelNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  level: acm.AccessLevel,
): AccessPoliciesAccessLevel["Attributes"] => {
  const name = level.name ?? "";
  const parsed = parseName(name, "accessLevels");
  const title = parseOwnership(level.title);
  const description = parseOwnership(level.description);
  return {
    name,
    accessLevelId: parsed.id,
    policy: parsed.parent,
    title: title.text,
    description: description.text,
    basic: level.basic,
    custom: level.custom,
  };
};

const getByName = (name: string) =>
  acm
    .getAccessPoliciesAccessLevels({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listLevels = (policy: string) =>
  collectPages(
    acm.listAccessPoliciesAccessLevels.pages({
      parent: policyNameOf(policy),
      pageSize: 100,
    }),
    (page) => page.accessLevels,
  ).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([] as acm.AccessLevel[])),
  );

export const AccessPoliciesAccessLevelProvider = () =>
  Provider.succeed(AccessPoliciesAccessLevel, {
    stables: ["name", "accessLevelId", "policy"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.accessLevelId ?? output?.accessLevelId;
      const idChanged =
        previousId !== undefined &&
        news.accessLevelId !== undefined &&
        news.accessLevelId !== previousId;
      const previousPolicy = olds?.policy ?? output?.policy;
      const policyChanged =
        previousPolicy !== undefined &&
        policyNameOf(news.policy) !== policyNameOf(previousPolicy);
      return replaceOnIdentity(idChanged || policyChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const accessLevelId = yield* toAcmId(
        id,
        olds?.accessLevelId,
        output?.accessLevelId,
      );
      const policy = olds?.policy ?? output?.policy;
      if (policy === undefined) return undefined;
      const name =
        output?.name ?? resourceNameOf(policy, "accessLevels", accessLevelId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.description ?? existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const policies = yield* listOwnedPolicies();
        const levels = yield* Effect.forEach(
          policies,
          (policy) =>
            policy.name
              ? listLevels(policy.name)
              : Effect.succeed([] as acm.AccessLevel[]),
          { concurrency: 4 },
        );
        return levels
          .flat()
          .filter(
            (level) =>
              parseOwnership(level.description ?? level.title).labels[
                "alchemy-id"
              ],
          )
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const policy = policyNameOf(news.policy);
      const accessLevelId = yield* toAcmId(
        id,
        news.accessLevelId,
        output?.accessLevelId,
      );
      const name = resourceNameOf(policy, "accessLevels", accessLevelId);
      const ownership = yield* createInternalLabels(id);
      const desiredTitle = encodeOwnershipLine(
        ownership,
        news.title ?? accessLevelId,
        MAX_TITLE_LENGTH,
      );
      const desiredDescription = encodeOwnership(
        ownership,
        news.description,
        MAX_DESCRIPTION_LENGTH,
      );

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* acm
          .createAccessPoliciesAccessLevels({
            parent: policy,
            body: {
              name,
              title: desiredTitle,
              description: desiredDescription,
              basic: news.basic,
              custom: news.custom,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new AccessPoliciesAccessLevelNotResolved({ name });
      }

      const titleChanged = (current.title ?? "") !== desiredTitle;
      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const basicChanged = !jsonEqual(current.basic, news.basic);
      const customChanged = !jsonEqual(current.custom, news.custom);

      const updateMask = [
        titleChanged ? "title" : undefined,
        descriptionChanged ? "description" : undefined,
        news.basic !== undefined && basicChanged ? "basic" : undefined,
        news.custom !== undefined && customChanged ? "custom" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        const operation = yield* acm.patchAccessPoliciesAccessLevels({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            name: current.name ?? name,
            title: desiredTitle,
            description: desiredDescription,
            basic: news.basic,
            custom: news.custom,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      if (current === undefined) {
        return yield* new AccessPoliciesAccessLevelNotResolved({ name });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* acm
        .deleteAccessPoliciesAccessLevels({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
