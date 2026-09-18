import { waitUntilDeleted } from "./GraphQL.ts";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Binding from "../Binding.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { ownedProjects, projectEnvironmentIds } from "./Project.ts";
import type { Providers } from "./Providers.ts";

type SandboxNetworkIsolation = railway.Scalars["SandboxNetworkIsolation"];
type SandboxStatus = railway.Scalars["SandboxStatus"];
type SandboxTemplateInput = railway.Inputs["SandboxTemplateInput"];

const selection = {
  id: true,
  environmentId: true,
  region: true,
  status: true,
  idleTimeoutMinutes: true,
  networkIsolation: true,
  createdAt: true,
  domains: { prefix: true, port: true, domain: true },
} as const satisfies railway.Selection<"Sandbox">;
type CreateSandboxResponse = railway.Result<"Sandbox!", typeof selection>;
type SandboxResponse = railway.Result<"Sandbox!", typeof selection>;
type SandboxDestroyResponse = railway.Result<"Sandbox!", typeof selection>;
type SandboxHeartbeatResponse = railway.Result<"Sandbox!", typeof selection>;
type SandboxesResponseEdgesItemNode = railway.Result<
  "Sandbox!",
  typeof selection
>;
type SandboxCheckpointsResultItem = railway.Result<
  "SandboxCheckpoint!",
  { createdAt: true; environmentId: true; id: true; key: true }
>;
type ExecSandboxResponse = railway.Result<
  "SandboxExecResult!",
  {
    exitCode: true;
    stderr: true;
    stdout: true;
    timedOut: true;
    truncated: true;
  }
>;

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Sandbox is created in. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type SandboxEnvironment = {
  readonly environmentId: string;
  readonly projectId?: string;
};

/**
 * Sandbox identity for {@link Exec} / helpers. Accepts a
 * `Railway.Sandbox` or a `{ sandboxId, environmentId }` stub.
 */
export type SandboxIdentity = {
  readonly sandboxId: string;
  readonly environmentId: string;
};

/**
 * Create-time template for a sandbox. Mutually exclusive `instructions`
 * (build a recipe) and `name` (boot from a named checkpoint).
 */
export interface SandboxTemplate {
  /** Region in which to build the template. Checkpoints retain their captured region. */
  region?: string;
  /**
   * Build a template by running these shell instructions on the base
   * image. Mutually exclusive with `name`.
   */
  instructions?: readonly string[];
  /**
   * Boot from a saved checkpoint with this name. Mutually exclusive
   * with `instructions`.
   */
  name?: string;
  /**
   * Environment variables available to the template's build
   * instructions. Values may contain Railway variable references.
   */
  variables?: Record<string, string>;
}

export interface SandboxDomain {
  /** Port of the HTTP server listening on `0.0.0.0`, from 1 to 65535. */
  port: number;
  /** Unique domain prefix. Railway generates one when omitted. */
  prefix?: string;
}

export interface SandboxResources {
  /** Maximum vCPU allocation. Fractional values are supported. */
  cpu?: number;
  /** Maximum memory allocation in GB. Subject to the workspace plan limit. */
  memoryGB?: number;
}

export interface SandboxProps {
  /**
   * Environment to create the sandbox in. Accepts a `Railway.Project`
   * (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Changing it replaces the Sandbox.
   */
  environment: Ref<SandboxEnvironment>;
  /**
   * Region to place the sandbox in (`us-west2`, `us-east4-eqdc4a`, …).
   * Defaults to US West when omitted. Changing it replaces the Sandbox.
   */
  region?: string;
  /**
   * Minutes of idle time before Railway auto-destroys the sandbox.
   * Plan-dependent default and maximum. Changing it replaces the
   * Sandbox — there is no update API.
   */
  idleTimeoutMinutes?: number;
  /**
   * Network access. `ISOLATED` (default) has outbound internet only.
   * `PRIVATE` also joins the environment's private network. Changing
   * it replaces the Sandbox.
   */
  networkIsolation?: SandboxNetworkIsolation;
  /**
   * Public HTTPS routes, up to ten unique ports. Requires `networkIsolation:
   * "PRIVATE"`. Changing or removing routes replaces the sandbox.
   */
  publicDomains?: SandboxDomain[];
  /**
   * VM allocation, bounded by the workspace plan. Omit for the plan default.
   * Changing or removing it replaces the sandbox.
   */
  resources?: SandboxResources;
  /**
   * Running sandbox whose disk to fork. The source must be in this environment;
   * the fork inherits its region, but not variables, routes or idle timeout.
   * Mutually exclusive with `template`. Changing it replaces the sandbox.
   */
  sourceSandboxId?: string;
  /**
   * Template to boot from: build instructions, or a named checkpoint.
   * Changing it replaces the Sandbox.
   */
  template?: SandboxTemplate;
  /**
   * Environment variables baked into the sandbox, available to every
   * command. Values may contain Railway variable references, resolved
   * at create time. Changing them replaces the Sandbox.
   */
  variables?: Record<string, string>;
}

