import type {
  ProjectCreateResponse,
  ProjectResponse,
  ProjectResponseServicesEdgesItemNode,
  ProjectUpdateResponse,
  ProjectsResponseEdgesItemNode,
  ServiceResponse,
  TemplateCloneResponse,
  TemplateGenerateResponse,
  TemplatePublishResponse,
  TemplateResponse,
  TemplatesResponseEdgesItemNode,
  TemplateSourceForProjectResponse,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { RailwayEnvironment } from "./Environment.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import {
  createProject,
  environmentIdOf as projectEnvironmentId,
  ownedProjects,
  workspaceIdOf as projectWorkspaceId,
} from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Project identity a template deploys into. Accepts a `Railway.Project`
 * or a `{ projectId }` stub.
 */
export type TemplateProject = {
  readonly projectId: string;
  readonly environmentId?: string;
  readonly workspaceId?: string;
};

/**
 * Environment identity a template deploys into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type TemplateEnvironment = {
  readonly environmentId: string;
};

export interface TemplateProps {
  /**
   * Marketplace template id (UUID) or template code (`postgres`,
   * `redis`). Changing it replaces the deployment.
   */
  templateId: string;
  /**
   * Project to deploy into. Accepts a `Railway.Project` or an Effect
   * that produces one. If omitted, Alchemy creates an owned Project
   * (serialized `createProject`) and deploys into it. Changing it
   * replaces the deployment.
   */
  project?: Ref<TemplateProject>;
  /**
   * Environment to deploy into. Accepts a `Railway.Project` (primary
   * environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment. Changing it
   * replaces the deployment.
   */
  environment?: Ref<TemplateEnvironment>;
  /**
   * Serialized template config passed to `templateDeployV2`. If omitted,
   * Alchemy fetches it from the marketplace template. Variables without
   * a `value` are filled from `defaultValue`.
   */
  serializedConfig?: unknown;
}

export type Template = Resource<
  "Railway.Template",
  TemplateProps,
  {
    /** Canonical marketplace template id (UUID). */
    templateId: string;
    /** Marketplace template code (`postgres`, …). */
    code: string;
    /** Marketplace template display name. */
    name: string;
    /** Project the template was deployed into. */
    projectId: string;
    /** Environment the template was deployed into. */
    environmentId: string;
    /** Workspace the project lives in. */
    workspaceId: string;
    /** Latest `templateDeployV2` workflow id, if Railway returned one. */
    workflowId: string | undefined;
    /** Service ids created from the template. */
    serviceIds: string[];
    /**
     * True when Alchemy created the Project because `project` was
     * omitted. Delete then removes that Project.
     */
    ownsProject: boolean;
    /** Dashboard URL (`https://railway.com/project/{projectId}`). */
    url: string;
  },
  never,
  Providers
>;

const resolveTemplateProps = (
  props: TemplateProps | Effect.Effect<TemplateProps, never, Providers>,
): Effect.Effect<TemplateProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project =
      resolved.project === undefined
        ? undefined
        : Effect.isEffect(resolved.project)
          ? yield* resolved.project as Effect.Effect<
              TemplateProject,
              never,
              Providers
            >
          : resolved.project;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              TemplateEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    return { ...resolved, project, environment };
  });

const TemplateResource = Resource<Template>("Railway.Template");

