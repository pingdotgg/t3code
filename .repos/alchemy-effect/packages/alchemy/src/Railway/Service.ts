import type { Builder, RestartPolicyType } from "@distilled.cloud/railway";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  Platform,
  type Main,
  type MainRpc,
  type PlatformProps,
} from "../Platform.ts";
import type { HttpEffect } from "../Http.ts";
import type { Resource } from "../Resource.ts";
import type { ServerHost } from "../Server/Process.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  createRailwayHostRuntimeContext,
  type ExtraFile,
  type RailwayBuildOptions,
  type RailwayHostRuntimeContext,
} from "./hosted.ts";
import { serveRailwayRpc } from "./rpc-server.ts";
import { mintRpcToken } from "./rpc-token.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* Project(...)` and `Project(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export type { ExtraFile, RailwayBuildOptions };

/**
 * Environment identity a Service is deployed into. Accepts a
 * `Railway.Project` (its primary environment), a `Railway.Environment`,
 * or an `{ environmentId }` stub.
 */
export type ServiceEnvironment = {
  readonly environmentId: string;
};

export interface ServiceProps extends PlatformProps {
  /**
   * Parent Railway Project. Accepts a `Railway.Project` or an Effect
   * that produces one. Changing the Project replaces the Service.
   */
  project: Ref<Project>;
  /**
   * Environment to deploy the service instance into. Accepts a
   * `Railway.Project` (primary environment), a `Railway.Environment`, or
   * `{ environmentId }`. Defaults to the project's primary environment.
   * Changing it replaces the Service.
   */
  environment?: Ref<ServiceEnvironment>;
  /**
   * Module entrypoint bundled with rolldown and packed into a generated
   * Dockerfile. Railway builds that Dockerfile (`railway up`). Typically
   * `import.meta.url`. Mutually exclusive with the public-image path
   * (`image` without `main`). A content-hash change updates in place.
   */
  main?: string;
  /**
   * Local Docker context uploaded with Railway `up`. Paths are relative to the
   * initial working directory. Limited to a 32 MiB archive, 10,000 entries,
   * ASCII paths, and no symlinks; Docker ignore files apply.
   */
  context?: string;
  /**
   * Docker image Railway should run.
   *
   * When `main` is omitted this is `source.image` (e.g.
   * `hashicorp/http-echo`). When `main` is set this is the generated
   * Dockerfile's `FROM` (default `node:26-slim`).
   */
  image?: string;
  /**
   * Region for the service instance (`us-west2`, `us-east4`, …). If
   * omitted, Railway picks the default. Updates in place.
   */
  region?: string;
  /**
   * Port the process listens on. Written to `PORT` and used as the
   * generated `*.up.railway.app` `targetPort`. Default is `3000` for
   * Effect-native (`main`) Services. Pass `5678` for
   * `hashicorp/http-echo`.
   */
  port?: number;
  /**
   * Whether to create and manage a generated `*.up.railway.app` domain.
   * Existing unowned generated or custom domains are not removed.
   * @default true
   */
  publicDomain?: boolean;
  /**
   * Additional environment variables. Merged after binding-injected
   * `env`. Upserted as service-scoped Railway variables with
   * `skipDeploys: true`; this Service owns the subsequent deploy.
   */
  env?: Record<string, any>;
  /**
   * Private-mesh RPC token. Minted by a child `Alchemy.Random`
   * (`{logicalId}RpcToken`) and persisted in state. Set automatically.
   */
  rpcToken?: Redacted.Redacted<string>;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output`
   * overrides, plus `install` for packages that must ship as real
   * `node_modules` (see {@link RailwayBuildOptions}).
   */
  build?: RailwayBuildOptions;
  /**
   * Extra files/directories copied into `/app` in the generated
   * Dockerfile (`COPY dest /app/dest`). Website composites use this to
   * bake the framework `clientDirectory` (or Next.js `.next`) so asset
   * changes rebuild on Railway.
   */
  extraFiles?: ReadonlyArray<ExtraFile>;
  /**
   * Named export to load from `main`.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Service name. Unique per Project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it updates
   * in place via `serviceUpdate`.
   */
  name?: string;
  /**
   * GitHub repository (`owner/repo`). Creates/syncs
   * `serviceCreate.source.repo` / `serviceInstanceUpdate.source.repo`.
   * Mutually exclusive with the public-image and `main` paths. Requires a
   * GitHub connection on the Railway account.
   */
  repo?: string;
  /**
   * GitHub branch for {@link repo}. Passed as `serviceCreate.branch` and
   * synced onto the deployment trigger.
   */
  branch?: string;
  /**
   * Monorepo subdirectory Railway builds from (`rootDirectory`).
   */
  rootDirectory?: string;
  /**
   * Build command (`pnpm build`). Distinct from hosted
   * {@link RailwayBuildOptions} (`build.install`).
   */
  buildCommand?: string;
  /**
   * Pre-deploy step Railway runs after the image build and before
   * start (migrations, seed). Omit to leave the current Railway setting
   * unchanged. Pass `{ command: null }` to clear it.
   *
   * @see https://docs.railway.com/deployments/pre-deploy-command
   */
  preDeploy?: {
    /**
     * Shell command Railway executes in a separate container after
     * build and before start. Must exit 0 or the deployment fails.
     * Pass `null` to clear it.
     */
    command: string | null;
  };
  /**
   * Start command (`pnpm start`).
   */
  startCommand?: string;
  /**
   * HTTP healthcheck path (`/health`). Synced via
   * `serviceInstanceUpdate.healthcheckPath`. Alias of {@link healthcheck}
   * (Railway IaC `healthcheck: "/health"`).
   */
  healthcheckPath?: string;
  /**
   * HTTP healthcheck path. Same as {@link healthcheckPath}; matches
   * Railway IaC `healthcheck`.
   */
  healthcheck?: string;
  /**
   * Healthcheck timeout in seconds.
   */
  healthcheckTimeout?: number;
  /**
   * Cron expression (`cronSchedule`). Observed as `cronSchedule` /
   * `nextCronRunAt`.
   */
  cronSchedule?: string;
  /**
   * Restart policy (`ALWAYS`, `NEVER`, `ON_FAILURE`).
   */
  restartPolicyType?: RestartPolicyType;
  /**
   * Max retries when {@link restartPolicyType} is `ON_FAILURE`.
   */
  restartPolicyMaxRetries?: number;
  /**
   * Drain window in seconds before a replica is stopped.
   */
  drainingSeconds?: number;
  /**
   * Overlap window in seconds while a new replica starts.
   */
  overlapSeconds?: number;
  /**
   * Sleep the application when idle.
   */
  sleepApplication?: boolean;
  /**
   * Auto-deploy on new commits / image tags
   * (`serviceInstanceAutoDeployUpdate`).
   */
  autoUpdates?: boolean;
  /**
   * Dockerfile path relative to {@link rootDirectory}, or to {@link context}
   * for a local context.
   * @default "Dockerfile"
   */
  dockerfilePath?: string;
  /**
   * Builder (`RAILPACK`, `NIXPACKS`, `HEROKU`, `PAKETO`).
   */
  builder?: Builder;
  /**
   * Git watch patterns that trigger a rebuild.
   */
  watchPatterns?: string[];
}

export type Service = Resource<
  "Railway.Service",
  ServiceProps,
  {
    /** Railway service id. */
    serviceId: string;
    /** Physical service name (unique per project). */
    name: string;
    /** Parent Railway project id. */
    projectId: string;
    /** Environment the instance is deployed in. */
    environmentId: string;
    /** Observed `source.image`, if set. */
    image: string | undefined;
    /** Observed `source.repo` (`owner/repo`), if set. */
    repo: string | undefined;
    /** Observed healthcheck path. */
    healthcheckPath: string | undefined;
    /** Observed healthcheck timeout in seconds. */
    healthcheckTimeout: number | undefined;
    /**
     * Observed replica count. Alchemy does not set this — Railway
     * load-balances whatever is running (default 1).
     */
    replicas: number | undefined;
    /** Observed build command. */
    buildCommand: string | undefined;
    /** Observed start command. */
    startCommand: string | undefined;
    /** Observed cron schedule. */
    cronSchedule: string | undefined;
    /** Observed root directory. */
    rootDirectory: string | undefined;
    /** Observed region, if Railway reported one. */
    region: string | undefined;
    /** Port published on the generated service domain. */
    port: number | undefined;
    /** Public `https://{domain}` URL (`*.up.railway.app`). */
    url: string | undefined;
    /** Generated Railway service domain hostname. */
    domain: string | undefined;
    /**
     * Internal DNS name on the default private mesh
     * (`{name}.railway.internal`). Derived from the service name — no
     * extra API call.
     */
    dnsName: string;
    /**
     * Shared token for private schemaless RPC. Value of the child
     * `Alchemy.Random` resource. Packed onto callers by `bindService` /
     * `bindFunction`; never send this to the public internet.
     */
    rpcToken: string;
    /** Railway service domain id. */
    domainId: string | undefined;
    /** Latest deployment id, if one exists. */
    deploymentId: string | undefined;
    /** Latest deployment status (`SUCCESS`, `DEPLOYING`, …). */
    deploymentStatus: string | undefined;
    /** Content hash of the bundled program (empty for public images). */
    code: {
      hash: string;
    };
  },
  ServiceBinding,
  Providers
