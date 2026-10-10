import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface TenantResourceAssociationProps {
  /**
   * Name of the tenant to associate the resource with. Typically the
   * `tenantName` output of a `SES.Tenant`. Changing it replaces the
   * association.
   */
  tenantName: string;
  /**
   * ARN of the resource to associate — an email identity, configuration set,
   * or email template. Changing it replaces the association.
   */
  resourceArn: string;
}

export interface TenantResourceAssociation extends Resource<
  "AWS.SES.TenantResourceAssociation",
  TenantResourceAssociationProps,
  {
    /** Name of the tenant. */
    tenantName: string;
    /** ARN of the associated resource. */
    resourceArn: string;
  },
  never,
  Providers
> {}

/**
 * An association between an Amazon SES v2 tenant and a resource — an email
 * identity, configuration set, or email template. Once associated, the
 * resource can be used when sending email on behalf of the tenant. A single
 * resource can be associated with multiple tenants.
 *
 * This is an existence-only link with no mutable properties: changing either
 * the tenant or the resource replaces the association.
 * ### Associating Resources
 * **Example:** Associate an Email Identity with a Tenant
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const tenant = yield* SES.Tenant("CustomerA", {});
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "sender@example.com",
 * });
 * const association = yield* SES.TenantResourceAssociation("SenderLink", {
 *   tenantName: tenant.tenantName,
 *   resourceArn: identity.identityArn,
 * });
 * ```
 *
 * **Example:** Associate a Configuration Set
 * ```typescript
 * const configSet = yield* SES.ConfigurationSet("AcmeTracking", {});
 * yield* SES.TenantResourceAssociation("ConfigSetLink", {
 *   tenantName: tenant.tenantName,
 *   resourceArn: configSet.configurationSetArn,
 * });
 * ```
 *
 * **Example:** Associate an Email Template
 * ```typescript
 * const template = yield* SES.EmailTemplate("Welcome", {
 *   subject: "Welcome, {{name}}!",
 *   text: "Thanks for signing up, {{name}}.",
 * });
 * yield* SES.TenantResourceAssociation("TemplateLink", {
 *   tenantName: tenant.tenantName,
 *   resourceArn: template.templateArn,
 * });
 * ```
 *
 * **Example:** Share One Identity Across Two Tenants
 * ```typescript
 * // A resource can belong to any number of tenants.
 * const acme = yield* SES.Tenant("Acme", {});
 * const globex = yield* SES.Tenant("Globex", {});
 *
 * yield* SES.TenantResourceAssociation("AcmeSender", {
 *   tenantName: acme.tenantName,
 *   resourceArn: identity.identityArn,
 * });
 * yield* SES.TenantResourceAssociation("GlobexSender", {
 *   tenantName: globex.tenantName,
 *   resourceArn: identity.identityArn,
 * });
 * ```
 *
 * @resource
 */
export const TenantResourceAssociation = Resource<TenantResourceAssociation>(
  "AWS.SES.TenantResourceAssociation",
);

export const TenantResourceAssociationProvider = () =>
  Provider.effect(
    TenantResourceAssociation,
    Effect.gen(function* () {
      // Every resource associated with the tenant, or undefined when the
      // tenant itself is gone.
      const listResources = Effect.fn(function* (tenantName: string) {
        const pages = yield* sesv2.listTenantResources
          .pages({ TenantName: tenantName })
          .pipe(
            Stream.runCollect,
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (pages === undefined) return undefined;
        return Array.from(pages).flatMap((page) => page.TenantResources ?? []);
      });

      const isAssociated = Effect.fn(function* (
        tenantName: string,
        resourceArn: string,
      ) {
        // A missing tenant means the association cannot exist.
        const resources = yield* listResources(tenantName);
        return (resources ?? []).some(
          (resource) => resource.ResourceArn === resourceArn,
        );
      });

      return TenantResourceAssociation.Provider.of({
        // Deleting an association requires BOTH ends to still exist: the
        // tenant, and the resource it points at — SES refuses to delete a
        // configuration set that still has tenant associations ("Cannot
        // delete <arn> because it has tenant associations"). So every
        // associable type must outlive the associations nuke tears down.
        nuke: {
          dependsOn: [
            "AWS.SES.Tenant",
            "AWS.SES.ConfigurationSet",
            "AWS.SES.EmailIdentity",
            "AWS.SES.EmailTemplate",
          ],
        },
        stables: ["tenantName", "resourceArn"],

        // Associations are keyed by their parent tenant, so enumeration walks
        // every tenant and pages through its resources. listResources already
        // treats a vanished tenant as "no associations".
        list: Effect.fn(function* () {
          const pages = yield* sesv2.listTenants
            .pages({})
            .pipe(Stream.runCollect);
          const tenantNames = Array.from(pages)
            .flatMap((page) => page.Tenants ?? [])
            .flatMap((tenant) =>
              tenant.TenantName ? [tenant.TenantName] : [],
            );
          const nested = yield* Effect.forEach(
            tenantNames,
            (tenantName) =>
              listResources(tenantName).pipe(
                Effect.map((resources) =>
                  (resources ?? []).flatMap((resource) =>
                    resource.ResourceArn
                      ? [{ tenantName, resourceArn: resource.ResourceArn }]
                      : [],
                  ),
                ),
              ),
            { concurrency: 2 },
          );
          return nested.flat();
        }),

        read: Effect.fn(function* ({ olds, output }) {
          const tenantName = output?.tenantName ?? olds?.tenantName;
          const resourceArn = output?.resourceArn ?? olds?.resourceArn;
          if (tenantName === undefined || resourceArn === undefined) {
            return undefined;
          }
          const found = yield* isAssociated(tenantName, resourceArn);
          return found ? { tenantName, resourceArn } : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.tenantName !== olds.tenantName ||
            news.resourceArn !== olds.resourceArn
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const tenantName = output?.tenantName ?? news.tenantName;
          const resourceArn = output?.resourceArn ?? news.resourceArn;

          // OBSERVE — associations have no update API, so reconcile is
          // create-only.
          const found = yield* isAssociated(tenantName, resourceArn);

          // ENSURE — create if missing; AlreadyExists is a race, not a failure.
          if (!found) {
            yield* sesv2
              .createTenantResourceAssociation({
                TenantName: tenantName,
                ResourceArn: resourceArn,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
          }

          return { tenantName, resourceArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteTenantResourceAssociation is idempotent; a missing tenant or
          // association means the link is already gone.
          yield* sesv2
            .deleteTenantResourceAssociation({
              TenantName: output.tenantName,
              ResourceArn: output.resourceArn,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
