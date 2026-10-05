import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import type * as Redacted from "effect/Redacted";
import type { Input } from "../Input.ts";
import { isPlainData } from "../Util/data.ts";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { arrayEquals } from "../Util/equal.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  InvalidBranchScope,
  resolveBranchScope,
  type BranchScope,
} from "./BranchScope.ts";
import type { Providers } from "./Providers.ts";

/** Unspecified settings are preserved. Removing previously managed settings requires an explicit reset value. */
export type AuthProps = BranchScope & {
  /** Database containing neon_auth. Omission preserves the existing database; changing its identity replaces the integration. */
  database?: string;
  /** Application name shown in authentication emails. */
  name?: string;
  /** Permit localhost origins; explicitly set false in production. */
  allowLocalhost?: boolean;
  /** Supported managed email/password settings, using Neon's wire field names. */
  emailAndPassword?: Omit<
    Neon.UpdateNeonAuthEmailAndPasswordConfigRequest,
    "project_id" | "branch_id"
  >;
  /** Managed SMTP or shared email settings. Passwords must be redacted. */
  emailProvider?:
    | Neon.SharedEmailServer
    | (Omit<Neon.StandardEmailServer, "password"> & {
        password?: Redacted.Redacted<string>;
      });
  /** Managed magic-link settings. */
  magicLink?: Omit<
    Neon.UpdateNeonAuthMagicLinkPluginRequest,
    "project_id" | "branch_id"
  >;
  /** Managed organization plugin settings; does not configure Neon organizations. */
  organization?: Omit<
    Neon.UpdateNeonAuthOrganizationPluginRequest,
    "project_id" | "branch_id"
  >;
  /** Managed phone-number plugin settings. */
  phoneNumber?: Omit<
    Neon.UpdateNeonAuthPhoneNumberPluginRequest,
    "project_id" | "branch_id"
  >;
  /** Managed webhook settings. */
  webhook?: Omit<
    Neon.UpdateNeonAuthWebhookConfigRequest,
    "project_id" | "branch_id"
  >;
};

export interface AuthAttributes {
  /** Neon project identity. */
  projectId: string;
  /** Branch identity; destruction never follows a parent branch. */
  branchId: string;
  /** Database holding authentication state. */
  database: string;
  /** Public managed Better Auth service URL. */
  baseUrl: string;
  /** Public JWKS endpoint for signature verification. */
  jwksUrl: string;
  /** Application name observed from Neon. */
  name: string | undefined;
}

export interface Auth extends Resource<
  "Neon.Auth",
  AuthProps,
  AuthAttributes,
  never,
  Providers
> {}

/**
 * Own the managed Better Auth integration on one branch. This is distinct from
 * Alchemy's deployment authentication provider. Existing or inherited singleton
 * integrations require explicit adoption. Users and sessions are runtime data.
 * OAuth providers and trusted origins are owned only by their child resources.
 * Disabling Auth preserves the neon_auth database schema. Neon refuses to enable
 * it again while that schema exists; this provider never drops user identity data
 * to recreate an externally disabled integration.
 *
 * ### Enable managed authentication
 * **Example:** Email and password authentication
 * ```typescript
 * const auth = yield* Neon.Auth("Auth", {
 *   branch,
 *   allowLocalhost: false,
 *   emailAndPassword: { enabled: true, require_email_verification: true },
 * });
 * yield* Neon.AuthTrustedDomain("SiteOrigin", { auth, domain: site.url });
 * ```
 *
 * @resource
 * @product Auth
 */
export const Auth = Resource<Auth>("Neon.Auth");

export class InvalidManagedAuth extends Data.TaggedError("InvalidManagedAuth")<{
  message: string;
}> {}

/** @internal */
export const authRequest = (scope: {
  projectId: string;
  branchId: string;
}) => ({
  project_id: scope.projectId,
  branch_id: scope.branchId,
});

/** Resolve identity independently of unrelated unresolved settings. @internal */
export const authPlanScope = Effect.fn(function* (news: Input<BranchScope>) {
  if (
    "branch" in news &&
    news.branch !== undefined &&
    "project" in news &&
    news.project !== undefined
  ) {
    return yield* new InvalidBranchScope({
      message: "Specify exactly one of branch or project",
    });
  }
  if ("branch" in news && news.branch !== undefined) {
    const branch = news.branch;
    if (
      "projectId" in branch &&
      "branchId" in branch &&
      isResolved(branch.projectId) &&
      isResolved(branch.branchId)
    ) {
      return yield* resolveBranchScope({
        branch: { projectId: branch.projectId, branchId: branch.branchId },
      });
    }
  } else if ("project" in news && news.project !== undefined) {
    const project = news.project;
    if ("projectId" in project && isResolved(project.projectId)) {
      return yield* resolveBranchScope({
        project: { projectId: project.projectId },
      });
    }
  }
  return undefined;
});