export type Sandbox = Resource<
  "Railway.Sandbox",
  SandboxProps,
  {
    /** Railway sandbox id. */
    sandboxId: string;
    /** Environment the sandbox lives in. */
    environmentId: string;
    /** Parent Railway project id, if known. */
    projectId: string | undefined;
    /** Region the sandbox was placed in. */
    region: string;
    /** Observed status (`CREATING`, `RUNNING`, `FAILED`, …). */
    status: SandboxStatus;
    /** Idle timeout in minutes, or `undefined` when Railway omitted it. */
    idleTimeoutMinutes: number | undefined;
    /** Network isolation mode. */
    networkIsolation: SandboxNetworkIsolation;
    /** RFC3339 creation timestamp. */
    createdAt: string;
    /** Published HTTPS routes. Empty when no public domains were requested. */
    domains: {
      /** Domain prefix assigned by Railway. */
      prefix: string;
      /** HTTP server port. */
      port: number;
      /** Hostname served over HTTPS. */
      domain: string;
    }[];
  },
  never,
  Providers
>;

const resolveSandboxProps = (
  props: SandboxProps | Effect.Effect<SandboxProps, never, Providers>,
): Effect.Effect<SandboxProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const environment = Effect.isEffect(resolved.environment)
      ? yield* resolved.environment as Effect.Effect<
          SandboxEnvironment,
          never,
          Providers
        >
      : resolved.environment;
    return { ...resolved, environment };
  });

const SandboxResource = Resource<Sandbox>("Railway.Sandbox");

/**
 * A Railway.Sandbox is an ephemeral Linux VM in an environment. Create
 * it, {@link execSandbox} commands, snapshot with checkpoints, and
 * destroy it when the task is done. Sandboxes are available on every plan.
 *
 * Railway has no labels and sandboxes have no names. Identity is the
 * Railway sandbox id. There is no in-place update — changing
 * `environment`, `region`, `idleTimeoutMinutes`, `networkIsolation`,
 * `template`, `variables`, `publicDomains`, `resources`, or `sourceSandboxId`
 * replaces the Sandbox. Removing a previously configured option also replaces it.
 *
 * @see https://docs.railway.com/sandboxes
 * @see https://docs.railway.com/guides/code-execution-sandboxes
 *
 * ### Create a Sandbox
 * Pass a Project (or Environment). Alchemy waits until the sandbox is
 * `RUNNING` and ready to exec.
 *
 * **Example:** From a Project
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const box = yield* Railway.Sandbox("Box", {
 *   environment: site,
 * });
 * ```
 *
 * :::caution[Changing `environment` or `region` replaces the Sandbox]
 * A new VM is created. The old sandbox is destroyed.
 * :::
 *
 * ### Idle timeout
 * Railway auto-destroys a sandbox after it sits idle. Active exec sessions
 * and SSH foreground work defer teardown; background processes alone do not.
 * Hobby/Pro default is 30 minutes (max 120), with `0` disabling idle teardown.
 * Trial/Free default and max is 5 minutes. A sandbox with idle teardown disabled
 * remains billable until explicitly destroyed.
 *
 * **Example:** Short idle timeout
 * ```typescript
 * const box = yield* Railway.Sandbox("Box", {
 *   environment: site,
 *   idleTimeoutMinutes: 5,
 * });
 * ```
 *
 * :::caution[Changing `idleTimeoutMinutes` replaces the Sandbox]
 * There is no sandbox update API.
 * :::
 *
 * ### Variables
 * Baked into the sandbox at create time. Available to every command.
 *
 * **Example:** Create-time env
 * ```typescript
 * const box = yield* Railway.Sandbox("Box", {
 *   environment: site,
 *   variables: { NODE_ENV: "production" },
 * });
 * ```
 *
 * ### Template
 * Boot from a named checkpoint, or from build instructions.
 *
 * **Example:** Checkpoint
 * ```typescript
 * const box = yield* Railway.Sandbox("Box", {
 *   environment: site,
 *   template: { name: "after-deps" },
 * });
 * ```
 *
 * ### Publish HTTP ports
 * **Example:** Private-network sandbox with an HTTPS route
 * ```typescript
 * const preview = yield* Railway.Sandbox("Preview", {
 *   environment: site,
 *   networkIsolation: "PRIVATE",
 *   publicDomains: [{ port: 3000 }],
 *   resources: { cpu: 1, memoryGB: 1 },
 * });
 * ```
 * Start the HTTP server on `0.0.0.0:3000`. Published hostnames are available
 * in `preview.domains`; creating a route does not start the server.
 *
 * ### Fork a sandbox
 * **Example:** Independent copy of a running sandbox's disk
 * ```typescript
 * const fork = yield* Railway.Sandbox("Attempt", {
 *   environment: site,
 *   sourceSandboxId: box.sandboxId,
 *   idleTimeoutMinutes: 5,
 * });
 * ```
 * Files are copied, but running processes and memory are not. Keep the source
 * declared while replacing a fork. For a reusable named disk snapshot, use
 * `Railway.SandboxCheckpoint` and pass its `name` as `template.name`.
 *
 * ### Exec
 * Run a command after deploy with {@link execSandbox} or {@link Exec}.
 *
 * **Example:** Echo
 * ```typescript
 * const result = yield* Railway.execSandbox({
 *   sandboxId: box.sandboxId,
 *   environmentId: box.environmentId,
 *   command: "echo hello",
 * });
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Sandbox
 * ```typescript
 * // src/box.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Box = Railway.Sandbox("Box", {
 *   environment: Site,
 *   idleTimeoutMinutes: 10,
 * });
 * ```
 *
 * @resource
 */
