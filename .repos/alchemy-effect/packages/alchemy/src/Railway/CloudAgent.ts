import type {
  CloudAgentCreateResponse,
  CloudAgentResponse,
  CloudAgentSleepResponse,
  CloudAgentStatus,
  CloudAgentWakeResponse,
  CloudAgentsResultItem,
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
  createRailwayName,
  matchesAlchemyPhysicalName,
  sanitizeRailwayName,
} from "./Metadata.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a cloud agent is created in. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type CloudAgentEnvironment = {
  readonly environmentId: string;
  readonly projectId?: string;
};

export interface CloudAgentProps {
  /**
   * Environment the agent VM lives in. Accepts a `Railway.Project`
   * (primary environment), a `Railway.Environment`, or `{ environmentId }`.
   * Changing it replaces the agent.
   */
  environment: Ref<CloudAgentEnvironment>;
  /**
   * Agent name. Unique per environment for this user. If omitted, a
   * unique name is generated from the stack, stage and logical ID.
   * Changing it replaces the agent — Railway has no rename API.
   */
  name?: string;
  /**
   * Variables written to the agent at create time. Values may be
   * Railway reference templates (`Railway.ref(...)`). Create-only;
   * ignored on update. Never persisted in attributes.
   */
  variables?: Record<string, string>;
}

export type CloudAgent = Resource<
  "Railway.CloudAgent",
  CloudAgentProps,
  {
    /** Railway cloud agent id. */
    cloudAgentId: string;
    /** Physical agent name. */
    name: string;
    /** Environment the agent lives in. */
    environmentId: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Observed lifecycle status (`STARTING`, `RUNNING`, `SLEEPING`, …). */
    status: CloudAgentStatus;
    /**
     * Public hostname serving port 8080. Stable across sleep and wake;
     * `undefined` while the machine is asleep.
     */
    domain: string | undefined;
    /** Every public domain on the machine, one per port. */
    domains: ReadonlyArray<{
      domain: string;
      port: number;
      prefix: string;
    }>;
    /** Console / exec target id. `undefined` while unavailable. */
    consoleTargetId: string | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string;
  },
  never,
  Providers
>;

/**
 * A Railway.CloudAgent is a persistent coding-agent VM in an
 * environment. Sleep keeps the disk; wake re-runs the entrypoint.
 * Cloud agents are Priority Boarding and bill at VM rates while
 * running.
 *
 * @see https://docs.railway.com/cloud-agents
 *
 * ### Create a CloudAgent
 * Pass the Project (or an Environment). Alchemy generates a unique
 * name unless you pass one. `domain` is the public URL for port 8080.
 *
 * **Example:** Next to a Project
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const agent = yield* Railway.CloudAgent("Coder", {
 *   environment: site,
 * });
 * ```
 *
 * :::caution[Changing `environment` or `name` replaces the agent]
 * Railway has no cloud-agent update API. A new VM is created, then
 * the old one is deleted — the disk is not copied.
 * :::
 *
 * ### A stable name
 * Pass `name` when you need a stable agent name. Changing it later
 * replaces the agent.
 *
 * **Example:** Explicit name
 * ```typescript
 * const agent = yield* Railway.CloudAgent("Coder", {
 *   environment: site,
 *   name: "reviews",
 * });
 * ```
 *
 * ### Variables
 * `variables` are create-only. Pair them with a new agent — Railway
 * does not update variables on an existing VM. Values may reference
 * other services via `Railway.ref`.
 *
 * **Example:** Variables at create
 * ```typescript
 * const agent = yield* Railway.CloudAgent("Coder", {
 *   environment: site,
 *   variables: {
 *     DATABASE_URL: Railway.ref(db, "DATABASE_URL"),
 *   },
 * });
 * ```
 *
 * ### Sleep and wake
 * Sleep stops compute billing and keeps the disk. Wake re-runs the
 * entrypoint with files in place. These are not reconciler steps —
 * call {@link sleepCloudAgent} / {@link wakeCloudAgent}.
 *
 * **Example:** Sleep then wake
 * ```typescript
 * yield* Railway.sleepCloudAgent(agent);
 * yield* Railway.wakeCloudAgent(agent);
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope CloudAgent
 * ```typescript
 * // src/agent.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Coder = Railway.CloudAgent("Coder", {
 *   environment: Site,
 * });
 * ```
 *
 * @resource
 */
export const CloudAgent = Resource<CloudAgent>("Railway.CloudAgent");

export class CloudAgentNotCreated extends Data.TaggedError(
  "Railway.CloudAgentNotCreated",
)<{
  name: string;
  environmentId: string;
}> {}

export class CloudAgentEnvironmentRequired extends Data.TaggedError(
  "Railway.CloudAgentEnvironmentRequired",
)<{
  message: string;
}> {}

type CloudRow =
  | CloudAgentResponse
  | CloudAgentCreateResponse
  | CloudAgentSleepResponse
  | CloudAgentWakeResponse
  | CloudAgentsResultItem;

const toAttrs = (
  agent: CloudRow,
  fallback?: { name?: string; environmentId?: string; projectId?: string },
): CloudAgent["Attributes"] => ({
  cloudAgentId: agent.id,
  name: agent.name || fallback?.name || "",
  environmentId: agent.environmentId || fallback?.environmentId || "",
  projectId: agent.projectId || fallback?.projectId || "",
  status: agent.status,
  domain: agent.domain ?? undefined,
  domains: agent.domains.map((item) => ({
    domain: item.domain,
    port: item.port,
    prefix: item.prefix,
  })),
  consoleTargetId: agent.consoleTargetId ?? undefined,
  createdAt: agent.createdAt,
});

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeRailwayName(name);
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const isGone = (agent: CloudRow | undefined) =>
  agent === undefined || agent.status === "DELETING";

const environmentIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { environmentId?: unknown };
  return typeof rec.environmentId === "string" && rec.environmentId.length > 0
    ? rec.environmentId
    : undefined;
};

const projectIdOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { projectId?: unknown };
  return typeof rec.projectId === "string" && rec.projectId.length > 0
    ? rec.projectId
    : undefined;
};

const listAgents = (environmentId: string) =>
  railway
    .cloudAgents({ environmentId, mine: true })
    .pipe(
      Effect.catchTag(
        [
          "RailwayNotFound",
          "NotFound",
          "RailwayForbidden",
          "RailwayPlanLimitExceeded",
        ],
        () => Effect.succeed([] as CloudAgentsResultItem[]),
      ),
    );

const findById = (environmentId: string, id: string) =>
  listAgents(environmentId).pipe(
    Effect.map((items) => items.find((agent) => agent.id === id)),
  );

const findByName = (environmentId: string, name: string) =>
  listAgents(environmentId).pipe(
    Effect.map((items) =>
      items.find((agent) => !isGone(agent) && agent.name === name),
    ),
  );

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

const waitUntilGone = (environmentId: string, cloudAgentId: string) =>
  findById(environmentId, cloudAgentId).pipe(
    Effect.map((agent) => isGone(agent)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
  );

const cloudAgentIdOf = (
  agent: { readonly cloudAgentId: string } | string,
): string => (typeof agent === "string" ? agent : agent.cloudAgentId);

/**
 * Sleep a running cloud agent. Compute billing stops; the disk is
 * kept. Waking re-runs the entrypoint.
 */
export const sleepCloudAgent = Effect.fn(function* (
  agent: { readonly cloudAgentId: string } | string,
) {
  return yield* railway.cloudAgentSleep({ id: cloudAgentIdOf(agent) });
});

/**
 * Wake a sleeping cloud agent. Crashed or failed agents cannot be
 * woken — create a new one instead.
 */
export const wakeCloudAgent = Effect.fn(function* (
  agent: { readonly cloudAgentId: string } | string,
) {
  return yield* railway.cloudAgentWake({ id: cloudAgentIdOf(agent) });
});

export const CloudAgentProvider = () =>
  Provider.succeed(CloudAgent, {
    stables: ["cloudAgentId", "environmentId", "projectId", "createdAt"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextEnvironmentId = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnvironmentId !== undefined &&
        nextEnvironmentId !== output.environmentId;
      const nameChanged =
        news.name !== undefined &&
        sanitizeRailwayName(news.name) !== output.name;
      if (environmentChanged || nameChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* resolveName(id, olds?.name, output?.name);
      const environmentId =
        output?.environmentId ??
        (olds !== undefined ? environmentIdOf(olds.environment) : undefined);
      if (environmentId === undefined) return undefined;
      const found =
        (output?.cloudAgentId !== undefined
          ? yield* findById(environmentId, output.cloudAgentId)
          : undefined) ?? (yield* findByName(environmentId, name));
      if (found === undefined || isGone(found)) return undefined;
      const attrs = toAttrs(found, {
        name,
        environmentId,
        projectId:
          output?.projectId ??
          (olds !== undefined ? projectIdOf(olds.environment) : undefined),
      });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(found.name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(envIds, (environmentId) =>
            listAgents(environmentId).pipe(
              Effect.map((agents) =>
                agents
                  .filter(
                    (agent) =>
                      !isGone(agent) && matchesAlchemyPhysicalName(agent.name),
                  )
                  .map((agent) =>
                    toAttrs(agent, {
                      environmentId,
                      projectId: project.projectId,
                    }),
                  ),
              ),
            ),
          );
          return nested.flat();
        }),
      );
      const seen = new Set<string>();
      const unique: CloudAgent["Attributes"][] = [];
      for (const row of rows.flat()) {
        if (seen.has(row.cloudAgentId)) continue;
        seen.add(row.cloudAgentId);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as CloudAgentProps);
      const environmentId =
        environmentIdOf(props.environment) ?? output?.environmentId;
      if (environmentId === undefined) {
        return yield* new CloudAgentEnvironmentRequired({
          message:
            "CloudAgent requires a resolved Railway.Project or Railway.Environment",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const projectId =
        projectIdOf(props.environment) ?? output?.projectId ?? "";

      let current =
        output?.cloudAgentId !== undefined
          ? yield* findById(environmentId, output.cloudAgentId)
          : undefined;
      if (current === undefined || isGone(current)) {
        current = yield* findByName(environmentId, name);
      }

      if (current === undefined || isGone(current)) {
        const created = yield* railway
          .cloudAgentCreate({
            input: {
              environmentId,
              name,
              ...(props.variables !== undefined
                ? { variables: props.variables }
                : {}),
            },
          })
          .pipe(
            Effect.catchTag("RailwayValidationError", () =>
              Effect.succeed(undefined),
            ),
          );
        current =
          created !== undefined && !isGone(created)
            ? created
            : yield* findByName(environmentId, name);
      }

      if (current === undefined || isGone(current)) {
        return yield* new CloudAgentNotCreated({ name, environmentId });
      }

      return toAttrs(current, { name, environmentId, projectId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const cloudAgentId = output.cloudAgentId;
      if (cloudAgentId.length === 0) return;
      yield* railway
        .cloudAgentDelete({ id: cloudAgentId })
        .pipe(
          Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
        );
      if (output.environmentId.length > 0) {
        yield* waitUntilGone(output.environmentId, cloudAgentId);
      }
    }),
  });