>;

export const isService = (value: unknown): value is Service =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "Railway.Service";

export type ServiceServices = ServerHost;

export type ServiceShape = Main<ServiceServices> & MainRpc<ServiceServices>;

export type ServiceRuntimeContext = RailwayHostRuntimeContext;

const createServiceRuntimeContext = (id: string): ServiceRuntimeContext => {
  const base = createRailwayHostRuntimeContext("Railway.Service")(id);
  const inner = base.serve;
  return Object.assign(base, {
    serve: ((handler, options) =>
      inner(
        (options?.shape === undefined
          ? handler
          : serveRailwayRpc(
              options.shape,
              handler as HttpEffect,
            )) as typeof handler,
        options,
      )) as ServiceRuntimeContext["serve"],
  });
};

/**
 * A Railway.Service is a container in a Project. Point it at a public
 * image (`hashicorp/http-echo`) or an Effect program (`main`). Alchemy
 * stamps the name, creates a `*.up.railway.app` domain via
 * `serviceDomainCreate`, and deploys.
 *
 * @see https://docs.railway.com/guides/services
 *
 * ### Image service
 * Pass `image` without `main`. Railway pulls the image and runs it.
 * `url` is the generated `*.up.railway.app` hostname.
 *
 * **Example:** Public image
 * ```typescript
 * const site = yield* Railway.Project("Site");
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 * });
 * ```
 *
 * :::caution[Changing `project` replaces the Service]
 * The Service is created in the new Project. The old Service is deleted.
 * :::
 *
 * ### Effect-native Service
 * A Service is a class. `main: import.meta.url` is the bundle
 * entrypoint. Alchemy bundles this file with Rolldown, generates a
 * Dockerfile (`FROM node:26-slim`), and uploads the context. Railway
 * builds the image. `build.install: ["pg"]` ships `pg` unbundled.
 *
 * **Example:** Class + Project + main
 * ```typescript
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   {
 *     project: Site,
 *     main: import.meta.url,
 *     build: { install: ["pg"] },
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("hello")),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Local Docker context
 * `context` is a directory Railway builds with `up`. Mutually exclusive
 * with `image` (without `main`) and `repo`. Docker ignore files apply.
 *
 * **Example:** Upload a local Dockerfile
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   context: "./api",
 *   port: 80,
 * });
 * ```
 *
 * ### The public URL
 * Yield the Service in the Stack. `api.url` is
 * `https://{name}.up.railway.app`.
 *
 * **Example:** Stack output
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: Railway.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const api = yield* Api;
 *     return { url: api.url };
 *   }),
 * );
 * ```
 *
 * ### Private service
 * `publicDomain: false` skips the generated `*.up.railway.app` hostname.
 * `url` / `domain` stay unset. Reach it on the private mesh at
 * `{name}.railway.internal`. Unowned generated or custom domains are
 * left alone.
 *
 * **Example:** Private-only service
 * ```typescript
 * const worker = yield* Railway.Service("Worker", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 *   publicDomain: false,
 * });
 * ```
 *
 * ### Pin a region
 * Omit `region` to use Railway's default. Updating it is in place.
 *
 * **Example:** Region
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 *   region: "us-west2",
 * });
 * ```
 *
 * ### Healthcheck
 * `healthcheckPath` (or `healthcheck`, matching Railway IaC) is the
 * HTTP path Railway probes. Railway load-balances public traffic
 * across whatever replicas are running. Alchemy does not pin a count.
 *
 * **Example:** Healthcheck
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 *   healthcheck: "/health",
 * });
 * ```
 *
 * :::caution[One volume per service]
 * Railway does not give each replica its own disk. A second volume
 * on one Service fails with `Railway.MultipleVolumes`.
 * :::
 *
 * ### GitHub source
 * `repo` + `branch` is the third source, next to `image` and `main`.
 * Railway must have GitHub connected to the account.
 *
 * **Example:** GitHub repo
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   repo: "acme/web",
 *   branch: "main",
 *   rootDirectory: "apps/api",
 *   buildCommand: "pnpm build",
 *   startCommand: "pnpm start",
 * });
 * ```
 *
 * ### Pre-deploy
 * Railway runs `preDeploy.command` after the image build and before
 * start — the same setting as the dashboard Pre-deploy Command.
 *
 * **Example:** Run migrations before traffic
 * ```typescript
 * const api = yield* Railway.Service("Api", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   preDeploy: { command: "bun --cwd apps/api migrate" },
 * });
 * ```
 *
 * ### Cron
 * `cronSchedule` runs the service on a cron expression.
 *
 * **Example:** Cron schedule
 * ```typescript
 * const worker = yield* Railway.Service("Worker", {
 *   project: site,
 *   image: "hashicorp/http-echo",
 *   cronSchedule: "0 * * * *",
 * });
 * ```
 *
 * ### Mount a disk
 * Bind {@link MountVolume} inside init. Provide {@link MountVolumeLive}.
 *
 * **Example:** Volume
 * ```typescript
 * export default class Api extends Railway.Service<Api>()(
 *   "Api",
 *   { project: Site, image: "hashicorp/http-echo", port: 5678 },
 *   Effect.gen(function* () {
 *     const disk = yield* Railway.MountVolume(Data, { path: "/data" });
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text(disk.path)),
 *     };
 *   }).pipe(Effect.provide(Railway.MountVolumeLive)),
 * ) {}
 * ```
 *
 * ### Schemaless RPC
 * Return methods next to `fetch`. Another Service or Function binds
 * this class and calls them over `{name}.railway.internal` with a
 * shared token. Public `*.up.railway.app` requests to `/__rpc__/*`
 * get 401.
 *
 * **Example:** Bind a Service
 * ```typescript
 * export default class Query extends Railway.Service<Query>()(
 *   "Query",
 *   { project: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       greet: (name: string) => Effect.succeed(`hello ${name}`),
 *     };
 *   }),
 * ) {}
 *
 * export default class Api extends Railway.Function<Api>()(
 *   "Api",
 *   { project: Site, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const query = yield* Railway.bindService(Query);
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
 * Declare the Project once. Pass it into every child. Resource-valued
 * props accept the resource or an Effect producing it.
 *
 * **Example:** Module-scope Service
 * ```typescript
 * // src/api.ts
 * import * as Railway from "alchemy/Railway";
 *
 * export const Site = Railway.Project("Site");
 * export const Api = Railway.Service("Api", {
 *   project: Site,
 *   image: "hashicorp/http-echo",
 *   port: 5678,
 * });
 * ```
 *
 * @resource
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  ServiceRuntimeContext
> = Platform("Railway.Service", {
  createRuntimeContext: createServiceRuntimeContext,
  transformProps: (id, props) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return props;
      const project = Effect.isEffect(props.project)
        ? yield* props.project as Effect.Effect<Project, never, Providers>
        : props.project;
      const environment =
        props.environment === undefined
          ? undefined
          : Effect.isEffect(props.environment)
            ? yield* props.environment as Effect.Effect<
                ServiceEnvironment,
                never,
                Providers
              >
            : props.environment;
      const rpcToken = yield* mintRpcToken(id);
      return { ...props, project, environment, rpcToken };
    }),
});
