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
  MAX_SESSION_TEMPLATE_ID_LENGTH,
  emptyOnMissing,
  fingerprint,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type SessionTemplateProps = {
  /**
   * Template id (the `{template}` segment of
   * `projects/{project}/locations/{location}/sessionTemplates/{template}`).
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
   * Brief description.
   */
  description?: string;
  /**
   * Jupyter kernel config. Defaults to a PYTHON kernel when neither
   * `jupyterSession` nor `sparkConnectSession` is set.
   */
  jupyterSession?: dataproc.JupyterConfig;
  /**
   * Spark Connect session config. Mutually exclusive with Jupyter.
   */
  sparkConnectSession?: dataproc.SparkConnectConfig;
  /**
   * Runtime configuration (version, properties, container image).
   */
  runtimeConfig?: dataproc.RuntimeConfig;
  /**
   * Environment configuration (execution and peripherals).
   */
  environmentConfig?: dataproc.EnvironmentConfig;
};

export type SessionTemplate = Resource<
  "GCP.Dataproc.SessionTemplate",
  SessionTemplateProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/sessionTemplates/{template}`. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Description. */
    description: string | undefined;
    /** Jupyter kernel, if configured. */
    jupyterKernel: string | undefined;
    /** Server-assigned uuid. */
    uuid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataproc serverless interactive session template.
 *
 * Changing `templateId` or `location` replaces the template. Description,
 * labels, Jupyter config, runtime, and environment patch in place.
 *
 * ### Creating a Template
 * **Example:** Generated name
 * ```typescript
 * const template = yield* GCP.Dataproc.SessionTemplate("Notebook", {});
 * ```
 *
 * **Example:** Explicit Jupyter kernel
 * ```typescript
 * const template = yield* GCP.Dataproc.SessionTemplate("Notebook", {
 *   templateId: "analytics-nb",
 *   location: "us-central1",
 *   description: "python notebooks",
 *   jupyterSession: { kernel: "PYTHON" },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const SessionTemplate = Resource<SessionTemplate>(
  "GCP.Dataproc.SessionTemplate",
);

export class SessionTemplateNotResolved extends Data.TaggedError(
  "GCP.Dataproc.SessionTemplateNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, templateId: string) =>
  `${locationParent(project, location)}/sessionTemplates/${templateId}`;

// Dataproc rejects a Jupyter session template without a display name.
const defaultJupyter = (
  news: SessionTemplateProps,
  templateId: string,
): dataproc.JupyterConfig | undefined => {
  if (news.sparkConnectSession !== undefined) return undefined;
  const jupyter = news.jupyterSession ?? { kernel: "PYTHON" };
  return { ...jupyter, displayName: jupyter.displayName ?? templateId };
};

const toAttrs = (
  template: dataproc.SessionTemplate,
  project: string,
  location: string,
) => {
  const name = template.name ?? "";
  const parsed = parseResourceName(name, "sessionTemplates", location);
  return {
    name,
    templateId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    labels: userLabels(template.labels),
    description: template.description,
    jupyterKernel: template.jupyterSession?.kernel,
    uuid: template.uuid,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const desiredBody = (
  news: SessionTemplateProps,
  name: string,
  templateId: string,
  desiredLabels: Record<string, string>,
): dataproc.SessionTemplate => ({
  name,
  description: news.description,
  labels: desiredLabels,
  jupyterSession: defaultJupyter(news, templateId),
  sparkConnectSession: news.sparkConnectSession,
  runtimeConfig: news.runtimeConfig,
  environmentConfig: news.environmentConfig,
});

const getByName = (name: string) =>
  dataproc
    .getProjectsLocationsSessionTemplates({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listLocation = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsLocationsSessionTemplates.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.sessionTemplates,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((template) => hasAlchemyLabelMap(template.labels))
          .map((template) => toAttrs(template, project, location)),
      ),
    ),
  );

const templateChanged = (
  current: dataproc.SessionTemplate,
  desired: dataproc.SessionTemplate,
) =>
  (current.description ?? "") !== (desired.description ?? "") ||
  fingerprint(current.jupyterSession) !== fingerprint(desired.jupyterSession) ||
  fingerprint(current.sparkConnectSession) !==
    fingerprint(desired.sparkConnectSession) ||
  fingerprint(current.runtimeConfig) !== fingerprint(desired.runtimeConfig) ||
  fingerprint(current.environmentConfig) !==
    fingerprint(desired.environmentConfig);

export const SessionTemplateProvider = () =>
  Provider.succeed(SessionTemplate, {
    stables: [
      "name",
      "templateId",
      "project",
      "location",
      "uuid",
      "createTime",
    ],

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
        MAX_SESSION_TEMPLATE_ID_LENGTH,
        "session",
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
        MAX_SESSION_TEMPLATE_ID_LENGTH,
        "session",
      );
      const name = resourceName(env.project, location, templateId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, name, templateId, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsLocationsSessionTemplates({
            parent: locationParent(env.project, location),
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SessionTemplateNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged || templateChanged(current, desired)) {
        current = yield* dataproc.patchProjectsLocationsSessionTemplates({
          name: current.name ?? name,
          body: {
            ...desired,
            name: current.name ?? name,
          },
        });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* dataproc
        .deleteProjectsLocationsSessionTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
