import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.RiskScoring.Integration" as const;
type TypeId = typeof TypeId;

export interface IntegrationProps {
  /**
   * The third-party SOAR/SSF consumer of risk-score changes. Only
   * `Okta` is supported by the API today.
   * @default "Okta"
   */
  integrationType?: "Okta";
  /**
   * The base URL of the tenant that receives risk-score changes, e.g.
   * `https://tenant.okta.com`. Mutable — updated in place via PUT.
   */
  tenantUrl: string;
  /**
   * A reference id supplied by the client. Cloudflare recommends setting
   * it to the Access-Okta identity provider ID (a UUIDv4) so the
   * integration can be recalled by that secondary asset.
   */
  referenceId?: string;
  /**
   * Whether the integration exports risk-score changes to the
   * third-party. Only togglable after create (the create API always
   * provisions an active integration).
   * @default true
   */
  active?: boolean;
}

export type IntegrationAttributes = {
  /** API UUID of the integration. */
  integrationId: string;
  /** Account that owns the integration. */
  accountId: string;
  /** The third-party consumer of risk-score changes. */
  integrationType: "Okta";
  /** Observed tenant base URL. */
  tenantUrl: string;
  /** Observed client-supplied reference id. */
  referenceId: string;
  /** Whether risk-score changes are exported. */
  active: boolean;
  /** The Shared Signals Framework configuration URL. */
  wellKnownUrl: string;
  /** RFC 3339 timestamp of when the integration was created. */
  createdAt: string;
};

export type Integration = Resource<
  TypeId,
  IntegrationProps,
  IntegrationAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust **risk scoring integration** — a Shared
 * Signals Framework (SSF) push integration that exports user risk-score
 * changes to a third-party tenant (currently Okta) so the IdP can react
 * to risky behavior detected by Zero Trust.
 *
 * Requires the Zero Trust risk-scoring entitlement (an Enterprise
 * feature); accounts without it receive the typed `Forbidden` error on
 * all writes.
 * @resource
 * @product Risk Scoring
 * @category Cloudflare One (Zero Trust)
 * @section Creating a risk scoring integration
 * @example Push risk scores to an Okta tenant
 * ```typescript
 * const okta = yield* Cloudflare.RiskScoring.Integration("OktaSsf", {
 *   tenantUrl: "https://tenant.okta.com",
 *   referenceId: oktaIdp.identityProviderId,
 * });
 * ```
 *
 * @example Pause exporting without deleting
 * ```typescript
 * const okta = yield* Cloudflare.RiskScoring.Integration("OktaSsf", {
 *   tenantUrl: "https://tenant.okta.com",
 *   active: false,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/insights/risk-score/
 */
export const Integration = Resource<Integration>(TypeId);

/**
 * Returns true if the given value is a Integration resource.
 */
export const isIntegration = (value: unknown): value is Integration =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IntegrationProvider = () =>
  Provider.succeed(Integration, {
    stables: ["integrationId", "accountId", "integrationType", "createdAt"],

    read: Effect.fn(function* ({ output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      if (output?.integrationId) {
        const observed = yield* observeIntegration(acct, output.integrationId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // Cold lookup by tenant URL. Integrations carry no ownership
      // markers — brand the match `Unowned`.
      const tenantUrl = olds?.tenantUrl;
      if (tenantUrl === undefined) return undefined;
      const match = yield* findByTenantUrl(acct, tenantUrl);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;

      // 1. Observe — cached id is a hint; fall back to a tenant-URL scan
      //    so a crashed prior run converges.
      let observed = output?.integrationId
        ? yield* observeIntegration(accountId, output.integrationId)
        : undefined;
      if (!observed) {
        observed = yield* findByTenantUrl(accountId, news.tenantUrl);
      }

      // 2. Ensure — create when missing. Create always provisions an
      //    active integration; the sync step below applies `active: false`.
      if (!observed) {
        observed = yield* zeroTrust.createRiskScoringIntegration({
          accountId,
          integrationType: news.integrationType ?? "Okta",
          tenantUrl: news.tenantUrl,
          ...(news.referenceId !== undefined
            ? { referenceId: news.referenceId }
            : {}),
        });
      }

      // 3. Sync — PUT the full desired state when the observed state
      //    differs; skip the call on a no-op.
      const desiredActive = news.active ?? true;
      const dirty =
        observed.tenantUrl !== news.tenantUrl ||
        observed.active !== desiredActive ||
        (news.referenceId !== undefined &&
          observed.referenceId !== news.referenceId);
      if (!dirty) {
        return toAttributes(observed, accountId);
      }
      const updated = yield* zeroTrust.updateRiskScoringIntegration({
        accountId,
        integrationId: observed.id,
        active: desiredActive,
        tenantUrl: news.tenantUrl,
        ...(news.referenceId !== undefined
          ? { referenceId: news.referenceId }
          : {}),
      });
      return toAttributes(updated, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* zeroTrust
        .deleteRiskScoringIntegration({
          accountId: output.accountId,
          integrationId: output.integrationId,
        })
        .pipe(
          Effect.catchTag("RiskScoringIntegrationNotFound", () => Effect.void),
        );
    }),

    // Account collection (pattern b). Enumerate every risk-scoring
    // integration in the ambient account, exhaustively paginating the
    // distilled list op. Accounts lacking the Zero Trust risk-scoring
    // entitlement reject the route with a typed `Forbidden` — treat that
    // as "nothing to list" and return [].
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listRiskScoringIntegrations
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((integration) =>
                toAttributes(integration, accountId),
              ),
            ),
          ),
          Effect.catchTag("Forbidden", () => Effect.succeed([])),
        );
    }),
  });

/**
 * Structural shape shared by get/list/create/update responses.
 */
type ObservedIntegration = {
  id: string;
  active: boolean;
  createdAt: string;
  integrationType: "Okta";
  referenceId: string;
  tenantUrl: string;
  wellKnownUrl: string;
};

/**
 * Read an integration by id, mapping "gone" to `undefined`.
 */
const observeIntegration = (accountId: string, integrationId: string) =>
  zeroTrust
    .getRiskScoringIntegration({ accountId, integrationId })
    .pipe(
      Effect.catchTag("RiskScoringIntegrationNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

/**
 * Find an integration by exact tenant URL.
 */
const findByTenantUrl = (accountId: string, tenantUrl: string) =>
  zeroTrust
    .listRiskScoringIntegrations({ accountId })
    .pipe(
      Effect.map((list) => list.result.find((i) => i.tenantUrl === tenantUrl)),
    );

const toAttributes = (
  integration: ObservedIntegration,
  accountId: string,
): IntegrationAttributes => ({
  integrationId: integration.id,
  accountId,
  integrationType: integration.integrationType,
  tenantUrl: integration.tenantUrl,
  referenceId: integration.referenceId,
  active: integration.active,
  wellKnownUrl: integration.wellKnownUrl,
  createdAt: integration.createdAt,
});
