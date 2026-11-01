import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { arrayEquals } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import {
  normalizePolicyRules,
  type PolicyDecision,
  type PolicyExcludeRule,
  type PolicyExcludeRuleInput,
  type PolicyRequireRule,
  type PolicyRequireRuleInput,
  type PolicyRule,
  type PolicyRuleInput,
} from "./Policy.ts";

/**
 * Application type literal — every value Cloudflare's Access service
 * recognises. Stable across reconciles; changing it triggers a replacement.
 */
export type ApplicationType =
  | "self_hosted"
  | "saas"
  | "ssh"
  | "vnc"
  | "bookmark"
  | "warp"
  | "infrastructure"
  | "app_launcher"
  | "biso"
  | "dash_sso";

/**
 * A destination that this Access application protects.
 *
 * Cloudflare supports these destination flavours:
 * - `public` — a public hostname/URI you own in Cloudflare (the legacy
 *   `domain` field on `ApplicationProps` covers the simple case).
 * - `private` — a hostname or CIDR reachable through a Cloudflare Tunnel.
 *   Traffic from WARP-enrolled devices is intercepted and forwarded
 *   through the tunnel; identity is enforced before forwarding.
 * - `via_mcp_server_portal` — routes via a managed MCP server portal.
 * - `worker` / `preview_worker` — a specific Cloudflare Worker's production
 *   traffic (custom domains, routes, `workers.dev`) or its version preview
 *   URLs, keyed by the Worker's immutable ID (its `workerId` attribute).
 *   Usually you don't write these by hand — set the `access` prop on the
 *   `Cloudflare.Worker` instead, and the Worker enrolls itself into the
 *   application.
 * - `all_workers` / `all_preview_workers` — every Worker on the account
 *   (including ones created later), production or preview traffic
 *   respectively. Hostname-level policies take precedence over Worker-level
 *   policies, which take precedence over these account-level policies.
 */
export type ApplicationDestination =
  | { type: "public"; uri: string }
  | {
      type: "private";
      hostname?: string;
      cidr?: string;
      l4Protocol?: "tcp" | "udp";
      portRange?: string;
      vnetId?: string;
    }
  | { type: "via_mcp_server_portal"; mcpServerId: string }
  | { type: "worker"; workerId: string }
  | { type: "preview_worker"; workerId: string }
  | { type: "all_workers" }
  | { type: "all_preview_workers" };

/**
 * Configuration for an OAuth authorization flow managed by Cloudflare Access.
 */
export interface OAuthConfiguration {
  /** Whether Access acts as the OAuth authorization server. */
  enabled?: boolean;
  /** OAuth grant and token lifetimes. */
  grant?: {
    /** Lifetime of issued access tokens, as a Go-style duration. */
    accessTokenLifetime?: string;
    /** Lifetime of the authorization session, as a Go-style duration. */
    sessionDuration?: string;
  };
  /** Settings for OAuth dynamic client registration. */
  dynamicClientRegistration?: {
    /** Whether dynamic client registration is enabled. */
    enabled?: boolean;
    /** Explicit redirect URIs that dynamically registered clients may use. */
    allowedUris?: ReadonlyArray<string>;
    /** Whether any localhost redirect URI is allowed. */
    allowAnyOnLocalhost?: boolean;
    /** Whether any loopback-address redirect URI is allowed. */
    allowAnyOnLoopback?: boolean;
  };
}

/**
 * An Access policy defined inline on (and owned by) an application: created
 * with the application, updated in place, and deleted with it. Uses the same
 * rule model as the reusable `Cloudflare.Access.Policy` resource.
 */
export interface InlineApplicationPolicy {
  /** The action Access takes when a user matches this policy. */
  decision: PolicyDecision;
  /** Rules evaluated with OR — matching any one grants the policy. */
  include: ReadonlyArray<PolicyRuleInput>;
  /** Rules evaluated with NOT — matching any one denies the policy. */
  exclude?: ReadonlyArray<PolicyExcludeRuleInput>;
  /** Rules evaluated with AND — all must match. */
  require?: ReadonlyArray<PolicyRequireRuleInput>;
  /** Display name. Cloudflare generates one when omitted. */
  name?: string;
  /** Execution order of this policy within the application. */
  precedence?: number;
  /** Session lifetime for this policy, e.g. `"24h"`, `"2h45m"`. */
  sessionDuration?: string;
  /** Require admin approval at the start of each session. */
  approvalRequired?: boolean;
  /** Administrators who can approve a temporary authentication request. */
  approvalGroups?: ReadonlyArray<{
    approvalsNeeded: number;
    emailAddresses?: ReadonlyArray<string>;
    emailListUuid?: string;
  }>;
  /** Serve the application in an isolated browser for matching users. */
  isolationRequired?: boolean;
  /** Require a login justification from matching users. */
  purposeJustificationRequired?: boolean;
  /** Custom message shown on the justification screen. */
  purposeJustificationPrompt?: string;
}

