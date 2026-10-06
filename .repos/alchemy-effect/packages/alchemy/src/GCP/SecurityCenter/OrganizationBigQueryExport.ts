import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  hasOwnershipMarker,
  lastSegment,
  organizationIdOf,
  organizationParent,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOn,
  resolveOrganization,
  sameText,
  SecuritycenterNotResolved,
  toPhysicalId,
  tryResolveOrganization,
  updateMaskOf,
} from "./internal.ts";

export type OrganizationBigQueryExportProps = {
  /**
   * Export id (the `{export}` segment of
   * `organizations/{organization}/bigQueryExports/{export}`). If omitted,
   * a unique id is generated from the stack, stage, and logical id.
   * Letters, digits, and hyphens; max 63 characters. Immutable — changing
   * it replaces the export.
   */
  exportId?: string;
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to the project's Resource
   * Manager ancestor. Immutable — changing it replaces the export.
   */
  organization?: string;
  /**
   * Destination dataset
   * (`projects/{project}/datasets/{dataset}`).
   */
  dataset: string;
  /**
   * Finding filter. Empty or omitted exports every finding under the
   * parent.
   */
  filter?: string;
  /**
   * Human-readable description. BigQuery exports have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  description?: string;
};

export type OrganizationBigQueryExport = Resource<
  "GCP.SecurityCenter.OrganizationBigQueryExport",
  OrganizationBigQueryExportProps,
  {
    /** Full resource name `organizations/{organization}/bigQueryExports/{export}`. */
    name: string;
    /** Export id (last path segment). */
    exportId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Destination dataset. */
    dataset: string;
    /** Finding filter. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Principal Security Command Center uses to write to the dataset. */
    principal: string | undefined;
    /** Most recent editor of the export. */
    mostRecentEditor: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Security Command Center BigQuery export.
 *
 * Exports have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Export id and organization
 * are identity. Dataset, filter, and description update in place.
 *
 * ### Creating a BigQuery Export
 * **Example:** Export active findings to a dataset
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("SccFindings", {
 *   location: "US",
 *   forceDestroy: true,
 * });
 * const exp = yield* GCP.SecurityCenter.OrganizationBigQueryExport(
 *   "Findings",
 *   {
 *     dataset: `projects/${dataset.project}/datasets/${dataset.datasetId}`,
 *     filter: 'state="ACTIVE"',
 *     description: "active findings",
 *   },
 * );
 * ```
 *
 * **Example:** Named export on an explicit organization
 * ```typescript
 * const exp = yield* GCP.SecurityCenter.OrganizationBigQueryExport(
 *   "Findings",
 *   {
 *     organization: "organizations/123456789",
 *     exportId: "active-findings",
 *     dataset: "projects/my-project/datasets/scc",
 *   },
 * );
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const OrganizationBigQueryExport = Resource<OrganizationBigQueryExport>(
  "GCP.SecurityCenter.OrganizationBigQueryExport",
);

const resourceName = (organization: string, exportId: string) =>
  `${organization}/bigQueryExports/${exportId}`;

const toAttrs = (
  exp: scc.GoogleCloudSecuritycenterV1BigQueryExport,
  organization: string,
  project: string,
) => {
  const name = exp.name ?? "";
  const parsed = parseName(name, "bigQueryExports");
  const ownership = parseOwnership(exp.description);
  return {
    name,
    exportId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    project,
    dataset: exp.dataset ?? "",
    filter: exp.filter,
    description: ownership.text,
    principal: exp.principal,
    mostRecentEditor: exp.mostRecentEditor,
    createTime: exp.createTime,
    updateTime: exp.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getOrganizationsBigQueryExports({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const OrganizationBigQueryExportProvider = () =>
  Provider.succeed(OrganizationBigQueryExport, {
    stables: [
      "name",
      "exportId",
      "organization",
      "organizationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceOn(olds?.exportId ?? output?.exportId, news.exportId) ??
        replaceOn(
          olds?.organization ?? output?.organization,
          news.organization !== undefined
            ? organizationParent(news.organization)
            : undefined,
        )
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const exportId = yield* toPhysicalId(
        id,
        olds?.exportId,
        output?.exportId,
      );
      const name = output?.name ?? resourceName(organization, exportId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const organization = yield* tryResolveOrganization();
        if (organization === undefined) return [];
        return yield* scc.listOrganizationsBigQueryExports
          .pages({ parent: organization, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.bigQueryExports ?? []),
            ),
            Stream.filter((exp) => hasOwnershipMarker(exp.description)),
            Stream.map((exp) => toAttrs(exp, organization, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const exportId = yield* toPhysicalId(id, news.exportId, output?.exportId);
      const name = resourceName(organization, exportId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeDescription(ownership, news.description);
      const dataset = news.dataset;
      const filter = news.filter;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createOrganizationsBigQueryExports({
            parent: organization,
            bigQueryExportId: exportId,
            body: { dataset, filter, description },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecuritycenterNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const updateMask = updateMaskOf(
        !sameText(current.dataset, dataset) ? "dataset" : undefined,
        !sameText(current.filter, filter) ? "filter" : undefined,
        !sameText(current.description, description) ? "description" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchOrganizationsBigQueryExports({
          name: currentName,
          updateMask,
          body: { dataset, filter, description },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteOrganizationsBigQueryExports({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