/**
 * A Railway.Template deploys a marketplace template into a Project.
 * Alchemy looks up the template (`template` / `templates`), sends
 * `templateDeployV2` with its `serializedConfig`, and adopts the
 * project/services the workflow creates.
 *
 * Pass a Project to deploy into an existing one. Omit `project` and
 * Alchemy creates an owned Project first (the workspace project-create
 * cap is serialized).
 *
 * @see https://docs.railway.com/templates/deploy
 *
 * ### Deploy a marketplace template
 * `templateId` is a marketplace UUID or code (`postgres`). Pass a
 * Project to deploy into it.
 *
 * **Example:** Postgres into a Project
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const db = yield* Railway.Template("Postgres", {
 *   templateId: "postgres",
 *   project: site,
 * });
 * ```
 *
 * :::caution[Changing `templateId`, `project`, or `environment` replaces]
 * The previous template services (and the owned Project, if Alchemy
 * created it) are deleted. A new deploy runs.
 * :::
 *
 * ### Create the Project
 * Omit `project` to let Alchemy create one. The name is stamped so
 * nuke can reclaim it.
 *
 * **Example:** Generated Project
 * ```typescript
 * const db = yield* Railway.Template("Postgres", {
 *   templateId: "postgres",
 * });
 * ```
 *
 * ### Serialized config
 * Omit `serializedConfig` to use the marketplace default. Pass a
 * config (from `template.serializedConfig`, with service variable
 * `value`s filled in) to override.
 *
 * **Example:** Override config
 * ```typescript
 * const db = yield* Railway.Template("Postgres", {
 *   templateId: "postgres",
 *   project: site,
 *   serializedConfig: config,
 * });
 * ```
 *
 * ### Environment
 * Defaults to the Project's primary environment.
 *
 * **Example:** Extra environment
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", { project: site });
 * const db = yield* Railway.Template("StagingPostgres", {
 *   templateId: "postgres",
 *   project: site,
 *   environment: staging,
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Template
 * ```typescript
 * // src/db.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Postgres = Railway.Template("Postgres", {
 *   templateId: "postgres",
 *   project: Site,
 * });
 * ```
 *
 * @resource
 */
export const Template: typeof TemplateResource = Object.assign(
  (
    id: string,
    props: TemplateProps | Effect.Effect<TemplateProps, never, Providers>,
  ) => TemplateResource(id, resolveTemplateProps(props)),
  TemplateResource,
);

export class TemplateNotFound extends Data.TaggedError(
  "Railway.TemplateNotFound",
)<{
  templateId: string;
}> {}

export class TemplateNotCreated extends Data.TaggedError(
  "Railway.TemplateNotCreated",
)<{
  templateId: string;
  projectId: string;
}> {}

export class TemplateConfigRequired extends Data.TaggedError(
  "Railway.TemplateConfigRequired",
)<{
  templateId: string;
}> {}

export class TemplateWorkflowFailed extends Data.TaggedError(
  "Railway.TemplateWorkflowFailed",
)<{
  workflowId: string;
  error: string;
}> {}

class TemplatePending extends Data.TaggedError("Railway.TemplatePending")<{
  projectId: string;
  state: string;
}> {}

type CloudTemplate =
  | TemplateResponse
  | TemplateCloneResponse
  | TemplateGenerateResponse
  | TemplatePublishResponse
  | TemplateSourceForProjectResponse
  | TemplatesResponseEdgesItemNode;

type CloudProject =
  | ProjectResponse
  | ProjectCreateResponse
  | ProjectUpdateResponse
  | ProjectsResponseEdgesItemNode;

type CloudService = ProjectResponseServicesEdgesItemNode | ServiceResponse;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const workspaceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { workspaceId?: unknown };
  return typeof rec.workspaceId === "string" && rec.workspaceId.length > 0
    ? rec.workspaceId
    : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isGoneProject = (project: CloudProject | undefined) =>
  project === undefined || project.deletedAt != null;

const isGoneService = (service: CloudService | undefined) =>
  service === undefined || service.deletedAt != null;

const currentWorkspaceId = Effect.fn(function* () {
  const env = yield* yield* RailwayEnvironment;
  return env.workspaceId;
});

const environmentIdFromProject = (project: CloudProject) =>
  projectEnvironmentId(project);

const toAttrs = (input: {
  template: CloudTemplate;
  project: CloudProject;
  environmentId: string;
  workspaceId: string;
  serviceIds: string[];
  workflowId: string | undefined;
  ownsProject: boolean;
}): Template["Attributes"] => ({
  templateId: input.template.id,
  code: input.template.code,
  name: input.template.name,
  projectId: input.project.id,
  environmentId: input.environmentId,
  workspaceId: input.workspaceId || projectWorkspaceId(input.project) || "",
  workflowId: input.workflowId,
  serviceIds: input.serviceIds,
  ownsProject: input.ownsProject,
  url: `https://railway.com/project/${input.project.id}`,
});