export interface ApplicationProps {
  /**
   * The Access application type.
   *
   * Cloudflare requires a single global `warp` application per account; the
   * provider's observe step special-cases this by scanning the account for an
   * existing `warp` app when no `applicationId` is cached.
   *
   * Immutable — changing the type triggers a replace.
   */
  type: ApplicationType;
  /**
   * Human-readable display name. If omitted, a deterministic physical name
   * is generated from the app/stage/logical-id.
   */
  name?: string;
  /**
   * Primary hostname and path secured by Access. Required for `self_hosted`
   * apps; ignored on the request for `warp` (Cloudflare auto-fills it with
   * `${authDomain}/warp`) and `saas` (Cloudflare uses the OIDC issuer).
   */
  domain?: string;
  /**
   * Destinations this application protects. Use for the modern multi-
   * destination model — required for **Access for private apps** flows
   * where traffic to a private hostname/CIDR is intercepted by WARP and
   * routed through a Cloudflare Tunnel, with Access enforcing identity
   * before the request reaches the upstream service.
   *
   * For simple public-hostname apps, set `domain` instead. The two are
   * not mutually exclusive — Cloudflare treats `domain` as a shorthand
   * for adding a single `{ type: "public" }` destination.
   *
   * @example
   * ```ts
   * destinations: [
   *   { type: "private", hostname: "admin.internal" },
   * ]
   * ```
   */
  destinations?: ReadonlyArray<ApplicationDestination>;
  /**
   * Optional OAuth authorization-server configuration managed by Access.
   * Use this for non-browser clients such as MCP clients that authenticate
   * through OAuth and may register redirect URIs dynamically.
   */
  oauthConfiguration?: OAuthConfiguration;
  /**
   * Token TTL for sessions issued by this application. Accepts Go-style
   * duration strings, e.g. `"24h"`, `"720h"`, `"2h45m"`.
   *
   * @default "24h"
   */
  sessionDuration?: string;
  /**
   * Allowed identity-provider UUIDs. Defaults (on Cloudflare's side) to every
   * IdP configured for the account.
   */
  allowedIdps?: string[];
  /**
   * Skip the IdP picker when only one IdP is allowed. Requires `allowedIdps`
   * to contain exactly one entry.
   *
   * @default false
   */
  autoRedirectToIdentity?: boolean;
  /**
   * Whether the app should be visible in the App Launcher dashboard.
   */
  appLauncherVisible?: boolean;
  /**
   * Tags applied to this application for filtering in the App Launcher.
   */
  tags?: string[];
  /**
   * Access policies that gate access to this application, in ascending
   * order of precedence.
   *
   * Each entry can be:
   * - an **inline policy** owned by this application —
   *   `{ decision, include, ... }` with the same rule model as
   *   `Cloudflare.Access.Policy` (created, updated, and deleted with the
   *   application; no separate resource needed),
   * - a deployed reusable `Cloudflare.Access.Policy`
   *   (`policies: [allowTeam]`),
   * - a policy id (`string`),
   * - `{ id, precedence? }`, or
   * - the same with per-application overrides (`approvalRequired`,
   *   `isolationRequired`, `purposeJustificationRequired`,
   *   `purposeJustificationPrompt`, `sessionDuration`, `approvalGroups`).
   *
   * Cloudflare treats inline and reusable policies as mutually exclusive on
   * one application — mixing the two forms fails validation.
   *
   * @example
   * ```ts
   * policies: [
   *   { decision: "allow", include: [{ emailDomain: "example.com" }] },
   * ]
   * ```
   */
  policies?: ReadonlyArray<
    | string
    | { policyId: string }
    | InlineApplicationPolicy
    | { id: string; precedence?: number }
    | {
        id: string;
        precedence?: number;
        approvalRequired?: boolean;
        isolationRequired?: boolean;
        purposeJustificationRequired?: boolean;
        purposeJustificationPrompt?: string;
        sessionDuration?: string;
        approvalGroups?: ReadonlyArray<{
          approvalsNeeded: number;
          emailAddresses?: ReadonlyArray<string>;
          emailListUuid?: string;
        }>;
      }
  >;
  /**
   * Adopt an existing app that already lives in Cloudflare (matched by
   * applicationId observation) instead of failing on conflict.
   *
   * @default false
   */
  adopt?: boolean;
}

/**
 * Output attributes persisted between reconciles.
 */
export interface ApplicationAttributes {
  /** Cloudflare-assigned application UUID. */
  applicationId: string;
  /** Audience tag used to verify JWTs issued for this application. */
  aud: string;
  /** Resolved domain. Cloudflare fills this in for `warp`/`saas` apps. */
  domain: string;
  /** Resolved destinations (echoed back by Cloudflare). */
  destinations: ReadonlyArray<ApplicationDestination> | undefined;
  /** Resolved managed OAuth configuration. */
  oauthConfiguration: OAuthConfiguration | undefined;
  /** Application type. */
  type: ApplicationType;
  /** Display name (resolved). */
  name: string;
  /** Account that owns this application. */
  accountId: string;
  /** ISO8601 creation timestamp (Cloudflare-supplied). */
  createdAt: string | undefined;
  /** ISO8601 last-update timestamp (Cloudflare-supplied). */
  updatedAt: string | undefined;
}

/**
 * Data other resources attach to an Access application via bindings.
 * Workers enrolling themselves (the `access` prop on `Cloudflare.Worker`)
 * push their `worker`/`preview_worker` destinations here; the application
 * deploys with — and converges on — the union of its own `destinations`
 * prop and every bound contribution.
 */
export interface ApplicationBinding {
  destinations?: ApplicationDestination[];
}

export const isApplication = <T>(value: T): value is T & Application =>
  isResourceOfType(value, "Cloudflare.Access.Application");

export type Application = Resource<
  "Cloudflare.Access.Application",
  ApplicationProps,
  ApplicationAttributes,
  ApplicationBinding,
  Providers
>;