/** Find omitted managed fields without inspecting secret values. @internal */
export const removedAuthSettings = (
  olds: object | undefined,
  news: object,
  fields: readonly string[],
): string[] => {
  if (!olds || !isPlainData(news)) return [];
  return fields.flatMap((key) => {
    const oldValue = Reflect.get(olds, key);
    const newValue = Reflect.get(news, key);
    if (oldValue === undefined) return [];
    if (newValue === undefined) return [key];
    if (
      isPlainData(oldValue) &&
      isPlainData(newValue) &&
      !Array.isArray(oldValue) &&
      !Array.isArray(newValue) &&
      Reflect.get(oldValue, "type") === Reflect.get(newValue, "type")
    ) {
      return removedAuthSettings(oldValue, newValue, Object.keys(oldValue)).map(
        (field) => `${key}.${field}`,
      );
    }
    return [];
  });
};

const managedAuthFields = [
  "name",
  "allowLocalhost",
  "emailAndPassword",
  "emailProvider",
  "magicLink",
  "organization",
  "phoneNumber",
  "webhook",
] as const;

const validateAuthRemoval = (
  olds: AuthProps | undefined,
  news: Input<AuthProps>,
) => {
  const removed = removedAuthSettings(olds, news, managedAuthFields);
  return removed.length === 0
    ? Effect.void
    : Effect.fail(
        new InvalidManagedAuth({
          message: `Cannot remove managed Auth settings: ${removed.join(", ")}; set explicit reset values instead`,
        }),
      );
};

/** Compare only explicitly managed fields, never serialize secrets. @internal */
export const authSettingsMatch = (observed: object, desired: object) =>
  Object.entries(desired).every(
    ([key, value]) =>
      value === undefined ||
      (Array.isArray(value)
        ? arrayEquals(Reflect.get(observed, key), value)
        : Equal.equals(Reflect.get(observed, key), value)),
  );

const observeAuth = (scope: { projectId: string; branchId: string }) =>
  Neon.getNeonAuth(authRequest(scope)).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const attributes = Effect.fn(function* (
  scope: { projectId: string; branchId: string },
  observed: Neon.NeonAuthIntegration,
) {
  if (observed.auth_provider !== "better_auth" || !observed.base_url) {
    return yield* new InvalidManagedAuth({
      message:
        "The branch must expose a managed Better Auth integration and base URL",
    });
  }
  return {
    ...scope,
    database: observed.db_name,
    baseUrl: observed.base_url,
    jwksUrl: observed.jwks_url,
    name: observed.name,
  } satisfies AuthAttributes;
});

