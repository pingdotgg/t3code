import * as Neon from "@distilled.cloud/neon";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationSpendingLimitProps {
  /** Existing Neon organization ID. Restore and remove this control before changing organizations. */
  orgId: string;
  /** Positive integer monthly alert threshold in cents; zero and null are not supported. */
  spendingLimitCents: number;
}

export interface OrganizationSpendingLimitAttributes {
  /** Organization whose billing alert is managed. */
  orgId: string;
  /** Observed monthly threshold in cents, or null when no threshold is configured. */
  spendingLimitCents: number | null;
  /** Original threshold captured before adoption; null means Alchemy created the threshold. */
  initialSpendingLimitCents: number | null;
  /** Last managed threshold, retained across refreshes to detect external changes on destroy. */
  managedSpendingLimitCents: number | null;
}

export interface OrganizationSpendingLimit extends Resource<
  "Neon.OrganizationSpendingLimit",
  OrganizationSpendingLimitProps,
  OrganizationSpendingLimitAttributes,
  never,
  Providers
> {}

/**
 * Manage an ALERT-ONLY monthly spending threshold on an existing organization.
 * Neon emails at 80% and 100%; reaching the threshold NEVER stops compute or
 * enforces a hard budget. Requires an organization admin on Launch or Scale.
 * This resource does not create or delete organizations.
 *
 * Existing thresholds require explicit, preferably resource-scoped adoption.
 * The engine durably captures the original threshold, including an absent
 * (null) threshold, before the first write; destroy restores it. A newly created
 * threshold is removed on destroy. All initial props must resolve during
 * planning so that this snapshot can be persisted before reconciliation.
 * Initial unresolved props or missing snapshots fail safely without mutation;
 * first deploy with resolved values, then update using dependent values.
 * Restore and remove this control before targeting another organization.
 * Replacement generations without a snapshot also fail safely; use a new
 * logical ID to plan a baseline for another organization before managing it.
 * Cleanup refuses external drift rather than overwriting somebody else's policy.
 * Keep the state store: losing it loses the ownership and restoration record.
 * The API has no conditional writes; serialize management of each organization.
 *
 * ### Set a billing alert
 * **Example:** Adopt only this organization's existing threshold
 * ```typescript
 * const alert = yield* Neon.OrganizationSpendingLimit("BillingAlert", {
 *   orgId: "org-example-12345678",
 *   spendingLimitCents: 10000,
 * }).pipe(Alchemy.adopt(true));
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationSpendingLimit = Resource<OrganizationSpendingLimit>(
  "Neon.OrganizationSpendingLimit",
);

export class InvalidOrganizationSpendingLimit extends Data.TaggedError(
  "InvalidOrganizationSpendingLimit",
)<{
  /** Invalid configuration or unsafe cleanup condition. */
  message: string;
}> {}

/** @internal */
export const validateOrganizationSpendingLimit = (
  props: OrganizationSpendingLimitProps,
) =>
  /^[a-z0-9-]{1,60}$/.test(props.orgId) &&
  Number.isSafeInteger(props.spendingLimitCents) &&
  props.spendingLimitCents > 0
    ? Effect.void
    : Effect.fail(
        new InvalidOrganizationSpendingLimit({
          message:
            "An organization ID and a positive safe integer threshold in cents are required",
        }),
      );

const observe = (orgId: string) =>
  Neon.getOrganizationSpendingLimit({ org_id: orgId }).pipe(
    Effect.map((value) => value.spending_limit_cents),
  );

/** Preserve the original baseline and last managed value across refreshes. @internal */
export const organizationSpendingLimitSnapshot = (
  orgId: string,
  spendingLimitCents: number | null,
  output?: OrganizationSpendingLimitAttributes,
): OrganizationSpendingLimitAttributes => {
  if (output) return { ...output, spendingLimitCents };
  const snapshot = {
    orgId,
    spendingLimitCents,
    initialSpendingLimitCents: spendingLimitCents,
    managedSpendingLimitCents: spendingLimitCents,
  };
  return spendingLimitCents === null ? snapshot : Unowned(snapshot);
};

export const OrganizationSpendingLimitProvider = () =>
  Provider.succeed(OrganizationSpendingLimit, {
    nuke: { singleton: true },
    stables: ["orgId", "initialSpendingLimitCents"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return;
      if (news.orgId !== (output?.orgId ?? olds.orgId)) {
        return yield* new InvalidOrganizationSpendingLimit({
          message:
            "Restore and remove the existing spending control before changing organizations; the new organization requires a separately persisted baseline",
        });
      }
      yield* validateOrganizationSpendingLimit(news);
      if ((yield* observe(news.orgId)) !== news.spendingLimitCents) {
        return { action: "update" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const orgId = output?.orgId ?? olds?.orgId;
      if (!orgId) return;
      const value = yield* observe(orgId);
      return organizationSpendingLimitSnapshot(orgId, value, output);
    }),
    reconcile: Effect.fn(function* ({ news, output, olds }) {
      yield* validateOrganizationSpendingLimit(news);
      if (
        !output ||
        output.initialSpendingLimitCents === undefined ||
        output.managedSpendingLimitCents === undefined
      ) {
        return yield* new InvalidOrganizationSpendingLimit({
          message:
            "A persisted spending baseline is required before mutation; resolve all initial props during planning",
        });
      }
      if (output.orgId !== news.orgId) {
        return yield* new InvalidOrganizationSpendingLimit({
          message: "Organization identity changed without replacement",
        });
      }
      const observed = yield* observe(news.orgId);
      if (
        !olds &&
        observed !== output.managedSpendingLimitCents &&
        observed !== news.spendingLimitCents
      ) {
        return yield* new InvalidOrganizationSpendingLimit({
          message:
            "Spending threshold changed since its adoption baseline was captured",
        });
      }
      if (observed !== news.spendingLimitCents) {
        yield* Neon.setOrganizationSpendingLimit({
          org_id: news.orgId,
          spending_limit_cents: news.spendingLimitCents,
        });
      }
      const value = yield* observe(news.orgId);
      if (value !== news.spendingLimitCents) {
        return yield* new InvalidOrganizationSpendingLimit({
          message: "Spending threshold changed during reconciliation",
        });
      }
      return {
        orgId: news.orgId,
        spendingLimitCents: value,
        initialSpendingLimitCents: output.initialSpendingLimitCents,
        managedSpendingLimitCents: news.spendingLimitCents,
      };
    }),
    delete: Effect.fn(function* ({ output, olds }) {
      const observed = yield* observe(output.orgId);
      if (observed === output.initialSpendingLimitCents) return;
      if (
        observed !== output.managedSpendingLimitCents &&
        observed !== olds.spendingLimitCents
      ) {
        return yield* new InvalidOrganizationSpendingLimit({
          message:
            "Refusing to overwrite an externally changed spending threshold during cleanup",
        });
      }
      if (output.initialSpendingLimitCents === null) {
        yield* Neon.deleteOrganizationSpendingLimit({ org_id: output.orgId });
      } else {
        yield* Neon.setOrganizationSpendingLimit({
          org_id: output.orgId,
          spending_limit_cents: output.initialSpendingLimitCents,
        });
      }
    }),
  });