const getProject = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) => (isGoneProject(project) ? undefined : project)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const getTemplateById = (id: string) =>
  railway
    .template({ id })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const getTemplateByCode = (code: string) =>
  railway
    .template({ code })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const findPublished = (needle: string) =>
  railway.templates.items({ first: 50 }).pipe(
    Stream.filter(
      (template) => template.id === needle || template.code === needle,
    ),
    Stream.take(1),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const resolveMarketplaceTemplate = (templateId: string) =>
  Effect.gen(function* () {
    const primary = UUID.test(templateId)
      ? yield* getTemplateById(templateId)
      : yield* getTemplateByCode(templateId);
    if (primary !== undefined) return primary;
    const secondary = UUID.test(templateId)
      ? yield* getTemplateByCode(templateId)
      : yield* getTemplateById(templateId);
    if (secondary !== undefined) return secondary;
    return yield* findPublished(templateId);
  });

const sourceForProject = (projectId: string) =>
  railway
    .templateSourceForProject({ projectId })
    .pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound", "RailwayForbidden"], () =>
        Effect.succeed(undefined),
      ),
    );

const listProjectServices = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) =>
      project.services.edges
        .map((edge) => edge.node)
        .filter((node) => !isGoneService(node)),
    ),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as ProjectResponseServicesEdgesItemNode[]),
    ),
  );

const hydrateService = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const hydrateServices = (services: readonly CloudService[]) =>
  Effect.forEach(services, (service) => hydrateService(service.id), {
    concurrency: 4,
  }).pipe(
    Effect.map((rows) =>
      rows.filter((row): row is ServiceResponse => row !== undefined),
    ),
  );

const matchingServices = (input: {
  services: readonly ServiceResponse[];
  templateId: string;
  sourceId: string | undefined;
  ownsProject: boolean;
}): ServiceResponse[] => {
  const byTemplate = input.services.filter(
    (service) => service.templateId === input.templateId,
  );
  if (byTemplate.length > 0) return byTemplate;
  if (input.sourceId === input.templateId || input.ownsProject) {
    return [...input.services];
  }
  return [];
};

const parseConfig = (config: unknown) =>
  Effect.sync(() => {
    if (typeof config !== "string") return config;
    try {
      return JSON.parse(config) as unknown;
    } catch {
      return config;
    }
  });

const normalizeVariables = (variables: unknown): unknown => {
  if (!isRecord(variables)) return variables;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(variables)) {
    if (!isRecord(item)) {
      out[key] = item;
      continue;
    }
    const value =
      typeof item.value === "string"
        ? item.value
        : typeof item.defaultValue === "string"
          ? item.defaultValue
          : "";
    out[key] = { ...item, value };
  }
  return out;
};

const normalizeConfig = (config: unknown): unknown => {
  if (!isRecord(config) || !isRecord(config.services)) return config;
  const services: Record<string, unknown> = {};
  for (const [id, service] of Object.entries(config.services)) {
    if (!isRecord(service)) {
      services[id] = service;
      continue;
    }
    services[id] =
      service.variables === undefined
        ? service
        : { ...service, variables: normalizeVariables(service.variables) };
  }
  return { ...config, services };
};

