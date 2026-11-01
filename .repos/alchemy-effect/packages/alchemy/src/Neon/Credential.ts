import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { Unowned } from "../AdoptPolicy.ts";
import {
  resolveBranchScope,
  type BranchScope,
  type ResolvedBranchScope,
} from "./BranchScope.ts";
import type { Providers } from "./Providers.ts";

export type CredentialScope = Neon.CredentialScope;

export type CredentialProps = BranchScope & {
  /** Stable customer label. Omit to generate an ownership-qualified name. Explicit labels require delete-first replacement when scopes change. */
  name?: string;
  /** Branch-lineage permissions. Request storage:read explicitly for S3 reads; current data-plane behavior differs from the documented write-implies-read contract. Changes replace the credential. */
  scopes: CredentialScope[];
};

export interface CredentialAttributes extends ResolvedBranchScope {
  /** Opaque credential identifier, also the S3 access-key ID. */
  tokenId: string;
  /** Stable customer label. */
  name: string;
  /** Granted scopes, including any platform-added capabilities. */
  scopes: string[];
  /** Branch service bearer token, never the deployment account key. */
  apiToken: Redacted.Redacted<string>;
  /** S3 signing secret. */
  s3SecretAccessKey: Redacted.Redacted<string>;
  /** Issuance time. */
  createdAt: string;
}

export interface Credential extends Resource<
  "Neon.Credential",
  CredentialProps,
  CredentialAttributes,
  never,
  Providers
> {}

/**
 * A customer-managed branch service credential. Credentials authorize their branch
 * and descendants, not individual buckets. Reconciliation reveals existing secrets;
 * it never rotates a credential. Unrecoverable legacy secrets require explicit action.
 *
 * ### Creating a Credential
 * **Example:** Read-only storage access from an external application
 * ```typescript
 * const credential = yield* Neon.Credential("Reader", {
 *   branch,
 *   scopes: ["storage:read"],
 * });
 * ```
 *
 * @resource
 * @product Credential
 */
export const Credential = Resource<Credential>("Neon.Credential");

export class CredentialRecoveryError extends Data.TaggedError(
  "CredentialRecoveryError",
)<{
  message: string;
}> {}

const sameScopes = (a: readonly string[], b: readonly string[]) =>
  [...new Set(a)].sort().join("\n") === [...new Set(b)].sort().join("\n");

const requestScope = (scope: ResolvedBranchScope) => ({
  project_id: scope.projectId,
  branch_id: scope.branchId,
});

const findCredential = Effect.fn(function* (
  scope: ResolvedBranchScope,
  name: string,
  tokenId?: string,
) {
  const { credentials } = yield* Neon.listCredentials(requestScope(scope));
  const matches = credentials.filter(
    (credential) =>
      !credential.revoked_at &&
      credential.principal_type === "user" &&
      (credential.branch_id === undefined ||
        credential.branch_id === scope.branchId) &&
      (tokenId ? credential.token_id === tokenId : credential.name === name),
  );
  if (matches.length > 1) {
    return yield* new CredentialRecoveryError({
      message: `Ambiguous credential label ${name}; refusing to choose a token`,
    });
  }
  return matches[0];
});

const hydrateCredential = Effect.fn(function* (
  scope: ResolvedBranchScope,
  metadata: Neon.CredentialMeta,
) {
  const secret = yield* Neon.revealCredential({
    ...requestScope(scope),
    token_id: metadata.token_id,
  }).pipe(
    Effect.catchTag("Conflict", () =>
      Effect.fail(
        new CredentialRecoveryError({
          message:
            "Credential secrets cannot be revealed; explicitly rotate or replace this legacy credential",
        }),
      ),
    ),
  );
  return {
    ...scope,
    tokenId: metadata.token_id,
    name: metadata.name ?? "",
    scopes: metadata.scopes,
    apiToken: Redacted.isRedacted(secret.api_token)
      ? secret.api_token
      : Redacted.make(secret.api_token),
    s3SecretAccessKey: Redacted.isRedacted(secret.s3_secret_access_key)
      ? secret.s3_secret_access_key
      : Redacted.make(secret.s3_secret_access_key),
    createdAt: metadata.created_at,
  } satisfies CredentialAttributes;
});

export const CredentialProvider = () =>
  Provider.succeed(Credential, {
    stables: ["projectId", "branchId", "name"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return;
      const scope = yield* resolveBranchScope(news);
      if (
        scope.projectId !== output.projectId ||
        scope.branchId !== output.branchId ||
        (news.name !== undefined && news.name !== output.name) ||
        !sameScopes(news.scopes, output.scopes)
      ) {
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined &&
            news.name === output.name &&
            scope.projectId === output.projectId &&
            scope.branchId === output.branchId,
        };
      }
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (!output && !olds?.branch && !olds?.project) return undefined;
      const scope = output ?? (yield* resolveBranchScope(olds!));
      const name =
        output?.name ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 100 }));
      const metadata = yield* findCredential(scope, name, output?.tokenId);
      if (!metadata) return undefined;
      const attrs = yield* hydrateCredential(scope, metadata);
      return !output && olds?.name !== undefined ? Unowned(attrs) : attrs;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveBranchScope(news);
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 100 }));
      let metadata = yield* findCredential(scope, name, output?.tokenId);
      if (!metadata && output) metadata = yield* findCredential(scope, name);
      if (!metadata) {
        const created = yield* Neon.createCredential({
          ...requestScope(scope),
          name,
          scopes: news.scopes,
          principal_type: "user",
        });
        return {
          ...scope,
          name,
          tokenId: created.token_id,
          scopes: created.scopes,
          apiToken: Redacted.isRedacted(created.api_token)
            ? created.api_token
            : Redacted.make(created.api_token),
          s3SecretAccessKey: Redacted.isRedacted(created.s3_secret_access_key)
            ? created.s3_secret_access_key
            : Redacted.make(created.s3_secret_access_key),
          createdAt: created.created_at,
        };
      }
      if (!sameScopes(metadata.scopes, news.scopes)) {
        return yield* new CredentialRecoveryError({
          message:
            "Observed credential scopes differ from desired scopes; replace rather than rotate or adopt broader access",
        });
      }
      return yield* hydrateCredential(scope, metadata);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* Neon.revokeCredential({
        ...requestScope(output),
        token_id: output.tokenId,
      }).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

/** Validate an override against the target branch's actual ancestry and required scope. */
export const validateCredential = Effect.fn(function* (
  credential: Pick<CredentialAttributes, "projectId" | "branchId" | "scopes">,
  target: ResolvedBranchScope,
  required: CredentialScope,
) {
  if (
    credential.projectId !== target.projectId ||
    !credential.scopes.includes(required)
  ) {
    return yield* new CredentialRecoveryError({
      message: "Credential project or scope does not authorize this binding",
    });
  }
  let branchId: string | undefined = target.branchId;
  const seen = new Set<string>();
  while (branchId) {
    if (branchId === credential.branchId) return;
    if (seen.has(branchId)) break;
    seen.add(branchId);
    const response: Neon.GetProjectBranchResponse =
      yield* Neon.getProjectBranch({
        project_id: target.projectId,
        branch_id: branchId,
      });
    branchId = response.branch.parent_id;
  }
  return yield* new CredentialRecoveryError({
    message: "Credential branch is not the target branch or an ancestor",
  });
});
