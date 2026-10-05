import * as Neon from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  authPlanScope,
  authRequest,
  InvalidManagedAuth,
  removedAuthSettings,
} from "./Auth.ts";
import type { Input } from "../Input.ts";
import type { Providers } from "./Providers.ts";

export interface AuthOAuthProviderProps {
  /** Managed Auth integration; its scope is inherited without owning the parent. */
  auth: { projectId: string; branchId: string };
  /** Supported OAuth provider identity. Changing it replaces this child. */
  provider: Neon.NeonAuthOauthProviderId;
  /** OAuth client ID. Omit for Neon-managed development credentials. */
  clientId?: string;
  /** OAuth secret, never included in resource outputs. */
  clientSecret?: Redacted.Redacted<string>;
  /** Microsoft tenant ID; write-only in the current read schema. */
  microsoftTenantId?: string;
}

export interface AuthOAuthProviderAttributes {
  /** Neon project identity. */
  projectId: string;
  /** Owning branch identity. */
  branchId: string;
  /** OAuth provider identity. */
  provider: Neon.NeonAuthOauthProviderId;
  /** Whether Neon-managed development or application credentials are active. */
  type: Neon.NeonAuthOauthProviderType;
  /** Public OAuth client identifier, when configured. */
  clientId: string | undefined;
}

export interface AuthOAuthProvider extends Resource<
  "Neon.AuthOAuthProvider",
  AuthOAuthProviderProps,
  AuthOAuthProviderAttributes,
  never,
  Providers
> {}

/**
 * Independently own one managed Auth OAuth provider. Shared credentials are for
 * development only. Existing providers, including inherited providers, require
 * explicit adoption. Removing managed credential fields is rejected; replace the
 * child explicitly to switch back to development credentials.
 *
 * ### Configure an OAuth application
 * **Example:** GitHub sign-in
 * ```typescript
 * yield* Neon.AuthOAuthProvider("GitHub", {
 *   auth, provider: "github", clientId: "application-id",
 *   clientSecret: yield* Config.Redacted("GITHUB_CLIENT_SECRET"),
 * });
 * ```
 *
 * @resource
 * @product Auth
 */
export const AuthOAuthProvider = Resource<AuthOAuthProvider>(
  "Neon.AuthOAuthProvider",
);

const observe = (
  scope: { projectId: string; branchId: string },
  provider: Neon.NeonAuthOauthProviderId,
) =>
  Neon.listBranchNeonAuthOauthProviders(authRequest(scope)).pipe(
    Effect.map((response) =>
      response.providers.find((item) => item.id === provider),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const attributes = (
  scope: { projectId: string; branchId: string },
  value: Neon.NeonAuthOauthProvider,
): AuthOAuthProviderAttributes => ({
  projectId: scope.projectId,
  branchId: scope.branchId,
  provider: value.id,
  type: value.type,
  clientId: value.client_id,
});

const validateOAuthRemoval = (
  olds: AuthOAuthProviderProps | undefined,
  news: Input<AuthOAuthProviderProps>,
) => {
  const removed = removedAuthSettings(olds, news, [
    "clientId",
    "clientSecret",
    "microsoftTenantId",
  ]);
  return removed.length === 0
    ? Effect.void
    : Effect.fail(
        new InvalidManagedAuth({
          message: `Cannot remove managed OAuth settings: ${removed.join(", ")}; replace the OAuth child explicitly`,
        }),
      );
};

export const AuthOAuthProviderProvider = () =>
  Provider.succeed(AuthOAuthProvider, {
    stables: ["projectId", "branchId", "provider"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      yield* validateOAuthRemoval(olds, news);
      const scope =
        "auth" in news
          ? yield* authPlanScope({ branch: news.auth })
          : undefined;
      if (
        output &&
        (!scope ||
          scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId ||
          !("provider" in news) ||
          news.provider !== output.provider)
      )
        return { action: "replace" } as const;
      if (!isResolved(news)) return;
      if (
        news.auth.projectId !== olds.auth.projectId ||
        news.auth.branchId !== olds.auth.branchId ||
        news.provider !== olds.provider
      ) {
        return { action: "replace" } as const;
      }
      if (output) {
        const current = yield* observe(news.auth, news.provider);
        if (
          !current ||
          (news.clientId !== undefined && current.client_id !== news.clientId)
        )
          return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const scope = output ?? olds.auth;
      const current = yield* observe(scope, output?.provider ?? olds.provider);
      if (!current) return undefined;
      const attrs = attributes(scope, current);
      return output ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news, output, olds }) {
      yield* validateOAuthRemoval(olds, news);
      if (
        output &&
        (news.auth.projectId !== output.projectId ||
          news.auth.branchId !== output.branchId ||
          news.provider !== output.provider)
      )
        return yield* new InvalidManagedAuth({
          message:
            "OAuth identity changed without replacement; refusing to mutate either provider",
        });
      const request = authRequest(news.auth);
      let current = yield* observe(news.auth, news.provider);
      if (current && !output)
        return yield* new OwnedBySomeoneElse({
          message: "Existing OAuth provider requires explicit adoption",
          resourceType: "Neon.AuthOAuthProvider",
        });
      if (!current) {
        yield* Neon.addBranchNeonAuthOauthProvider({
          ...request,
          id: news.provider,
          client_id: news.clientId,
          client_secret: news.clientSecret,
          microsoft_tenant_id: news.microsoftTenantId,
        }).pipe(
          Effect.catchTag("Conflict", () =>
            Effect.fail(
              new OwnedBySomeoneElse({
                message:
                  "OAuth provider appeared during creation; explicit adoption is required",
                resourceType: "Neon.AuthOAuthProvider",
              }),
            ),
          ),
        );
        current = yield* observe(news.auth, news.provider);
      }
      const secretMatches =
        news.clientSecret === undefined ||
        (current?.client_secret !== undefined &&
          (Redacted.isRedacted(current.client_secret)
            ? Redacted.value(current.client_secret)
            : current.client_secret) === Redacted.value(news.clientSecret));
      // The API may mask secrets and does not expose the Microsoft tenant on GET.
      if (
        (news.clientId !== undefined && news.clientId !== current?.client_id) ||
        !secretMatches ||
        news.microsoftTenantId !== undefined
      ) {
        yield* Neon.updateBranchNeonAuthOauthProvider({
          ...request,
          oauth_provider_id: news.provider,
          client_id: news.clientId,
          client_secret: news.clientSecret,
          microsoft_tenant_id: news.microsoftTenantId,
        });
      }
      const result = yield* Neon.listBranchNeonAuthOauthProviders(request);
      const provider = result.providers.find(
        (item) => item.id === news.provider,
      );
      if (!provider)
        return yield* Effect.fail(
          new Error("OAuth provider was not visible after reconciliation"),
        );
      return attributes(news.auth, provider);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (yield* observe(output, output.provider)) {
        yield* Neon.deleteBranchNeonAuthOauthProvider({
          ...authRequest(output),
          oauth_provider_id: output.provider,
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }),
  });
