import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationApiKeyProps {
  /** Organization that owns the key. Changes replace the key. */
  orgId: string;
  /** Restrict access to this project. Omission grants organization-wide access. Changes replace the key. */
  projectId?: string;
  /** Immutable key label. Defaults to an instance-qualified physical name. Adding, changing, or removing an explicit label replaces the key. */
  name?: string;
}

export interface OrganizationApiKeyAttributes {
  /** Organization that owns the key. */
  orgId: string;
  /** Project restriction, or undefined for organization-wide access. */
  projectId: string | undefined;
  /** Stable numeric API key identifier, not the secret token. */
  keyId: number;
  /** Observed key label. A matching label is never ownership evidence. */
  name: string;
  /** Reveal-once secret stored in Alchemy state. Never the deployment API key. */
  key: Redacted.Redacted<string>;
  /** Issuance timestamp. */
  createdAt: string;
}

export interface OrganizationApiKey extends Resource<
  "Neon.OrganizationApiKey",
  OrganizationApiKeyProps,
  OrganizationApiKeyAttributes,
  never,
  Providers
> {}

/**
 * A reveal-once Neon management API key owned by an organization, optionally
 * restricted to one project. This is not a branch service credential; use
 * `Neon.Credential` for branch-scoped storage and backend permissions.
 *
 * Keep Alchemy state secure and backed up. Neon cannot reveal an existing key.
 * Missing secrets, revoked keys, and same-name foreign keys fail with
 * `OrganizationApiKeyRecoveryError` instead of being adopted or silently rotated.
 * Restore the original state or explicitly revoke the recorded key and replace
 * the resource. Changing the organization, project restriction, or name replaces
 * the key. Explicit names may require deleting the recorded old key first.
 *
 * ### Project-restricted access
 * **Example:** Provision a key for a test-owned project
 * ```typescript
 * const project = yield* Neon.Project("Application", { orgId: "org-example" });
 * const key = yield* Neon.OrganizationApiKey("Automation", {
 *   orgId: "org-example",
 *   projectId: project.projectId,
 * });
 * ```
 *
 * ### Organization-wide access
 * **Example:** Explicitly choose organization-wide administration
 * ```typescript
 * const key = yield* Neon.OrganizationApiKey("OrganizationAdministration", {
 *   orgId: "org-example",
 * });
 * ```
 * Omitting `projectId` grants broad organization access; prefer a project
 * restriction whenever possible. The secret output is `key.key`, a Redacted value.
 *
 * @resource
 * @product Organization
 */
export const OrganizationApiKey = Resource<OrganizationApiKey>(
  "Neon.OrganizationApiKey",
);

export class OrganizationApiKeyRecoveryError extends Data.TaggedError(
  "OrganizationApiKeyRecoveryError",
)<{
  message: string;
}> {}

type KeyScope = Pick<OrganizationApiKeyProps, "orgId" | "projectId">;
type KeyMetadata = Pick<
  Neon.OrgApiKeysListResponseItem,
  "id" | "name" | "project_id" | "created_at"
>;

const recoveryError = () =>
  new OrganizationApiKeyRecoveryError({
    message:
      "Organization API key identity or reveal-once secret cannot be recovered. Restore the original Alchemy state, or explicitly revoke the recorded key and replace the resource; names do not authorize adoption or recreation.",
  });

const sameScope = (a: KeyScope, b: KeyScope) =>
  a.orgId === b.orgId && a.projectId === b.projectId;

const validScope = (scope: KeyScope) =>
  typeof scope.orgId === "string" &&
  scope.orgId.trim().length > 0 &&
  (scope.projectId === undefined ||
    (typeof scope.projectId === "string" && scope.projectId.trim().length > 0));

const validateScope = (scope: KeyScope) =>
  validScope(scope) ? Effect.void : Effect.fail(recoveryError());

/** Preserve a cached secret only when the observed ID and complete scope match. */
export const recoverOrganizationApiKey = (
  scope: KeyScope,
  observed: KeyMetadata | undefined,
  cached: OrganizationApiKeyAttributes | undefined,
): Effect.Effect<
  OrganizationApiKeyAttributes,
  OrganizationApiKeyRecoveryError
> => {
  if (
    !validScope(scope) ||
    !observed ||
    !cached ||
    !Number.isSafeInteger(observed.id) ||
    observed.id <= 0 ||
    cached.keyId !== observed.id ||
    !sameScope(scope, cached) ||
    observed.project_id !== scope.projectId ||
    !Redacted.isRedacted(cached.key) ||
    typeof Redacted.value(cached.key) !== "string" ||
    Redacted.value(cached.key).length === 0
  ) {
    return Effect.fail(recoveryError());
  }
  return Effect.succeed({
    ...scope,
    projectId: observed.project_id,
    keyId: observed.id,
    name: observed.name,
    key: cached.key,
    createdAt: observed.created_at,
  });
};

const observeKey = Effect.fn(function* (
  scope: KeyScope,
  name: string,
  cached?: OrganizationApiKeyAttributes,
) {
  yield* validateScope(scope);
  // This endpoint returns one complete array, with no pagination or cursor.
  const keys = yield* Neon.listOrgApiKeys({ org_id: scope.orgId }).pipe(
    Neon.Retry.none,
  );
  const matches = keys.filter((key) =>
    cached ? key.id === cached.keyId : key.name === name,
  );
  if (matches.length > 1) return yield* recoveryError();
  return matches[0];
});

export const OrganizationApiKeyProvider = () =>
  Provider.succeed(OrganizationApiKey, {
    stables: ["orgId", "projectId", "keyId", "name", "key", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return { action: "replace" };
      if (news.name !== olds.name || (output && !sameScope(news, output))) {
        return {
          action: "replace",
          deleteFirst:
            output !== undefined &&
            news.orgId === output.orgId &&
            news.name === output.name,
        };
      }
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (!output && !olds) return undefined;
      const scope = output ?? olds!;
      const name =
        output?.name ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 100 }));
      const observed = yield* observeKey(scope, name, output);
      if (!observed && !output) return undefined;
      return yield* recoverOrganizationApiKey(scope, observed, output);
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      yield* validateScope(news);
      if (
        (output &&
          (!sameScope(news, output) ||
            (news.name !== undefined && news.name !== output.name))) ||
        (olds && news.name !== olds.name) ||
        (!output && olds)
      ) {
        return yield* recoveryError();
      }
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 100 }));
      if (!name.trim()) return yield* recoveryError();
      const observed = yield* observeKey(news, name, output);
      if (observed || output) {
        const recovered = yield* recoverOrganizationApiKey(
          news,
          observed,
          output,
        );
        if (recovered.name !== name) return yield* recoveryError();
        return recovered;
      }
      // A retried reveal-once POST could issue an untracked second key.
      const created = yield* Neon.createOrgApiKey({
        org_id: news.orgId,
        project_id: news.projectId,
        key_name: name,
      }).pipe(
        Neon.Retry.none,
        Effect.catchTag("Conflict", () => Effect.fail(recoveryError())),
      );
      return yield* recoverOrganizationApiKey(news, created, {
        orgId: news.orgId,
        projectId: news.projectId,
        keyId: created.id,
        name: created.name,
        key: Redacted.isRedacted(created.key)
          ? created.key
          : Redacted.make(created.key),
        createdAt: created.created_at,
      });
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* observeKey(output, output.name, output).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (!observed) return;
      if (observed.project_id !== output.projectId)
        return yield* recoveryError();
      yield* Neon.revokeOrgApiKey({
        org_id: output.orgId,
        key_id: output.keyId,
      }).pipe(
        Neon.Retry.none,
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
