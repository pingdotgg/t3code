import { createHash } from "node:crypto";
import type {
  ProjectResponseServicesEdgesItemNode,
  ServiceCreateResponse,
  ServiceInstanceResponse,
  ServiceInstanceUpdateInput,
  ServiceResponse,
  ServiceUpdateResponse,
} from "@distilled.cloud/railway";
import * as railway from "@distilled.cloud/railway";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { isResolved } from "../Diff.ts";
import type { InputProps } from "../Input.ts";
import {
  Platform,
  type Main,
  type MainRpc,
  type PlatformProps,
} from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import { Stack } from "../Stack.ts";
import { createRailwayName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import {
  assertHostDisk,
  type MountSpec,
  type ServiceBinding,
} from "./MountVolume.ts";
import {
  ownedProjects,
  projectEnvironmentIds,
  type Project,
} from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  ensureServiceDomain,
  type ServiceDomainRecord,
} from "./ServiceDomain.ts";
import {
  collectBindingState,
  createRailwayFunctionSupport,
  createRailwayFunctionRuntimeContext,
  DEFAULT_PORT,
  plainEnvValue,
  toEnvRecord,
  type HostedProgramProps,
  type RailwayBuildOptions,
  type RailwayHostRuntimeContext,
} from "./hosted.ts";
import { mintRpcToken, RPC_TOKEN_ENV } from "./rpc-token.ts";

export { FunctionBundleNotSingleFile } from "./hosted.ts";
export type { InferEnv } from "./InferEnv.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

/**
 * Environment identity a Function is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type FunctionEnvironment = {
  readonly environmentId: string;
};

/** Canvas Functions run on the Bun function runtime. */
export const FUNCTION_RUNTIME_NAME = "bun" as const;

/** Start-command prefix the Bun function runtime uses to decode source. */
export const FUNCTION_START_PREFIX = "./run.sh ";

/**
 * Canvas Functions are capped at 96KB (the encoded start command, which
 * includes `./run.sh ` plus standard base64 of the TypeScript file).
 */
export const FUNCTION_MAX_BYTES = 96 * 1024;

/**
 * Railway function-runtime images (`ghcr.io/railwayapp/function-*`).
 * Canvas Functions are ordinary Services whose `source.image` uses this
 * prefix — the same check the Railway CLI uses.
 */
export const isFunctionImage = (image: string | null | undefined): boolean =>
  image != null && image.startsWith("ghcr.io/railwayapp/function");

export interface FunctionProps<
  Env extends Record<string, any> = Record<string, any>,
> extends PlatformProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces the Function.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy the function instance into. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Defaults to the project's primary environment.
   * Changing it replaces the Function.
   */
  environment?: Ref<FunctionEnvironment>;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * in place via `serviceUpdate`.
   */
  name?: string;
  /**
   * Module entrypoint bundled with rolldown into a **single file** and
   * deployed as a canvas Function. Typically `import.meta.url`. No
   * Docker. No registry — that is {@link Service}. Mutually exclusive
   * with {@link source} / {@link path}.
   */
  main?: string;
  /**
   * Named export to load from {@link main}.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Bundler configuration for {@link main}: rolldown `input`/`output`
   * overrides, plus `install` for packages Railway should `bun install`
   * from the function's imports (`pg`).
   */
  build?: RailwayBuildOptions;
  /**
   * Inline TypeScript source (one file). Mutually preferred over
   * {@link path}. Max 96KB once base64-encoded into the start command.
   */
  source?: string;
  /**
   * Path to a single TypeScript file (`railway functions new --path`).
   * Read at plan/reconcile time. Distinct from Effect-native
   * {@link main}, which bundles first, and from `Service({ main })`,
   * which pushes a Docker image.
   */
  path?: string;
  /**
   * Cron expression (`cronSchedule`). Observed as `cronSchedule` /
   * `nextCronRunAt`. `railway functions new --cron`.
   */
  cronSchedule?: string;
  /**
   * Create a generated `*.up.railway.app` domain (`--http`). Defaults
   * to `true` when {@link cronSchedule} is omitted, `false` otherwise.
   */
  http?: boolean;
  /**
   * Sleep the application when idle (`--serverless` /
   * `sleepApplication`). Updates in place.
   */
  sleepApplication?: boolean;
  /**
   * Region for the service instance (`us-west2`, `us-east4`, …). If
   * omitted, Railway picks the default. Updates in place.
   */
  region?: string;
  /**
   * Port published on the generated service domain. Passed as
   * `serviceDomainCreate.targetPort`. Omit to let Railway detect it.
   */
  port?: number;
  /**
   * Additional environment variables. Merged after binding-injected
   * `env`. Upserted as service-scoped Railway variables with
   * `skipDeploys: true`; this Function owns the subsequent deploy.
   *
   * On an async Function, {@link InferEnv} types the handler's second
   * argument from these keys. Railway has no native bindings — every
   * value is a `string` at runtime (`process.env`).
   */
  env?: Env;
  /**
   * Private-mesh RPC token. Minted by a child `Alchemy.Random`
   * (`{logicalId}RpcToken`) and persisted in state. Set automatically.
   */
  rpcToken?: Redacted.Redacted<string>;
}