const waitForWorkflow = (workflowId: string, projectId: string) =>
  Effect.gen(function* () {
    const result = yield* railway.workflowStatus({ workflowId }).pipe(
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({
          status: "NotFound",
          error: null,
        } as const),
      ),
    );
    if (result.status === "Complete") return result;
    if (result.status === "Error") {
      return yield* new TemplateWorkflowFailed({
        workflowId,
        error: result.error ?? "template deploy failed",
      });
    }
    return yield* new TemplatePending({
      projectId,
      state: result.status,
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.TemplatePending",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
    Effect.catchTag("Railway.TemplatePending", () => Effect.void),
  );

const waitForServices = (input: {
  projectId: string;
  templateId: string;
  sourceId: string | undefined;
  ownsProject: boolean;
}) =>
  listProjectServices(input.projectId).pipe(
    Effect.flatMap((listed) => hydrateServices(listed)),
    Effect.flatMap((services) => {
      const matched = matchingServices({
        services,
        templateId: input.templateId,
        sourceId: input.sourceId,
        ownsProject: input.ownsProject,
      });
      if (matched.length === 0) {
        return Effect.fail(
          new TemplatePending({
            projectId: input.projectId,
            state: "services",
          }),
        );
      }
      return Effect.succeed(matched);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.TemplatePending",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.TemplatePending", () =>
      listProjectServices(input.projectId).pipe(
        Effect.flatMap((listed) => hydrateServices(listed)),
        Effect.map((services) =>
          matchingServices({
            services,
            templateId: input.templateId,
            sourceId: input.sourceId,
            ownsProject: input.ownsProject,
          }),
        ),
      ),
    ),
  );

const waitUntilServiceGone = (serviceId: string) =>
  hydrateService(serviceId).pipe(
    Effect.map((service) => service === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

const waitUntilProjectGone = (projectId: string) =>
  getProject(projectId).pipe(
    Effect.map((project) => project === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

const observeDeployment = Effect.fn(function* (input: {
  projectId: string;
  templateId: string;
  ownsProject: boolean;
}) {
  const project = yield* getProject(input.projectId);
  if (project === undefined) {
    return undefined;
  }
  const source = yield* sourceForProject(input.projectId);
  const listed = yield* listProjectServices(input.projectId);
  const services = yield* hydrateServices(listed);
  const matched = matchingServices({
    services,
    templateId: input.templateId,
    sourceId: source?.id,
    ownsProject: input.ownsProject,
  });
  return { project, source, services: matched };
});

export const TemplateProvider = () =>
  Provider.succeed(Template, {
    stables: ["templateId", "code", "projectId", "workspaceId"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const templateChanged =
        news.templateId !== output.templateId &&
        news.templateId !== output.code;
      const nextProject = projectIdOf(news.project);
      const projectChanged =
        nextProject !== undefined && nextProject !== output.projectId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      if (templateChanged || projectChanged || environmentChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const templateRef = output?.templateId ?? olds?.templateId;
      if (templateRef === undefined || templateRef.length === 0) {
        return undefined;
      }
      const marketplace = yield* resolveMarketplaceTemplate(templateRef);
      const templateId = marketplace?.id ?? output?.templateId ?? templateRef;
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      if (projectId === undefined) return undefined;
      const ownsProject = output?.ownsProject ?? olds?.project === undefined;
      const observed = yield* observeDeployment({
        projectId,
        templateId,
        ownsProject,
      });
      if (observed === undefined || observed.services.length === 0) {
        return undefined;
      }
      const template = marketplace ?? observed.source;
      if (template === undefined) return undefined;
      const environmentId =
        output?.environmentId ??
        (olds !== undefined
          ? (environmentIdOf(olds.environment) ?? environmentIdOf(olds.project))
          : undefined) ??
        environmentIdFromProject(observed.project);
      const workspaceId =
        output?.workspaceId ??
        (olds !== undefined ? workspaceIdOf(olds.project) : undefined) ??
        projectWorkspaceId(observed.project);
      const attrs = toAttrs({
        template,
        project: observed.project,
        environmentId,
        workspaceId,
        serviceIds: observed.services.map((service) => service.id),
        workflowId: output?.workflowId,
        ownsProject,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(observed.project.name)
        ? attrs
        : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const live = yield* railway
            .project({ id: project.projectId })
            .pipe(
              Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
                Effect.succeed(undefined),
              ),
            );
          if (live === undefined || live.deletedAt != null) {
            return [] as Template["Attributes"][];
          }
          const services = live.services.edges
            .map((edge) => edge.node)
            .filter((service) => service.deletedAt == null);
          const stampedId = services.find(
            (service) => service.templateId != null,
          )?.templateId;
          const source =
            (yield* sourceForProject(project.projectId)) ??
            (stampedId != null ? yield* getTemplateById(stampedId) : undefined);
          if (source === undefined) return [] as Template["Attributes"][];
          return [
            toAttrs({
              template: source,
              project: live,
              environmentId: project.environmentId,
              workspaceId: project.workspaceId,
              serviceIds: services.map((service) => service.id),
              workflowId: undefined,
              ownsProject: false,
            }),
          ];
        }),
      );
      const seen = new Set<string>();
      const unique: Template["Attributes"][] = [];
      for (const row of rows.flat()) {
        const key = `${row.projectId}:${row.templateId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as TemplateProps);
      const templateRef = props.templateId ?? output?.templateId;
      if (templateRef === undefined || templateRef.length === 0) {
        return yield* new TemplateNotFound({ templateId: "" });
      }
      const marketplace = yield* resolveMarketplaceTemplate(templateRef);
      if (marketplace === undefined) {
        return yield* new TemplateNotFound({ templateId: templateRef });
      }

      const providedProject = props.project !== undefined;
      let ownsProject = providedProject ? false : (output?.ownsProject ?? true);
      let projectId = projectIdOf(props.project) ?? output?.projectId;
      let environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      let workspaceId =
        workspaceIdOf(props.project) ??
        output?.workspaceId ??
        (yield* currentWorkspaceId());

      let current: CloudProject | undefined =
        projectId !== undefined && projectId.length > 0
          ? yield* getProject(projectId)
          : undefined;

      if (current === undefined && !providedProject) {
        const name = yield* createRailwayName(id);
        const created = yield* createProject({
          name,
          workspaceId,
        }).pipe(
          Effect.catchTag("RailwayValidationError", () =>
            Effect.succeed(undefined),
          ),
        );
        current = created;
        ownsProject = true;
      }

      if (current === undefined || isGoneProject(current)) {
        return yield* new TemplateNotCreated({
          templateId: marketplace.id,
          projectId: projectId ?? "",
        });
      }

      projectId = current.id;
      environmentId =
        environmentId && environmentId.length > 0
          ? environmentId
          : environmentIdFromProject(current);
      workspaceId = projectWorkspaceId(current, workspaceId);

      const observed = yield* observeDeployment({
        projectId,
        templateId: marketplace.id,
        ownsProject,
      });
      let services = observed?.services ?? [];
      let workflowId = output?.workflowId;

      if (services.length === 0) {
        const rawConfig =
          props.serializedConfig ?? marketplace.serializedConfig;
        if (rawConfig == null) {
          return yield* new TemplateConfigRequired({
            templateId: marketplace.id,
          });
        }
        const parsed = yield* parseConfig(rawConfig);
        const serializedConfig = normalizeConfig(parsed);
        const deployed = yield* railway.templateDeployV2({
          input: {
            templateId: marketplace.id,
            serializedConfig,
            projectId,
            ...(environmentId.length > 0 ? { environmentId } : {}),
            workspaceId,
          },
        });
        projectId = deployed.projectId || projectId;
        workflowId = deployed.workflowId ?? workflowId;
        if (
          deployed.projectId.length > 0 &&
          deployed.projectId !== current.id
        ) {
          const created = yield* getProject(deployed.projectId);
          if (created !== undefined) current = created;
        }
        if (workflowId !== undefined && workflowId.length > 0) {
          yield* waitForWorkflow(workflowId, projectId);
        }
        const source = yield* sourceForProject(projectId);
        services = yield* waitForServices({
          projectId,
          templateId: marketplace.id,
          sourceId: source?.id,
          ownsProject,
        });
      }

      if (services.length === 0) {
        return yield* new TemplateNotCreated({
          templateId: marketplace.id,
          projectId,
        });
      }

      const live = (yield* getProject(projectId)) ?? current;
      if (environmentId.length === 0) {
        environmentId = environmentIdFromProject(live);
      }

      return toAttrs({
        template: marketplace,
        project: live,
        environmentId,
        workspaceId,
        serviceIds: services.map((service) => service.id),
        workflowId,
        ownsProject,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      const serviceIds = output.serviceIds ?? [];
      for (const serviceId of serviceIds) {
        if (serviceId.length === 0) continue;
        yield* railway
          .serviceDelete({
            id: serviceId,
            ...(output.environmentId.length > 0
              ? { environmentId: output.environmentId }
              : {}),
          })
          .pipe(
            Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
          );
        yield* waitUntilServiceGone(serviceId);
      }
      if (!output.ownsProject) return;
      const projectId = output.projectId;
      if (projectId.length === 0) return;
      yield* railway
        .projectDelete({ id: projectId })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      yield* waitUntilProjectGone(projectId);
    }),
  });
