import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  hasOwnershipMarker,
  listOwnedPolicies,
  parseName,
  policyNameOf,
  replaceOnIdentity,
  resourceNameOf,
  sameStringList,
  toAcmId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type AuthorizedOrgsDescDirection =
  acm.AuthorizedOrgsDescAuthorizationDirectionEnum;
export type AuthorizedOrgsDescAssetType = acm.AuthorizedOrgsDescAssetTypeEnum;
export type AuthorizedOrgsDescAuthorizationType =
  acm.AuthorizedOrgsDescAuthorizationTypeEnum;

export type AccessPoliciesAuthorizedOrgsDescProps = {
  /**
   * Parent access policy (`accessPolicies/{policy}` or the policy id).
   * Immutable — changing it replaces the descriptor.
   */
  policy: string;
  /**
   * Authorized-orgs descriptor id (the `{authorized_orgs_desc}`
   * segment). If omitted, a unique name is generated from the stack,
   * stage, and logical id. Must begin with a letter, then alphanumeric
   * or `_`. Immutable — changing it replaces the descriptor.
   */
  authorizedOrgsDescId?: string;
  /**
   * Direction of the authorization relationship.
   * `AUTHORIZATION_DIRECTION_FROM` lets this organization evaluate
   * traffic in `orgs`. `AUTHORIZATION_DIRECTION_TO` lets `orgs` evaluate
   * traffic in this organization. Immutable — changing it replaces the
   * descriptor.
   */
  authorizationDirection: AuthorizedOrgsDescDirection | (string & {});
  /**
   * Asset type. Immutable — changing it replaces the descriptor.
   */
  assetType: AuthorizedOrgsDescAssetType | (string & {});
  /**
   * Authorization type. Currently only `AUTHORIZATION_TYPE_TRUST`.
   * Immutable — changing it replaces the descriptor.
   */
  authorizationType: AuthorizedOrgsDescAuthorizationType | (string & {});
  /**
   * Organization ids in this descriptor. Format: `organizations/{id}`.
   * This is the only mutable field.
   */
  orgs?: string[];
};

export type AccessPoliciesAuthorizedOrgsDesc = Resource<
  "GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDesc",
  AccessPoliciesAuthorizedOrgsDescProps,
  {
    /** Resource name `accessPolicies/{policy}/authorizedOrgsDescs/{id}`. */
    name: string;
    /** Descriptor id (last path segment). */
    authorizedOrgsDescId: string;
    /** Parent policy name `accessPolicies/{policy}`. */
    policy: string;
    /** Authorization direction. */
    authorizationDirection: string | undefined;
    /** Asset type. */
    assetType: string | undefined;
    /** Authorization type. */
    authorizationType: string | undefined;
    /** Organization ids (`organizations/{id}`). */
    orgs: string[];
  },
  never,
  Providers
>;

/**
 * An Access Context Manager authorized-orgs descriptor.
 *
 * Authorized-orgs descriptors configure cross-organization authorization
 * for device or credential-strength evaluation. They live under an
 * {@link AccessPolicy}. The API has no labels or description field —
 * Alchemy uses the generated resource id as identity, and `list` returns
 * descriptors under Alchemy-owned access policies so `pnpm nuke:gcp`
 * can find them.
 *
 * `policy`, `authorizedOrgsDescId`, `authorizationDirection`,
 * `assetType`, and `authorizationType` are immutable. `orgs` updates in
 * place.
 *
 * ### Creating an Authorized Orgs Descriptor
 * **Example:** Trust devices from a partner org
 * ```typescript
 * const policy = yield* GCP.AccessContextManager.AccessPolicy("Corp", {
 *   scopes: ["projects/123456789"],
 * });
 * const desc = yield* GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDesc(
 *   "Partner",
 *   {
 *     policy: policy.name,
 *     authorizationDirection: "AUTHORIZATION_DIRECTION_FROM",
 *     assetType: "ASSET_TYPE_DEVICE",
 *     authorizationType: "AUTHORIZATION_TYPE_TRUST",
 *     orgs: ["organizations/987654321"],
 *   },
 * );
 * ```
 *
 * ### Updating an Authorized Orgs Descriptor
 * **Example:** Change the trusted org list
 * ```typescript
 * const desc = yield* GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDesc(
 *   "Partner",
 *   {
 *     policy: policy.name,
 *     authorizationDirection: "AUTHORIZATION_DIRECTION_FROM",
 *     assetType: "ASSET_TYPE_DEVICE",
 *     authorizationType: "AUTHORIZATION_TYPE_TRUST",
 *     orgs: ["organizations/111", "organizations/222"],
 *   },
 * );
 * ```
 *
 * @resource
 * @category AccessContextManager
 */
export const AccessPoliciesAuthorizedOrgsDesc =
  Resource<AccessPoliciesAuthorizedOrgsDesc>(
    "GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDesc",
  );

