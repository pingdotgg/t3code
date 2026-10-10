import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  collectPages,
  lastSegment,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import { listAlchemyDataDomains } from "./DataDomain.ts";

export type DataDomainsBindingProps = {
  /**
   * Parent DataDomain resource name
   * (`projects/{project}/locations/{location}/dataDomains/{dataDomain}`).
   * Immutable — changing it replaces the binding.
   */
  parent: string;
  /**
   * Binding id. If omitted, a unique name is generated. Must contain
   * only lowercase letters, numbers and hyphens, start with a letter,
   * end with a letter or number, and be 1-63 characters. Immutable —
   * changing it replaces the binding.
   */
  dataDomainBindingId?: string;
  /**
   * Immutable IAM full resource name to include in the DataDomain, e.g.
   * `//cloudresourcemanager.googleapis.com/projects/{project}` or
   * `//bigquery.googleapis.com/projects/{project}/datasets/{dataset}`.
   * Changing it replaces the binding.
   */
  resource: string;
};

export type DataDomainsBinding = Resource<
  "GCP.Dataplex.DataDomainsBinding",
  DataDomainsBindingProps,
  {
    /** Full resource name. */
    name: string;
    /** Binding id (last path segment). */
    dataDomainBindingId: string;
    /** Parent DataDomain resource name. */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Bound Google Cloud resource. */
    resource: string;
    /** System uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex DataDomainBinding that includes a Google Cloud resource
 * (and its contents) in a DataDomain.
 *
 * Bindings have no labels or description. `list` walks alchemy-labeled
 * DataDomains and returns their bindings so nuke can find them. Parent,
 * binding id, and resource are identity — there is no in-place update
 * API.
 *
 * ### Creating a DataDomainBinding
 * **Example:** Bind a BigQuery dataset
 * ```typescript
 * const binding = yield* GCP.Dataplex.DataDomainsBinding("Analytics", {
 *   parent: domain.name,
 *   resource:
 *     "//bigquery.googleapis.com/projects/my-project/datasets/analytics",
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const DataDomainsBinding = Resource<DataDomainsBinding>(
  "GCP.Dataplex.DataDomainsBinding",
);

const resourceNameOf = (parent: string, dataDomainBindingId: string) =>
  `${parent}/bindings/${dataDomainBindingId}`;

const toAttrs = (
  binding: dataplex.GoogleCloudDataplexV1DataDomainBinding,
  project: string,
) => {
  const name = binding.name ?? "";
  const parsed = parseName(name, "bindings");
  return {
    name,
    dataDomainBindingId: parsed.id,
    parent: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    resource: binding.resource ?? "",
    uid: binding.uid,
    createTime: binding.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : retryQuota(
        dataplex.getProjectsLocationsDataDomainsBindings({ name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  collectPages(
    dataplex.listProjectsLocationsDataDomainsBindings.pages({
      parent,
      pageSize: 100,
    }),
    (page) => page.dataDomainBindings,
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));

export const DataDomainsBindingProvider = () =>
  Provider.succeed(DataDomainsBinding, {
    stables: [
      "name",
      "dataDomainBindingId",
      "parent",
      "project",
      "location",
      "resource",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.dataDomainBindingId ?? output?.dataDomainBindingId,
        nextId:
          news.dataDomainBindingId ??
          olds?.dataDomainBindingId ??
          output?.dataDomainBindingId,
        previousLocation: lastSegment(olds?.parent ?? output?.parent ?? ""),
        nextLocation: lastSegment(news.parent),
        previousParent: olds?.parent ?? output?.parent,
        nextParent: news.parent,
        extra:
          (olds?.resource ?? output?.resource) !== undefined &&
          news.resource !== (olds?.resource ?? output?.resource),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const dataDomainBindingId = yield* toPhysicalId(
        id,
        olds?.dataDomainBindingId,
        output?.dataDomainBindingId,
        "ddbinding",
      );
      const name =
        output?.name ??
        (olds?.parent ? resourceNameOf(olds.parent, dataDomainBindingId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return lastSegment(existing.name ?? "") === dataDomainBindingId
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const domains = yield* listAlchemyDataDomains(env.project, env.region);
        const pages = yield* Effect.forEach(
          domains,
          (domain) =>
            domain.name
              ? listAtParent(domain.name)
              : Effect.succeed(
                  [] as dataplex.GoogleCloudDataplexV1DataDomainBinding[],
                ),
          { concurrency: 4 },
        );
        return pages.flat().map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const dataDomainBindingId = yield* toPhysicalId(
        id,
        news.dataDomainBindingId,
        output?.dataDomainBindingId,
        "ddbinding",
      );
      const name = resourceNameOf(news.parent, dataDomainBindingId);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryQuota(
          dataplex.createProjectsLocationsDataDomainsBindings({
            parent: news.parent,
            dataDomainBindingId,
            body: { resource: news.resource },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteProjectsLocationsDataDomainsBindings({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
