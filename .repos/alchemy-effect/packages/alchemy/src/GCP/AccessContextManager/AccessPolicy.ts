import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  lastSegment,
  listAccessPolicies,
  MAX_TITLE_LENGTH,
  normalizeScopes,
  ownedByAlchemy,
  parseOwnership,
  projectNumberOf,
  replaceOnIdentity,
  resolveOrganization,
  resourceNameFromOperation,
  sameStringList,
  tryResolveOrganization,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type AccessPolicyProps = {
  /**
   * Organization parent (`organizations/{organization}` or the numeric
   * organization id). If omitted, Alchemy uses `GOOGLE_ORGANIZATION_ID`
   * or the project's Resource Manager parent. Immutable — changing it
   * replaces the policy.
   */
  parent?: string;
  /**
   * Human-readable title. Access policies have no labels or description,
   * so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  title?: string;
  /**
   * Policy scopes. Format: `folders/{folder_number}` or
   * `projects/{project_number}`. At most one scope. Empty or omitted
   * creates the organization-wide default policy (one per organization).
   * Immutable — changing scopes replaces the policy.
   */
  scopes?: string[];
};

export type AccessPolicy = Resource<
  "GCP.AccessContextManager.AccessPolicy",
  AccessPolicyProps,
  {
    /** Resource name `accessPolicies/{policy}`. */
    name: string;
    /** Policy id (last path segment). */
    policyId: string;
    /** Parent `organizations/{organization}`. */
    parent: string;
    /** User title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Policy scopes (`projects/{number}` or `folders/{number}`). */
    scopes: string[];
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Access Context Manager access policy.
 *
 * An access policy is the container for access levels, service
 * perimeters, and authorized-orgs descriptors. One unscoped
 * (organization-wide) policy is allowed per organization; additional
 * policies must set `scopes` to a folder or project.
 *
 * Access policies have no labels. Alchemy stamps ownership into `title`
 * so `list` / `pnpm nuke:gcp` can find them. `parent` and `scopes` are
 * immutable — changing them replaces the policy. `title` updates in
 * place. The policy id is assigned by the API.
 *
 * ### Creating an Access Policy
 * **Example:** Scoped to the current project
 * ```typescript
 * const policy = yield* GCP.AccessContextManager.AccessPolicy("Corp", {
 *   title: "corp access policy",
 *   scopes: ["projects/123456789"],
 * });
 * ```
 *
 * **Example:** Organization-wide default policy
 * ```typescript
 * const policy = yield* GCP.AccessContextManager.AccessPolicy("Default", {
 *   parent: "organizations/123456789",
 *   title: "default policy",
 * });
 * ```
 *
 * ### Updating an Access Policy
 * **Example:** Change the title
 * ```typescript
 * const policy = yield* GCP.AccessContextManager.AccessPolicy("Corp", {
 *   title: "corp access policy (prod)",
 *   scopes: ["projects/123456789"],
 * });
 * ```
 *
 * @resource
 * @category AccessContextManager
 */
export const AccessPolicy = Resource<AccessPolicy>(
  "GCP.AccessContextManager.AccessPolicy",
);

export class AccessPolicyNotResolved extends Data.TaggedError(
  "GCP.AccessContextManager.AccessPolicyNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (policy: acm.AccessPolicy): AccessPolicy["Attributes"] => {
  const name = policy.name ?? "";
  const parsed = parseOwnership(policy.title);
  return {
    name,
    policyId: lastSegment(name),
    parent: policy.parent ?? "",
    title: parsed.text,
    scopes: policy.scopes ?? [],
    etag: policy.etag,
  };
};

const getByName = (name: string) =>
  acm
    .getAccessPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, organization: string) =>
  Effect.gen(function* () {
    const policies = yield* listAccessPolicies(organization);
    for (const policy of policies) {
      if (yield* ownedByAlchemy(id, policy.title)) {
        return policy;
      }
    }
    return undefined;
  });

const observe = (id: string, name: string | undefined, organization: string) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const byName = yield* getByName(name);
      if (byName !== undefined) return byName;
    }
    return yield* findOwned(id, organization);
  });

export const AccessPolicyProvider = () =>
  Provider.succeed(AccessPolicy, {
    stables: ["name", "policyId", "parent"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = news.parent ?? previousParent;
      const parentChanged =
        previousParent !== undefined &&
        nextParent !== undefined &&
        lastSegment(previousParent) !== lastSegment(nextParent);

      const previousScopes = olds?.scopes ?? output?.scopes;
      const scopesChanged =
        news.scopes !== undefined &&
        previousScopes !== undefined &&
        !sameStringList(news.scopes, previousScopes);

      return replaceOnIdentity(parentChanged || scopesChanged);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const organization = yield* resolveOrganization(
        olds?.parent,
        output?.parent,
      );
      const existing = yield* observe(id, output?.name, organization);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        const policies = yield* listAccessPolicies(organization);
        return policies
          .filter((policy) => parseOwnership(policy.title).labels["alchemy-id"])
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.parent,
        output?.parent,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredTitle = encodeOwnershipLine(
        ownership,
        news.title,
        MAX_TITLE_LENGTH,
      );
      const projectNumber = yield* projectNumberOf(env.project);
      const desiredScopes =
        news.scopes !== undefined
          ? normalizeScopes(news.scopes, projectNumber)
          : (output?.scopes ?? []);

      let current = yield* observe(id, output?.name, organization);

      if (current === undefined) {
        const created = yield* acm
          .createAccessPolicies({
            body: {
              title: desiredTitle,
              parent: organization,
              scopes: desiredScopes.length > 0 ? desiredScopes : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          const settled = yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.succeed(created) : Effect.fail(error),
            ),
          );
          const createdName =
            resourceNameFromOperation(settled, "accessPolicies/") ??
            resourceNameFromOperation(created, "accessPolicies/");
          current =
            createdName !== undefined
              ? yield* waitUntilExists(getByName(createdName), createdName)
              : yield* waitUntilExists(
                  findOwned(id, organization),
                  organization,
                );
        } else {
          current = yield* waitUntilExists(
            findOwned(id, organization),
            organization,
          );
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new AccessPolicyNotResolved({
          name: output?.name ?? organization,
        });
      }

      if ((current.title ?? "") !== desiredTitle) {
        const operation = yield* acm.patchAccessPolicies({
          name: current.name,
          updateMask: "title",
          body: {
            name: current.name,
            title: desiredTitle,
            etag: current.etag,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getByName(current.name), current.name);
      }

      if (current === undefined) {
        return yield* new AccessPolicyNotResolved({
          name: output?.name ?? organization,
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* acm
        .deleteAccessPolicies({ name: output.name })
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
