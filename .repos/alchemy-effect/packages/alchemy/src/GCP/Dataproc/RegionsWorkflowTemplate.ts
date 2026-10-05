import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type { WorkflowTemplateProps } from "./WorkflowTemplate.ts";
import {
  collectPages,
  LIST_LOCATIONS,
  MAX_MANAGED_CLUSTER_PREFIX_LENGTH,
  MAX_POLICY_ID_LENGTH,
  defaultWorkflowJobs,
  defaultWorkflowPlacement,
  emptyOnMissing,
  fingerprint,
  hasAlchemyLabelMap,
  normalizeLocation,
  parseResourceName,
  regionParent,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type RegionsWorkflowTemplateProps = Omit<
  WorkflowTemplateProps,
  "location"
> & {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * template. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  region?: string;
};

export type RegionsWorkflowTemplate = Resource<
  "GCP.Dataproc.RegionsWorkflowTemplate",
  RegionsWorkflowTemplateProps,
  {
    /** Full resource name `projects/{project}/regions/{region}/workflowTemplates/{template}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Project id. */
    project: string;
    /** Region id. */
    region: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server version used for optimistic updates. */
    version: number | undefined;
    /** DAG timeout. */
    dagTimeout: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataproc workflow template (regions API).
 *
 * Same resource as {@link WorkflowTemplate} addressed via
 * `projects/{project}/regions/{region}/workflowTemplates/{template}`.
 *
 * ### Creating a Template
 * **Example:** Generated name
 * ```typescript
 * const template = yield* GCP.Dataproc.RegionsWorkflowTemplate("Nightly", {});
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const template = yield* GCP.Dataproc.RegionsWorkflowTemplate("Nightly", {
 *   templateId: "nightly-etl-reg",
 *   region: "us-central1",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const RegionsWorkflowTemplate = Resource<RegionsWorkflowTemplate>(
  "GCP.Dataproc.RegionsWorkflowTemplate",
);

export class RegionsWorkflowTemplateNotResolved extends Data.TaggedError(
  "GCP.Dataproc.RegionsWorkflowTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, region: string, templateId: string) =>
  `${regionParent(project, region)}/workflowTemplates/${templateId}`;

const toAttrs = (
  template: dataproc.WorkflowTemplate,
  project: string,
  region: string,
) => {
  const name = template.name ?? "";
  const parsed = parseResourceName(name, "workflowTemplates", region);
  return {
    name,
    templateId: template.id ?? parsed.id,
    project: parsed.project || project,
    region: parsed.location || region,
    labels: userLabels(template.labels),
    version: template.version,
    dagTimeout: template.dagTimeout,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const desiredBody = (
  news: RegionsWorkflowTemplateProps,
  templateId: string,
  name: string,
  desiredLabels: Record<string, string>,
  version?: number,
): dataproc.WorkflowTemplate => ({
  id: templateId,
  name,
  labels: desiredLabels,
  version,
  jobs: news.jobs ?? defaultWorkflowJobs(),
  placement:
    news.placement ??
    defaultWorkflowPlacement(
      rfc1035(`${templateId}-c`, MAX_MANAGED_CLUSTER_PREFIX_LENGTH, "cluster"),
    ),
  dagTimeout: news.dagTimeout,
  parameters: news.parameters,
  encryptionConfig: news.kmsKey ? { kmsKey: news.kmsKey } : undefined,
});

const getByName = (name: string) =>
  dataproc
    .getProjectsRegionsWorkflowTemplates({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listRegion = (project: string, region: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsRegionsWorkflowTemplates.pages({
        parent: regionParent(project, region),
        pageSize: 1000,
      }),
      (page) => page.templates,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((template) => hasAlchemyLabelMap(template.labels))
          .map((template) => toAttrs(template, project, region)),
      ),
    ),
  );

const templateChanged = (
  current: dataproc.WorkflowTemplate,
  desired: dataproc.WorkflowTemplate,
) =>
  fingerprint(current.jobs) !== fingerprint(desired.jobs) ||
  fingerprint(current.placement) !== fingerprint(desired.placement) ||
  (current.dagTimeout ?? "") !== (desired.dagTimeout ?? "") ||
  fingerprint(current.parameters) !== fingerprint(desired.parameters) ||
  (current.encryptionConfig?.kmsKey ?? "") !==
    (desired.encryptionConfig?.kmsKey ?? "");

export const RegionsWorkflowTemplateProvider = () =>
  Provider.succeed(RegionsWorkflowTemplate, {
    stables: ["name", "templateId", "project", "region", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.templateId ?? output?.templateId;
      const nextId = news.templateId ?? previousId;
      const previousRegion = normalizeLocation(
        olds?.region ?? output?.region,
        env.region,
      );
      const nextRegion = normalizeLocation(
        news.region ?? olds?.region ?? output?.region,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (output !== undefined && previousRegion !== nextRegion)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousRegion === nextRegion &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeLocation(
        olds?.region ?? output?.region,
        env.region,
      );
      const templateId = yield* toPhysicalId(
        id,
        olds?.templateId,
        output?.templateId,
        MAX_POLICY_ID_LENGTH,
        "template",
      );
      const name =
        output?.name ?? resourceName(env.project, region, templateId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_LOCATIONS])],
          (region) => listRegion(env.project, region),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const region = normalizeLocation(
        news.region ?? output?.region,
        env.region,
      );
      const templateId = yield* toPhysicalId(
        id,
        news.templateId,
        output?.templateId,
        MAX_POLICY_ID_LENGTH,
        "template",
      );
      const name = resourceName(env.project, region, templateId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsRegionsWorkflowTemplates({
            parent: regionParent(env.project, region),
            body: desiredBody(news, templateId, name, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RegionsWorkflowTemplateNotResolved({ name });
      }

      const desired = desiredBody(
        news,
        templateId,
        current.name ?? name,
        desiredLabels,
        current.version,
      );
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged || templateChanged(current, desired)) {
        current = yield* dataproc.updateProjectsRegionsWorkflowTemplates({
          name: current.name ?? name,
          body: desired,
        });
      }

      return toAttrs(current, env.project, region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* dataproc
        .deleteProjectsRegionsWorkflowTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
