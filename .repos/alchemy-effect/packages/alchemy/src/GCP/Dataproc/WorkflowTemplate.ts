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
  locationParent,
  normalizeLocation,
  parseResourceName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type WorkflowTemplateProps = {
  /**
   * Template id (the `{template}` segment of
   * `projects/{project}/locations/{location}/workflowTemplates/{template}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the template.
   */
  templateId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * template. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Directed acyclic graph of jobs. Defaults to a SparkPi example step.
   */
  jobs?: dataproc.OrderedJobList;
  /**
   * Target cluster (managed cluster or selector). Defaults to a 1-master
   * 2-worker managed cluster template; creating the workflow does not
   * provision the cluster until the template is instantiated.
   */
  placement?: dataproc.WorkflowTemplatePlacement;
  /**
   * DAG timeout (JSON Duration, 10m-24h).
   */
  dagTimeout?: string;
  /**
   * Cloud KMS key for encrypting job arguments.
   */
  kmsKey?: string;
  /**
   * Template parameters substituted at instantiate time.
   */
  parameters?: dataproc.TemplateParameterList;
};

export type WorkflowTemplate = Resource<
  "GCP.Dataproc.WorkflowTemplate",
  WorkflowTemplateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/workflowTemplates/{template}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
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
 * A Dataproc workflow template (locations API).
 *
 * Stores a DAG of jobs and a cluster placement. Instantiating the template
 * (out of band) is what actually creates a cluster and runs jobs.
 *
 * Changing `templateId` or `location` replaces the template. Jobs,
 * placement, labels, and timeout update in place (optimistic version).
 *
 * ### Creating a Template
 * **Example:** Generated name
 * ```typescript
 * const template = yield* GCP.Dataproc.WorkflowTemplate("Nightly", {});
 * ```
 *
 * **Example:** Explicit jobs
 * ```typescript
 * const template = yield* GCP.Dataproc.WorkflowTemplate("Nightly", {
 *   templateId: "nightly-etl",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   jobs: [{
 *     stepId: "spark-pi",
 *     sparkJob: {
 *       mainClass: "org.apache.spark.examples.SparkPi",
 *       jarFileUris: ["file:///usr/lib/spark/examples/jars/spark-examples.jar"],
 *     },
 *   }],
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const WorkflowTemplate = Resource<WorkflowTemplate>(
  "GCP.Dataproc.WorkflowTemplate",
);

export class WorkflowTemplateNotResolved extends Data.TaggedError(
  "GCP.Dataproc.WorkflowTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, templateId: string) =>
  `${locationParent(project, location)}/workflowTemplates/${templateId}`;

const toAttrs = (
  template: dataproc.WorkflowTemplate,
  project: string,
  location: string,
) => {
  const name = template.name ?? "";
  const parsed = parseResourceName(name, "workflowTemplates", location);
  return {
    name,
    templateId: template.id ?? parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    labels: userLabels(template.labels),
    version: template.version,
    dagTimeout: template.dagTimeout,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const desiredBody = (
  news: WorkflowTemplateProps,
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
    .getProjectsLocationsWorkflowTemplates({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listLocation = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsLocationsWorkflowTemplates.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.templates,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((template) => hasAlchemyLabelMap(template.labels))
          .map((template) => toAttrs(template, project, location)),
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

export const WorkflowTemplateProvider = () =>
  Provider.succeed(WorkflowTemplate, {
    stables: ["name", "templateId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.templateId ?? output?.templateId;
      const nextId = news.templateId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
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
        output?.name ?? resourceName(env.project, location, templateId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_LOCATIONS])],
          (location) => listLocation(env.project, location),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const templateId = yield* toPhysicalId(
        id,
        news.templateId,
        output?.templateId,
        MAX_POLICY_ID_LENGTH,
        "template",
      );
      const name = resourceName(env.project, location, templateId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsLocationsWorkflowTemplates({
            parent: locationParent(env.project, location),
            body: desiredBody(news, templateId, name, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new WorkflowTemplateNotResolved({ name });
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
        current = yield* dataproc.updateProjectsLocationsWorkflowTemplates({
          name: current.name ?? name,
          body: desired,
        });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* dataproc
        .deleteProjectsLocationsWorkflowTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
