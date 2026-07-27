import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * One arm of a Cloudflare Access policy rule discriminated union. A rule is a
 * single-key object whose key selects the rule kind (`email`, `emailDomain`,
 * `everyone`, `ip`, etc.) and whose value carries the rule's parameters.
 *
 * Re-exported from `@distilled.cloud/cloudflare/zero-trust`'s
 * `CreateAccessPolicyRequest` so the full Cloudflare rule surface is available
 * without re-declaring the union.
 */
export type PolicyRule = zeroTrust.CreateAccessPolicyRequest["include"][number];

/**
 * Decision Cloudflare Access takes when a request matches this policy.
 *
 * - `"allow"` — admit the user.
 * - `"deny"` — block the user.
 * - `"non_identity"` — admit without requiring an identity provider login.
 * - `"bypass"` — skip Access entirely.
 */
export type PolicyDecision =
  | "allow"
  | "deny"
  | "non_identity"
  | "bypass"
  // Match distilled's open-ended literal union so Cloudflare-returned values
  // outside the closed set still narrow cleanly.
  | (string & {});

export type PolicyProps = {
  /**
   * Display name for the policy. Treated as a stable identifier so the
   * provider can locate the policy by name during adoption / state recovery.
   * If omitted, a unique name is generated from the stack/stage/logical id.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Decision the policy enforces when its rules match. Changing the decision
   * triggers replacement.
   */
  decision: PolicyDecision;
  /**
   * Rules combined with logical OR. A request must satisfy at least one
   * include rule for the policy to match. Required and must be non-empty.
   */
  include: Policy.RuleGroup[];
  /**
   * Rules combined with logical NOT. A request matching any exclude rule is
   * rejected by the policy even if it satisfied an include rule.
   */
  exclude?: Policy.RuleGroup[];
  /**
   * Rules combined with logical AND. A request must satisfy every require
   * rule in addition to an include rule.
   */
  require?: Policy.RuleGroup[];
  /**
   * Duration of issued session tokens. Format: `300ms`, `2h45m`, etc. When
   * unset, applications using this policy fall back to their own configured
   * session duration.
   */
  sessionDuration?: string;
  /**
   * When true, Access requires an administrator to approve each authentication
   * request before the user is admitted.
   *
   * @default false
   */
  approvalRequired?: boolean;
  /**
   * When true, users must enter a justification when logging in to any
   * application that consumes this policy.
   *
   * @default false
   */
  purposeJustificationRequired?: boolean;
  /**
   * Adopt an existing reusable policy with the same name when the engine has
   * no prior state for this logical id.
   *
   * @default false
   */
  adopt?: boolean;
};

export declare namespace Policy {
  /**
   * A single Access policy rule. See {@link PolicyRule} for the full
   * discriminated union (email, emailDomain, everyone, ip, ipList, group,
   * gsuite, githubOrganization, okta, azureAD, saml, oidc, deviceCheck via
   * `devicePosture`, externalEvaluation, etc.).
   */
  export type RuleGroup = PolicyRule;
}

export type Policy = Resource<
  "Cloudflare.Access.Policy",
  PolicyProps,
  {
    /** UUID of the policy assigned by Cloudflare. */
    policyId: string;
    /** Display name reported by Cloudflare. */
    name: string;
    /** Decision the policy enforces. */
    decision: string;
    /** Cloudflare account that owns the policy. */
    accountId: string;
    /** Creation timestamp reported by Cloudflare, when available. */
    createdAt: string | undefined;
    /** Last-modified timestamp reported by Cloudflare, when available. */
    updatedAt: string | undefined;
  },
  never,
  Providers
>;

/**
 * A reusable, account-scoped Cloudflare Access policy. Distinct from the
 * inline policies attached directly to an `Application` — a reusable
 * policy can be referenced by multiple applications by id.
 * @resource
 * @product Access
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Policy
 * @example Allow a single email domain
 * ```typescript
 * const policy = yield* Cloudflare.Access.Policy("AllowExampleDomain", {
 *   decision: "allow",
 *   include: [{ emailDomain: { domain: "example.com" } }],
 * });
 * ```
 *
 * @example Allow everyone but require purpose justification
 * ```typescript
 * const policy = yield* Cloudflare.Access.Policy("OpenWithJustification", {
 *   decision: "allow",
 *   include: [{ everyone: {} }],
 *   purposeJustificationRequired: true,
 *   sessionDuration: "12h",
 * });
 * ```
 *
 * @section Combining rule groups
 * @example Include + exclude + require
 * ```typescript
 * const policy = yield* Cloudflare.Access.Policy("EngineersExceptInterns", {
 *   decision: "allow",
 *   include: [{ emailDomain: { domain: "example.com" } }],
 *   exclude: [{ email: { email: "intern@example.com" } }],
 *   require: [{ geo: { countryCode: "US" } }],
 * });
 * ```
 */