export type Function<Env extends Record<string, any> = Record<string, any>> =
  Resource<
    "Railway.Function",
    FunctionProps<Env>,
    {
      /** Railway service id. */
      serviceId: string;
      /** Physical service name (unique per project). */
      name: string;
      /** Parent Railway project id. */
      projectId: string;
      /** Environment the instance is deployed in. */
      environmentId: string;
      /** Observed function-runtime image. */
      image: string;
      /** Function runtime name (`bun`). */
      runtime: typeof FUNCTION_RUNTIME_NAME;
      /** Observed cron schedule, if set. */
      cronSchedule: string | undefined;
      /** Observed `sleepApplication`. */
      sleepApplication: boolean | undefined;
      /** Observed region, if Railway reported one. */
      region: string | undefined;
      /** Port published on the generated service domain. */
      port: number | undefined;
      /**
       * Internal DNS name on the default private mesh
       * (`{name}.railway.internal`). Derived from the service name.
       */
      dnsName: string;
      /**
       * Shared token for private schemaless RPC. Value of the child
       * `Alchemy.Random` resource. Packed onto callers by
       * {@link bindFunction}; never send this to the public internet.
       */
      rpcToken: string;
      /** Public `https://{domain}` URL (`*.up.railway.app`). */
      url: string | undefined;
      /** Generated Railway service domain hostname. */
      domain: string | undefined;
      /** Railway service domain id. */
      domainId: string | undefined;
      /** Latest deployment id, if one exists. */
      deploymentId: string | undefined;
      /** Latest deployment status (`SUCCESS`, `DEPLOYING`, …). */
      deploymentStatus: string | undefined;
      /** Next cron fire time, if scheduled. */
      nextCronRunAt: string | undefined;
      /** Content hash of the TypeScript source. */
      code: {
        hash: string;
      };
    },
    ServiceBinding,
    Providers
  >;

export const isFunction = (value: unknown): value is Function =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Railway.Function";

export type FunctionServices = ServerHost;

export type FunctionShape = Main<FunctionServices> & MainRpc<FunctionServices>;

export type FunctionRuntimeContext = RailwayHostRuntimeContext;

const resolveFunctionProps = (
  id: string,
  props: FunctionProps | Effect.Effect<FunctionProps, never, Providers>,
) =>
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
              FunctionEnvironment,
              never,
              Providers
            >
          : resolved.environment;
    const rpcToken = yield* mintRpcToken(id);
    return { ...resolved, project, environment, rpcToken };
  });

