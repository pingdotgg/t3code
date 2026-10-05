import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  lastSegment,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOn,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type BigQueryExportProps = {
  /**
   * Export id (the `{export}` segment of
   * `projects/{project}/bigQueryExports/{export}`). If omitted, a unique
   * id is generated. Lowercase letters, digits, and hyphens; must start
   * with a letter; max 63 characters. Immutable — changing it replaces
   * the export.
   */
  exportId?: string;
  /**
   * Destination dataset, as `projects/{project}/datasets/{dataset}`.
   */
  dataset: string;
  /**
   * Finding filter. Empty exports every finding in the parent.
   */
  filter?: string;
  /**
   * Human-readable description (max 1024 characters). BigQuery exports
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
};

export type BigQueryExport = Resource<
  "GCP.SecurityCenter.BigQueryExport",
  BigQueryExportProps,
  {
    /** Full resource name `projects/{project}/bigQueryExports/{export}`. */
    name: string;
    /** Export id (last path segment). */
    exportId: string;
    /** Project id. */
    project: string;
    /** Destination dataset. */
    dataset: string | undefined;
    /** Finding filter. */
    filter: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Service account SCC uses to write rows. */
    principal: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Last editor email. */
    mostRecentEditor: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-scoped Security Command Center BigQuery export that writes
 * findings to a dataset.
 *
 * Exports have no labels field — Alchemy stamps ownership into the
 * description so `list` / nuke can find them. Export id is identity.
 * Dataset, filter, and description update in place.
 *
 * ### Creating a BigQuery Export
 * **Example:** Export high-severity findings
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("SccFindings", {
 *   location: "US",
 *   forceDestroy: true,
 * });
 * const exp = yield* GCP.SecurityCenter.BigQueryExport("High", {
 *   dataset: dataset.name,
 *   description: "high severity",
 *   filter: 'severity="HIGH"',
 * });
 * ```
 *
 * ### Updating a BigQuery Export
 * **Example:** Also export critical findings
 * ```typescript
 * const exp = yield* GCP.SecurityCenter.BigQueryExport("High", {
 *   dataset: dataset.name,
 *   description: "high and critical",
 *   filter: 'severity="HIGH" OR severity="CRITICAL"',
 * });
 * ```
 *
 * @resource
 * @category SecurityCenter
 */
export const BigQueryExport = Resource<BigQueryExport>(
  "GCP.SecurityCenter.BigQueryExport",
);

export class BigQueryExportNotResolved extends Data.TaggedError(
  "GCP.SecurityCenter.BigQueryExportNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, exportId: string) =>
  `projects/${project}/bigQueryExports/${exportId}`;

const toAttrs = (
  exp: scc.GoogleCloudSecuritycenterV1BigQueryExport,
  project: string,
) => {
  const name = exp.name ?? "";
  const parsed = parseOwnership(exp.description);
  return {
    name,
    exportId: lastSegment(name),
    project: projectOf(name) || project,
    dataset: exp.dataset,
    filter: exp.filter,
    description: parsed.text,
    principal: exp.principal,
    createTime: exp.createTime,
    updateTime: exp.updateTime,
    mostRecentEditor: exp.mostRecentEditor,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : scc
        .getProjectsBigQueryExports({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const BigQueryExportProvider = () =>
  Provider.succeed(BigQueryExport, {
    stables: ["name", "exportId", "project", "principal", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOn(olds?.exportId ?? output?.exportId, news.exportId);
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const exportId = yield* toResourceId(
        id,
        olds?.exportId,
        output?.exportId,
        "e",
      );
      const name = output?.name ?? resourceName(env.project, exportId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          scc.listProjectsBigQueryExports.pages({
            parent: `projects/${env.project}`,
            pageSize: 100,
          }),
          (page) => page.bigQueryExports,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed(
              [] as scc.GoogleCloudSecuritycenterV1BigQueryExport[],
            ),
          ),
        );
        return items
          .filter((exp) => hasOwnershipMarker(exp.description))
          .map((exp) => toAttrs(exp, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const exportId = yield* toResourceId(
        id,
        news.exportId,
        output?.exportId,
        "e",
      );
      const name = resourceName(env.project, exportId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const filter = news.filter ?? "";
      const body: scc.GoogleCloudSecuritycenterV1BigQueryExport = {
        dataset: news.dataset,
        filter,
        description,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* scc
          .createProjectsBigQueryExports({
            parent: `projects/${env.project}`,
            bigQueryExportId: exportId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new BigQueryExportNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const datasetChanged = !sameText(current.dataset, news.dataset);
      const filterChanged = !sameText(current.filter, filter);
      const descriptionChanged = !sameText(current.description, description);
      const updateMask = updateMaskOf(
        datasetChanged ? "dataset" : undefined,
        filterChanged ? "filter" : undefined,
        descriptionChanged ? "description" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* scc.patchProjectsBigQueryExports({
          name: currentName,
          updateMask,
          body: {
            ...body,
            name: currentName,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* scc
        .deleteProjectsBigQueryExports({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
