import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEquals } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

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
 * Cloudflare supports three destination flavours:
 * - `public` — a public hostname/URI you own in Cloudflare (the legacy
 *   `domain` field on `ApplicationProps` covers the simple case).
 * - `private` — a hostname or CIDR reachable through a Cloudflare Tunnel.
 *   Traffic from WARP-enrolled devices is intercepted and forwarded
 *   through the tunnel; identity is enforced before forwarding.
 * - `via_mcp_server_portal` — routes via a managed MCP server portal.
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
  | { type: "via_mcp_server_portal"; mcpServerId: string };

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
   * Reusable Access policies that gate access to this application, in
   * ascending order of precedence. Author each policy with the
   * `Cloudflare.Access.Policy` resource and pass `policy.policyId` (or a bare
   * policy UUID) here — Access applications no longer accept inline policy
   * bodies in this provider.
   *
   * Each entry can be:
   * - a policy id (`string`),
   * - `{ id, precedence? }`, or
   * - the same with per-application overrides (`approvalRequired`,
   *   `isolationRequired`, `purposeJustificationRequired`,
   *   `purposeJustificationPrompt`, `sessionDuration`, `approvalGroups`).
   */
  policies?: ReadonlyArray<
    | string
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

export type Application = Resource<
  "Cloudflare.Access.Application",
  ApplicationProps,
  ApplicationAttributes,
  never,
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
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating an Application
 * @example Self-hosted application gated by a reusable Access policy
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
 *   policies: [allowMyOrg.policyId],
 * });
 * ```
 *
 * @section Device-enrollment (warp)
 * @example WARP device-enrollment application
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
 *   policies: [allowCorp.policyId],
 * });
 * ```
 *
 * @section Self-hosted with Google IdP
 * @example Self-hosted application restricted to a Google Workspace group
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
 *   policies: [admins.policyId],
 * });
 * ```
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
      const domain = observed.domain ?? output?.domain ?? olds?.domain;
      const name = observed.name ?? output?.name;
      if (domain === undefined || name === undefined) {
        return undefined;
      }
      const attrs = {
        applicationId: observed.id,
        aud: observed.aud,
        domain,
        destinations: observed.destinations ?? output?.destinations,
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const resolvedName = yield* resolveName(id, news.name);
      const resolvedIdps = resolveAllowedIdps(news.allowedIdps);
      const resolvedPolicies = resolvePolicies(news.policies);
      const body = buildMutableBody(
        news,
        resolvedName,
        resolvedIdps,
        resolvedPolicies,
      );

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
            // Cloudflare requires a `domain` body field, but ignores it for
            // warp (auto-set). Sending an empty string is safe and keeps
            // distilled's request shape valid for the non-warp case where
            // the caller forgot to pass one — server validation will then
            // reject with a clear error rather than a TypeScript surprise.
            domain: body.domain ?? "",
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
            domain: body.domain ?? observed.domain ?? "",
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
        // Distilled only tags transport errors (Unauthorized,
        // ServiceUnavailable, etc.); the live Cloudflare 404 surfaces as
        // an untagged error. Swallow generically so observe falls through
        // to recreate.
        Effect.catch(() => Effect.succeed(undefined)),
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
}

interface ObservedApp {
  readonly id?: string;
  readonly aud?: string;
  readonly name?: string;
  readonly type?: ApplicationType;
  readonly domain?: string;
  readonly destinations?: ReadonlyArray<ApplicationDestination>;
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

const narrowApp = (raw: {
  id?: string | null;
  aud?: string | null;
  name?: string | null;
  type?: ApplicationType | null | string;
  domain?: string | null;
  destinations?: ReadonlyArray<unknown> | null;
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

type ResolvedPolicy =
  | string
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

// Distilled now types `policies` as `Array<refOrId> | Array<inlinePolicy>` —
// a union at the array level. We only ever emit the references form, so
// exclude the inline arm (discriminated by its required `decision` field)
// to keep `Array<RequestPolicy>` assignable to distilled's first arm.
type RequestPolicy = Exclude<
  NonNullable<
    zeroTrust.CreateAccessApplicationForAccountRequest["policies"]
  >[number],
  { decision: unknown }
>;

interface AppMutableBody {
  domain?: string;
  destinations?: ReadonlyArray<ApplicationDestination>;
  type: ApplicationType;
  name?: string;
  sessionDuration?: string;
  allowedIdps?: ReadonlyArray<string>;
  autoRedirectToIdentity?: boolean;
  appLauncherVisible?: boolean;
  tags?: ReadonlyArray<string>;
  policies?: ReadonlyArray<ResolvedPolicy>;
}

const policyIdOf = (p: ResolvedPolicy): string =>
  typeof p === "string" ? p : p.id;

const toRequestPolicy = (p: ResolvedPolicy): RequestPolicy => {
  if (typeof p === "string") return p;
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

const resolvePolicies = (
  policies: ApplicationProps["policies"],
): ReadonlyArray<ResolvedPolicy> | undefined =>
  policies === undefined
    ? undefined
    : // Inputs are concrete strings here — the Plan layer resolved them
      // before the reconciler ran.
      (policies as ReadonlyArray<ResolvedPolicy>);

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