/**
 * A Cloudflare Zero Trust Access application.
 *
 * Replaces the curl-based `POST /accounts/{accountId}/access/apps` workflow
 * with an Alchemy-managed resource. Supports every Cloudflare application
 * type including `warp`, which Cloudflare requires for device enrolment via
 * the WARP client.
 *
 * Access policies are authored as standalone {@link Policy} resources
 * and referenced here by id — there is no inline-policy support.
 * ### Creating an Application
 * **Example:** Self-hosted application gated by a reusable Access policy
 * ```typescript
 * const allowMyOrg = yield* Cloudflare.Access.Policy("AllowMyOrg", {
 *   name: "Allow example.com via Google",
 *   decision: "allow",
 *   include: [{ emailDomain: { domain: "example.com" } }],
 * });
 *
 * const app = yield* Cloudflare.Access.Application("InternalDashboard", {
 *   type: "self_hosted",
 *   domain: "dashboard.example.com",
 *   sessionDuration: "24h",
 *   policies: [allowMyOrg],
 * });
 * ```
 *
 * **Example:** Managed OAuth for an MCP server
 * ```typescript
 * const app = yield* Cloudflare.Access.Application("McpServer", {
 *   type: "self_hosted",
 *   domain: "mcp.example.com",
 *   oauthConfiguration: {
 *     enabled: true,
 *     grant: {
 *       sessionDuration: "24h",
 *       accessTokenLifetime: "15m",
 *     },
 *     dynamicClientRegistration: {
 *       enabled: true,
 *       allowAnyOnLocalhost: true,
 *       allowAnyOnLoopback: true,
 *     },
 *   },
 * });
 * ```
 *
 * ### Protecting Cloudflare Workers
 * **Example:** Require Access on a specific Worker
 * ```typescript
 * // The application owns the policies (inline here — no separate Policy
 * // resource needed); the Worker enrolls itself via its `access` prop,
 * // covering its custom domains, routes, workers.dev URL, and version
 * // preview URLs.
 * const App = Cloudflare.Access.Application("TeamOnly", {
 *   type: "self_hosted",
 *   policies: [
 *     { decision: "allow", include: [{ emailDomain: "example.com" }] },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()("Api", {
 *   main: import.meta.url,
 *   access: { application: App },
 * }, /* ... *​/) {}
 * ```
 *
 * **Example:** Require Access on every Worker in the account
 * ```typescript
 * // Covers all current AND future Workers. Hostname-level policies beat
 * // Worker-level policies, which beat this account-level policy — so an
 * // individual Worker can still be opened up with its own application.
 * yield* Cloudflare.Access.Application("ProtectAllWorkers", {
 *   type: "self_hosted",
 *   destinations: [
 *     Cloudflare.Access.AllWorkers,         // production traffic of every Worker
 *     Cloudflare.Access.AllWorkerPreviews,  // every Worker's preview URLs
 *   ],
 *   policies: [
 *     { decision: "allow", include: [{ emailDomain: "example.com" }] },
 *   ],
 * });
 * ```
 *
 * ### Device-enrollment (warp)
 * **Example:** WARP device-enrollment application
 * ```typescript
 * // There can only be ONE warp app per account; Cloudflare auto-derives the
 * // domain (`${authDomain}/warp`) so do not pass `domain` for this type.
 * const allowCorp = yield* Cloudflare.Access.Policy("AllowCorpUsers", {
 *   name: "Allow corp users",
 *   decision: "allow",
 *   include: [{ emailDomain: { domain: "example.com" } }],
 * });
 *
 * const enroll = yield* Cloudflare.Access.Application("warp-login", {
 *   type: "warp",
 *   allowedIdps: [googleIdpId],
 *   autoRedirectToIdentity: true,
 *   sessionDuration: "720h",
 *   policies: [allowCorp],
 * });
 * ```
 *
 * ### Self-hosted with Google IdP
 * **Example:** Self-hosted application restricted to a Google Workspace group
 * ```typescript
 * const admins = yield* Cloudflare.Access.Policy("AdminsOnly", {
 *   name: "Admins only",
 *   decision: "allow",
 *   include: [
 *     {
 *       gsuite: {
 *         email: "admins@example.com",
 *         identityProviderId: googleIdpUuid,
 *       },
 *     },
 *   ],
 * });
 *
 * const app = yield* Cloudflare.Access.Application("AdminConsole", {
 *   type: "self_hosted",
 *   domain: "admin.example.com",
 *   allowedIdps: [googleIdpUuid],
 *   autoRedirectToIdentity: true,
 *   policies: [admins],
 * });
 * ```
 *
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 */
export const Application = Resource<Application>(
  "Cloudflare.Access.Application",
);