export const AuthProvider = () =>
  Provider.succeed(Auth, {
    stables: ["projectId", "branchId", "database"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      yield* validateAuthRemoval(olds, news);
      const scope = yield* authPlanScope(news);
      if (
        output &&
        (!scope ||
          scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId)
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return;
      const resolved = scope ?? (yield* resolveBranchScope(news));
      const previous = output ?? (yield* resolveBranchScope(olds));
      if (
        resolved.projectId !== previous.projectId ||
        resolved.branchId !== previous.branchId ||
        (news.database ?? output?.database ?? olds.database) !==
          (output?.database ?? olds.database)
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!output) return;
      const request = authRequest(resolved);
      const observed = yield* observeAuth(resolved);
      if (!observed) return { action: "update" } as const;
      if (news.name !== undefined && news.name !== observed.name)
        return { action: "update" } as const;
      if (
        news.allowLocalhost !== undefined &&
        (yield* Neon.getNeonAuthAllowLocalhost(request)).allow_localhost !==
          news.allowLocalhost
      )
        return { action: "update" } as const;
      if (
        news.emailAndPassword !== undefined &&
        !authSettingsMatch(
          yield* Neon.getNeonAuthEmailAndPasswordConfig(request),
          news.emailAndPassword,
        )
      )
        return { action: "update" } as const;
      if (
        news.emailProvider !== undefined &&
        !authSettingsMatch(
          yield* Neon.getNeonAuthEmailProvider(request),
          news.emailProvider,
        )
      )
        return { action: "update" } as const;
      if (
        news.magicLink !== undefined ||
        news.organization !== undefined ||
        news.phoneNumber !== undefined
      ) {
        const current = yield* Neon.getNeonAuthPluginConfigs(request);
        if (
          (news.magicLink !== undefined &&
            !authSettingsMatch(current.magic_link ?? {}, news.magicLink)) ||
          (news.organization !== undefined &&
            !authSettingsMatch(
              current.organization ?? {},
              news.organization,
            )) ||
          (news.phoneNumber !== undefined &&
            !authSettingsMatch(current.phone_number ?? {}, news.phoneNumber))
        )
          return { action: "update" } as const;
      }
      if (
        news.webhook !== undefined &&
        !authSettingsMatch(
          yield* Neon.getNeonAuthWebhookConfig(request),
          news.webhook,
        )
      )
        return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (
        !output &&
        !(olds?.branch?.projectId && olds.branch.branchId) &&
        !olds?.project?.projectId
      )
        return undefined;
      const scope = output ?? (yield* resolveBranchScope(olds));
      const observed = yield* observeAuth(scope);
      if (!observed) return undefined;
      const attrs = yield* attributes(scope, observed);
      return output ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ news, output, olds }) {
      yield* validateAuthRemoval(olds, news);
      const scope = yield* resolveBranchScope(news);
      const database = news.database ?? output?.database;
      if (
        output &&
        (scope.projectId !== output.projectId ||
          scope.branchId !== output.branchId ||
          database !== output.database)
      ) {
        return yield* new InvalidManagedAuth({
          message:
            "Auth identity changed without replacement; refusing to mutate either integration",
        });
      }
      const request = authRequest(scope);
      let observed = yield* observeAuth(scope);
      if (observed && !output) {
        return yield* new OwnedBySomeoneElse({
          message: "Existing Auth requires explicit adoption",
          resourceType: "Neon.Auth",
        });
      }
      if (!observed) {
        yield* Neon.createNeonAuth({
          ...request,
          auth_provider: "better_auth",
          database_name: database,
        }).pipe(
          Effect.catchTag(
            "Conflict",
            Effect.fn(function* (error) {
              const raced = yield* observeAuth(scope);
              if (!raced) return yield* error;
              if (!output) {
                return yield* new OwnedBySomeoneElse({
                  message:
                    "Auth integration appeared during creation; explicit adoption is required",
                  resourceType: "Neon.Auth",
                });
              }
            }),
          ),
        );
        observed = yield* Neon.getNeonAuth(request);
      }
      yield* attributes(scope, observed);
      if (news.database !== undefined && observed.db_name !== news.database) {
        return yield* new InvalidManagedAuth({
          message:
            "Existing Auth uses a different database; replace the integration explicitly",
        });
      }
      if (news.name !== undefined && news.name !== observed.name) {
        yield* Neon.updateNeonAuthConfig({ ...request, name: news.name });
      }
      if (news.allowLocalhost !== undefined) {
        const current = yield* Neon.getNeonAuthAllowLocalhost(request);
        if (current.allow_localhost !== news.allowLocalhost) {
          yield* Neon.updateNeonAuthAllowLocalhost({
            ...request,
            allow_localhost: news.allowLocalhost,
          });
        }
      }
      if (news.emailAndPassword !== undefined) {
        const current = yield* Neon.getNeonAuthEmailAndPasswordConfig(request);
        if (!authSettingsMatch(current, news.emailAndPassword)) {
          yield* Neon.updateNeonAuthEmailAndPasswordConfig({
            ...request,
            ...news.emailAndPassword,
          });
        }
      }
      if (news.emailProvider !== undefined) {
        const current = yield* Neon.getNeonAuthEmailProvider(request);
        // SMTP passwords may be masked on read, so reassert an explicitly managed secret.
        if (
          (news.emailProvider.type === "standard" &&
            news.emailProvider.password !== undefined) ||
          !authSettingsMatch(current, news.emailProvider)
        ) {
          yield* Neon.updateNeonAuthEmailProvider({
            ...request,
            body: news.emailProvider,
          });
        }
      }
      if (
        news.magicLink !== undefined ||
        news.organization !== undefined ||
        news.phoneNumber !== undefined
      ) {
        const current = yield* Neon.getNeonAuthPluginConfigs(request);
        if (
          news.magicLink !== undefined &&
          !authSettingsMatch(current.magic_link ?? {}, news.magicLink)
        ) {
          yield* Neon.updateNeonAuthMagicLinkPlugin({
            ...request,
            ...news.magicLink,
          });
        }
        if (
          news.organization !== undefined &&
          !authSettingsMatch(current.organization ?? {}, news.organization)
        ) {
          yield* Neon.updateNeonAuthOrganizationPlugin({
            ...request,
            ...news.organization,
          });
        }
        if (
          news.phoneNumber !== undefined &&
          !authSettingsMatch(current.phone_number ?? {}, news.phoneNumber)
        ) {
          yield* Neon.updateNeonAuthPhoneNumberPlugin({
            ...request,
            ...news.phoneNumber,
          });
        }
      }
      if (news.webhook !== undefined) {
        const current = yield* Neon.getNeonAuthWebhookConfig(request);
        if (!authSettingsMatch(current, news.webhook)) {
          yield* Neon.updateNeonAuthWebhookConfig({
            ...request,
            ...news.webhook,
          });
        }
      }
      return yield* attributes(scope, yield* Neon.getNeonAuth(request));
    }),
    delete: Effect.fn(function* ({ output }) {
      if (yield* observeAuth(output)) {
        yield* Neon.disableNeonAuth(authRequest(output)).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });
