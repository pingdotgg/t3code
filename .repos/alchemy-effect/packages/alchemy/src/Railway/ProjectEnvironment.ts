import type {
  EnvironmentCreateResponse,
  EnvironmentRenameResponse,
  EnvironmentResponse,
  EnvironmentsResponseEdgesItemNode,
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
import {
  createRailwayEnvironmentName,
  matchesAlchemyPhysicalName,
  sanitizeRailwayEnvironmentName,
} from "./Metadata.ts";
import { ownedProjects, type Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import { waitOutCreateRateLimit } from "./transient.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface EnvironmentProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` resource or an
   * Effect that produces one. Changing it replaces the Environment.
   */
  project: Ref<Project>;
  /**
   * Environment name. Unique per project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * the environment in place via `environmentRename`.
   */
  name?: string;
  /**
   * Fork this environment from an existing one (`sourceEnvironmentId`).
   * Create-only; ignored on update. Pass the project's `environmentId` to
   * copy production's services, volumes, and variables.
   */
  sourceEnvironmentId?: string;
}

export type Environment = Resource<
  "Railway.Environment",
  EnvironmentProps,
  {
    /** Railway environment id. */
    environmentId: string;
    /** Physical environment name (unique per project). */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Whether this is an ephemeral (PR) environment. */
    isEphemeral: boolean;
    /** Dashboard URL for this environment. */
    url: string;
  },
  never,
  Providers
>;

const EnvironmentResource = Resource<Environment>("Railway.Environment");

const resolveEnvironmentProps = (
  props: EnvironmentProps | Effect.Effect<EnvironmentProps, never, Providers>,
): Effect.Effect<EnvironmentProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project = Effect.isEffect(resolved.project)
      ? yield* resolved.project as Effect.Effect<Project, never, Providers>
      : resolved.project;
    return { ...resolved, project };
  });

/**
 * A Railway.Environment is an extra deploy environment under a Project
 * (staging, preview, …). The production environment is created with the
 * Project — do not recreate it as an Environment resource.
 *
 * @see https://docs.railway.com/guides/environments
 *
 * ### Create an extra environment
 * Alchemy generates a unique name unless you pass one. Production is
 * already on the Project as `environmentId`.
 *
 * **Example:** Staging next to production
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const staging = yield* Railway.Environment("Staging", {
 *   project: site,
 * });
 * ```
 *
 * :::note
 * Prefer omitting `name` in tests and CI so names stay unique and
 * reclaimable.
 * :::
 *
 * ### A stable name
 * Pass `name` when you need a stable environment name (`staging`).
 * Changing it later updates the environment in place.
 *
 * **Example:** Explicit name
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", {
 *   project: site,
 *   name: "staging",
 * });
 * ```
 *
 * ### Fork from production
 * `sourceEnvironmentId` copies services, volumes, configuration, and
 * variables from another environment. Create-only.
 *
 * **Example:** Fork production
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", {
 *   project: site,
 *   sourceEnvironmentId: site.environmentId,
 * });
 * ```
 *
 * ### Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Environment
 * ```typescript
 * // src/project.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Staging = Railway.Environment("Staging", {
 *   project: Site,
 * });
 * ```
 *
 * @resource
 */
export const Environment: typeof EnvironmentResource = Object.assign(
  (
    id: string,
    props: EnvironmentProps | Effect.Effect<EnvironmentProps, never, Providers>,
  ) => EnvironmentResource(id, resolveEnvironmentProps(props)),
  EnvironmentResource,
);

export class EnvironmentNotCreated extends Data.TaggedError(
  "Railway.EnvironmentNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class EnvironmentProjectRequired extends Data.TaggedError(
  "Railway.EnvironmentProjectRequired",
)<{
  message: string;
}> {}

type CloudEnvironment =
  | EnvironmentResponse
  | EnvironmentCreateResponse
  | EnvironmentRenameResponse
  | EnvironmentsResponseEdgesItemNode;

