import { createHash } from "node:crypto";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import {
  ownedProjects,
  projectEnvironmentIds,
  type Project,
} from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Variable is stored in. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type VariableEnvironment = {
  readonly environmentId: string;
};

/**
 * Service identity a Variable can be scoped to. Accepts a
 * `Railway.Service` or a `{ serviceId }` stub.
 */
export type VariableService = {
  readonly serviceId: string;
};

export interface VariableProps {
  /**
   * Parent Railway Project. Changing it replaces the variable.
   */
  project: Ref<Project>;
  /**
   * Environment to store the variable in. Accepts a `Railway.Project`
   * (primary environment), a `Railway.Environment`, or `{ environmentId }`.
   * Defaults to the project's primary environment. Changing it replaces
   * the variable.
   */
  environment?: Ref<VariableEnvironment>;
  /**
   * Service to scope the variable to. Omit for a shared (project-level)
   * variable. Accepts a `Railway.Service` or `{ serviceId }`. Changing it
   * replaces the variable.
   */
  service?: Ref<VariableService>;
  /**
   * Variable name (the env-var name services see). Stored as-is when set
   * by the user (case-sensitive). If omitted, a unique name is generated
   * from the stack, stage and logical ID. Changing it replaces the
   * variable.
   */
  name?: string;
  /**
   * Variable value. Wrap secrets with `Redacted.make(...)` so they are
   * never logged. May also be a `Railway.ref(...)` template
   * (`${{Db.DATABASE_URL}}`, `${{shared.NAME}}`); Railway stores the
   * template and interpolates it at build/runtime. Updated in place via
   * `variableUpsert`. Never persisted in attributes.
   */
  value: Redacted.Redacted<string> | string;
}

export type Variable = Resource<
  "Railway.Variable",
  VariableProps,
  {
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the variable lives in. */
    environmentId: string;
    /** Service the variable is scoped to, if any. */
    serviceId: string | undefined;
    /** Variable name (unique per project + environment + service). */
    name: string;
    /** sha256 of the current value. Not the plaintext. */
    digest: string;
  },
  never,
  Providers
>;

const resolveVariableProps = (
  props: VariableProps | Effect.Effect<VariableProps, never, Providers>,
): Effect.Effect<VariableProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const project = Effect.isEffect(resolved.project)
      ? yield* resolved.project as Effect.Effect<Project, never, Providers>
      : resolved.project;
    const environment =
      resolved.environment === undefined
        ? undefined
        : Effect.isEffect(resolved.environment)
          ? yield* resolved.environment as Effect.Effect<
              VariableEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    const service =
      resolved.service === undefined
        ? undefined
        : Effect.isEffect(resolved.service)
          ? yield* resolved.service as Effect.Effect<
              VariableService,
              never,
              Providers
            >
          : resolved.service;
    return { ...resolved, project, environment, service };
  });

const VariableResource = Resource<Variable>("Railway.Variable");