export const Policy = Resource<Policy>("Cloudflare.Access.Policy", {
  aliases: ["Cloudflare.AccessPolicy"],
});

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: ["policyId", "accountId", "decision"],
    diff: Effect.fn(function* ({ id, olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldName = output?.name ?? (yield* createPolicyName(id, olds.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const name = news.name ?? oldName;
      if (name !== oldName) {
        return { action: "replace" } as const;
      }
      const oldDecision = output?.decision ?? olds.decision;
      if (oldDecision && oldDecision !== news.decision) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {} as PolicyProps, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would target a different
      // resource if the generator's output for this id ever drifts.
      const name = yield* createPolicyName(id, news.name ?? output?.name);
      const acct = output?.accountId ?? accountId;

      // Observe — prefer cached policyId, fall back to a name lookup so
      // we recover from out-of-band deletes and partial state-persistence
      // failures.
      let observed: ObservedPolicy | undefined;
      if (output?.policyId) {
        observed = yield* zeroTrust
          .getAccessPolicy({
            accountId: acct,
            policyId: output.policyId,
          })
          .pipe(
            Effect.map(toObserved),
            Effect.catch(
              (): Effect.Effect<ObservedPolicy | undefined> =>
                Effect.succeed(undefined),
            ),
          );
      }
      if (!observed) {
        observed = yield* findPolicyByName(acct, name);
      }

      // Ensure — create the policy if missing. Tolerate a race where a
      // parallel actor created the same-named policy by re-observing.
      let ensured: ObservedPolicy;
      if (!observed || !observed.id) {
        ensured = yield* zeroTrust
          .createAccessPolicy({
            accountId: acct,
            name,
            decision: news.decision,
            include: news.include,
            exclude: news.exclude,
            require: news.require,
            sessionDuration: news.sessionDuration,
            approvalRequired: news.approvalRequired,
            purposeJustificationRequired: news.purposeJustificationRequired,
          })
          .pipe(
            Effect.map(toObserved),
            Effect.catch((err) =>
              Effect.gen(function* () {
                const existing = yield* findPolicyByName(acct, name);
                if (existing && existing.id) return existing;
                return yield* Effect.fail(err);
              }),
            ),
          );
      } else {
        // Sync — Cloudflare PUTs the policy as a whole replacement, so a
        // single update converges every mutable field. Always issuing the
        // PUT keeps the resource convergent against drift; the API is
        // idempotent for equal payloads.
        const prior = observed;
        const updated = yield* zeroTrust.updateAccessPolicy({
          accountId: acct,
          policyId: prior.id!,
          name,
          decision: news.decision,
          include: news.include,
          exclude: news.exclude,
          require: news.require,
          sessionDuration: news.sessionDuration,
          approvalRequired: news.approvalRequired,
          purposeJustificationRequired: news.purposeJustificationRequired,
        });
        ensured = {
          id: updated.id ?? prior.id,
          name: updated.name ?? prior.name,
          decision: updated.decision ?? prior.decision,
          createdAt: updated.createdAt ?? prior.createdAt,
          updatedAt: updated.updatedAt ?? prior.updatedAt,
        };
      }

      if (!ensured.id) {
        return yield* Effect.fail(
          new Error("Policy: ensured policy missing id"),
        );
      }
      return {
        policyId: ensured.id,
        name: ensured.name ?? name,
        decision: ensured.decision ?? news.decision,
        accountId: acct,
        createdAt: ensured.createdAt ?? undefined,
        updatedAt: ensured.updatedAt ?? undefined,
      };
    }),
    // Account-scoped collection (pattern (b)): enumerate every reusable
    // Access policy in the ambient account, exhaustively paginated, and
    // hydrate each into the exact `read` Attributes shape. Items missing the
    // mandatory id are skipped (typed per-item drop).
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listAccessPolicies.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).flatMap((raw) => {
              const observed = toObserved(raw as RawPolicy);
              if (!observed.id) return [];
              return [
                {
                  policyId: observed.id,
                  name: observed.name ?? "",
                  decision: observed.decision ?? "allow",
                  accountId,
                  createdAt: observed.createdAt ?? undefined,
                  updatedAt: observed.updatedAt ?? undefined,
                },
              ];
            }),
          ),
        ),
      );
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteAccessPolicy({
          accountId: output.accountId,
          policyId: output.policyId,
        })
        .pipe(Effect.catch((): Effect.Effect<void> => Effect.void));
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      if (output?.policyId) {
        const direct = yield* zeroTrust
          .getAccessPolicy({
            accountId: acct,
            policyId: output.policyId,
          })
          .pipe(
            Effect.catch(
              (): Effect.Effect<ObservedPolicy | undefined> =>
                Effect.succeed(undefined),
            ),
          );
        if (direct && direct.id) {
          return {
            policyId: direct.id,
            name: direct.name ?? output.name,
            decision: direct.decision ?? output.decision,
            accountId: acct,
            createdAt: direct.createdAt ?? output.createdAt,
            updatedAt: direct.updatedAt ?? output.updatedAt,
          };
        }
      }
      const name = yield* createPolicyName(id, olds?.name ?? output?.name);
      const existing = yield* findPolicyByName(acct, name);
      if (!existing || !existing.id) return undefined;
      return {
        policyId: existing.id,
        name: existing.name ?? name,
        decision: existing.decision ?? olds?.decision ?? "allow",
        accountId: acct,
        createdAt: existing.createdAt ?? undefined,
        updatedAt: existing.updatedAt ?? undefined,
      };
    }),
  });

const createPolicyName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id });
  });

const findPolicyByName = (acct: string, name: string) =>
  zeroTrust.listAccessPolicies.items({ accountId: acct }).pipe(
    Stream.filter((p): p is ObservedPolicy => p.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.catch(() => Effect.succeed(undefined)),
  );

type ObservedPolicy = {
  id?: string | null;
  name?: string | null;
  decision?: PolicyDecision | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

// Distilled response shapes (Get / Create / Update) all carry the same set
// of fields we care about, but typed wider than `ObservedPolicy`. Narrow at
// the API boundary so the rest of the reconciler stays in our shape.
type RawPolicy = {
  id?: string | null;
  name?: string | null;
  decision?: PolicyDecision | null | string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const toObserved = (r: RawPolicy): ObservedPolicy => ({
  id: r.id,
  name: r.name,
  decision: r.decision ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