export const Sandbox: typeof SandboxResource = Object.assign(
  (
    id: string,
    props: SandboxProps | Effect.Effect<SandboxProps, never, Providers>,
  ) => SandboxResource(id, resolveSandboxProps(props)),
  SandboxResource,
);

export class SandboxNotCreated extends Data.TaggedError(
  "Railway.SandboxNotCreated",
)<{
  environmentId: string;
}> {}

export class SandboxEnvironmentRequired extends Data.TaggedError(
  "Railway.SandboxEnvironmentRequired",
)<{
  message: string;
}> {}

export class SandboxFailed extends Data.TaggedError("Railway.SandboxFailed")<{
  sandboxId: string;
  status: string;
}> {}

export class SandboxCheckpointNotFound extends Data.TaggedError(
  "Railway.SandboxCheckpointNotFound",
)<{
  environmentId: string;
  name: string;
}> {}

class SandboxPending extends Data.TaggedError("Railway.SandboxPending")<{
  sandboxId: string;
  status: string;
}> {}

type CloudSandbox =
  | SandboxResponse
  | CreateSandboxResponse
  | SandboxDestroyResponse
  | SandboxHeartbeatResponse
  | SandboxesResponseEdgesItemNode;

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

const isGone = (sandbox: CloudSandbox | undefined) =>
  sandbox === undefined || sandbox.status === "DESTROYED";

const toAttrs = (
  sandbox: CloudSandbox,
  fallback?: { projectId?: string },
): Sandbox["Attributes"] => ({
  sandboxId: sandbox.id,
  environmentId: sandbox.environmentId,
  projectId: fallback?.projectId,
  region: sandbox.region,
  status: sandbox.status,
  idleTimeoutMinutes: sandbox.idleTimeoutMinutes ?? undefined,
  networkIsolation: sandbox.networkIsolation,
  createdAt: sandbox.createdAt,
  domains: sandbox.domains,
});

const toTemplateInput = (template: SandboxTemplate): SandboxTemplateInput => ({
  ...(template.region !== undefined ? { region: template.region } : {}),
  ...(template.instructions !== undefined
    ? { instructions: [...template.instructions] }
    : {}),
  ...(template.name !== undefined ? { name: template.name } : {}),
  ...(template.variables !== undefined
    ? { variables: template.variables }
    : {}),
});

const varsKey = (vars: Record<string, string> | undefined) => {
  if (vars === undefined) return undefined;
  const entries = Object.entries(vars).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
};

const templateKey = (template: SandboxTemplate | undefined) => {
  if (template === undefined) return undefined;
  return JSON.stringify({
    region: template.region ?? null,
    instructions: template.instructions ?? null,
    name: template.name ?? null,
    variables: varsKey(template.variables) ?? null,
  });
};

