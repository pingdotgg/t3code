import * as Neon from "@distilled.cloud/neon";
import * as Effect from "effect/Effect";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { authPlanScope, authRequest, InvalidManagedAuth } from "./Auth.ts";
import type { Providers } from "./Providers.ts";

export interface AuthTrustedDomainProps {
  /** Managed Auth integration to trust the origin on. */
  auth: { projectId: string; branchId: string };
  /** Exact trusted origin, including scheme and optional port. */
  domain: string;
}

export interface AuthTrustedDomainAttributes {
  /** Neon project identity. */
  projectId: string;
  /** Branch identity. */
  branchId: string;
  /** Trusted origin owned by this child. */
  domain: string;
}

export interface AuthTrustedDomain extends Resource<
  "Neon.AuthTrustedDomain",
  AuthTrustedDomainProps,
  AuthTrustedDomainAttributes,
  never,
  Providers
> {}

/**
 * Own one trusted origin without replacing the Auth integration or overwriting
 * other origins. Existing entries require explicit adoption.
 *
 * ### Trust a deployed frontend
 * **Example:** Resolve the site URL after creating Auth
 * ```typescript
 * yield* Neon.AuthTrustedDomain("SiteOrigin", { auth, domain: site.url });
 * ```
 *
 * @resource
 * @product Auth
 */
export const AuthTrustedDomain = Resource<AuthTrustedDomain>(
  "Neon.AuthTrustedDomain",
);

const observe = (
  scope: { projectId: string; branchId: string },
  domain: string,
) =>
  Neon.listBranchNeonAuthTrustedDomains(authRequest(scope)).pipe(
    Effect.map((response) =>
      response.domains.some(
        (item) =>
          item.domain === domain && item.auth_provider === "better_auth",
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

export const AuthTrustedDomainProvider = () =>
  Provider.succeed(AuthTrustedDomain, {
    stables: ["projectId", "branchId", "domain"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const scope =
        "auth" in news
          ? yield* authPlanScope({ branch: news.auth })
          : undefined;
      if (
        output &&
        (!scope ||
          scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId ||
          !("domain" in news) ||
          news.domain !== output.domain)
      )
        return { action: "replace" } as const;
      if (!isResolved(news)) return;
      if (
        news.auth.projectId !== olds.auth.projectId ||
        news.auth.branchId !== olds.auth.branchId ||
        news.domain !== olds.domain
      ) {
        return { action: "replace" } as const;
      }
      if (!(yield* observe(news.auth, news.domain)))
        return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (
        !output &&
        (!olds?.auth?.projectId || !olds.auth.branchId || !olds.domain)
      )
        return undefined;
      const scope = output ?? olds.auth;
      const domain = output?.domain ?? olds.domain;
      if (!(yield* observe(scope, domain))) return undefined;
      const attrs = {
        projectId: scope.projectId,
        branchId: scope.branchId,
        domain,
      };
      return output ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      if (
        output &&
        (news.auth.projectId !== output.projectId ||
          news.auth.branchId !== output.branchId ||
          news.domain !== output.domain)
      )
        return yield* new InvalidManagedAuth({
          message:
            "Trusted origin identity changed without replacement; refusing to mutate either origin",
        });
      const request = authRequest(news.auth);
      const current = yield* observe(news.auth, news.domain);
      if (current && !output)
        return yield* new OwnedBySomeoneElse({
          message: "Existing trusted origin requires explicit adoption",
          resourceType: "Neon.AuthTrustedDomain",
        });
      if (!current) {
        yield* Neon.addBranchNeonAuthTrustedDomain({
          ...request,
          auth_provider: "better_auth",
          domain: news.domain,
        }).pipe(
          Effect.catchTag("Conflict", () =>
            Effect.fail(
              new OwnedBySomeoneElse({
                message:
                  "Trusted origin appeared during creation; explicit adoption is required",
                resourceType: "Neon.AuthTrustedDomain",
              }),
            ),
          ),
        );
      }
      if (!(yield* observe(news.auth, news.domain))) {
        return yield* Effect.fail(
          new Error("Trusted origin was not visible after reconciliation"),
        );
      }
      return {
        projectId: news.auth.projectId,
        branchId: news.auth.branchId,
        domain: news.domain,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      if (yield* observe(output, output.domain)) {
        yield* Neon.deleteBranchNeonAuthTrustedDomain({
          ...authRequest(output),
          auth_provider: "better_auth",
          domains: [{ domain: output.domain }],
        }).pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
    }),
  });
