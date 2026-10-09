import * as jobs from "@distilled.cloud/gcp/jobs_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteTenant,
  encodeOwnershipLine,
  findOwnedTenant,
  getTenant,
  listOwnedTenants,
  MAX_EXTERNAL_ID_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  parseTenantName,
  projectParent,
  replaceOnIdentity,
  sameText,
  tenantNameOf,
  toGeneratedName,
  waitUntilGone,
} from "./internal.ts";

export type TenantProps = {
  /**
   * Server-assigned tenant id (the `{tenant}` segment of
   * `projects/{project}/tenants/{tenant}`). Leave blank on create.
   * Immutable — changing it replaces the tenant.
   */
  tenantId?: string;
  /**
   * Client-side tenant identifier (max 255 characters). Cloud Talent
   * tenants have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  externalId?: string;
};

export type Tenant = Resource<
  "GCP.Jobs.Tenant",
  TenantProps,
  {
    /** Full resource name `projects/{project}/tenants/{tenant}`. */
    name: string;
    /** Server-assigned tenant id. */
    tenantId: string;
    /** Project id. */
    project: string;
    /** Client identifier with the Alchemy ownership prefix stripped. */
    externalId: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Talent Solution tenant. Tenants isolate jobs and companies
 * for different customer groups.
 *
 * Tenants have no labels field, so Alchemy stamps ownership into
 * `externalId` for `list` / nuke. The server-assigned tenant id is
 * identity — changing `tenantId` replaces the tenant. `externalId`
 * updates in place.
 *
 * ### Creating a Tenant
 * **Example:** Generated identifier
 * ```typescript
 * const tenant = yield* GCP.Jobs.Tenant("Acme", {});
 * ```
 *
 * **Example:** Explicit external id
 * ```typescript
 * const tenant = yield* GCP.Jobs.Tenant("Acme", {
 *   externalId: "acme-corp",
 * });
 * ```
 *
 * ### Updating a Tenant
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Change the client identifier
 * ```typescript
 * const tenant = yield* GCP.Jobs.Tenant("Acme", {
 *   externalId: "acme-holdings",
 * });
 * ```
 *
 * @resource
 * @category Jobs
 */
export const Tenant = Resource<Tenant>("GCP.Jobs.Tenant");

export class TenantNotResolved extends Data.TaggedError(
  "GCP.Jobs.TenantNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (tenant: jobs.Tenant, project: string) => {
  const name = tenant.name ?? "";
  const parsed = parseTenantName(name, project);
  return {
    name,
    tenantId: parsed.tenantId,
    project: parsed.project || project,
    externalId: parseOwnership(tenant.externalId).text,
  };
};

export const TenantProvider = () =>
  Provider.succeed(Tenant, {
    stables: ["name", "tenantId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.tenantId ?? output?.tenantId,
        nextId: news.tenantId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name =
        output?.name ??
        tenantNameOf(env.project, olds?.tenantId ?? output?.tenantId ?? "");
      let existing = yield* getTenant(name);
      if (existing === undefined) {
        existing = yield* findOwnedTenant(env.project, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.externalId))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const tenants = yield* listOwnedTenants(env.project);
        return tenants.map((tenant) => toAttrs(tenant, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const clientId = yield* toGeneratedName(
        id,
        news.externalId,
        output?.externalId,
      );
      const externalId = encodeOwnershipLine(
        ownership,
        clientId,
        MAX_EXTERNAL_ID_LENGTH,
      );
      const name =
        output?.name ?? tenantNameOf(env.project, news.tenantId ?? "");

      let current = yield* getTenant(name);
      if (current === undefined) {
        current = yield* findOwnedTenant(env.project, id);
      }

      if (current === undefined) {
        const created = yield* jobs
          .createProjectsTenants({
            parent: projectParent(env.project),
            body: { externalId },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedTenant(env.project, id)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TenantNotResolved({
          name: name || `projects/${env.project}/tenants/${clientId}`,
        });
      }

      const currentName = current.name ?? name;
      if (!sameText(current.externalId, externalId)) {
        current = yield* jobs.patchProjectsTenants({
          name: currentName,
          updateMask: "externalId",
          body: { name: currentName, externalId },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteTenant(output.name);
      yield* waitUntilGone(getTenant(output.name));
    }),
  });