// Ride out the two transient failure modes Cloudflare's Access endpoints
// exhibit under load:
//
//   - `AccessReferenceNotFound` (400 `policy <id> not found`): Access
//     validates referenced entities (e.g. the `policies` an application gates
//     on) synchronously, but a *freshly created* policy propagates
//     eventually-consistently — so a create/update referencing it, or a list
//     hydrating an app that references it, is briefly rejected. Distilled
//     types this 400 distinctly (vs. a generic `BadRequest`) so we retry only
//     this case and still fail fast on real bad requests.
//   - `Forbidden` (403): Cloudflare frequently returns 403 when throttling a
//     valid token rather than a dedicated rate-limit status, so a 403 here is
//     a transient back-pressure signal, not an auth failure.
//
// Capped exponential, bounded to ride out the window (~45s) then fail.
const retryTransientAccessError = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) =>
        e._tag === "AccessReferenceNotFound" || e._tag === "Forbidden",
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("1 second", 1.5),
          Schedule.spaced("5 seconds"),
        ]),
        Schedule.recurs(12),
      ]),
    }),
  );

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: ["applicationId", "aud", "type", "accountId"],

    diff: Effect.fn(function* ({ olds = {}, news }) {
      if ((olds as ApplicationProps).type !== undefined) {
        if (
          (olds as ApplicationProps).type !== (news as ApplicationProps).type
        ) {
          return { action: "replace" } as const;
        }
      }
    }),

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // Prefer the persisted physical id. After state loss there is no
      // applicationId to probe, so fall back to matching an existing app
      // by domain — without this the engine plans a blind `create`, and
      // Cloudflare happily creates a second application on the same
      // domain with a fresh `aud`, silently breaking existing JWT
      // validation. Warp apps are excluded from the fallback: they are a
      // per-account singleton that `reconcile` already recovers.
      let observed: ObservedApp | undefined;
      if (output?.applicationId) {
        observed = yield* observeById(accountId, output.applicationId);
      } else if (olds?.type !== "warp" && typeof olds?.domain === "string") {
        observed = yield* findByDomain(accountId, olds.domain);
      } else {
        return undefined;
      }
      if (!observed?.id || !observed.aud || !observed.type) {
        return undefined;
      }
      const domain =
        observed.domain ??
        output?.domain ??
        olds?.domain ??
        // Worker-destination apps (`worker`/`all_workers`/...) have no
        // hostname; Cloudflare omits `domain` for them entirely.
        (observed.destinations !== undefined ? "" : undefined);
      const name = observed.name ?? output?.name;
      if (domain === undefined || name === undefined) {
        return undefined;
      }
      const attrs = {
        applicationId: observed.id,
        aud: observed.aud,
        domain,
        destinations: observed.destinations ?? output?.destinations,
        // Live cloud state is authoritative. In particular, do not resurrect
        // a persisted configuration when Cloudflare explicitly returns null.
        oauthConfiguration: observed.oauthConfiguration,
        type: observed.type,
        name,
        accountId: output?.accountId ?? accountId,
        createdAt: observed.createdAt ?? output?.createdAt,
        updatedAt: observed.updatedAt ?? output?.updatedAt,
      } satisfies ApplicationAttributes;
      // Recovered by id → positively ours. Recovered by domain scan →
      // existence is certain but ownership is not (Access applications
      // carry no alchemy marker), so gate takeover behind `--adopt`.
      return output?.applicationId ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const resolvedName = yield* resolveName(id, news.name);
      const resolvedIdps = resolveAllowedIdps(news.allowedIdps);
      const resolvedPolicies = resolvePolicies(news.policies);
      if (
        resolvedPolicies !== undefined &&
        resolvedPolicies.some(
          (p) => typeof p !== "string" && isInlinePolicy(p),
        ) &&
        resolvedPolicies.some(
          (p) => typeof p === "string" || !isInlinePolicy(p),
        )
      ) {
        return yield* Effect.fail(
          new Error(
            "Cloudflare Access applications cannot mix inline policies with " +
              "reusable policy references — use one form for the whole " +
              "`policies` list.",
          ),
        );
      }
      const body = buildMutableBody(
        news,
        resolvedName,
        resolvedIdps,
        resolvedPolicies,
      );
      // Destinations contributed through the binding contract (e.g. Workers
      // enrolling via their `access` prop) extend the declared ones. The
      // engine dedupes and sid-sorts bindings, so the merged order is
      // stable across deploys.
      const boundDestinations = (bindings ?? []).flatMap(
        (b) => (b.data.destinations ?? []) as ApplicationDestination[],
      );
      if (boundDestinations.length > 0) {
        body.destinations = [
          ...(body.destinations ?? []),
          ...boundDestinations,
        ];
      }

      // 1. Observe
      let observed: ObservedApp | undefined;
      if (output?.applicationId) {
        observed = yield* observeById(accountId, output.applicationId);
      }
      if (!observed && news.type === "warp") {
        // Warp is a singleton per account — reuse any existing app.
        observed = yield* findWarpApp(accountId);
      }

      // 2. Ensure
      if (!observed) {
        const created = yield* zeroTrust
          .createAccessApplicationForAccount({
            accountId,
            domain: body.domain,
            type: news.type,
            name: resolvedName,
            sessionDuration: body.sessionDuration,
            allowedIdps:
              body.allowedIdps === undefined
                ? undefined
                : Array.from(body.allowedIdps),
            autoRedirectToIdentity: body.autoRedirectToIdentity,
            appLauncherVisible: body.appLauncherVisible,
            tags: body.tags === undefined ? undefined : Array.from(body.tags),
            policies: toRequestPolicies(body.policies),
            destinations:
              body.destinations === undefined
                ? undefined
                : Array.from(body.destinations),
            oauthConfiguration: toRequestOAuthConfiguration(
              body.oauthConfiguration,
            ),
          })
          .pipe(
            // A referenced policy may be propagating, or the call may be
            // throttled (403) — ride out both before falling through.
            retryTransientAccessError,
            // Distilled does not tag Conflict; surface any creation error
            // through the warp-singleton recovery path before re-failing.
            Effect.catch((err) =>
              Effect.gen(function* () {
                if (news.type === "warp") {
                  const existing = yield* findWarpApp(accountId);
                  if (existing) return existing;
                }
                return yield* Effect.fail(err);
              }),
            ),
          );
        observed = narrowApp(created as Parameters<typeof narrowApp>[0]);
      }

      // 3. Sync — Cloudflare's update endpoint is PUT-style; resend the
      // full desired body whenever any mutable field differs.
      if (!observed.id) {
        return yield* Effect.fail(
          new Error(
            "Cloudflare did not return an application id for Access application",
          ),
        );
      }
      if (!bodyEqualsObserved(body, observed)) {
        const updated = yield* zeroTrust
          .updateAccessApplicationForAccount({
            accountId,
            appId: observed.id,
            domain: body.domain ?? observed.domain,
            type: news.type,
            name: resolvedName,
            sessionDuration: body.sessionDuration,
            allowedIdps:
              body.allowedIdps === undefined
                ? undefined
                : Array.from(body.allowedIdps),
            autoRedirectToIdentity: body.autoRedirectToIdentity,
            appLauncherVisible: body.appLauncherVisible,
            tags: body.tags === undefined ? undefined : Array.from(body.tags),
            policies: toRequestPolicies(
              attachObservedPolicyIds(body.policies, observed.policies),
            ),
            destinations:
              body.destinations === undefined
                ? undefined
                : Array.from(body.destinations),
            // Preserve a live managed OAuth configuration when the caller
            // does not manage it but another mutable field triggers this
            // PUT-style update.
            oauthConfiguration: toRequestOAuthConfiguration(
              mergeOAuthConfiguration(
                observed.oauthConfiguration,
                body.oauthConfiguration,
              ),
            ),
          })
          // A just-added policy reference may still be propagating, or the
          // call may be throttled (403) — ride out both.
          .pipe(retryTransientAccessError);
        observed = narrowApp(updated as Parameters<typeof narrowApp>[0]);
      }

      // 4. Return
      if (!observed.id || !observed.aud || !observed.type) {
        return yield* Effect.fail(
          new Error(
            "Cloudflare returned an Access application without id/aud/type",
          ),
        );
      }
      return {
        applicationId: observed.id,
        aud: observed.aud,
        domain: observed.domain ?? body.domain ?? "",
        destinations: observed.destinations ?? body.destinations,
        // Keep the provider output cloud-authoritative. If Cloudflare rejects
        // or clears the desired configuration, do not mask that drift with
        // the request body.
        oauthConfiguration: observed.oauthConfiguration,
        type: observed.type,
        name: observed.name ?? resolvedName,
        accountId,
        createdAt: observed.createdAt,
        updatedAt: observed.updatedAt,
      } satisfies ApplicationAttributes;
    }),

    // Account-scoped collection (pattern (b)): enumerate every Access
    // application in the ambient account, exhaustively paginated, and hydrate
    // each into the exact `read`/`reconcile` Attributes shape. Items missing
    // the mandatory id/aud/type triplet are skipped (typed per-item drop).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listAccessApplicationsForAccount
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          // The list hydrates each app's `policies`; Cloudflare rejects the
          // whole enumeration with the typed `AccessReferenceNotFound` (400
          // "policy ... not found") while a sibling app references a policy
          // that is still propagating or mid-deletion, and 403s the call when
          // throttling. Ride out both.
          retryTransientAccessError,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).flatMap((raw) => {
                const app = narrowApp(raw as Parameters<typeof narrowApp>[0]);
                if (!app.id || !app.aud || !app.type) return [];
                return [
                  {
                    applicationId: app.id,
                    aud: app.aud,
                    domain: app.domain ?? "",
                    destinations: app.destinations,
                    oauthConfiguration: app.oauthConfiguration,
                    type: app.type,
                    name: app.name ?? "",
                    accountId,
                    createdAt: app.createdAt,
                    updatedAt: app.updatedAt,
                  } satisfies ApplicationAttributes,
                ];
              }),
            ),
          ),
        );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessApplicationForAccount({
          accountId: output.accountId,
          appId: output.applicationId,
        })
        .pipe(Effect.catch(() => Effect.void));
    }),
  });

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id });
  });

