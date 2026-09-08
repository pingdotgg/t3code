import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import type { SuppressionListReason } from "./ConfigurationSet.ts";

/**
 * The scope of the tenant's suppression list: `ACCOUNT` shares the
 * account-level suppression list, `TENANT` maintains a separate list scoped to
 * this tenant.
 */
export type SuppressionListScope = sesv2.SuppressionListScope;

export interface TenantSuppressionSettings {
  /**
   * The bounce/complaint reasons for which SES adds destinations to the
   * tenant's suppression list.
   */
  reasons: SuppressionListReason[];
  /**
   * Whether the tenant uses the account-level suppression list (`ACCOUNT`) or
   * maintains its own tenant-scoped list (`TENANT`).
   */
  scope: SuppressionListScope;
}

export interface TenantProps {
  /**
   * Name of the tenant. If omitted, a deterministic physical name is generated
   * from the app, stage, and logical ID. Changing the name replaces the
   * tenant.
   */
  tenantName?: string;
  /**
   * The tenant's suppression list configuration, synced in place via
   * `putTenantSuppressionAttributes`. Leave undefined to keep SES's current
   * setting.
   *
   * `reasons` and `scope` are both required together: SES rejects a
   * suppression update carrying only one of them
   * (`BadRequestException: SuppressedReasons cannot be specified without
   * SuppressionScope`, and vice versa).
   */
  suppression?: TenantSuppressionSettings;
  /**
   * Tags to apply to the tenant. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Tenant extends Resource<
  "AWS.SES.Tenant",
  TenantProps,
  {
    /** Name of the tenant. */
    tenantName: string;
    /** Opaque tenant identifier assigned by SES. */
    tenantId: string;
    /** ARN of the tenant. */
    tenantArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 tenant — a logical container that groups related SES
 * resources (email identities, configuration sets, templates) together, each
 * with its own reputation metrics, sending status, and optional
 * tenant-scoped suppression list. Useful for isolating email sending across
 * customers or business units within a single SES account.
 *
 * Associate resources with a tenant using `SES.TenantResourceAssociation`.
 * Deleting the tenant removes its resource associations but leaves the
 * underlying resources in place.
 * ### Creating Tenants
 * **Example:** Basic Tenant
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const tenant = yield* SES.Tenant("CustomerA", {});
 * ```
 *
 * **Example:** Tenant with a Scoped Suppression List
 * ```typescript
 * // SES requires the reasons and the scope together, so they travel as one
 * // prop rather than two independently-optional ones.
 * const tenant = yield* SES.Tenant("CustomerA", {
 *   suppression: { reasons: ["BOUNCE", "COMPLAINT"], scope: "TENANT" },
 * });
 * ```
 *
 * **Example:** Tenant with Tags
 * ```typescript
 * const tenant = yield* SES.Tenant("CustomerA", {
 *   tags: { Customer: "acme", CostCenter: "growth" },
 * });
 * ```
 *
 * ### Associating Resources
 * **Example:** Give the Tenant an Identity, Config Set, and Template
 * ```typescript
 * const tenant = yield* SES.Tenant("CustomerA", {});
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "mail.acme.example.com",
 * });
 * const configSet = yield* SES.ConfigurationSet("AcmeTracking", {});
 *
 * // A resource must be associated before the tenant can send with it.
 * yield* SES.TenantResourceAssociation("AcmeIdentity", {
 *   tenantName: tenant.tenantName,
 *   resourceArn: identity.identityArn,
 * });
 * yield* SES.TenantResourceAssociation("AcmeConfigSet", {
 *   tenantName: tenant.tenantName,
 *   resourceArn: configSet.configurationSetArn,
 * });
 * ```
 *
 * ### Tenant Suppression Lists
 * **Example:** Read and Write the Tenant's Own Suppression List
 * ```typescript
 * // With scope "TENANT" the list is separate from the account's.
 * const tenant = yield* SES.Tenant("CustomerA", {
 *   suppression: { reasons: ["BOUNCE", "COMPLAINT"], scope: "TENANT" },
 * });
 *
 * // init — account-level bindings, scoped per call via TenantName
 * const suppress = yield* SES.PutSuppressedDestination();
 * const listSuppressed = yield* SES.ListSuppressedDestinations();
 *
 * // runtime
 * yield* suppress({
 *   EmailAddress: "hard-bounce@example.com",
 *   Reason: "BOUNCE",
 *   TenantName: yield* tenant.tenantName,
 * });
 * const { SuppressedDestinationSummaries } = yield* listSuppressed({
 *   TenantName: yield* tenant.tenantName,
 * });
 * ```
 *
 * @resource
 */
export const Tenant = Resource<Tenant>("AWS.SES.Tenant");

const toTagRecord = (
  tags: ReadonlyArray<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

const sameReasons = (
  a: ReadonlyArray<sesv2.SuppressionListReason> | undefined,
  b: ReadonlyArray<sesv2.SuppressionListReason> | undefined,
): boolean => {
  const key = (
    reasons: ReadonlyArray<sesv2.SuppressionListReason> | undefined,
  ) => JSON.stringify([...(reasons ?? [])].sort());
  return key(a) === key(b);
};

export const TenantProvider = () =>
  Provider.effect(
    Tenant,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Pick<TenantProps, "tenantName">,
      ) {
        return (
          props.tenantName ?? (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const getTenant = Effect.fn(function* (name: string) {
        return yield* sesv2.getTenant({ TenantName: name }).pipe(
          Effect.map((response) => response.Tenant),
          Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
        );
      });

      return Tenant.Provider.of({
        stables: ["tenantName", "tenantId", "tenantArn"],

        // Account-scoped: enumerate every tenant so leaked test resources are
        // cleaned by nuke.
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listTenants
            .pages({})
            .pipe(Stream.runCollect);
          return Array.from(pages)
            .flatMap((page) => page.Tenants ?? [])
            .flatMap((entry) =>
              entry.TenantName && entry.TenantId && entry.TenantArn
                ? [
                    {
                      tenantName: entry.TenantName,
                      tenantId: entry.TenantId,
                      tenantArn: entry.TenantArn,
                    },
                  ]
                : [],
            );
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.tenantName ?? (yield* createName(id, olds ?? {}));
          const found = yield* getTenant(name);
          if (!found || !found.TenantId || !found.TenantArn) return undefined;
          const attrs = {
            tenantName: name,
            tenantId: found.TenantId,
            tenantArn: found.TenantArn,
          };
          const tags = toTagRecord(found.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds ?? {});
          const newName = yield* createName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.tenantName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let observed = yield* getTenant(name);

          if (observed === undefined) {
            // 2. ENSURE — create with the full desired set. AlreadyExists is a
            //    race → fall through to the sync steps to converge.
            yield* sesv2
              .createTenant({
                TenantName: name,
                Tags: createTagsList(desiredTags),
                SuppressionAttributes: news.suppression
                  ? {
                      SuppressedReasons: news.suppression.reasons,
                      SuppressionScope: news.suppression.scope,
                    }
                  : undefined,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
            // Not always readable the instant create returns, and on the
            // AlreadyExists race another writer may still be mid-create.
            observed = yield* getTenant(name).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("1 second"),
                until: (tenant) => tenant !== undefined,
                times: 8,
              }),
            );
          }

          if (
            observed === undefined ||
            !observed.TenantId ||
            !observed.TenantArn
          ) {
            return yield* Effect.fail(
              new Error(`SES tenant ${name} was not found after create`),
            );
          }
          const tenantArn = observed.TenantArn;

          // 3. SYNC SUPPRESSION — diff observed suppression against desired and
          //    apply only on a real delta.
          //
          //    SES requires both members together — a put carrying only one
          //    fails with BadRequestException ("SuppressedReasons cannot be
          //    specified without SuppressionScope", and the mirror image). The
          //    prop nests them so that invalid state is unrepresentable and
          //    the put below always carries both.
          const observedReasons =
            observed.SuppressionAttributes?.SuppressedReasons;
          const observedScope =
            observed.SuppressionAttributes?.SuppressionScope;
          if (
            news.suppression !== undefined &&
            (!sameReasons(observedReasons, news.suppression.reasons) ||
              observedScope !== news.suppression.scope)
          ) {
            yield* sesv2.putTenantSuppressionAttributes({
              TenantName: name,
              SuppressedReasons: news.suppression.reasons,
              SuppressionScope: news.suppression.scope,
            });
          }

          // 3b. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //     converges.
          const observedTags = toTagRecord(observed.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* sesv2.tagResource({ ResourceArn: tenantArn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* sesv2.untagResource({
              ResourceArn: tenantArn,
              TagKeys: removed,
            });
          }

          yield* session.note(tenantArn);
          return {
            tenantName: name,
            tenantId: observed.TenantId,
            tenantArn,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteTenant removes the tenant and its resource associations (not
          // the resources themselves), and is idempotent for a missing tenant.
          yield* sesv2
            .deleteTenant({ TenantName: output.tenantName })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