export class AccessPoliciesAuthorizedOrgsDescNotResolved extends Data.TaggedError(
  "GCP.AccessContextManager.AccessPoliciesAuthorizedOrgsDescNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  desc: acm.AuthorizedOrgsDesc,
): AccessPoliciesAuthorizedOrgsDesc["Attributes"] => {
  const name = desc.name ?? "";
  const parsed = parseName(name, "authorizedOrgsDescs");
  return {
    name,
    authorizedOrgsDescId: parsed.id,
    policy: parsed.parent,
    authorizationDirection: desc.authorizationDirection,
    assetType: desc.assetType,
    authorizationType: desc.authorizationType,
    orgs: desc.orgs ?? [],
  };
};

const getByName = (name: string) =>
  acm
    .getAccessPoliciesAuthorizedOrgsDescs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listDescs = (policy: string) =>
  collectPages(
    acm.listAccessPoliciesAuthorizedOrgsDescs.pages({
      parent: policyNameOf(policy),
      pageSize: 100,
    }),
    (page) => page.authorizedOrgsDescs,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as acm.AuthorizedOrgsDesc[]),
    ),
  );

export const AccessPoliciesAuthorizedOrgsDescProvider = () =>
  Provider.succeed(AccessPoliciesAuthorizedOrgsDesc, {
    stables: [
      "name",
      "authorizedOrgsDescId",
      "policy",
      "authorizationDirection",
      "assetType",
      "authorizationType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.authorizedOrgsDescId ?? output?.authorizedOrgsDescId;
      const idChanged =
        previousId !== undefined &&
        news.authorizedOrgsDescId !== undefined &&
        news.authorizedOrgsDescId !== previousId;
      const previousPolicy = olds?.policy ?? output?.policy;
      const policyChanged =
        previousPolicy !== undefined &&
        policyNameOf(news.policy) !== policyNameOf(previousPolicy);
      const directionChanged =
        (olds?.authorizationDirection ?? output?.authorizationDirection) !==
          undefined &&
        news.authorizationDirection !==
          (olds?.authorizationDirection ?? output?.authorizationDirection);
      const assetChanged =
        (olds?.assetType ?? output?.assetType) !== undefined &&
        news.assetType !== (olds?.assetType ?? output?.assetType);
      const typeChanged =
        (olds?.authorizationType ?? output?.authorizationType) !== undefined &&
        news.authorizationType !==
          (olds?.authorizationType ?? output?.authorizationType);
      return replaceOnIdentity(
        idChanged ||
          policyChanged ||
          directionChanged ||
          assetChanged ||
          typeChanged,
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const authorizedOrgsDescId = yield* toAcmId(
        id,
        olds?.authorizedOrgsDescId,
        output?.authorizedOrgsDescId,
      );
      const policy = olds?.policy ?? output?.policy;
      if (policy === undefined) return undefined;
      const name =
        output?.name ??
        resourceNameOf(policy, "authorizedOrgsDescs", authorizedOrgsDescId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing);
    }),

    list: () =>
      Effect.gen(function* () {
        const policies = yield* listOwnedPolicies();
        const descs = yield* Effect.forEach(
          policies,
          (policy) =>
            policy.name && hasOwnershipMarker(policy.title)
              ? listDescs(policy.name)
              : Effect.succeed([] as acm.AuthorizedOrgsDesc[]),
          { concurrency: 4 },
        );
        return descs.flat().map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const policy = policyNameOf(news.policy);
      const authorizedOrgsDescId = yield* toAcmId(
        id,
        news.authorizedOrgsDescId,
        output?.authorizedOrgsDescId,
      );
      const name = resourceNameOf(
        policy,
        "authorizedOrgsDescs",
        authorizedOrgsDescId,
      );
      const desiredOrgs = news.orgs ?? [];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* acm
          .createAccessPoliciesAuthorizedOrgsDescs({
            parent: policy,
            body: {
              name,
              authorizationDirection: news.authorizationDirection,
              assetType: news.assetType,
              authorizationType: news.authorizationType,
              orgs: desiredOrgs.length > 0 ? desiredOrgs : undefined,
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
        return yield* new AccessPoliciesAuthorizedOrgsDescNotResolved({
          name,
        });
      }

      if (!sameStringList(current.orgs, desiredOrgs)) {
        const operation = yield* acm.patchAccessPoliciesAuthorizedOrgsDescs({
          name: current.name ?? name,
          updateMask: "orgs",
          body: {
            name: current.name ?? name,
            orgs: desiredOrgs,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      if (current === undefined) {
        return yield* new AccessPoliciesAuthorizedOrgsDescNotResolved({
          name,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* acm
        .deleteAccessPoliciesAuthorizedOrgsDescs({ name: output.name })
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