/**
 * A Railway.Function is a **single TypeScript file** on Railway's Bun
 * canvas runtime. No GitHub repo. No Docker. No registry. Alchemy
 * queries `functionRuntime(bun)`, creates the Service with that image,
 * and writes the source as `startCommand` (`./run.sh` + base64).
 *
 * There are two ways to define a Function. Prefer **async** (`main` +
 * `export default { fetch }`, no Effect) — Effect-native canvas
 * Functions pull the Effect runtime into the 96KB encoded start-command
 * cap and fail {@link FunctionTooLarge} for anything non-trivial. Use
 * {@link Service} when you need an Effect program or a real image.
 *
 * Distinct from Effect-native {@link Service} (`main`), which bundles
 * with Rolldown and uploads a generated Dockerfile for Railway to
 * build.
 *
 * @see https://docs.railway.com/reference/functions
 *
 * ### Async Functions
 * You don't have to use Effect. Declare the Function with `main`
 * pointing at a file and **no** `Effect.gen` implementation — Alchemy
 * bundles that file as-is (no Effect runtime) and deploys it as a
 * canvas Function. The handler is a plain `async fetch`. Use the `env`
 * prop to declare variables, and {@link InferEnv} to type the second
 * argument (Railway bindings are environment variables).
 *
 * **Example:** Defining an async Function in your stack
 * ```typescript
 * const db = yield* Railway.Postgres("Db", { project: site });
 *
 * export const Ping = Railway.Function("Ping", {
 *   project: site,
 *   main: "./src/ping.ts",
 *   env: { DATABASE_URL: db.connectionUri },
 * });
 *
 * export type PingEnv = Railway.InferEnv<typeof Ping>;
 * ```
 *
 * **Example:** Writing the async handler
 * ```typescript
 * import type { PingEnv } from "../alchemy.run.ts";
 *
 * export default {
 *   async fetch(_request: Request, env: PingEnv) {
 *     return new Response(env.DATABASE_URL ? "ok" : "missing");
 *   },
 * };
 * ```
 *
 * ### Effect-native Function
 * A Function is a class. Props describe the canvas Function. The Effect
 * is the program that runs in it. `main: import.meta.url` is the bundle
 * entrypoint — Alchemy bundles this file into one JS file and deploys
 * it. No `registry`. Stay tiny: the encoded start command maxes out at
 * 96KB (`effect` plus handlers overflows it).
 *
 * **Example:** Class + Project + main
 * ```typescript
 * export default class Ping extends Railway.Function<Ping>()(
 *   "Ping",
 *   {
 *     project: Site,
 *     main: import.meta.url,
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * :::caution[Changing `project` replaces the Function]
 * The Function is created in the new Project. The old Function is deleted.
 * :::
 *
 * ### Inline source
 * Pass inline `source` (or `path` to a `.ts` file) instead of `main`
 * when the Function is not an Effect class. Alchemy generates a
 * `*.up.railway.app` domain unless `http: false` or a cron schedule is
 * set.
 *
 * **Example:** Inline source
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const ping = yield* Railway.Function("Ping", {
 *   project: site,
 *   source: `
 *     Bun.serve({
 *       hostname: "0.0.0.0",
 *       port: Number(process.env.PORT ?? 3000),
 *       fetch() { return new Response("ok"); },
 *     });
 *   `,
 * });
 * ```
 *
 * ### File path
 * `path` is the CLI `--path` equivalent. The file is read at
 * plan/reconcile. Content changes update in place.
 *
 * **Example:** Path
 * ```typescript
 * const ping = yield* Railway.Function("Ping", {
 *   project: site,
 *   path: "./fn.ts",
 * });
 * ```
 *
 * ### Cron
 * `cronSchedule` runs the Function on a cron expression (`--cron`).
 * HTTP domains are skipped unless `http: true` is set explicitly.
 *
 * **Example:** Cron schedule
 * ```typescript
 * const job = yield* Railway.Function("Cleanup", {
 *   project: site,
 *   source: `console.log("tick");`,
 *   cronSchedule: "0 * * * *",
 * });
 * ```
 *
 * ### Serverless
 * `sleepApplication` sleeps the Function when idle (`--serverless`).
 *
 * **Example:** Sleep when idle
 * ```typescript
 * const ping = yield* Railway.Function("Ping", {
 *   project: site,
 *   source: `console.log("hi");`,
 *   http: false,
 *   sleepApplication: true,
 * });
 * ```
 *
 * ### Schemaless RPC
 * Return methods next to `fetch`. Call `enableRailwayRpc()` in init
 * (canvas Functions are capped at 96KB; the dispatcher is opt-in).
 * Another Function or Service binds this class and calls them over
 * `{name}.railway.internal` with a shared token. Public
 * `*.up.railway.app` requests to `/__rpc__/*` get 401.
 *
 * **Example:** Bind a Function
 * ```typescript
 * export default class Query extends Railway.Function<Query>()(
 *   "Query",
 *   { project: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     Railway.enableRailwayRpc();
 *     return {
 *       greet: (name: string) => Effect.succeed(`hello ${name}`),
 *     };
 *   }),
 * ) {}
 *
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const query = yield* Railway.bindFunction(Query);
 *     return {
 *       fetch: query
 *         .greet("sam")
 *         .pipe(Effect.map((greeting) => HttpServerResponse.text(greeting))),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Module-scope declarations
 * Resource-valued props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Function
 * ```typescript
 * // src/ping.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Ping = Railway.Function("Ping", {
 *   project: Site,
 *   source: `console.log("hello");`,
 *   http: false,
 * });
 * ```
 *
 * @resource
 */
export const Function: Platform<
  Function,
  FunctionServices,
  FunctionShape,
  FunctionRuntimeContext