const resolveAllowedIdps = (
  idps: ApplicationProps["allowedIdps"],
): ReadonlyArray<string> | undefined =>
  idps === undefined
    ? undefined
    : // Inputs have already been resolved by the Plan layer by the time
      // we run, so they're concrete strings here.
      (idps as ReadonlyArray<string>);

// Cloudflare allows only one `warp` app per account. When we have no
// cached applicationId, scan the account and reuse it. Requirements
// (Credentials | HttpClient) are inferred and provided by the Provider
// runtime — matches the un-annotated Tunnel.findTunnelByName pattern.
const findWarpApp = (accountId: string) =>
  zeroTrust.listAccessApplicationsForAccount.items({ accountId }).pipe(
    Stream.runCollect,
    // A sibling app mid-teardown can transiently reject the whole
    // enumeration (AccessReferenceNotFound), and Cloudflare 403s when
    // throttling — same transient windows `list` rides out.
    retryTransientAccessError,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (a) => (a as { type?: string | null }).type === "warp",
      ),
    ),
    Effect.map((found) =>
      found === undefined
        ? undefined
        : narrowApp(found as Parameters<typeof narrowApp>[0]),
    ),
  );

// Cold-recovery scan for `read` when no applicationId was persisted:
// match an existing application by its domain (unique per account for
// non-warp app types).
const findByDomain = (accountId: string, domain: string) =>
  zeroTrust.listAccessApplicationsForAccount.items({ accountId }).pipe(
    Stream.runCollect,
    // A sibling app mid-teardown can transiently reject the whole
    // enumeration (AccessReferenceNotFound), and Cloudflare 403s when
    // throttling. A missed scan here is worse than a slow one: the engine
    // would plan a blind `create` and either duplicate the app or trip
    // Cloudflare's `application_already_exists` Conflict.
    retryTransientAccessError,
    Effect.map((chunk) =>
      Array.from(chunk).find(
        (a) => (a as { domain?: string | null }).domain === domain,
      ),
    ),
    Effect.map((found) =>
      found === undefined
        ? undefined
        : narrowApp(found as Parameters<typeof narrowApp>[0]),
    ),
  );

const observeById = (accountId: string, appId: string) =>
  Effect.gen(function* () {
    const r = yield* zeroTrust
      .getAccessApplicationForAccount({ accountId, appId })
      .pipe(
        // A missing application is typed (404 → AccessApplicationNotFound):
        // observe falls through to recreate. Transient 403 back-pressure is
        // retried; anything else is a real failure and propagates.
        retryTransientAccessError,
        Effect.catchTag("AccessApplicationNotFound", () =>
          Effect.succeed(undefined),
        ),
      );
    if (r === undefined) return undefined;
    return narrowApp(r as Parameters<typeof narrowApp>[0]);
  });

// ---------------------------------------------------------------------------
// Observed-state types
//
// We only diff policy references by id (and order), so the observed policy
// shape is narrowed to just the identifier here.
// ---------------------------------------------------------------------------

interface ObservedPolicy {
  readonly id?: string;
  readonly precedence?: number;
  /** false for application-owned (inline) policies, true for reusable. */
  readonly reusable?: boolean;
  readonly decision?: string;
  readonly name?: string;
  readonly include?: ReadonlyArray<unknown>;
  readonly exclude?: ReadonlyArray<unknown>;
  readonly require?: ReadonlyArray<unknown>;
  readonly sessionDuration?: string;
  readonly approvalRequired?: boolean;
  readonly isolationRequired?: boolean;
  readonly purposeJustificationRequired?: boolean;
  readonly purposeJustificationPrompt?: string;
}