/**
 * A Railway.Variable is a project- or service-scoped env var. Railway
 * injects it into services in that environment. The plaintext is never
 * stored in attributes.
 *
 * @see https://docs.railway.com/guides/variables
 *
 * ### Create a Variable
 * Wrap the value with `Redacted.make` so it is never logged. Omit `name`
 * and Alchemy generates an ownership-stamped name. Shared (no `service`)
 * variables apply to every service in the environment.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const dbUrl = yield* Railway.Variable("DatabaseUrl", {
 *   project: site,
 *   value: Redacted.make("postgres://…"),
 * });
 * ```
 *
 * :::caution[Changing `project` replaces the Variable]
 * The value is created on the new Project. The old name is deleted.
 * :::
 *
 * ### Env-var name
 * `name` is the env-var services see. It is stored as-is
 * (case-sensitive).
 *
 * **Example:** Explicit name
 * ```typescript
 * export const ApiToken = Railway.Variable("ApiToken", {
 *   project: Site,
 *   name: "API_TOKEN",
 *   value: Redacted.make("sk_live_…"),
 * });
 * ```
 *
 * :::caution[Changing `name` replaces the Variable]
 * Railway cannot rename a variable. Alchemy creates the new name, then
 * deletes the old one.
 * :::
 *
 * ### Environment
 * Defaults to the Project's primary environment. Pass a
 * `Railway.Environment` (or `{ environmentId }`) to target another one.
 *
 * **Example:** Extra environment
 * ```typescript
 * const staging = yield* Railway.Environment("Staging", { project: site });
 * const token = yield* Railway.Variable("StagingToken", {
 *   project: site,
 *   environment: staging,
 *   value: Redacted.make("sk_staging_…"),
 * });
 * ```
 *
 * :::caution[Changing `environment` replaces the Variable]
 * The value is created in the new environment. The old name is deleted.
 * :::
 *
 * ### Service-scoped
 * Pass `service` to attach the variable to one service instead of the
 * shared project set.
 *
 * **Example:** Service variable
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const token = yield* Railway.Variable("ApiToken", {
 *   project: site,
 *   service: api,
 *   name: "API_TOKEN",
 *   value: Redacted.make("sk_live_…"),
 * });
 * ```
 *
 * ### Variable references
 * `value` may be a `Railway.ref(resource, key)` template instead of a
 * plaintext secret. Upsert stores `${{LogicalName.KEY}}` (or
 * `${{shared.NAME}}`) — not a resolved URI. Railway interpolates it.
 * Next to {@link ConnectPostgres}: use `ConnectPostgres` for a typed
 * client inside an Effect-native Service; use `Railway.ref` when you
 * want Railway's own `${{Db.DATABASE_URL}}` interpolation (IaC
 * `db.env.DATABASE_URL`).
 *
 * **Example:** Reference Postgres DATABASE_URL
 * ```typescript
 * const db = yield* Railway.Postgres("Db", { project: site });
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 * });
 * const databaseUrl = yield* Railway.Variable("DatabaseUrl", {
 *   project: site,
 *   service: api,
 *   name: "DATABASE_URL",
 *   value: Railway.ref(db, "DATABASE_URL"),
 * });
 * ```
 *
 * **Example:** Shared variable
 * ```typescript
 * yield* Railway.Variable("SentryDsn", {
 *   project: site,
 *   name: "SENTRY_DSN",
 *   value: Redacted.make("https://…"),
 * });
 * yield* Railway.Variable("ApiSentry", {
 *   project: site,
 *   service: api,
 *   name: "SENTRY_DSN",
 *   value: Railway.ref("shared", "SENTRY_DSN"),
 * });
 * ```
 *
 * ### Rotate the value
 * Updating `value` is in place via `variableUpsert`. Deploys are skipped
 * (`skipDeploys: true`); the Service resource owns deploys.
 *
 * **Example:** New value
 * ```typescript
 * export const ApiToken = Railway.Variable("ApiToken", {
 *   project: Site,
 *   name: "API_TOKEN",
 *   value: Redacted.make("sk_live_rotated"),
 * });
 * ```
 *
 * ### Module-scope declarations
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Variable
 * ```typescript
 * // src/secrets.ts
 * import * as Railway from "alchemy/Railway";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Site = Railway.Project("Site");
 * export const ApiToken = Railway.Variable("ApiToken", {
 *   project: Site,
 *   name: "API_TOKEN",
 *   value: Redacted.make("sk_live_…"),
 * });
 * ```
 *
 * @resource
 */
export const Variable: typeof VariableResource = Object.assign(
  (
    id: string,
    props: VariableProps | Effect.Effect<VariableProps, never, Providers>,
  ) => VariableResource(id, resolveVariableProps(props)),
  VariableResource,
);

export class VariableNotCreated extends Data.TaggedError(
  "Railway.VariableNotCreated",
)<{
  projectId: string;
  environmentId: string;
  name: string;
}> {}

export class VariableProjectRequired extends Data.TaggedError(
  "Railway.VariableProjectRequired",
)<{
  message: string;
}> {}

export class VariableEnvironmentRequired extends Data.TaggedError(
  "Railway.VariableEnvironmentRequired",
)<{
  message: string;
}> {}

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

const serviceIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { serviceId?: unknown };
  return typeof rec.serviceId === "string" && rec.serviceId.length > 0
    ? rec.serviceId
    : undefined;
};

const unwrapSecret = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const digestOf = (plain: string) =>
  Effect.sync(() =>
    createHash("sha256").update(Buffer.from(plain, "utf8")).digest("hex"),
  );

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const toAttrs = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string | undefined;
  name: string;
  digest: string;
}): Variable["Attributes"] => input;

const asVariableMap = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      out[key] = item;
    }
  }
  return out;
};

const listVariableMap = (
  projectId: string,
  environmentId: string,
  serviceId?: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      ...(serviceId !== undefined ? { serviceId } : {}),
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const getValue = (
  projectId: string,
  environmentId: string,
  name: string,
  serviceId?: string,
) =>
  listVariableMap(projectId, environmentId, serviceId).pipe(
    Effect.map((vars) => vars[name]),
  );

const upsertVariable = (input: {
  projectId: string;
  environmentId: string;
  name: string;
  value: string;
  serviceId?: string;
}) =>
  railway.variableUpsert({
    input: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      name: input.name,
      value: input.value,
      skipDeploys: true,
      ...(input.serviceId !== undefined ? { serviceId: input.serviceId } : {}),
    },
  });

const listEnvironmentIds = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments.items({ projectId: project.projectId, first: 50 }).pipe(
    Stream.filter((env) => env.deletedAt == null),
    Stream.map((env) => env.id),
    Stream.runCollect,
    Effect.map((ids) => {
      const set = new Set(Array.from(ids));
      if (project.environmentId.length > 0) {
        set.add(project.environmentId);
      }
      return Array.from(set);
    }),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(
        project.environmentId.length > 0 ? [project.environmentId] : [],
      ),
    ),
  );

