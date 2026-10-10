import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { ALCHEMY_LABEL_PREFIX } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_POLICY_ID_LENGTH = 256;

export type RowAccessPolicyProps = {
  /**
   * Dataset id (the `{dataset}` segment of
   * `projects/{project}/datasets/{dataset}`) or a full dataset resource
   * name. Immutable — changing it replaces the policy.
   */
  datasetId: string;
  /**
   * Table id (the `{table}` segment of
   * `projects/{project}/datasets/{dataset}/tables/{table}`) or a full
   * table resource name. Immutable — changing it replaces the policy.
   */
  tableId: string;
  /**
   * Policy id (the `{policy}` segment of
   * `projects/{project}/datasets/{dataset}/tables/{table}/rowAccessPolicies/{policy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Letters, numbers, and underscores; max 256 characters.
   * Immutable — changing it replaces the policy.
   */
  policyId?: string;
  /**
   * SQL boolean expression that selects the rows this policy covers,
   * similar to a `WHERE` clause. Sent verbatim.
   */
  filterPredicate: string;
  /**
   * Initial IAM members granted this policy (`user:`, `group:`,
   * `serviceAccount:`, `domain:`, `allAuthenticatedUsers`, `allUsers`).
   * Input-only — sent on create, not readable after insert.
   */
  grantees?: string[];
};