> & {
  /**
   * Async (no-impl) constructor — captures the `env` literal so
   * {@link InferEnv} types the handler's second argument.
   */
  <const Env extends Record<string, any>, PropsReq = never>(
    id: string,
    props:
      | InputProps<FunctionProps<Env>>
      | Effect.Effect<InputProps<FunctionProps<Env>>, never, PropsReq>,
  ): Effect.Effect<Function<Env>, never, Providers | PropsReq>;
} = Platform("Railway.Function", {
  createRuntimeContext: createRailwayFunctionRuntimeContext("Railway.Function"),
  transformProps: (id, props) => resolveFunctionProps(id, props),
});

export class FunctionNotCreated extends Data.TaggedError(
  "Railway.FunctionNotCreated",
)<{
  name: string;
  projectId: string;
}> {}

export class FunctionProjectRequired extends Data.TaggedError(
  "Railway.FunctionProjectRequired",
)<{
  message: string;
}> {}

export class FunctionSourceRequired extends Data.TaggedError(
  "Railway.FunctionSourceRequired",
)<{
  message: string;
}> {}

export class FunctionTooLarge extends Data.TaggedError(
  "Railway.FunctionTooLarge",
)<{
  bytes: number;
  maxBytes: number;
}> {
  get message() {
    return `canvas Function is ${this.bytes} bytes (max ${this.maxBytes})`;
  }
}

export class FunctionRuntimeImageMissing extends Data.TaggedError(
  "Railway.FunctionRuntimeImageMissing",
)<{
  message: string;
}> {}

export class FunctionDeployFailed extends Data.TaggedError(
  "Railway.FunctionDeployFailed",
)<{
  serviceId: string;
  status: string;
  deploymentId: string | undefined;
  logs: string;
}> {
  override get message() {
    return this.logs.length > 0
      ? `Function deploy ${this.status}: ${this.logs}`
      : `Function deploy ${this.status}`;
  }
}

class FunctionPending extends Data.TaggedError("Railway.FunctionPending")<{
  serviceId: string;
  status: string;
}> {}

class FunctionDeployPending extends Data.TaggedError(
  "Railway.FunctionDeployPending",
)<{
  serviceId: string;
  status: string;
}> {}

type CloudService =
  | ServiceResponse
  | ServiceCreateResponse
  | ServiceUpdateResponse
  | ProjectResponseServicesEdgesItemNode;

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

const isGoneService = (service: CloudService | undefined) =>
  service === undefined || service.deletedAt != null;

const isGoneInstance = (instance: ServiceInstanceResponse | undefined) =>
  instance === undefined || instance.deletedAt != null;

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createRailwayName(id);
  });

const wantsHttp = (props: FunctionProps) =>
  props.http === true ||
  (props.http !== false && props.cronSchedule === undefined);

const hashSource = (source: string) =>
  Effect.sync(() => createHash("sha256").update(source).digest("hex"));

const startCommandOf = (source: string) =>
  Effect.gen(function* () {
    const encoded = yield* Effect.sync(() =>
      Buffer.from(source, "utf8").toString("base64"),
    );
    const cmd = `${FUNCTION_START_PREFIX}${encoded}`;
    if (cmd.length > FUNCTION_MAX_BYTES) {
      return yield* new FunctionTooLarge({
        bytes: cmd.length,
        maxBytes: FUNCTION_MAX_BYTES,
      });
    }
    return cmd;
  });

const resolveSource = (props: FunctionProps) =>
  Effect.gen(function* () {
    if (props.source !== undefined && props.source.length > 0) {
      return props.source;
    }
    if (props.path !== undefined && props.path.length > 0) {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readFileString(props.path);
    }
    return yield* new FunctionSourceRequired({
      message:
        "Railway.Function requires `source` (inline TypeScript), `path` to a single file, or `main` (Effect-native).",
    });
  });

const latestRuntimeImage = () =>
  railway.functionRuntime({ name: FUNCTION_RUNTIME_NAME }).pipe(
    Effect.flatMap((runtime) => {
      const image = runtime.latestVersion.image;
      if (image.length === 0) {
        return new FunctionRuntimeImageMissing({
          message: "functionRuntime(bun) returned an empty latestVersion.image",
        });
      }
      return Effect.succeed(image);
    }),
  );

const sameImage = (observed: string | null | undefined, desired: string) => {
  if (observed == null || observed.length === 0) return false;
  if (observed === desired) return true;
  if (observed === `${desired}:latest` || desired === `${observed}:latest`) {
    return true;
  }
  return (
    observed.endsWith(`/${desired}`) || observed.endsWith(`/${desired}:latest`)
  );
};