export const VariableProvider = () =>
  Provider.succeed(Variable, {
    stables: ["projectId", "environmentId", "serviceId", "name"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName = news.name !== undefined ? news.name : output.name;
      const nameChanged = desiredName !== output.name;
      const nextProject = projectIdOf(news.project);
      const projectChanged =
        nextProject !== undefined && nextProject !== output.projectId;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      const nextService = serviceIdOf(news.service);
      const serviceChanged =
        news.service !== undefined && nextService !== output.serviceId;
      if (
        nameChanged ||
        projectChanged ||
        environmentChanged ||
        serviceChanged
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            nameChanged &&
            !projectChanged &&
            !environmentChanged &&
            !serviceChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const projectId =
        output?.projectId ??
        (olds !== undefined ? projectIdOf(olds.project) : undefined);
      const environmentId =
        output?.environmentId ??
        (olds !== undefined
          ? (environmentIdOf(olds.environment) ?? environmentIdOf(olds.project))
          : undefined);
      if (projectId === undefined || environmentId === undefined) {
        return undefined;
      }
      const name = yield* resolveName(id, olds?.name, output?.name);
      const serviceId =
        output?.serviceId ??
        (olds !== undefined ? serviceIdOf(olds.service) : undefined);
      const value = yield* getValue(projectId, environmentId, name, serviceId);
      if (value === undefined) return undefined;
      const digest = yield* digestOf(value);
      const attrs = toAttrs({
        projectId,
        environmentId,
        serviceId,
        name,
        digest,
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(envIds, (environmentId) =>
            listVariableMap(project.projectId, environmentId).pipe(
              Effect.flatMap((vars) =>
                Effect.forEach(
                  Object.keys(vars).filter((name) =>
                    matchesAlchemyPhysicalName(name),
                  ),
                  (name) =>
                    digestOf(vars[name]!).pipe(
                      Effect.map((digest) =>
                        toAttrs({
                          projectId: project.projectId,
                          environmentId,
                          serviceId: undefined,
                          name,
                          digest,
                        }),
                      ),
                    ),
                ),
              ),
            ),
          );
          return nested.flat();
        }),
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as VariableProps);
      const projectId = projectIdOf(props.project) ?? output?.projectId;
      if (projectId === undefined) {
        return yield* new VariableProjectRequired({
          message: "Variable requires a resolved Railway.Project",
        });
      }
      const environmentId =
        environmentIdOf(props.environment) ??
        environmentIdOf(props.project) ??
        output?.environmentId;
      if (environmentId === undefined) {
        return yield* new VariableEnvironmentRequired({
          message:
            "Variable requires a Railway environment (pass environment or a Project with environmentId)",
        });
      }
      const serviceId =
        props.service !== undefined
          ? serviceIdOf(props.service)
          : output?.serviceId;
      const name = yield* resolveName(id, props.name, output?.name);
      const desiredPlain = unwrapSecret(props.value);

      let current =
        output !== undefined
          ? yield* getValue(
              output.projectId,
              output.environmentId,
              output.name,
              output.serviceId,
            )
          : undefined;
      if (
        current === undefined &&
        (output === undefined ||
          output.projectId !== projectId ||
          output.environmentId !== environmentId ||
          output.name !== name ||
          output.serviceId !== serviceId)
      ) {
        current = yield* getValue(projectId, environmentId, name, serviceId);
      }

      let createdThisRun = false;
      if (current === undefined) {
        yield* upsertVariable({
          projectId,
          environmentId,
          name,
          value: desiredPlain,
          serviceId,
        });
        current = yield* getValue(projectId, environmentId, name, serviceId);
        createdThisRun = true;
      }

      if (current === undefined) {
        return yield* new VariableNotCreated({
          projectId,
          environmentId,
          name,
        });
      }

      if (!createdThisRun && current !== desiredPlain) {
        yield* upsertVariable({
          projectId,
          environmentId,
          name,
          value: desiredPlain,
          serviceId,
        });
        current =
          (yield* getValue(projectId, environmentId, name, serviceId)) ??
          desiredPlain;
      }

      const digest = yield* digestOf(current);
      return toAttrs({
        projectId,
        environmentId,
        serviceId,
        name,
        digest,
      });
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        output.projectId.length === 0 ||
        output.environmentId.length === 0 ||
        output.name.length === 0
      ) {
        return;
      }
      yield* railway
        .variableDelete({
          input: {
            projectId: output.projectId,
            environmentId: output.environmentId,
            name: output.name,
            ...(output.serviceId !== undefined
              ? { serviceId: output.serviceId }
              : {}),
          },
        })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      yield* getValue(
        output.projectId,
        output.environmentId,
        output.name,
        output.serviceId,
      ).pipe(
        Effect.map((value) => value === undefined),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (gone) => gone,
          times: 8,
        }),
      );
    }),
  });