export type RowAccessPolicy = Resource<
  "GCP.BigQuery.RowAccessPolicy",
  RowAccessPolicyProps,
  {
    /**
     * Resource path
     * `projects/{project}/datasets/{dataset}/tables/{table}/rowAccessPolicies/{policy}`.
     */
    name: string;
    /** Policy id (last path segment). */
    policyId: string;
    /** Table id. */
    tableId: string;
    /** Dataset id. */
    datasetId: string;
    /** Project id. */
    project: string;
    /** Filter predicate (a legacy Alchemy ownership suffix is stripped). */
    filterPredicate: string;
    /** Server etag. */
    etag: string | undefined;
    /** Creation time in milliseconds since epoch. */
    creationTime: string | undefined;
    /** Last-modified time in milliseconds since epoch. */
    lastModifiedTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google BigQuery row-access policy — a filter predicate plus IAM
 * members that together hide rows from unauthorized readers.
 *
 * Row-access policies have no labels, and Alchemy never edits the filter
 * predicate: `list` / `pnpm nuke:gcp` return the policies on tables that
 * carry `alchemy-*` labels, and `read` reports a policy with an explicit
 * id that Alchemy has no state for as unowned. `datasetId`, `tableId`, and `policyId`
 * are immutable (changing them replaces the policy). `filterPredicate`
 * updates in place. `grantees` is create-only.
 *
 * ### Creating a Row Access Policy
 * **Example:** Filter non-null rows
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
 *   forceDestroy: true,
 * });
 * const table = yield* GCP.BigQuery.Table("Events", {
 *   datasetId: dataset.datasetId,
 *   schema: [{ name: "nullable_field", type: "STRING" }],
 * });
 * const policy = yield* GCP.BigQuery.RowAccessPolicy("Visible", {
 *   datasetId: dataset.datasetId,
 *   tableId: table.tableId,
 *   filterPredicate: "nullable_field IS NOT NULL",
 * });
 * ```
 *
 * **Example:** Grant a domain
 * ```typescript
 * const policy = yield* GCP.BigQuery.RowAccessPolicy("Domain", {
 *   datasetId: dataset.datasetId,
 *   tableId: table.tableId,
 *   filterPredicate: "TRUE",
 *   grantees: ["domain:example.com"],
 * });
 * ```
 *
 * @resource
 * @category BigQuery
 */
export const RowAccessPolicy = Resource<RowAccessPolicy>(
  "GCP.BigQuery.RowAccessPolicy",
);

export class RowAccessPolicyNotResolved extends Data.TaggedError(
  "GCP.BigQuery.RowAccessPolicyNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const datasetIdOf = (datasetId: string) =>
  datasetId.includes("/") ? lastSegment(datasetId) : datasetId;

const tableIdOf = (tableId: string) =>
  tableId.includes("/") ? lastSegment(tableId) : tableId;

const resourceName = (
  project: string,
  datasetId: string,
  tableId: string,
  policyId: string,
) =>
  `projects/${project}/datasets/${datasetId}/tables/${tableId}/rowAccessPolicies/${policyId}`;

const toId = (id: string, policyId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (policyId !== undefined) return policyId;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_POLICY_ID_LENGTH,
      lowercase: true,
      delimiter: "_",
    });
    return generated.replaceAll("-", "_");
  });

const MARKER_SUFFIX =
  /\s+AND\s+\('\[alchemy ([^\]]+)\]'\s+IS\s+NOT\s+NULL\)\s*$/i;

const parseMarkerLabels = (encoded: string): Record<string, string> => {
  const labels: Record<string, string> = {};
  for (const part of encoded.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return labels;
};

const parseFilter = (
  filterPredicate: string | undefined,
): {
  labels: Record<string, string>;
  filterPredicate: string | undefined;
} => {
  if (filterPredicate === undefined) {
    return { labels: {}, filterPredicate };
  }
  const match = filterPredicate.match(MARKER_SUFFIX);
  if (match === null || match.index === undefined) {
    return { labels: {}, filterPredicate };
  }
  const labels = parseMarkerLabels(match[1] ?? "");
  let user = filterPredicate.slice(0, match.index).trim();
  if (user.startsWith("(") && user.endsWith(")")) {
    user = user.slice(1, -1);
  }
  return {
    labels,
    filterPredicate: user.length > 0 ? user : undefined,
  };
};

const hasAlchemyDatasetLabels = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const toAttrs = (policy: bigquery.RowAccessPolicy, project: string) => {
  const ref = policy.rowAccessPolicyReference;
  const policyId = ref?.policyId ?? "";
  const datasetId = ref?.datasetId ?? "";
  const tableId = ref?.tableId ?? "";
  const projectId = ref?.projectId ?? project;
  return {
    name: resourceName(projectId, datasetId, tableId, policyId),
    policyId,
    tableId,
    datasetId,
    project: projectId,
    filterPredicate:
      parseFilter(policy.filterPredicate).filterPredicate ??
      policy.filterPredicate ??
      "",
    etag: policy.etag,
    creationTime: policy.creationTime,
    lastModifiedTime: policy.lastModifiedTime,
  };
};

const getByRef = (
  projectId: string,
  datasetId: string,
  tableId: string,
  policyId: string,
) =>
  bigquery
    .getRowAccessPolicies({
      projectId,
      datasetId,
      tableId,
      policyId,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toPolicyBody = (
  projectId: string,
  datasetId: string,
  tableId: string,
  policyId: string,
  news: RowAccessPolicyProps,
  filter: string,
  includeGrantees: boolean,
): bigquery.RowAccessPolicy => {
  const body: bigquery.RowAccessPolicy = {
    rowAccessPolicyReference: {
      projectId,
      datasetId,
      tableId,
      policyId,
    },
    filterPredicate: filter,
  };
  if (includeGrantees && news.grantees !== undefined) {
    body.grantees = news.grantees;
  }
  return body;
};

const sameFilter = (left: string, right: string) =>
  left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();

export const RowAccessPolicyProvider = () =>
  Provider.succeed(RowAccessPolicy, {
    stables: [
      "name",
      "policyId",
      "tableId",
      "datasetId",
      "project",
      "creationTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPolicyId = olds?.policyId ?? output?.policyId;
      const nextPolicyId = news.policyId ?? previousPolicyId;
      const policyIdChanged =
        news.policyId !== undefined &&
        previousPolicyId !== undefined &&
        news.policyId !== previousPolicyId;

      const previousDataset = olds?.datasetId ?? output?.datasetId;
      const nextDataset = datasetIdOf(news.datasetId);
      const datasetChanged =
        previousDataset !== undefined &&
        datasetIdOf(previousDataset) !== nextDataset;

      const previousTable = olds?.tableId ?? output?.tableId;
      const nextTable = tableIdOf(news.tableId);
      const tableChanged =
        previousTable !== undefined && tableIdOf(previousTable) !== nextTable;

      if (!policyIdChanged && !datasetChanged && !tableChanged) {
        return undefined;
      }
      return {
        action: "replace" as const,
        deleteFirst:
          !policyIdChanged &&
          !datasetChanged &&
          !tableChanged &&
          nextPolicyId !== undefined &&
          previousPolicyId !== undefined &&
          nextPolicyId === previousPolicyId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const policyId = yield* toId(id, olds?.policyId, output?.policyId);
      const datasetId = datasetIdOf(olds?.datasetId ?? output?.datasetId ?? "");
      const tableId = tableIdOf(olds?.tableId ?? output?.tableId ?? "");
      if (datasetId.length === 0 || tableId.length === 0) return undefined;
      const existing = yield* getByRef(
        env.project,
        datasetId,
        tableId,
        policyId,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels: a generated id derives from this stack, stage, logical
      // id and instance; an explicit id is only ours when state has it.
      return output !== undefined || olds?.policyId === undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const datasets = yield* bigquery.listDatasets
          .pages({
            projectId: env.project,
            maxResults: 1000,
            all: true,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.datasets ?? [])),
            Stream.filter((dataset) => hasAlchemyDatasetLabels(dataset.labels)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () =>
              Effect.succeed([] as bigquery.DatasetListDatasetsItem[]),
            ),
          );
        const pages = yield* Effect.forEach(
          datasets,
          (dataset) => {
            const datasetId = dataset.datasetReference?.datasetId;
            if (datasetId === undefined) {
              return Effect.succeed([] as ReturnType<typeof toAttrs>[]);
            }
            return bigquery.listTables
              .pages({
                projectId: env.project,
                datasetId,
                maxResults: 1000,
              })
              .pipe(
                Stream.flatMap((page) =>
                  Stream.fromIterable(page.tables ?? []),
                ),
                Stream.filter((table) => hasAlchemyDatasetLabels(table.labels)),
                Stream.map((table) => table.tableReference?.tableId),
                Stream.filter(
                  (tableId): tableId is string =>
                    tableId !== undefined && tableId.length > 0,
                ),
                Stream.runCollect,
                Effect.flatMap((tableIds) =>
                  Effect.forEach(
                    Array.from(tableIds),
                    (tableId) =>
                      bigquery.listRowAccessPolicies
                        .pages({
                          projectId: env.project,
                          datasetId,
                          tableId,
                          pageSize: 1000,
                        })
                        .pipe(
                          Stream.flatMap((page) =>
                            Stream.fromIterable(page.rowAccessPolicies ?? []),
                          ),
                          Stream.map((policy) => toAttrs(policy, env.project)),
                          Stream.runCollect,
                          Effect.map((chunk) => Array.from(chunk)),
                          Effect.catchTag("NotFound", () =>
                            Effect.succeed([] as ReturnType<typeof toAttrs>[]),
                          ),
                        ),
                    { concurrency: 4 },
                  ),
                ),
                Effect.map((nested) => nested.flat()),
                Effect.catchTag("NotFound", () =>
                  Effect.succeed([] as ReturnType<typeof toAttrs>[]),
                ),
              );
          },
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const policyId = yield* toId(id, news.policyId, output?.policyId);
      const datasetId = datasetIdOf(news.datasetId);
      const tableId = tableIdOf(news.tableId);
      const name = resourceName(env.project, datasetId, tableId, policyId);
      const filter = news.filterPredicate;

      let current = yield* getByRef(env.project, datasetId, tableId, policyId);

      if (current === undefined) {
        const created = yield* bigquery
          .insertRowAccessPolicies({
            projectId: env.project,
            datasetId,
            tableId,
            body: toPolicyBody(
              env.project,
              datasetId,
              tableId,
              policyId,
              news,
              filter,
              true,
            ),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getByRef(env.project, datasetId, tableId, policyId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RowAccessPolicyNotResolved({ name });
      }

      const observedFilter = current.filterPredicate ?? "";
      if (!sameFilter(observedFilter, filter)) {
        current = yield* bigquery
          .updateRowAccessPolicies({
            projectId: env.project,
            datasetId,
            tableId,
            policyId,
            body: toPolicyBody(
              env.project,
              datasetId,
              tableId,
              policyId,
              news,
              filter,
              false,
            ),
          })
          .pipe(
            Effect.catchTag("NotFound", () =>
              bigquery
                .insertRowAccessPolicies({
                  projectId: env.project,
                  datasetId,
                  tableId,
                  body: toPolicyBody(
                    env.project,
                    datasetId,
                    tableId,
                    policyId,
                    news,
                    filter,
                    true,
                  ),
                })
                .pipe(
                  Effect.catchTag("Conflict", () =>
                    getByRef(env.project, datasetId, tableId, policyId),
                  ),
                ),
            ),
          );
        if (current === undefined) {
          return yield* new RowAccessPolicyNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bigquery
        .deleteRowAccessPolicies({
          projectId: output.project,
          datasetId: output.datasetId,
          tableId: output.tableId,
          policyId: output.policyId,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