const deployReady = (status: string | undefined) =>
  status === "SUCCESS" || status === "SLEEPING";

const deployFailed = (status: string | undefined) =>
  status === "FAILED" || status === "CRASHED" || status === "REMOVED";

const alreadyExists = (message: string) =>
  /already exists|already in use|duplicate/i.test(message);

const getById = (serviceId: string) =>
  railway.service({ id: serviceId }).pipe(
    Effect.map((service) => (isGoneService(service) ? undefined : service)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const getInstance = (environmentId: string, serviceId: string) =>
  railway.serviceInstance({ environmentId, serviceId }).pipe(
    Effect.map((instance) => (isGoneInstance(instance) ? undefined : instance)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
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

const findByName = (projectId: string, name: string) =>
  listProjectServices(projectId).pipe(
    Effect.map((services) => services.find((service) => service.name === name)),
  );

const waitForInstance = (environmentId: string, serviceId: string) =>
  getInstance(environmentId, serviceId).pipe(
    Effect.flatMap((instance) => {
      if (instance === undefined) {
        return Effect.fail(
          new FunctionPending({ serviceId, status: "creating" }),
        );
      }
      return Effect.succeed(instance);
    }),
    Effect.retry({
      while: (e) => e._tag === "Railway.FunctionPending",
      times: 20,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.catchTag("Railway.FunctionPending", () =>
      getInstance(environmentId, serviceId),
    ),
  );

const fetchDeployLogs = (deploymentId: string | undefined) =>
  deploymentId === undefined || deploymentId.length === 0
    ? Effect.succeed("")
    : railway.deploymentLogs({ deploymentId, limit: 80 }).pipe(
        Effect.map((rows) =>
          rows
            .map((row) =>
              row.severity != null
                ? `[${row.severity}] ${row.message}`
                : row.message,
            )
            .join("\n"),
        ),
        Effect.orElseSucceed(() => ""),
      );

const waitForDeployment = (environmentId: string, serviceId: string) =>
  Effect.gen(function* () {
    const instance = yield* getInstance(environmentId, serviceId);
    const latest = instance?.latestDeployment;
    const status = latest?.status;
    if (status !== undefined && deployFailed(status)) {
      const logs = yield* fetchDeployLogs(latest?.id);
      return yield* new FunctionDeployFailed({
        serviceId,
        status,
        deploymentId: latest?.id,
        logs,
      });
    }
    if (instance !== undefined && deployReady(status)) {
      return instance;
    }
    return yield* new FunctionDeployPending({
      serviceId,
      status: status ?? "pending",
    });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Railway.FunctionDeployPending",
      // Queued builds under full-suite load can exceed 3 minutes — allow ~8.
      times: 96,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

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
  serviceId: string,
) =>
  railway
    .variables({
      projectId,
      environmentId,
      serviceId,
      unrendered: true,
    })
    .pipe(
      Effect.map(asVariableMap),
      Effect.catchTag(["RailwayNotFound", "NotFound"], () =>
        Effect.succeed({} as Record<string, string>),
      ),
    );

const upsertVariable = (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  name: string;
  value: string;
}) =>
  railway.variableUpsert({
    input: {
      projectId: input.projectId,
      environmentId: input.environmentId,
      serviceId: input.serviceId,
      name: input.name,
      value: input.value,
      skipDeploys: true,
    },
  });

const hostedProgramProps = (
  props: FunctionProps,
  port: number | undefined,
): HostedProgramProps | undefined => {
  if (props.main === undefined || props.main.length === 0) return undefined;
  return {
    main: props.main,
    handler: props.handler,
    port,
    env: props.env,
    isExternal: props.isExternal,
    build: props.build,
  };
};

const syncEnv = Effect.fn(function* (input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  desired: Record<string, string>;
}) {
  if (Object.keys(input.desired).length === 0) return false;
  const observed = yield* listVariableMap(
    input.projectId,
    input.environmentId,
    input.serviceId,
  );
  let changed = false;
  for (const [name, value] of Object.entries(input.desired)) {
    if (observed[name] !== value) {
      yield* upsertVariable({
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        name,
        value,
      });
      changed = true;
    }
  }
  return changed;
});

const syncMounts = Effect.fn(function* (input: {
  environmentId: string;
  serviceId: string;
  mounts: MountSpec[];
}) {
  for (const mount of input.mounts) {
    if (mount.volumeId.length === 0) continue;
    yield* railway
      .volumeInstanceUpdate({
        volumeId: mount.volumeId,
        environmentId: input.environmentId,
        input: {
          serviceId: input.serviceId,
          mountPath: mount.path,
        },
      })
      .pipe(
        Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.void),
      );
  }
});

const toAttrs = (input: {
  service: CloudService;
  instance: ServiceInstanceResponse | undefined;
  domain: ServiceDomainRecord | undefined;
  projectId: string;
  environmentId: string;
  image: string;
  port: number | undefined;
  codeHash: string;
  rpcToken: string;
}): Function["Attributes"] => ({
  serviceId: input.service.id,
  name: input.service.name,
  projectId: input.projectId,
  environmentId: input.environmentId,
  image: input.instance?.source?.image ?? input.image,
  runtime: FUNCTION_RUNTIME_NAME,
  cronSchedule: input.instance?.cronSchedule ?? undefined,
  sleepApplication: input.instance?.sleepApplication ?? undefined,
  region: input.instance?.region ?? undefined,
  port: input.port ?? input.domain?.targetPort,
  dnsName: `${input.service.name}.railway.internal`,
  rpcToken: input.rpcToken,
  url: input.domain?.url,
  domain: input.domain?.domain,
  domainId: input.domain?.id,
  deploymentId: input.instance?.latestDeployment?.id,
  deploymentStatus: input.instance?.latestDeployment?.status,
  nextCronRunAt: input.instance?.nextCronRunAt ?? undefined,
  code: { hash: input.codeHash },
});

const instanceSettingsDelta = (input: {
  instance: ServiceInstanceResponse | undefined;
  sourceImage: string;
  startCommand: string;
  props: FunctionProps;
}): ServiceInstanceUpdateInput | undefined => {
  const instance = input.instance;
  const delta: ServiceInstanceUpdateInput = {};
  let changed = false;

  if (!sameImage(instance?.source?.image, input.sourceImage)) {
    delta.source = { image: input.sourceImage };
    changed = true;
  }
  if ((instance?.startCommand ?? undefined) !== input.startCommand) {
    delta.startCommand = input.startCommand;
    changed = true;
  }
  if (
    input.props.cronSchedule !== undefined &&
    (instance?.cronSchedule ?? undefined) !== input.props.cronSchedule
  ) {
    delta.cronSchedule = input.props.cronSchedule;
    changed = true;
  }
  if (
    input.props.sleepApplication !== undefined &&
    instance?.sleepApplication !== input.props.sleepApplication
  ) {
    delta.sleepApplication = input.props.sleepApplication;
    changed = true;
  }
  if (
    input.props.region !== undefined &&
    (instance?.region ?? undefined) !== input.props.region
  ) {
    delta.region = input.props.region;
    changed = true;
  }
  return changed ? delta : undefined;
};

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const hosted = createRailwayFunctionSupport({
        stackName: stack.name,
        stage: stack.stage,
        virtualEntryPlugin,
      });

      return Function.Provider.of({
        stables: ["serviceId", "projectId", "environmentId"],
        nuke: { dependsOn: ["Railway.Project"] },

        diff: Effect.fn(function* ({ news, output }) {
          if (news === undefined || !isResolved(news)) return undefined;
          if (output === undefined) return undefined;
          const nextProject = projectIdOf(news.project);
          const projectChanged =
            nextProject !== undefined && nextProject !== output.projectId;
          const nextEnv = environmentIdOf(news.environment);
          const environmentChanged =
            nextEnv !== undefined && nextEnv !== output.environmentId;
          if (projectChanged || environmentChanged) {
            return { action: "replace" as const };
          }
          const program = hostedProgramProps(news, news.port);
          if (program !== undefined) {
            const hash = yield* hosted.hash(program);
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
            return undefined;
          }
          const hasSource =
            (news.source !== undefined && news.source.length > 0) ||
            (news.path !== undefined && news.path.length > 0);
          if (hasSource) {
            const source = yield* resolveSource(news);
            const hash = yield* hashSource(source);
            if (hash !== output.code.hash) {
              return { action: "update" as const };
            }
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
              ? (environmentIdOf(olds.environment) ??
                environmentIdOf(olds.project))
              : undefined);
          const name = yield* resolveName(id, olds?.name, output?.name);
          const byId =
            output?.serviceId !== undefined && output.serviceId.length > 0
              ? yield* getById(output.serviceId)
              : undefined;
          const found =
            byId ??
            (projectId !== undefined
              ? yield* findByName(projectId, name)
              : undefined);
          if (found === undefined) return undefined;
          const resolvedProjectId = projectIdOf(found) ?? projectId ?? "";
          const resolvedEnvId =
            environmentId ??
            environmentIdOf(olds?.project) ??
            output?.environmentId ??
            "";
          const instance =
            resolvedEnvId.length > 0
              ? yield* getInstance(resolvedEnvId, found.id)
              : undefined;
          const attrs = toAttrs({
            service: found,
            instance,
            domain: undefined,
            projectId: resolvedProjectId,
            environmentId: resolvedEnvId,
            image: instance?.source?.image ?? output?.image ?? "",
            port: output?.port ?? olds?.port,
            codeHash: output?.code.hash ?? "",
            rpcToken: output?.rpcToken ?? "",
          });
          if (output !== undefined) return attrs;
          return matchesAlchemyPhysicalName(found.name)
            ? attrs
            : Unowned(attrs);
        }),

        list: Effect.fn(function* () {
          const projects = yield* ownedProjects();
          const rows = yield* Effect.forEach(projects, (project) =>
            Effect.gen(function* () {
              const services = yield* listProjectServices(project.projectId);
              const envIds = yield* projectEnvironmentIds(project);
              const items = yield* Effect.forEach(
                services.filter((service) =>
                  matchesAlchemyPhysicalName(service.name),
                ),
                (service) =>
                  Effect.gen(function* () {
                    for (const environmentId of envIds) {
                      const instance = yield* getInstance(
                        environmentId,
                        service.id,
                      );
                      const image = instance?.source?.image ?? undefined;
                      if (!isFunctionImage(image)) continue;
                      return toAttrs({
                        service,
                        instance,
                        domain: undefined,
                        projectId: project.projectId,
                        environmentId,
                        image: image ?? "",
                        port: undefined,
                        codeHash: "",
                        rpcToken: "",
                      });
                    }
                    return undefined;
                  }),
              );
              return items.filter((item) => item !== undefined);
            }),
          );
          return rows.flat();
        }),

        // Circular Service↔Function RPC binds `dnsName` / `port` / `rpcToken`.
        // Those are knowable from the physical name and props; the cloud
        // service is created in reconcile (and re-synced in converge).
        precreate: Effect.fn(function* ({ id, news }) {
          const name = yield* resolveName(
            id,
            typeof news.name === "string" ? news.name : undefined,
          );
          const port = typeof news.port === "number" ? news.port : DEFAULT_PORT;
          return {
            serviceId: "",
            name,
            projectId: "",
            environmentId: "",
            image: "",
            runtime: FUNCTION_RUNTIME_NAME,
            cronSchedule: undefined,
            sleepApplication: undefined,
            region: undefined,
            port,
            dnsName: `${name}.railway.internal`,
            rpcToken: plainEnvValue(news.rpcToken) ?? "",
            url: undefined,
            domain: undefined,
            domainId: undefined,
            deploymentId: undefined,
            deploymentStatus: undefined,
            nextCronRunAt: undefined,
            code: { hash: "" },
          } satisfies Function["Attributes"];
        }),

        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const props = news ?? ({} as FunctionProps);
          const projectId = projectIdOf(props.project) ?? output?.projectId;
          if (projectId === undefined) {
            return yield* new FunctionProjectRequired({
              message: "Function requires a resolved Railway.Project",
            });
          }
          const environmentId =
            environmentIdOf(props.environment) ??
            environmentIdOf(props.project) ??
            output?.environmentId;
          if (environmentId === undefined) {
            return yield* new FunctionProjectRequired({
              message:
                "Function requires a Railway environment (pass environment or a Project with environmentId)",
            });
          }
          const name = yield* resolveName(id, props.name, output?.name);
          const bound = collectBindingState(bindings ?? []);
          yield* assertHostDisk({
            name,
            mounts: bound.mounts,
          });
          const program = hostedProgramProps(
            props,
            props.port ?? (props.main !== undefined ? DEFAULT_PORT : undefined),
          );
          let source: string;
          let codeHash: string;
          if (program !== undefined) {
            const bundled = yield* hosted.bundleToSource(program);
            source = bundled.source;
            codeHash = bundled.hash;
          } else {
            source = yield* resolveSource(props);
            codeHash = yield* hashSource(source);
          }
          const startCommand = yield* startCommandOf(source);
          const image = yield* latestRuntimeImage();
          // Effect-native Functions listen on PORT (canvas default 3000).
          // Pin PORT and the generated domain's targetPort together so
          // private-mesh RPC and public HTTP hit the same listener.
          const port =
            program !== undefined ? (props.port ?? DEFAULT_PORT) : props.port;
          const rpcToken =
            plainEnvValue(props.rpcToken) ?? output?.rpcToken ?? "";
          const env = {
            ...bound.env,
            ...(program !== undefined ? hosted.alchemyEnv : {}),
            ...(port !== undefined ? { PORT: String(port) } : {}),
            ...toEnvRecord(props.env),
            [RPC_TOKEN_ENV]: rpcToken,
          };

          let current: CloudService | undefined =
            output?.serviceId !== undefined && output.serviceId.length > 0
              ? yield* getById(output.serviceId)
              : undefined;
          if (current === undefined) {
            current = yield* findByName(projectId, name);
          }

          if (current === undefined) {
            const created = yield* railway
              .serviceCreate({
                input: {
                  projectId,
                  environmentId,
                  name,
                  source: { image },
                },
              })
              .pipe(
                Effect.catchTag("RailwayValidationError", (e) =>
                  alreadyExists(e.message)
                    ? Effect.succeed(undefined)
                    : Effect.fail(e),
                ),
                Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
              );
            current = created ?? (yield* findByName(projectId, name));
          }

          if (current === undefined || isGoneService(current)) {
            return yield* new FunctionNotCreated({ name, projectId });
          }

          if (current.name !== name) {
            current = yield* railway.serviceUpdate({
              id: current.id,
              input: { name },
            });
          }

          // The service instance must exist in this environment before a
          // domain can be generated. Extra non-fork environments lag.
          let instance = yield* waitForInstance(environmentId, current.id);

          // Domain before PORT — Railway refuses serviceDomainCreate on a
          // service that already has PORT set ("please try again").
          let domain = wantsHttp(props)
            ? yield* ensureServiceDomain({
                projectId,
                environmentId,
                serviceId: current.id,
              })
            : undefined;
          let needsDeploy = false;

          const instanceDelta = instanceSettingsDelta({
            instance,
            sourceImage: image,
            startCommand,
            props,
          });
          if (instanceDelta !== undefined) {
            yield* railway.serviceInstanceUpdate({
              environmentId,
              serviceId: current.id,
              input: instanceDelta,
            });
            needsDeploy = true;
            instance =
              (yield* getInstance(environmentId, current.id)) ?? instance;
          }

          const envChanged = yield* syncEnv({
            projectId,
            environmentId,
            serviceId: current.id,
            desired: env,
          });
          if (envChanged) needsDeploy = true;

          if (wantsHttp(props) && port !== undefined) {
            domain = yield* ensureServiceDomain({
              projectId,
              environmentId,
              serviceId: current.id,
              targetPort: port,
            });
          }

          yield* syncMounts({
            environmentId,
            serviceId: current.id,
            mounts: bound.mounts,
          });

          if (needsDeploy || instance?.latestDeployment == null) {
            yield* railway
              .serviceInstanceDeployV2({
                environmentId,
                serviceId: current.id,
              })
              .pipe(
                Effect.catchTag("RailwayValidationError", () => Effect.void),
              );
          }

          // Cron-only Functions sleep until the schedule. Waiting for
          // SUCCESS queues behind sibling Docker builds and can sit in
          // QUEUED/BUILDING for the full retry budget. HTTP Functions
          // still wait — they have a public URL to serve.
          if (wantsHttp(props)) {
            instance =
              (yield* waitForDeployment(environmentId, current.id)) ?? instance;
          } else {
            instance =
              (yield* getInstance(environmentId, current.id)) ?? instance;
            const status = instance?.latestDeployment?.status;
            if (status !== undefined && deployFailed(status)) {
              const logs = yield* fetchDeployLogs(
                instance?.latestDeployment?.id,
              );
              return yield* new FunctionDeployFailed({
                serviceId: current.id,
                status,
                deploymentId: instance?.latestDeployment?.id,
                logs,
              });
            }
          }

          return toAttrs({
            service: current,
            instance,
            domain,
            projectId,
            environmentId,
            image,
            port,
            codeHash,
            rpcToken,
          });
        }),

        delete: Effect.fn(function* ({ output }) {
          const serviceId = output.serviceId;
          if (serviceId.length === 0) return;
          yield* railway
            .serviceDelete({
              id: serviceId,
              ...(output.environmentId.length > 0
                ? { environmentId: output.environmentId }
                : {}),
            })
            .pipe(
              Effect.catchTag(
                ["RailwayNotFound", "NotFound"],
                () => Effect.void,
              ),
            );
          yield* getById(serviceId).pipe(
            Effect.map((service) => service === undefined),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (gone) => gone,
              times: 8,
            }),
          );
        }),
      });
    }),
  );