const domainsKey = (domains: SandboxDomain[] | undefined) =>
  JSON.stringify(
    (domains ?? [])
      .map(({ port, prefix }) => ({ port, prefix: prefix ?? null }))
      .sort((a, b) => a.port - b.port),
  );

const getById = (environmentId: string, sandboxId: string) =>
  railway.sandbox({ environmentId, id: sandboxId }, selection).pipe(
    Effect.map((sandbox) =>
      sandbox == null || isGone(sandbox) ? undefined : sandbox,
    ),
    railway.catchTags(["RailwayNotFound"], () => Effect.succeed(undefined)),
  );

const listSandboxes = (environmentId: string) =>
  railway.sandboxes.items({ environmentId, first: 50 }, selection).pipe(
    Stream.filter((sandbox) => !isGone(sandbox)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    railway.catchTags(
      ["RailwayNotFound", "RailwayForbidden", "RailwayPlanLimitExceeded"],
      () => Effect.succeed([] as SandboxesResponseEdgesItemNode[]),
    ),
  );

const listEnvironmentIds = (project: {
  projectId: string;
  environmentId: string;
}) =>
  railway.environments
    .items(
      { projectId: project.projectId, first: 50 },
      { id: true, deletedAt: true },
    )
    .pipe(
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
      railway.catchTags(["RailwayNotFound"], () =>
        Effect.succeed(
          project.environmentId.length > 0 ? [project.environmentId] : [],
        ),
      ),
    );

const waitUntilRunning = (environmentId: string, sandboxId: string) =>
  Effect.gen(function* () {
    const sandbox = yield* getById(environmentId, sandboxId);
    if (sandbox === undefined) {
      return yield* new SandboxPending({ sandboxId, status: "missing" });
    }
    if (sandbox.status === "FAILED") {
      return yield* new SandboxFailed({
        sandboxId,
        status: sandbox.status,
      });
    }
    if (sandbox.status !== "RUNNING") {
      return yield* new SandboxPending({
        sandboxId,
        status: sandbox.status,
      });
    }
    return sandbox;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.SandboxPending",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitUntilGone = (environmentId: string, sandboxId: string) =>
  waitUntilDeleted(
    "Sandbox",
    sandboxId,
    getById(environmentId, sandboxId).pipe(
      Effect.map((sandbox) => sandbox === undefined),
    ),
    10,
  );

/**
 * Execute a command inside a running sandbox. Does not fail on a
 * non-zero exit code — inspect `exitCode`.
 */
export const execSandbox = Effect.fn(function* (input: {
  sandboxId: string;
  environmentId: string;
  command: string;
  timeoutSec?: number;
}) {
  return yield* railway.execSandbox(
    {
      command: input.command,
      environmentId: input.environmentId,
      id: input.sandboxId,
      ...(input.timeoutSec !== undefined
        ? { timeoutSec: input.timeoutSec }
        : {}),
    },
    {
      exitCode: true,
      stderr: true,
      stdout: true,
      timedOut: true,
      truncated: true,
    },
  );
});

/**
 * Extend a sandbox's idle timeout from the last interaction.
 */
export const heartbeatSandbox = Effect.fn(function* (input: {
  sandboxId: string;
  environmentId: string;
}) {
  return yield* railway.sandboxHeartbeat(
    {
      environmentId: input.environmentId,
      id: input.sandboxId,
    },
    selection,
  );
});

/**
 * Capture a running sandbox's disk as a named checkpoint. Synchronous:
 * the checkpoint is ready when this returns. Reusing a name replaces
 * the previous checkpoint.
 */
export const createSandboxCheckpoint = Effect.fn(function* (input: {
  sandboxId: string;
  environmentId: string;
  name: string;
}) {
  return yield* railway.createSandboxCheckpoint(
    {
      environmentId: input.environmentId,
      name: input.name,
      sandboxId: input.sandboxId,
    },
    { createdAt: true, environmentId: true, id: true, key: true },
  );
});

/**
 * List named sandbox checkpoints in an environment (newest first).
 */
export const listSandboxCheckpoints = Effect.fn(function* (input: {
  environmentId: string;
}) {
  return yield* railway.sandboxCheckpoints(
    {
      environmentId: input.environmentId,
    },
    { createdAt: true, environmentId: true, id: true, key: true },
  );
});

const findCheckpoint = (
  items: readonly SandboxCheckpointsResultItem[],
  name: string,
) => items.find((item) => item.key === name);

/**
 * Rename a sandbox checkpoint by its current name (`key`).
 */
export const renameSandboxCheckpoint = Effect.fn(function* (input: {
  environmentId: string;
  name: string;
  newName: string;
}) {
  const items = yield* railway.sandboxCheckpoints(
    {
      environmentId: input.environmentId,
    },
    { createdAt: true, environmentId: true, id: true, key: true },
  );
  const found = findCheckpoint(items, input.name);
  if (found === undefined) {
    return yield* new SandboxCheckpointNotFound({
      environmentId: input.environmentId,
      name: input.name,
    });
  }
  return yield* railway.renameSandboxCheckpoint(
    {
      environmentId: input.environmentId,
      id: found.id,
      name: input.newName,
    },
    { createdAt: true, environmentId: true, id: true, key: true },
  );
});

/**
 * Delete a sandbox checkpoint by name (`key`). Idempotent if missing.
 */
export const deleteSandboxCheckpoint = Effect.fn(function* (input: {
  environmentId: string;
  name: string;
}) {
  const items = yield* railway.sandboxCheckpoints(
    {
      environmentId: input.environmentId,
    },
    { createdAt: true, environmentId: true, id: true, key: true },
  );
  const found = findCheckpoint(items, input.name);
  if (found === undefined) return;
  yield* railway
    .deleteSandboxCheckpoint({
      environmentId: input.environmentId,
      id: found.id,
    })
    .pipe(railway.catchTags(["RailwayNotFound"], () => Effect.void));
});

export type ExecRequest = {
  command: string;
  timeoutSec?: number;
};

export type ExecResult = ExecSandboxResponse;

/**
 * Run a command inside a {@link Sandbox}. Control-plane GraphQL —
 * provide {@link ExecHttp}. The inner Effect requires
 * {@link RuntimeContext} so it is typed as runtime-only; from tests
 * prefer {@link execSandbox}.
 *
 *
 * ### Exec
 * **Example:** Echo
 * ```typescript
 * const run = yield* Railway.Exec(box);
 * const result = yield* run({ command: "echo hello" });
 * ```
 *
 * @binding
 * @product Railway
 */
export interface Exec extends Binding.Service<
  Exec,
  "Railway.Sandbox.Exec",
  (sandbox: SandboxIdentity) => Effect.Effect<ExecClient>
> {}

export const Exec = Binding.Service<Exec>("Railway.Sandbox.Exec");

export interface ExecClient {
  (
    request: ExecRequest,
  ): Effect.Effect<
    ExecResult,
    Effect.Error<ReturnType<typeof execSandbox>>,
    RuntimeContext
  >;
}

/**
 * HTTP / GraphQL implementation of {@link Exec}.
 *
 * @layer
 * @provides Railway.Sandbox.Exec
 */
export const ExecHttp = Layer.effect(
  Exec,
  Effect.succeed(
    Effect.fn(function* (sandbox: SandboxIdentity) {
      const sandboxId = sandbox.sandboxId;
      const environmentId = sandbox.environmentId;
      return ((request: ExecRequest) =>
        execSandbox({
          sandboxId,
          environmentId,
          command: request.command,
          ...(request.timeoutSec !== undefined
            ? { timeoutSec: request.timeoutSec }
            : {}),
        })) as unknown as ExecClient;
    }),
  ),
);

export const SandboxProvider = () =>
  Provider.succeed(Sandbox, {
    stables: ["sandboxId", "environmentId", "createdAt", "region"],
    nuke: { dependsOn: ["Railway.Project"] },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const nextEnv = environmentIdOf(news.environment);
      const environmentChanged =
        nextEnv !== undefined && nextEnv !== output.environmentId;
      const regionChanged =
        olds !== undefined
          ? news.region !== olds.region
          : news.region !== undefined && news.region !== output.region;
      const idleChanged =
        olds !== undefined
          ? news.idleTimeoutMinutes !== olds.idleTimeoutMinutes
          : news.idleTimeoutMinutes !== undefined &&
            news.idleTimeoutMinutes !== output.idleTimeoutMinutes;
      const isolationChanged =
        olds !== undefined
          ? news.networkIsolation !== olds.networkIsolation
          : news.networkIsolation !== undefined &&
            news.networkIsolation !== output.networkIsolation;
      const templateChanged =
        templateKey(news.template) !== templateKey(olds?.template);
      const variablesChanged =
        varsKey(news.variables) !== varsKey(olds?.variables);
      const domainsChanged =
        domainsKey(news.publicDomains) !== domainsKey(olds?.publicDomains);
      const resourcesChanged =
        news.resources?.cpu !== olds?.resources?.cpu ||
        news.resources?.memoryGB !== olds?.resources?.memoryGB;
      const sourceChanged = news.sourceSandboxId !== olds?.sourceSandboxId;
      if (
        environmentChanged ||
        regionChanged ||
        idleChanged ||
        isolationChanged ||
        templateChanged ||
        variablesChanged ||
        domainsChanged ||
        resourcesChanged ||
        sourceChanged
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const environmentId =
        output?.environmentId ??
        (olds !== undefined ? environmentIdOf(olds.environment) : undefined);
      const sandboxId = output?.sandboxId;
      if (environmentId === undefined || sandboxId === undefined) {
        return undefined;
      }
      const found = yield* getById(environmentId, sandboxId);
      if (found === undefined) return undefined;
      return toAttrs(found, {
        projectId:
          output?.projectId ??
          (olds !== undefined ? projectIdOf(olds.environment) : undefined),
      });
    }),

    list: Effect.fn(function* () {
      const projects = yield* ownedProjects();
      const rows = yield* Effect.forEach(projects, (project) =>
        Effect.gen(function* () {
          const envIds = yield* projectEnvironmentIds(project);
          const nested = yield* Effect.forEach(envIds, (environmentId) =>
            listSandboxes(environmentId).pipe(
              Effect.map((items) =>
                items.map((item) =>
                  toAttrs(item, { projectId: project.projectId }),
                ),
              ),
            ),
          );
          return nested.flat();
        }),
      );
      const seen = new Set<string>();
      const unique: Sandbox["Attributes"][] = [];
      for (const row of rows.flat()) {
        if (seen.has(row.sandboxId)) continue;
        seen.add(row.sandboxId);
        unique.push(row);
      }
      return unique;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const props = news ?? ({} as SandboxProps);
      const environmentId =
        environmentIdOf(props.environment) ?? output?.environmentId;
      if (environmentId === undefined) {
        return yield* new SandboxEnvironmentRequired({
          message:
            "Sandbox requires a Railway environment (pass a Project, Environment, or { environmentId })",
        });
      }
      const projectId = projectIdOf(props.environment) ?? output?.projectId;

      let current: CloudSandbox | undefined =
        output?.sandboxId !== undefined && output.sandboxId.length > 0
          ? yield* getById(environmentId, output.sandboxId)
          : undefined;

      if (current === undefined) {
        const created = yield* railway.createSandbox(
          {
            input: {
              environmentId,
              ...(props.idleTimeoutMinutes !== undefined
                ? { idleTimeoutMinutes: props.idleTimeoutMinutes }
                : {}),
              ...(props.networkIsolation !== undefined
                ? { networkIsolation: props.networkIsolation }
                : {}),
              ...(props.region !== undefined ? { region: props.region } : {}),
              ...(props.publicDomains !== undefined
                ? { publicDomains: props.publicDomains }
                : {}),
              ...(props.resources !== undefined
                ? { resources: props.resources }
                : {}),
              ...(props.sourceSandboxId !== undefined
                ? { sourceSandboxId: props.sourceSandboxId }
                : {}),
              ...(props.template !== undefined
                ? { template: toTemplateInput(props.template) }
                : {}),
              ...(props.variables !== undefined
                ? { variables: props.variables }
                : {}),
            },
          },
          selection,
        );
        current = isGone(created)
          ? undefined
          : created.status === "RUNNING"
            ? created
            : yield* waitUntilRunning(environmentId, created.id);
      } else if (current.status !== "RUNNING" && current.status !== "FAILED") {
        current = yield* waitUntilRunning(environmentId, current.id);
      }

      if (current === undefined || isGone(current)) {
        return yield* new SandboxNotCreated({ environmentId });
      }
      if (current.status === "FAILED") {
        return yield* new SandboxFailed({
          sandboxId: current.id,
          status: current.status,
        });
      }

      return toAttrs(current, { projectId });
    }),

    delete: Effect.fn(function* ({ output }) {
      const sandboxId = output.sandboxId;
      const environmentId = output.environmentId;
      if (sandboxId.length === 0 || environmentId.length === 0) return;
      yield* railway
        .sandboxDestroy({ environmentId, id: sandboxId }, selection)
        .pipe(railway.catchTags(["RailwayNotFound"], () => Effect.void));
      yield* waitUntilGone(environmentId, sandboxId);
    }),
  });