interface ObservedApp {
  readonly id?: string;
  readonly aud?: string;
  readonly name?: string;
  readonly type?: ApplicationType;
  readonly domain?: string;
  readonly destinations?: ReadonlyArray<ApplicationDestination>;
  readonly oauthConfiguration?: OAuthConfiguration;
  readonly allowedIdps?: ReadonlyArray<string>;
  readonly autoRedirectToIdentity?: boolean;
  readonly appLauncherVisible?: boolean;
  readonly sessionDuration?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly policies?: ReadonlyArray<ObservedPolicy>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const undefArr = <T>(
  v: ReadonlyArray<T | null> | null | undefined,
): ReadonlyArray<T> | undefined =>
  v == null ? undefined : (v.filter((x) => x != null) as ReadonlyArray<T>);

interface RawOAuthConfiguration {
  readonly enabled?: boolean | null;
  readonly grant?: {
    readonly accessTokenLifetime?: string | null;
    readonly sessionDuration?: string | null;
  } | null;
  readonly dynamicClientRegistration?: {
    readonly enabled?: boolean | null;
    readonly allowedUris?: ReadonlyArray<string | null> | null;
    readonly allowAnyOnLocalhost?: boolean | null;
    readonly allowAnyOnLoopback?: boolean | null;
  } | null;
}

const narrowOAuthConfiguration = (
  raw: RawOAuthConfiguration | null | undefined,
): OAuthConfiguration | undefined =>
  raw == null
    ? undefined
    : {
        enabled: undef(raw.enabled),
        grant:
          raw.grant == null
            ? undefined
            : {
                accessTokenLifetime: undef(raw.grant.accessTokenLifetime),
                sessionDuration: undef(raw.grant.sessionDuration),
              },
        dynamicClientRegistration:
          raw.dynamicClientRegistration == null
            ? undefined
            : {
                enabled: undef(raw.dynamicClientRegistration.enabled),
                allowedUris: undefArr(
                  raw.dynamicClientRegistration.allowedUris,
                ) as string[] | undefined,
                allowAnyOnLocalhost: undef(
                  raw.dynamicClientRegistration.allowAnyOnLocalhost,
                ),
                allowAnyOnLoopback: undef(
                  raw.dynamicClientRegistration.allowAnyOnLoopback,
                ),
              },
      };

const narrowApp = (raw: {
  id?: string | null;
  aud?: string | null;
  name?: string | null;
  type?: ApplicationType | null | string;
  domain?: string | null;
  destinations?: ReadonlyArray<unknown> | null;
  oauthConfiguration?: RawOAuthConfiguration | null;
  allowedIdps?: ReadonlyArray<string> | null;
  autoRedirectToIdentity?: boolean | null;
  appLauncherVisible?: boolean | null;
  sessionDuration?: string | null;
  tags?: ReadonlyArray<string> | null;
  policies?: ReadonlyArray<unknown> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}): ObservedApp => ({
  id: undef(raw.id),
  aud: undef(raw.aud),
  name: undef(raw.name),
  type: raw.type == null ? undefined : (raw.type as ApplicationType),
  domain: undef(raw.domain),
  destinations:
    raw.destinations == null
      ? undefined
      : (raw.destinations as ReadonlyArray<ApplicationDestination>),
  oauthConfiguration: narrowOAuthConfiguration(raw.oauthConfiguration),
  allowedIdps: undefArr(raw.allowedIdps ?? undefined),
  autoRedirectToIdentity: undef(raw.autoRedirectToIdentity),
  appLauncherVisible: undef(raw.appLauncherVisible),
  sessionDuration: undef(raw.sessionDuration),
  tags: undefArr(raw.tags ?? undefined),
  policies:
    raw.policies == null
      ? undefined
      : (raw.policies as ReadonlyArray<ObservedPolicy>),
  createdAt: undef(raw.createdAt),
  updatedAt: undef(raw.updatedAt),
});

// ---------------------------------------------------------------------------
// Body construction
//
// Inputs declared as `Input<string>` are concrete strings by the time the
// reconciler runs (resolved by the Plan layer). We narrow them at the
// resolution boundary, then build the request shape distilled already types
// correctly — no cast-to-Parameters needed.
// ---------------------------------------------------------------------------

/**
 * Reconciler-side inline policy: `InlineApplicationPolicy` plus the optional
 * `id` of the observed application-owned policy it updates in place (see
 * `attachObservedPolicyIds`).
 */
interface InlineResolvedPolicy extends InlineApplicationPolicy {
  id?: string;
}

const isInlinePolicy = (p: ResolvedPolicy): p is InlineResolvedPolicy =>
  typeof p !== "string" && "decision" in p;

type ResolvedPolicy =
  | string
  | InlineResolvedPolicy
  | { id: string; precedence?: number }
  | {
      id: string;
      precedence?: number;
      approvalRequired?: boolean;
      isolationRequired?: boolean;
      purposeJustificationRequired?: boolean;
      purposeJustificationPrompt?: string;
      sessionDuration?: string;
      approvalGroups?: ReadonlyArray<{
        approvalsNeeded: number;
        emailAddresses?: ReadonlyArray<string>;
        emailListUuid?: string;
      }>;
    };

// The self-hosted policies item union: references (id string / link /
// per-app overrides) plus application-owned inline policies
// (`InlineAccessPolicy`, added to distilled's model — the API docs only
// carry the inline arm for infrastructure apps, but the live API accepts
// it for self_hosted).
type RequestPolicy =
  zeroTrust.AccessApplicationsCreateForAccountRequestPoliciesSelfHostedApplicationItem;

interface AppMutableBody {
  domain?: string;
  destinations?: ReadonlyArray<ApplicationDestination>;
  oauthConfiguration?: OAuthConfiguration;
  type: ApplicationType;
  name?: string;
  sessionDuration?: string;
  allowedIdps?: ReadonlyArray<string>;
  autoRedirectToIdentity?: boolean;
  appLauncherVisible?: boolean;
  tags?: ReadonlyArray<string>;
  policies?: ReadonlyArray<ResolvedPolicy>;
}

const policyIdOf = (p: ResolvedPolicy): string | undefined =>
  typeof p === "string" ? p : p.id;

const toRequestPolicy = (p: ResolvedPolicy): RequestPolicy => {
  if (typeof p === "string") return p;
  if (isInlinePolicy(p)) {
    return {
      // `id` present when this inline body updates an observed
      // application-owned policy in place (attachObservedPolicyIds).
      id: p.id,
      decision: p.decision,
      include: normalizePolicyRules(
        p.include,
      ) as zeroTrust.InlineAccessPolicy["include"],
      exclude: normalizePolicyRules(
        p.exclude,
      ) as zeroTrust.InlineAccessPolicy["exclude"],
      require: normalizePolicyRules(
        p.require,
      ) as zeroTrust.InlineAccessPolicy["require"],
      name: p.name,
      precedence: p.precedence,
      sessionDuration: p.sessionDuration,
      approvalRequired: p.approvalRequired,
      approvalGroups:
        p.approvalGroups === undefined
          ? undefined
          : p.approvalGroups.map((g) => ({
              approvalsNeeded: g.approvalsNeeded,
              emailAddresses:
                g.emailAddresses === undefined
                  ? undefined
                  : Array.from(g.emailAddresses),
              emailListUuid: g.emailListUuid,
            })),
      isolationRequired: p.isolationRequired,
      purposeJustificationRequired: p.purposeJustificationRequired,
      purposeJustificationPrompt: p.purposeJustificationPrompt,
    } satisfies zeroTrust.InlineAccessPolicy;
  }
  // The simple `{ id, precedence? }` form lacks the per-app override fields;
  // narrow once to a permissive view so we can copy them through uniformly.
  const rich = p as {
    id: string;
    precedence?: number;
    approvalRequired?: boolean;
    isolationRequired?: boolean;
    purposeJustificationRequired?: boolean;
    purposeJustificationPrompt?: string;
    sessionDuration?: string;
    approvalGroups?: ReadonlyArray<{
      approvalsNeeded: number;
      emailAddresses?: ReadonlyArray<string>;
      emailListUuid?: string;
    }>;
  };
  return {
    id: rich.id,
    precedence: rich.precedence,
    approvalRequired: rich.approvalRequired,
    isolationRequired: rich.isolationRequired,
    purposeJustificationRequired: rich.purposeJustificationRequired,
    purposeJustificationPrompt: rich.purposeJustificationPrompt,
    sessionDuration: rich.sessionDuration,
    approvalGroups:
      rich.approvalGroups === undefined
        ? undefined
        : rich.approvalGroups.map((g) => ({
            approvalsNeeded: g.approvalsNeeded,
            emailAddresses:
              g.emailAddresses === undefined
                ? undefined
                : Array.from(g.emailAddresses),
            emailListUuid: g.emailListUuid,
          })),
  };
};

const toRequestPolicies = (
  policies: ReadonlyArray<ResolvedPolicy> | undefined,
): Array<RequestPolicy> | undefined =>
  policies === undefined ? undefined : policies.map(toRequestPolicy);

const mergeOAuthConfiguration = (
  observed: OAuthConfiguration | undefined,
  desired: OAuthConfiguration | undefined,
): OAuthConfiguration | undefined => {
  if (desired === undefined) return observed;
  return {
    enabled: desired.enabled ?? observed?.enabled,
    grant:
      desired.grant === undefined
        ? observed?.grant
        : {
            accessTokenLifetime:
              desired.grant.accessTokenLifetime ??
              observed?.grant?.accessTokenLifetime,
            sessionDuration:
              desired.grant.sessionDuration ?? observed?.grant?.sessionDuration,
          },
    dynamicClientRegistration:
      desired.dynamicClientRegistration === undefined
        ? observed?.dynamicClientRegistration
        : {
            enabled:
              desired.dynamicClientRegistration.enabled ??
              observed?.dynamicClientRegistration?.enabled,
            allowedUris:
              desired.dynamicClientRegistration.allowedUris ??
              observed?.dynamicClientRegistration?.allowedUris,
            allowAnyOnLocalhost:
              desired.dynamicClientRegistration.allowAnyOnLocalhost ??
              observed?.dynamicClientRegistration?.allowAnyOnLocalhost,
            allowAnyOnLoopback:
              desired.dynamicClientRegistration.allowAnyOnLoopback ??
              observed?.dynamicClientRegistration?.allowAnyOnLoopback,
          },
  };
};

const toRequestOAuthConfiguration = (
  config: OAuthConfiguration | undefined,
): zeroTrust.CreateAccessApplicationForAccountRequest["oauthConfiguration"] =>
  config === undefined
    ? undefined
    : {
        enabled: config.enabled,
        grant: config.grant,
        dynamicClientRegistration:
          config.dynamicClientRegistration === undefined
            ? undefined
            : {
                ...config.dynamicClientRegistration,
                allowedUris:
                  config.dynamicClientRegistration.allowedUris === undefined
                    ? undefined
                    : Array.from(config.dynamicClientRegistration.allowedUris),
              },
      };

const resolvePolicies = (
  policies: ApplicationProps["policies"],
): ReadonlyArray<ResolvedPolicy> | undefined =>
  policies === undefined
    ? undefined
    : // Inputs are concrete values here — the Plan layer resolved them
      // before the reconciler ran. A whole `Access.Policy` resource resolves
      // to its Attributes; normalize it to the bare policy id so everything
      // downstream (diffing, request building) sees one shape.
      (policies as ReadonlyArray<ResolvedPolicy | { policyId: string }>).map(
        (p) => (typeof p !== "string" && "policyId" in p ? p.policyId : p),
      );

const buildMutableBody = (
  news: ApplicationProps,
  resolvedName: string,
  resolvedAllowedIdps: ReadonlyArray<string> | undefined,
  resolvedPolicies: ReadonlyArray<ResolvedPolicy> | undefined,
): AppMutableBody => {
  const body: AppMutableBody = {
    type: news.type,
    name: resolvedName,
  };
  // Warp apps cannot accept a user-supplied domain — Cloudflare derives it.
  if (news.type !== "warp" && news.domain !== undefined) {
    body.domain = news.domain;
  }
  if (news.destinations !== undefined) {
    body.destinations = news.destinations;
  }
  if (news.oauthConfiguration !== undefined) {
    body.oauthConfiguration = news.oauthConfiguration;
  }
  if (news.sessionDuration !== undefined) {
    body.sessionDuration = news.sessionDuration;
  }
  if (resolvedAllowedIdps !== undefined) {
    body.allowedIdps = resolvedAllowedIdps;
  }
  if (news.autoRedirectToIdentity !== undefined) {
    body.autoRedirectToIdentity = news.autoRedirectToIdentity;
  }
  if (news.appLauncherVisible !== undefined) {
    body.appLauncherVisible = news.appLauncherVisible;
  }
  if (news.tags !== undefined) {
    body.tags = news.tags;
  }
  if (resolvedPolicies !== undefined) {
    body.policies = resolvedPolicies;
  }
  return body;
};

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

const jsonEq = <T>(x: T, y: T): boolean =>
  JSON.stringify(x) === JSON.stringify(y);

const oauthConfigurationEquals = (
  desired: OAuthConfiguration | undefined,
  observed: OAuthConfiguration | undefined,
): boolean => {
  if (desired === undefined) return true;
  if (observed === undefined) return false;
  if (desired.enabled !== undefined && desired.enabled !== observed.enabled) {
    return false;
  }

  const desiredGrant = desired.grant;
  if (desiredGrant?.accessTokenLifetime !== undefined) {
    if (
      desiredGrant.accessTokenLifetime !== observed.grant?.accessTokenLifetime
    ) {
      return false;
    }
  }
  if (desiredGrant?.sessionDuration !== undefined) {
    if (desiredGrant.sessionDuration !== observed.grant?.sessionDuration) {
      return false;
    }
  }

  const desiredRegistration = desired.dynamicClientRegistration;
  const observedRegistration = observed.dynamicClientRegistration;
  if (
    desiredRegistration?.enabled !== undefined &&
    desiredRegistration.enabled !== observedRegistration?.enabled
  ) {
    return false;
  }
  if (
    desiredRegistration?.allowAnyOnLocalhost !== undefined &&
    desiredRegistration.allowAnyOnLocalhost !==
      observedRegistration?.allowAnyOnLocalhost
  ) {
    return false;
  }
  if (
    desiredRegistration?.allowAnyOnLoopback !== undefined &&
    desiredRegistration.allowAnyOnLoopback !==
      observedRegistration?.allowAnyOnLoopback
  ) {
    return false;
  }
  if (
    desiredRegistration?.allowedUris !== undefined &&
    !arrayEquals(
      [...desiredRegistration.allowedUris].sort(),
      [...(observedRegistration?.allowedUris ?? [])].sort(),
      jsonEq,
    )
  ) {
    return false;
  }
  return true;
};

const policiesEq = (
  desired: ReadonlyArray<ResolvedPolicy> | undefined,
  observed: ReadonlyArray<ObservedPolicy> | undefined,
): boolean => {
  if (desired === undefined && observed === undefined) return true;
  if (desired === undefined || observed === undefined) {
    // An explicit empty `[]` should be honoured; nothing observed and
    // nothing desired collapses to "in sync".
    return (desired ?? []).length === 0 && (observed ?? []).length === 0;
  }
  if (desired.length !== observed.length) return false;
  for (let i = 0; i < desired.length; i++) {
    const d = desired[i];
    const o = observed[i];
    if (typeof d !== "string" && isInlinePolicy(d)) {
      // Inline (application-owned) policy: compare the fields the caller
      // set against the observed policy body. Cloudflare echoes rule
      // objects structurally, so JSON equality is stable; getting this
      // wrong is costly — a false inequality re-PUTs the policy list and
      // id-less inline items would mint fresh policies every deploy.
      if (o.reusable === true) return false;
      if (d.decision !== o.decision) return false;
      // Compare in wire shape: the caller may have used the scalar
      // shorthand while Cloudflare echoes expanded rules.
      const include = normalizePolicyRules(d.include);
      if (!jsonEq(include, (o.include ?? []) as typeof include)) {
        return false;
      }
      const exclude = normalizePolicyRules(d.exclude);
      if (
        exclude !== undefined &&
        !jsonEq(exclude, (o.exclude ?? []) as typeof exclude)
      ) {
        return false;
      }
      const require = normalizePolicyRules(d.require);
      if (
        require !== undefined &&
        !jsonEq(require, (o.require ?? []) as typeof require)
      ) {
        return false;
      }
      if (d.name !== undefined && d.name !== o.name) return false;
      if (
        d.precedence !== undefined &&
        o.precedence !== undefined &&
        d.precedence !== o.precedence
      ) {
        return false;
      }
      if (
        d.sessionDuration !== undefined &&
        d.sessionDuration !== o.sessionDuration
      ) {
        return false;
      }
      if (
        d.approvalRequired !== undefined &&
        d.approvalRequired !== (o.approvalRequired ?? false)
      ) {
        return false;
      }
      if (
        d.isolationRequired !== undefined &&
        d.isolationRequired !== (o.isolationRequired ?? false)
      ) {
        return false;
      }
      if (
        d.purposeJustificationRequired !== undefined &&
        d.purposeJustificationRequired !==
          (o.purposeJustificationRequired ?? false)
      ) {
        return false;
      }
      continue;
    }
    // Reference forms: an observed application-owned policy can never
    // satisfy a reusable reference.
    if (o.reusable === false) return false;
    if (policyIdOf(d) !== o.id) return false;
    if (typeof d !== "string") {
      if (
        d.precedence !== undefined &&
        o.precedence !== undefined &&
        d.precedence !== o.precedence
      ) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Zip desired inline policies with the observed application-owned policies
 * so an update PUT carries their ids and updates them in place — an id-less
 * inline item in an update creates a brand-new policy (and drops the old
 * one), churning policy ids on every deploy that touches any app field.
 * Positional matching, guarded on `reusable === false` (never attach a
 * reusable policy's id to an inline body — that would mutate the shared
 * policy) and on a matching decision.
 */
const attachObservedPolicyIds = (
  desired: ReadonlyArray<ResolvedPolicy> | undefined,
  observed: ReadonlyArray<ObservedPolicy> | undefined,
): ReadonlyArray<ResolvedPolicy> | undefined =>
  desired === undefined || observed === undefined
    ? desired
    : desired.map((p, i) => {
        const o = observed[i];
        return typeof p !== "string" &&
          isInlinePolicy(p) &&
          p.id === undefined &&
          o?.id !== undefined &&
          o.reusable === false &&
          o.decision === p.decision
          ? { ...p, id: o.id }
          : p;
      });

const bodyEqualsObserved = (
  desired: AppMutableBody,
  observed: ObservedApp,
): boolean => {
  if (desired.name !== undefined && desired.name !== observed.name) {
    return false;
  }
  // Only diff domain when caller actually set one (warp's auto-derived
  // domain must not trigger a perpetual update loop).
  if (desired.domain !== undefined && desired.domain !== observed.domain) {
    return false;
  }
  // Same rule for destinations — Cloudflare may echo back an enriched
  // shape (e.g. server-assigned `vnetId`); we only diff when the caller
  // explicitly set them.
  if (
    desired.destinations !== undefined &&
    JSON.stringify(desired.destinations) !==
      JSON.stringify(observed.destinations ?? [])
  ) {
    return false;
  }
  if (
    !oauthConfigurationEquals(
      desired.oauthConfiguration,
      observed.oauthConfiguration,
    )
  ) {
    return false;
  }
  if (
    desired.sessionDuration !== undefined &&
    desired.sessionDuration !== observed.sessionDuration
  ) {
    return false;
  }
  if (
    desired.autoRedirectToIdentity !== undefined &&
    desired.autoRedirectToIdentity !== observed.autoRedirectToIdentity
  ) {
    return false;
  }
  if (
    desired.appLauncherVisible !== undefined &&
    desired.appLauncherVisible !== observed.appLauncherVisible
  ) {
    return false;
  }
  if (
    desired.allowedIdps !== undefined &&
    !arrayEquals(desired.allowedIdps, observed.allowedIdps, jsonEq)
  ) {
    return false;
  }
  if (
    desired.tags !== undefined &&
    !arrayEquals(desired.tags, observed.tags, jsonEq)
  ) {
    return false;
  }
  if (!policiesEq(desired.policies, observed.policies)) {
    return false;
  }
  return true;
};