const toAttrs = (
  env: CloudEnvironment,
  fallback?: { name?: string; projectId?: string },
): Environment["Attributes"] => {
  const name = env.name || fallback?.name || "";
  const projectId = env.projectId || fallback?.projectId || "";
  return {
    environmentId: env.id,
    name,
    projectId,
    isEphemeral: env.isEphemeral,
    url: `https://railway.com/project/${projectId}?environmentId=${env.id}`,
  };
};

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeRailwayEnvironmentName(name);
    if (existing !== undefined) return existing;
    return yield* createRailwayEnvironmentName(id);
  });

const isGone = (env: CloudEnvironment | undefined) =>
  env === undefined || env.deletedAt != null;

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const getById = (environmentId: string, projectId?: string) =>
  railway
    .environment({
      id: environmentId,
      ...(projectId !== undefined ? { projectId } : {}),
    })
    .pipe(
      Effect.map((env) => (isGone(env) ? undefined : env)),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const findByName = (projectId: string, name: string) =>
  railway.environments.items({ projectId, first: 50 }).pipe(
    Stream.filter((env) => !isGone(env) && env.name === name),
    Stream.take(1),
    Stream.runHead,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listProjectEnvironments = (projectId: string) =>
  railway.environments.items({ projectId, first: 50 }).pipe(
    Stream.runCollect,
    Effect.map((envs) => Array.from(envs)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed([] as EnvironmentsResponseEdgesItemNode[]),
    ),
  );

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: ["environmentId", "projectId"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextProjectId = projectIdOf(news.project);
      if (nextProjectId !== undefined && nextProjectId !== output.projectId) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* resolveName(id, olds?.name, output?.name);
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      const found =
        (output?.environmentId !== undefined
          ? yield* getById(output.environmentId, output.projectId)
          : undefined) ??
        (projectId !== undefined
          ? yield* findByName(projectId, name)
          : undefined);
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, { name, projectId });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        railway.environments
          .items({ projectId: project.projectId, first: 50 })
          .pipe(
            Stream.filter(
              (env) =>
                env.deletedAt == null && matchesAlchemyPhysicalName(env.name),
            ),
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).map((env) => {
                const projectId = env.projectId || project.projectId;
                return {
                  environmentId: env.id,
                  name: env.name,
                  projectId,
                  isEphemeral: env.isEphemeral,
                  url: `https://railway.com/project/${projectId}?environmentId=${env.id}`,
                };
              }),
            ),
            Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
              Effect.succeed([] as Environment["Attributes"][]),
            ),
          ),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as EnvironmentProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new EnvironmentProjectRequired({
          message: "Environment requires a resolved Railway.Project",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);

      let current: CloudEnvironment | undefined =
        output?.environmentId !== undefined
          ? yield* getById(output.environmentId, output.projectId)
          : undefined;
      if (current === undefined) {
        current = yield* findByName(projectId, name);
      }

      if (current === undefined) {
        const created = yield* waitOutCreateRateLimit(
          railway.environmentCreate({
            input: {
              name,
              projectId,
              ...(props.sourceEnvironmentId !== undefined
                ? { sourceEnvironmentId: props.sourceEnvironmentId }
                : {}),
            },
          }),
        ).pipe(
          Effect.catchTag("RailwayValidationError", () =>
            Effect.succeed(undefined),
          ),
        );
        current = created ?? (yield* findByName(projectId, name));
      }

      if (current === undefined || isGone(current)) {
        return yield* new EnvironmentNotCreated({ name, projectId });
      }

      if (current.name !== name) {
        current = yield* railway.environmentRename({
          id: current.id,
          input: { name },
        });
      }

      return toAttrs(current, { name, projectId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const environmentId = output.environmentId;
      if (environmentId.length === 0) return;
      yield* railway
        .environmentDelete({ id: environmentId })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      yield* getById(environmentId, output.projectId).pipe(
        Effect.map((env) => env === undefined),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (gone) => gone,
          times: 8,
        }),
      );
    }),
  });
