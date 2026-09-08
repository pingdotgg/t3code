import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../AlchemyContext.ts";
import { Unowned } from "../AdoptPolicy.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import { findCwdForBundle } from "../Bundle/TempRoot.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import { isResolved } from "../Diff.ts";
import { HttpServer, type HttpEffect } from "../Http.ts";
import type { InputProps } from "../Input.ts";
import * as Output from "../Output.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource, type ResourceBinding } from "../Resource.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import type * as Server from "../Server/index.ts";
import { Stack } from "../Stack.ts";
import { sha256Object } from "../Util/sha256.ts";
import {
  PrismaApiError,
  PrismaClient,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import {
  runBuildCommand,
  runComputeAutoBuild,
  type ComputeAutoBuildFramework,
} from "./ComputeBuild.ts";
import { createComputeArchive, normalizeEntrypoint } from "./ComputeArchive.ts";
import {
  destroyApp,
  destroyDeployment,
  isConflict,
  toDeploymentUrl,
  waitForDeploymentStatus,
} from "./ComputeLifecycle.ts";
import {
  startDeploymentIdempotent,
  stopDeploymentIdempotent,
} from "./Internal/DeploymentActions.ts";
import { ensureAppImmutableIdentity } from "./Internal/AppIdentity.ts";
import {
  promoteAppObserved,
  waitForAppDeploymentTarget,
} from "./Internal/AppPromotion.ts";
import { normalizeBundleFilePath } from "./Internal/BundlePaths.ts";
import { aggregateCleanupFailure } from "./Internal/CleanupFailure.ts";
import { ensureDeploymentMembership } from "./Internal/DeploymentIdentity.ts";
import { observeDeployment } from "./Internal/DeploymentObserve.ts";
import { tailDeploymentLogs } from "./PrismaLogs.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type {
  App as ApiApp,
  Deployment as ApiDeployment,
  EnvironmentVariable as ApiEnvironmentVariable,
  PrismaRegionId,
} from "./Types.ts";
import { readUploadArtifact, uploadArtifact } from "./Deployment.ts";

type ObservedDeployment = Omit<ApiDeployment, "createdAt"> & {
  createdAt?: string;
};

const ComputeTypeId = "Prisma.Compute" as const;
type ComputeTypeId = typeof ComputeTypeId;

export interface ComputeCommandBuild {
  /**
   * Shell command that creates the deployable output directory.
   */
  command: string;
  /**
   * Working directory for the build command.
   *
   * @default path
   */
  cwd?: string;
  /**
   * Build output directory, relative to `cwd`.
   */
  outdir: string;
  /**
   * Entrypoint inside `outdir`.
   */
  entrypoint?: string;
  /**
   * Environment variables supplied to the build command.
   * Ambient `PRISMA_SERVICE_TOKEN` and `PRISMA_API_TOKEN` credentials are not
   * inherited; include one here explicitly only when the application build
   * genuinely needs Prisma Management API access.
   *
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`; Prisma-side encryption does not protect a value
   * already stored in Alchemy state.
   *
   * ```typescript
   * env: { NPM_TOKEN: Redacted.make(process.env.NPM_TOKEN!) }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  /**
   * Maximum bytes retained from each build output stream.
   *
   * @default 1048576 (1 MiB)
   */
  outputLimitBytes?: number;
  /**
   * Maximum wall-clock time for the build command.
   *
   * @default 900 (15 minutes)
   */
  timeoutSeconds?: number;
}

export interface ComputeAutoBuild {
  /**
   * Auto-detect a Prisma Compute build strategy, or force one framework.
   */
  type: "auto";
  /**
   * Framework build strategy.
   *
   * @default "auto"
   */
  framework?: ComputeAutoBuildFramework;
  /**
   * Environment variables supplied to the build command.
   * Ambient `PRISMA_SERVICE_TOKEN` and `PRISMA_API_TOKEN` credentials are not
   * inherited; include one here explicitly only when the application build
   * genuinely needs Prisma Management API access.
   *
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`.
   *
   * ```typescript
   * env: { NPM_TOKEN: Redacted.make(process.env.NPM_TOKEN!) }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  /**
   * Maximum bytes retained from each framework build output stream.
   *
   * @default 1048576 (1 MiB)
   */
  outputLimitBytes?: number;
  /**
   * Maximum wall-clock time for the framework build command.
   *
   * @default 900 (15 minutes)
   */
  timeoutSeconds?: number;
}

export type ComputeBuild = ComputeCommandBuild | ComputeAutoBuild;

export interface ComputeBundleOptions {
  /**
   * Rolldown input options for effect-native Compute bundles.
   */
  input?: Partial<rolldown.InputOptions>;
  /**
   * Rolldown output options for effect-native Compute bundles.
   */
  output?: Partial<rolldown.OutputOptions>;
  /**
   * Additional Alchemy bundle options for effect-native Compute bundles.
   */
  extra?: Bundle.BundleExtraOptions;
}

export interface ComputeDev {
  /**
   * Local command to run during `alchemy dev`.
   */
  command?: string;
  /**
   * Working directory for the dev command.
   *
   * @default path
   */
  cwd?: string;
  /**
   * Local development port.
   */
  port?: number;
  /**
   * Explicit local URL to expose in the resource output.
   */
  url?: string;
  /**
   * Extra environment variables for the dev command.
   * Plain strings are persisted in Alchemy state. Wrap secrets with
   * `Redacted.make(secret)`.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface ComputeHealthCheck {
  /**
   * Absolute application path to probe after the deployment starts and after
   * promotion.
   *
   * @example "/api/health"
   */
  path: string;
  /**
   * Exact HTTP status codes that indicate readiness. When omitted, any 2xx
   * response is healthy.
   *
   * @default Any status from 200 through 299
   */
  statusCodes?: readonly number[];
}

export interface ComputeProps extends PlatformProps {
  /**
   * Project ID or `project.projectId` output that owns the App.
   */
  project: string | Project;
  /**
   * App display name. If omitted, Alchemy generates a stable physical name.
   */
  appName?: string;
  /**
   * Region where the App is placed.
   *
   * @default The project's default region, falling back to "us-east-1"
   */
  regionId?: PrismaRegionId;
  /**
   * Branch ID to attach the App to. Mutually exclusive with branchGitName.
   * If both branch fields are omitted, Alchemy attaches to the project's
   * current default branch.
   */
  branchId?: string;
  /**
   * Branch git name to attach the App to. Mutually exclusive with branchId.
   *
   * @default The project's current default branch
   */
  branchGitName?: string;
  /**
   * Application directory used for pre-built artifacts and build commands.
   *
   * @default "."
   */
  path?: string;
  /**
   * Additional artifact-relative files or directories to exclude from path
   * deployments. `*` and `**` wildcards are supported; absolute paths,
   * parent segments, and negated patterns are rejected. `.env*`, `.git`, and
   * `.alchemy` are always excluded.
   */
  archiveIgnore?: readonly string[];
  /**
   * Entrypoint relative to the deployed artifact directory.
   * If omitted, Alchemy reads `package.json#main`.
   */
  entrypoint?: string;
  /**
   * Entry module for an effect-native Compute app.
   *
   * This is required when you pass an inline Effect implementation to
   * `Prisma.Compute`, and ignored for external path deployments.
   */
  main?: string;
  /**
   * Exported symbol inside `main` for effect-native Compute apps.
   *
   * @default "default"
   */
  handler?: string;
  /**
   * Bundler options for effect-native Compute apps.
   */
  bundle?: ComputeBundleOptions;
  /**
   * Effect-native runtime exports populated by the Platform constructor.
   *
   * @internal
   */
  exports?: string[] | Record<string, unknown>;
  /**
   * Build command and output directory. Set to `"auto"` or `{ type: "auto" }`
   * to use Prisma Compute-style framework detection for Next.js, Nuxt, Astro,
   * TanStack Start, or Bun. Set to `false` to upload `path` as a pre-built
   * artifact.
   */
  build?: ComputeBuild | false | "auto";
  /**
   * Path to a pre-created `tar.gz` artifact file. When supplied, Alchemy reads
   * and uploads it directly.
   */
  artifactPath?: string;
  /**
   * HTTP port exposed by the application.
   *
   * @default 8080
   */
  port?: number;
  /**
   * Runtime environment variables to sync through Prisma's environment
   * variable API before creating a new deployment. Set a value to `null`
   * to delete that variable.
   *
   * Plain strings are persisted in Alchemy state. For secrets, use
   * `Redacted.make(secret)`; encryption in the Prisma Management API does not
   * protect a plain value already recorded in Alchemy state.
   *
   * The Management API exposes neither an idempotency key nor ownership
   * metadata for environment variables, and reads return redacted values. If
   * a process crashes after Prisma commits a create but before Alchemy saves
   * its returned ID, the next deploy safely refuses to claim that natural-key
   * match. Use standalone `Prisma.EnvironmentVariable` resources for critical
   * keys that need independent lifecycle management and explicit adoption.
   *
   * ```typescript
   * env: {
   *   LOG_LEVEL: "info",
   *   API_TOKEN: Redacted.make(process.env.API_TOKEN!),
   * }
   * ```
   */
  env?: Record<string, string | Redacted.Redacted<string> | null | undefined>;
  /**
   * Prisma environment variable class used by the `env` convenience property.
   *
   * @default "production"
   */
  envClass?: "production" | "preview";
  /**
   * Create the next deployment by reusing the previous code artifact.
   *
   * @default false
   */
  skipCodeUpload?: boolean;
  /**
   * Start the created/reused deployment.
   * Set `skipPromote: true` when disabling start.
   *
   * @default true
   */
  start?: boolean;
  /**
   * Do not promote the deployment to the stable App endpoint.
   *
   * @default false
   */
  skipPromote?: boolean;
  /**
   * Delete the previously promoted deployment after the new one is promoted.
   *
   * @default false
   */
  destroyOldDeployment?: boolean;
  /**
   * Poll timeout while waiting for start/stop.
   *
   * @default 120
   */
  timeoutSeconds?: number;
  /**
   * Poll interval while waiting for start/stop.
   *
   * @default 1000
   */
  pollIntervalMs?: number;
  /**
   * Verify that Prisma's public preview/App URL has reached the edge after
   * the Management API reports the deployment as running.
   *
   * @default true
   */
  verifyUrl?: boolean;
  /**
   * Optional application-level health check. Without this option, URL
   * verification only waits for Prisma edge routing to stop returning its
   * platform-level service-not-found response. With this option, Alchemy also
   * sends a public GET to the preview URL before promotion and to the stable
   * App URL afterward. Redirects are not followed. Each probe phase gets the
   * full `urlReadinessTimeoutSeconds` budget.
   *
   * Health checks run only during cloud deployment, not `alchemy dev`, and
   * cannot be combined with `verifyUrl: false` or `start: false`.
   */
  healthCheck?: ComputeHealthCheck;
  /**
   * Maximum time to wait for Prisma's public URL to stop returning the
   * platform-level "Service not found" page.
   *
   * @default 60
   */
  urlReadinessTimeoutSeconds?: number;
  /**
   * Local development behavior for `alchemy dev`.
   */
  dev?: ComputeDev;
}

export interface Compute extends Resource<
  ComputeTypeId,
  ComputeProps,
  {
    /**
     * Prisma App ID.
     */
    appId: string;
    /**
     * Prisma deployment ID created for the current deployment.
     */
    deploymentId: string | undefined;
    /**
     * Project ID that owns the app.
     */
    projectId: string;
    /**
     * App display name.
     */
    appName: string;
    /**
     * Region ID where the App is placed.
     */
    regionId: string;
    /**
     * Preview endpoint domain for the deployment.
     */
    deploymentEndpointDomain: string | undefined;
    /**
     * HTTPS URL for the deployment endpoint.
     */
    deploymentUrl: string | undefined;
    /**
     * Stable App endpoint domain after promotion.
     */
    appEndpointDomain: string | undefined;
    /**
     * Preferred URL for the app, local in dev or stable/preview in deploys.
     */
    url: string | undefined;
    /**
     * Whether the current deployment was promoted to the stable endpoint.
     */
    promoted: boolean;
    /**
     * Previously promoted deployment ID observed before deploy.
     */
    previousDeploymentId: string | null | undefined;
    /**
     * Action taken for the previous deployment.
     */
    previousDeploymentAction:
      | "stopped"
      | "destroyed"
      | "still-active"
      | null
      | undefined;
    /** Stable App endpoint readiness observed after promotion. */
    readinessStatus?: "ready" | "pending" | "skipped";
    /** Old deployment cleanup that will be retried before another generation. */
    pendingDeploymentCleanup?: {
      deploymentId: string;
      action: "stop" | "destroy";
    };
    /**
     * Environment variable keys managed by this Compute resource.
     *
     * This includes explicit `env` props and env vars added by bindings.
     */
    environmentKeys?: string[];
    /**
     * Environment variable IDs created by this Compute resource, keyed by
     * variable name. IDs are the ownership boundary for shared branch/project
     * environment-variable namespaces.
     */
    environmentVariableIds?: Record<string, string>;
    /**
     * Prisma environment class used for the managed environment variable keys.
     */
    environmentClass?: "production" | "preview";
    /**
     * Branch ID used for managed preview branch environment overrides, or null
     * for project-level environment templates.
     */
    environmentBranchId?: string | null;
    /**
     * Fingerprint of the uploaded artifact/reused artifact inputs and the
     * branch attachment that Prisma resolves environment variables from.
     */
    artifactHash: Redacted.Redacted<string> | undefined;
    /**
     * Whether the app output represents a local dev process.
     */
    local: boolean;
  },
  {
    env?: Record<string, string | Redacted.Redacted<string> | null | undefined>;
  },
  Providers
> {}

export type ComputeRuntimeServices = Server.ProcessServices;

export type ComputeShape = Main<ComputeRuntimeServices>;

export interface ComputeRuntimeContext extends Server.ProcessContext {
  readonly Type: ComputeTypeId;
}

export const isCompute = (value: unknown): value is Compute =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === ComputeTypeId;

const hasEffectNativeComputeInput = (props: ComputeProps) =>
  props.isExternal !== true &&
  (props.main !== undefined || props.exports !== undefined);

const isEffectNativeCompute = (props: ComputeProps) =>
  hasEffectNativeComputeInput(props);

/**
 * Build and deploy an application to Prisma Compute.
 *
 * Prisma's create-deployment API exposes neither an idempotency key nor a
 * caller-defined recovery key. If the API commits a deployment but its create
 * response is lost before Alchemy persists the returned ID, that deployment
 * can remain orphaned and a later deploy may create another one. Alchemy does
 * not guess that the App's latest deployment is owned, because it could belong
 * to another actor. Use a durable, locked state backend and inspect the App's
 * deployment history after an interrupted create.
 *
 * ### Deploying an App
 * **Example:** Deploy a directory with an entrypoint
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   port: 3000,
 * });
 * ```
 *
 * **Example:** Deploy an Effect-native HTTP app
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   {
 *     project,
 *     appName: "api",
 *     main: import.meta.filename,
 *     port: 8080,
 *   },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.succeed(HttpServerResponse.text("ok")),
 *     };
 *   }),
 * );
 * ```
 *
 * ### Bundling & Tree-shaking
 * `main` is bundled with rolldown at deploy time. Top-level calls in the
 * `effect`, `@effect/*`, `alchemy`, `@alchemy.run/*`, and
 * `@distilled.cloud/*` packages receive `#__PURE__` annotations by
 * default, so anything the app doesn't use from those packages is
 * tree-shaken out of the bundle. Any other package — including your own
 * app — is left untouched unless you list it explicitly.
 *
 * **Example:** Treat additional packages as pure
 * Pass package names (or picomatch globs) via `bundle.extra.pure.packages` to
 * annotate them in addition to the defaults.
 * ```typescript
 * {
 *   main: "./src/app.ts",
 *   bundle: {
 *     extra: { pure: { packages: ["my-lib", "@my-scope/*"] } },
 *   },
 * }
 * ```
 *
 * Listing a package annotates calls whose result is bound (variable
 * initializers, exports) — safe anywhere. If a listed package also
 * declares `"sideEffects": false` (or `[]`) in its `package.json`, that
 * combination opts it into full annotation: top-level calls whose result
 * is discarded (e.g. `router.on("/path", handler)` registrations) are
 * also marked pure and deleted under minification when unused. Only list
 * a `sideEffects: false` package if its modules really are free of
 * meaningful top-level side effects. The `effect`, `alchemy`, and
 * `@distilled.cloud` defaults declare exactly that, on purpose — their
 * modules are designed to be fully tree-shakeable.
 *
 * **Example:** Disable pure annotations
 * ```typescript
 * {
 *   main: "./src/app.ts",
 *   bundle: { extra: { pure: false } },
 * }
 * ```
 *
 * ### Runtime Bindings
 * **Example:** Bind a Prisma Connection
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   {
 *     project,
 *     appName: "api",
 *     main: import.meta.filename,
 *   },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connect(connection);
 *     const sql = yield* SQL.Postgres({ url: db.databaseUrl });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const users = yield* sql`SELECT * FROM users`;
 *         return yield* HttpServerResponse.json(users);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectBinding)),
 * );
 * ```
 *
 * **Example:** Build before upload and replace old versions
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   path: "./apps/api",
 *   build: {
 *     command: "bun build src/server.ts --target bun --outdir dist",
 *     outdir: "dist",
 *     entrypoint: "server.js",
 *   },
 *   port: 8080,
 *   env: {
 *     // Use this for a standalone Connection. A project's default database
 *     // is injected by Prisma without an explicit DATABASE_URL entry.
 *     DATABASE_URL: connection.databaseUrl,
 *   },
 *   destroyOldDeployment: true,
 * });
 * ```
 *
 * **Example:** Auto-build a framework app
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   path: "./apps/web",
 *   build: "auto",
 *   destroyOldDeployment: true,
 * });
 * ```
 *
 * **Example:** Deploy a prebuilt tar.gz artifact
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   artifactPath: "./dist/app.tar.gz",
 *   port: 8080,
 * });
 * ```
 *
 * ### Deployment Health
 * **Example:** Require application readiness before promotion
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   healthCheck: {
 *     path: "/api/health",
 *     // Defaults to any 2xx response when omitted.
 *     statusCodes: [200, 204],
 *   },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Run locally during alchemy dev
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project: project.projectId,
 *   path: "./apps/api",
 *   entrypoint: "server.ts",
 *   dev: {
 *     command: "bun run dev",
 *     port: 3000,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Compute: Platform<
  Compute,
  ComputeRuntimeServices,
  ComputeShape,
  ComputeRuntimeContext
> & {
  <PropsReq = never>(
    id: string,
    props:
      | InputProps<ComputeProps>
      | Effect.Effect<InputProps<ComputeProps>, never, PropsReq>,
  ): Effect.Effect<Compute, never, Providers | PropsReq>;
} = Platform(ComputeTypeId, {
  createRuntimeContext: (id): ComputeRuntimeContext => {
    const runners: Effect.Effect<void, never, unknown>[] = [];
    const env: Record<string, unknown> = {};
    let runtimeContext: ComputeRuntimeContext;
    const run: Server.ProcessContext["run"] = (effect) =>
      Effect.sync(() => {
        runners.push(effect);
      });

    const serve = <Req = never>(handler: HttpEffect<Req>) =>
      Effect.sync(() => {
        runners.push(
          Effect.gen(function* () {
            const httpServer = yield* Effect.serviceOption(HttpServer).pipe(
              Effect.map(Option.getOrUndefined),
            );
            if (httpServer) {
              yield* httpServer.serve(
                handler.pipe(
                  Effect.provideService(RuntimeContext, runtimeContext),
                ),
              );
              yield* Effect.never;
            }
          }).pipe(Effect.catch((error: unknown) => Effect.die(error))),
        );
      });

    runtimeContext = {
      Type: ComputeTypeId,
      id,
      env,
      set: (bindingId: string, output: Output.Output) =>
        Effect.sync(() => {
          // Prisma env keys are validated to the uppercase POSIX shape
          // ([A-Z_][A-Z0-9_]*), so the storage key is uppercased here. The
          // runtime `get` receives the key this returns, so both halves
          // agree without a second mapping.
          const key = bindingId.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
          env[key] = output.pipe(
            Output.map((value) =>
              Redacted.isRedacted(value)
                ? Redacted.make(
                    JSON.stringify({
                      _tag: "Redacted",
                      value: Redacted.value(value),
                    }),
                  )
                : JSON.stringify(value),
            ),
          );
          return key;
        }),
      get: <T>(key: string) =>
        // Runtime ConfigProvider lookups call back into RuntimeContext.get.
        // Read the process env directly here to avoid re-entering that path.
        Effect.sync(() => {
          const value = process.env[key];
          if (value === undefined) {
            return undefined;
          }
          try {
            const parsed = JSON.parse(value);
            if (
              parsed !== null &&
              typeof parsed === "object" &&
              (parsed as { _tag?: unknown })._tag === "Redacted" &&
              "value" in (parsed as object)
            ) {
              return Redacted.make((parsed as { value: string }).value) as T;
            }
            return parsed as T;
          } catch {
            return value as T;
          }
        }),
      run,
      serve,
      exports: Effect.sync(() => ({
        default: Effect.all(
          runners.map((effect) =>
            Effect.forever(
              effect.pipe(
                Effect.tapError((error) => Effect.logError(error)),
                Effect.ignore,
              ),
            ),
          ),
          { concurrency: "unbounded" },
        ),
      })),
    };
    return runtimeContext;
  },
});

const devProcesses = new Map<string, ChildProcessHandle>();

const stopTrackedDevProcess = Effect.fn(function* (processKey: string) {
  const existing = devProcesses.get(processKey);
  if (!existing) return;

  const running = yield* existing.isRunning;
  if (running) {
    // Keep the handle tracked when termination fails so a later reconcile or
    // destroy can retry instead of losing the only reference to the process.
    yield* existing.kill();
  }
  devProcesses.delete(processKey);
});

const projectConsistencySchedule = Schedule.max([
  Schedule.exponential(Duration.millis(500)),
  Schedule.recurs(6),
]);

const isAppProvisioningNotFound = (error: unknown): boolean =>
  error instanceof PrismaApiError &&
  error.status === 404 &&
  (error.path.startsWith("/v1/projects/") ||
    error.path === "/v1/apps" ||
    error.path.startsWith("/v1/apps/"));

const desiredComputeBranchId = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  props: Pick<ComputeProps, "branchId" | "branchGitName">,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return { resolved: true as const, id: props.branchId };
  }
  const branches = yield* client.listBranches(
    projectId,
    props.branchGitName === undefined
      ? { limit: 100 }
      : { gitName: props.branchGitName, limit: 100 },
  );
  const matchingBranches =
    props.branchGitName === undefined
      ? branches.filter((branch) => branch.isDefault)
      : branches;
  if (matchingBranches.length > 1) {
    return yield* Effect.fail(
      new Error(
        props.branchGitName === undefined
          ? `Prisma returned multiple default branches for project '${projectId}'; refusing an ambiguous Compute App match.`
          : `Prisma returned multiple branches named '${props.branchGitName}' in project '${projectId}'; refusing an ambiguous Compute App match.`,
      ),
    );
  }
  const branch = matchingBranches[0];
  return branch
    ? { resolved: true as const, id: branch.id }
    : { resolved: false as const };
});

const createAppName = (id: string, appName: string | undefined) =>
  appName === undefined ? createPhysicalName({ id }) : Effect.succeed(appName);

const findApp = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  appName: string,
  props: Pick<ComputeProps, "branchId" | "branchGitName">,
) {
  const candidates = (yield* client.listApps({
    projectId,
    limit: 100,
  })).filter((app) => app.name === appName);
  if (candidates.length === 0) return undefined;
  const branch = yield* desiredComputeBranchId(client, projectId, props);
  if (!branch.resolved) return undefined;
  const matches = candidates.filter((app) => app.branchId === branch.id);
  if (matches.length > 1) {
    return yield* Effect.fail(
      new Error(
        `Prisma returned multiple Apps named '${appName}' on branch '${branch.id}' in project '${projectId}'; refusing an ambiguous ownership match.`,
      ),
    );
  }
  return matches[0];
});

const createApp = (
  client: PrismaManagementClient,
  projectId: string,
  props: ComputeProps & { appName: string },
  branchId: string,
) =>
  client.createApp({
    projectId,
    displayName: props.appName,
    regionId: props.regionId,
    branchId,
    branchGitName: undefined,
  });

const plainEnv = (
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]],
    ),
  ) as Record<string, string | null>;

const persistedArtifactHashValue = (
  value: Redacted.Redacted<string> | string | undefined,
) => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

const managedEnvKeys = (
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) =>
  Object.entries(plainEnv(env))
    .flatMap(([key, value]) => (value === null ? [] : [key]))
    .sort();

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_VALUE_MAX_BYTES = 8 * 1024;
const EXPORT_IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const computeEnvValue = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const validateComputeEnvironmentKey = (key: string) =>
  Effect.gen(function* () {
    if (key.length < 1 || key.length > 256 || !ENV_KEY_PATTERN.test(key)) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable key '${key}' must match POSIX env-var key shape: [A-Z_][A-Z0-9_]* and be at most 256 characters.`,
        ),
      );
    }
  });

const validateComputeEnvironmentWrite = (
  key: string,
  value: string | Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    yield* validateComputeEnvironmentKey(key);
    const raw = computeEnvValue(value);
    if (raw.length === 0) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value must be non-empty.`,
        ),
      );
    }
    const byteLength = yield* Effect.sync(
      () => new TextEncoder().encode(raw).byteLength,
    );
    if (byteLength > ENV_VALUE_MAX_BYTES) {
      return yield* Effect.fail(
        new Error(
          `Prisma environment variable '${key}' value exceeds ${ENV_VALUE_MAX_BYTES} bytes.`,
        ),
      );
    }
  });

const validateComputeHealthCheck = (
  healthCheck: ComputeHealthCheck | undefined,
) =>
  Effect.gen(function* () {
    if (healthCheck === undefined) return;
    if (
      !healthCheck.path.startsWith("/") ||
      healthCheck.path.startsWith("//") ||
      healthCheck.path.includes("\\") ||
      /\s/.test(healthCheck.path)
    ) {
      return yield* Effect.fail(
        new Error(
          "healthCheck.path must be an absolute application path beginning with one '/'.",
        ),
      );
    }
    if (
      healthCheck.statusCodes !== undefined &&
      healthCheck.statusCodes.length === 0
    ) {
      return yield* Effect.fail(
        new Error("healthCheck.statusCodes must contain at least one status."),
      );
    }
    for (const status of healthCheck.statusCodes ?? []) {
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        return yield* Effect.fail(
          new Error(
            "healthCheck.statusCodes must contain HTTP status integers from 100 through 599.",
          ),
        );
      }
    }
  });

const validateComputeProps = (props: ComputeProps) =>
  Effect.gen(function* () {
    yield* validateComputeHealthCheck(props.healthCheck);
    if (props.healthCheck !== undefined && props.verifyUrl === false) {
      return yield* Effect.fail(
        new Error("healthCheck cannot be combined with verifyUrl: false."),
      );
    }
    if (props.healthCheck !== undefined && props.start === false) {
      return yield* Effect.fail(
        new Error("healthCheck requires start to be enabled."),
      );
    }
    for (const [name, value] of [
      ["timeoutSeconds", props.timeoutSeconds],
      ["pollIntervalMs", props.pollIntervalMs],
      ["urlReadinessTimeoutSeconds", props.urlReadinessTimeoutSeconds],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        return yield* Effect.fail(
          new Error(`${name} must be a positive finite number.`),
        );
      }
    }
    for (const [name, value] of [
      ["port", props.port],
      ["dev.port", props.dev?.port],
    ] as const) {
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < 1 || value > 65_535)
      ) {
        return yield* Effect.fail(
          new Error(`${name} must be an integer between 1 and 65535.`),
        );
      }
    }
    for (const [key, value] of Object.entries(props.env ?? {})) {
      if (value === undefined) continue;
      if (value === null) {
        yield* validateComputeEnvironmentKey(key);
      } else {
        yield* validateComputeEnvironmentWrite(key, value);
      }
    }
    if ((props.skipPromote ?? false) && (props.destroyOldDeployment ?? false)) {
      return yield* Effect.fail(
        new Error(
          "destroyOldDeployment cannot be combined with skipPromote because the previous deployment stays active when promotion is skipped.",
        ),
      );
    }
    if (props.start === false && !(props.skipPromote ?? false)) {
      return yield* Effect.fail(
        new Error(
          "start: false requires skipPromote: true because Prisma Compute promotion requires a running deployment.",
        ),
      );
    }
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* Effect.fail(
        new Error("branchId and branchGitName are mutually exclusive."),
      );
    }
    if (props.branchId === null || props.branchGitName === null) {
      return yield* Effect.fail(
        new Error(
          "Prisma.Compute requires an attached branch because deployment creation resolves environment variables from the App branch. Omit branchGitName to use the project's default branch, or set branchId/branchGitName.",
        ),
      );
    }
    if ((props.skipCodeUpload ?? false) && props.artifactPath !== undefined) {
      return yield* Effect.fail(
        new Error("skipCodeUpload cannot be combined with artifactPath."),
      );
    }
    if ((props.skipCodeUpload ?? false) && props.build !== undefined) {
      return yield* Effect.fail(
        new Error("skipCodeUpload cannot be combined with build."),
      );
    }
    if (hasEffectNativeComputeInput(props)) {
      const handler = props.handler ?? "default";
      if (handler !== "default" && !EXPORT_IDENTIFIER_PATTERN.test(handler)) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute handler must be `default` or a valid JavaScript export identifier.",
          ),
        );
      }
      if (props.main === undefined) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute apps require `main`. Set `main: import.meta.filename`.",
          ),
        );
      }
      if (props.artifactPath !== undefined) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute apps cannot use artifactPath.",
          ),
        );
      }
      if (props.build !== undefined) {
        return yield* Effect.fail(
          new Error("Effect-native Prisma Compute apps cannot use build."),
        );
      }
      if (props.skipCodeUpload) {
        return yield* Effect.fail(
          new Error(
            "Effect-native Prisma Compute apps cannot skip code upload.",
          ),
        );
      }
    }
  });

const processEnv = (
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      value === undefined || value === null
        ? []
        : [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]],
    ),
  ) as Record<string, string>;

const isPrismaEdgeServiceNotFound = (status: number, body: string) =>
  status === 404 &&
  (body.includes("There is no service on this URL") ||
    body.includes("<title>Service not found</title>"));

const URL_READINESS_BODY_PREFIX_BYTES = 64 * 1024;

const readResponseBodyPrefix = (response: HttpClientResponse) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        const remaining = URL_READINESS_BODY_PREFIX_BYTES - bytes;
        if (remaining <= 0) return false;
        const kept =
          chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
        chunks.push(kept);
        bytes += kept.byteLength;
        return bytes < URL_READINESS_BODY_PREFIX_BYTES;
      }),
    );
    const prefix = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      prefix.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(prefix);
  });

export const waitForDeploymentUrl = Effect.fn(function* (
  url: string | undefined,
  props: ComputeProps,
) {
  yield* validateComputeHealthCheck(props.healthCheck);
  if (props.healthCheck !== undefined && props.verifyUrl === false) {
    return yield* Effect.fail(
      new Error("healthCheck cannot be combined with verifyUrl: false."),
    );
  }
  if (props.verifyUrl === false) return;
  if (!url) {
    return yield* Effect.fail(
      new Error(
        props.healthCheck === undefined
          ? "Prisma Compute did not return a public URL for readiness verification."
          : "Prisma Compute did not return a public URL for the configured healthCheck.",
      ),
    );
  }
  const httpOption = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(httpOption)) {
    return props.healthCheck === undefined
      ? undefined
      : yield* Effect.fail(
          new Error(
            "Prisma Compute healthCheck requires an HTTP client service.",
          ),
        );
  }

  const http = httpOption.value;
  const probeUrl =
    props.healthCheck === undefined
      ? url
      : new URL(props.healthCheck.path, url).toString();
  const acceptsStatus = (status: number) =>
    props.healthCheck === undefined ||
    (props.healthCheck.statusCodes === undefined
      ? status >= 200 && status <= 299
      : props.healthCheck.statusCodes.includes(status));
  const timeoutSeconds = props.urlReadinessTimeoutSeconds ?? 60;
  const intervalMs = props.pollIntervalMs ?? 1_000;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* Effect.fail(
      new Error("urlReadinessTimeoutSeconds must be a positive finite number."),
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return yield* Effect.fail(
      new Error("pollIntervalMs must be a positive finite number."),
    );
  }
  const timeoutMs = timeoutSeconds * 1_000;
  const startedAt = yield* Effect.sync(() => Date.now());
  let lastStatus: number | undefined;
  let lastBody = "";

  while (true) {
    const beforeRequest = yield* Effect.sync(() => Date.now());
    const remainingBeforeRequest = timeoutMs - (beforeRequest - startedAt);
    if (remainingBeforeRequest <= 0) {
      return yield* Effect.fail(
        deploymentUrlTimeoutError(probeUrl, lastStatus, lastBody),
      );
    }
    const requestTimeoutMs = Math.min(5_000, remainingBeforeRequest);
    const response = yield* http.execute(HttpClientRequest.get(probeUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.timeoutOption(Duration.millis(requestTimeoutMs)),
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (response) {
      lastStatus = response.status;
      // Without an application health check, any non-404 response proves that
      // edge routing is live. A configured health check must also match its
      // status contract. Do not consume non-404 bodies: application responses
      // may intentionally stream.
      if (response.status !== 404 && acceptsStatus(response.status)) {
        return;
      }
      const beforeBody = yield* Effect.sync(() => Date.now());
      const remainingBeforeBody = timeoutMs - (beforeBody - startedAt);
      if (remainingBeforeBody > 0) {
        const bodyPrefix = yield* readResponseBodyPrefix(response).pipe(
          Effect.timeoutOption(
            Duration.millis(Math.min(2_000, remainingBeforeBody)),
          ),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
        );
        if (Option.isSome(bodyPrefix)) {
          lastBody = bodyPrefix.value;
          if (
            !isPrismaEdgeServiceNotFound(response.status, lastBody) &&
            acceptsStatus(response.status)
          ) {
            return;
          }
        }
      }
    }

    const elapsed = yield* Effect.sync(() => Date.now() - startedAt);
    if (elapsed >= timeoutMs) {
      return yield* Effect.fail(
        deploymentUrlTimeoutError(probeUrl, lastStatus, lastBody),
      );
    }

    yield* Effect.sleep(
      Duration.millis(Math.min(intervalMs, timeoutMs - elapsed)),
    );
  }
});

const deploymentUrlTimeoutError = (
  url: string,
  lastStatus: number | undefined,
  lastBody: string,
) =>
  new Error(
    [
      `Timed out waiting for Prisma Compute URL '${url}' to become reachable.`,
      lastStatus
        ? `Last response: HTTP ${lastStatus}.`
        : "No HTTP response was received.",
      lastBody.includes("There is no service on this URL")
        ? "The Prisma edge returned: There is no service on this URL."
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" "),
  );

const isAutoBuild = (
  build: ComputeProps["build"],
): build is "auto" | ComputeAutoBuild =>
  build === "auto" ||
  (typeof build === "object" &&
    build !== null &&
    "type" in build &&
    build.type === "auto");

const readPackageMain = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(directory, "package.json"))
    .pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    );
  if (!text) return undefined;
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as { main?: unknown };
      return typeof parsed.main === "string" ? parsed.main : undefined;
    },
    catch: (cause) =>
      new Error(`Failed to parse package.json in ${directory}: ${cause}`),
  });
});

const writeBundleDirectory = Effect.fn(function* (bundle: Bundle.BundleOutput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (bundle.files.length === 0) {
    return yield* Effect.fail(
      new Error("Effect-native Compute bundler produced no output files."),
    );
  }
  const normalizedFiles = yield* Effect.forEach(bundle.files, (file) =>
    normalizeBundleFilePath(file.path).pipe(
      Effect.map((normalizedPath) => ({ file, normalizedPath })),
    ),
  );
  const seen = new Set<string>();
  for (const { normalizedPath } of normalizedFiles) {
    if (seen.has(normalizedPath)) {
      return yield* Effect.fail(
        new Error(
          `Effect-native Compute bundler produced duplicate output path '${normalizedPath}'.`,
        ),
      );
    }
    seen.add(normalizedPath);
  }
  const directory = yield* fs.makeTempDirectory({
    prefix: "alchemy-prisma-compute-",
  });

  return yield* Effect.gen(function* () {
    for (const { file, normalizedPath } of normalizedFiles) {
      const target = path.join(directory, normalizedPath);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      if (typeof file.content === "string") {
        yield* fs.writeFileString(target, file.content);
      } else {
        yield* fs.writeFile(target, file.content);
      }
    }

    return {
      directory,
      entrypoint: normalizedFiles[0].normalizedPath,
      cleanup: fs
        .remove(directory, { recursive: true })
        .pipe(Effect.catch(() => Effect.void)),
    };
  }).pipe(
    Effect.onError(() =>
      fs.remove(directory, { recursive: true }).pipe(Effect.ignore),
    ),
  );
});

const bundleEffectCompute = Effect.fn(function* (props: ComputeProps) {
  if (!props.main) {
    return yield* Effect.fail(
      new Error(
        "Effect-native Prisma Compute apps require `main`. Set `main: import.meta.filename`.",
      ),
    );
  }

  const fs = yield* FileSystem.FileSystem;
  const stack = yield* Effect.serviceOption(Stack).pipe(
    Effect.map(
      Option.getOrElse(() => ({
        name: "alchemy",
        stage: "dev",
        bindings: {},
        resources: {},
      })),
    ),
  );
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
  const realMain = yield* fs.realPath(props.main);
  const cwd = yield* findCwdForBundle(realMain);
  const handler = props.handler ?? "default";
  const defaultPort = props.port ?? 8080;

  const importEntrypoint =
    handler === "default"
      ? "import entrypoint"
      : `import { ${handler} as entrypoint }`;

  const bundle = yield* Bundle.build(
    {
      ...props.bundle?.input,
      input: realMain,
      cwd,
      platform: "node",
      // Prisma Compute runs the bundle on bun.
      resolve: {
        conditionNames: [...Bundle.BUN_CONDITION_NAMES],
        ...props.bundle?.input?.resolve,
      },
      plugins: [
        props.bundle?.input?.plugins,
        virtualEntryPlugin(
          (importPath) => `
import { bootstrap } from "alchemy/Runtime/Bootstrap/Prisma";
${importEntrypoint} from ${JSON.stringify(importPath)};

await bootstrap(entrypoint, ${JSON.stringify({
            port: defaultPort,
            stack: { name: stack.name, stage: stack.stage },
          })});
`,
        ),
      ],
      checks: {
        unresolvedImport: false,
        ineffectiveDynamicImport: false,
      },
    },
    {
      ...props.bundle?.output,
      format: "esm",
      sourcemap: props.bundle?.output?.sourcemap ?? "hidden",
      minify: props.bundle?.output?.minify ?? true,
      entryFileNames: "index.js",
    },
    props.bundle?.extra,
  );

  const artifact = yield* writeBundleDirectory(bundle);
  const file = yield* createComputeArchive({
    directory: artifact.directory,
    entrypoint: artifact.entrypoint,
    ignore: props.archiveIgnore,
    output: "file",
  }).pipe(Effect.ensuring(artifact.cleanup));

  return {
    file,
    bundleHash: bundle.hash,
  };
});

const resolveArtifact = Effect.fn(function* (props: ComputeProps) {
  const env = plainEnv(props.env);
  const envClass = props.envClass ?? "production";
  const defaultPort = props.port ?? 8080;
  if (isEffectNativeCompute(props)) {
    if (props.artifactPath !== undefined) {
      return yield* Effect.fail(
        new Error("Effect-native Prisma Compute apps cannot use artifactPath."),
      );
    }
    if (props.skipCodeUpload) {
      return yield* Effect.fail(
        new Error("Effect-native Prisma Compute apps cannot skip code upload."),
      );
    }
    if (props.build !== undefined) {
      return yield* Effect.fail(
        new Error("Effect-native Prisma Compute apps cannot use build."),
      );
    }
    const artifact = yield* bundleEffectCompute(props);
    return {
      file: artifact.file,
      hash: yield* sha256Object({
        bundle: artifact.bundleHash,
        env,
        envClass,
        port: defaultPort,
      }),
      port: defaultPort,
    };
  }

  if (props.skipCodeUpload) {
    return {
      file: undefined,
      hash: yield* sha256Object({
        skipCodeUpload: true,
        env,
        envClass,
        port: defaultPort,
      }),
      port: defaultPort,
    };
  }

  if (props.artifactPath !== undefined) {
    const file = yield* readUploadArtifact({
      artifactPath: props.artifactPath,
      output: "file",
    });
    return {
      file: file!,
      hash: yield* sha256Object({
        artifact: file!.sha256,
        env,
        envClass,
        port: defaultPort,
      }),
      port: defaultPort,
    };
  }

  const path = yield* Path.Path;
  const appPath = path.resolve(props.path ?? ".");
  let directory = appPath;
  let entrypoint = props.entrypoint;
  let port = defaultPort;

  if (isAutoBuild(props.build)) {
    const auto = props.build === "auto" ? undefined : props.build;
    const artifact = yield* runComputeAutoBuild({
      appPath,
      entrypoint,
      framework: auto?.framework,
      env: auto?.env,
      outputLimitBytes: auto?.outputLimitBytes,
      timeoutSeconds: auto?.timeoutSeconds,
    });
    const file = yield* createComputeArchive({
      directory: artifact.directory,
      entrypoint: artifact.entrypoint,
      ignore: props.archiveIgnore,
      output: "file",
    }).pipe(Effect.ensuring(artifact.cleanup));
    port = props.port ?? artifact.defaultPort ?? 8080;
    return {
      file,
      hash: yield* sha256Object({
        artifact: file.sha256,
        env,
        envClass,
        port,
      }),
      port,
    };
  }

  if (props.build) {
    const cwd = props.build.cwd ? path.resolve(props.build.cwd) : appPath;
    yield* runBuildCommand({
      command: props.build.command,
      cwd,
      env: processEnv(props.build.env),
      outputLimitBytes: props.build.outputLimitBytes,
      timeoutSeconds: props.build.timeoutSeconds,
    });
    directory = path.resolve(cwd, props.build.outdir);
    entrypoint = props.build.entrypoint ?? entrypoint;
  }

  entrypoint ??= yield* readPackageMain(directory);
  if (!entrypoint) {
    return yield* Effect.fail(
      new Error(
        "Prisma Compute app entrypoint is required. Set `entrypoint` or package.json `main`.",
      ),
    );
  }

  const normalizedEntrypoint = yield* normalizeEntrypoint(entrypoint);
  const file = yield* createComputeArchive({
    directory,
    entrypoint: normalizedEntrypoint,
    ignore: props.archiveIgnore,
    output: "file",
  });
  return {
    file,
    hash: yield* sha256Object({
      artifact: file.sha256,
      env,
      envClass,
      port,
    }),
    port,
  };
});

const findExistingApp = Effect.fn(function* (
  client: PrismaManagementClient,
  output: Compute["Attributes"] | undefined,
) {
  const appId =
    output?.appId && !isPrismaDevId(output.appId) ? output.appId : undefined;
  return appId
    ? yield* client
        .getApp(appId)
        .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)))
    : undefined;
});

const ensureApp = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  props: ComputeProps & { appName: string },
  output: Compute["Attributes"] | undefined,
  observedApp?: ApiApp,
) {
  let app = observedApp ?? (yield* findExistingApp(client, output));
  const branch = yield* desiredComputeBranchId(client, projectId, props);
  if (!branch.resolved) {
    return yield* Effect.fail(
      new Error(
        props.branchGitName === undefined
          ? `Prisma project '${projectId}' has no default branch to attach Compute App '${props.appName}'. Create or promote a default branch, or specify branchId/branchGitName.`
          : `Prisma project '${projectId}' has no branch named '${props.branchGitName}' to attach Compute App '${props.appName}'.`,
      ),
    );
  }

  let createdApp = false;
  if (!app) {
    const result = yield* createApp(client, projectId, props, branch.id).pipe(
      Effect.map((app) => ({ app, created: true })),
      Effect.catchIf(isConflict, (conflict) =>
        findApp(client, projectId, props.appName, props).pipe(
          Effect.flatMap((app) =>
            app && output?.appId !== undefined && app.id === output.appId
              ? Effect.succeed({ app, created: false })
              : Effect.fail(
                  new Error(
                    `Prisma App '${props.appName}' already exists on the requested branch but is not owned by this Compute resource. Import it with explicit adoption or choose a different App name.`,
                    { cause: conflict },
                  ),
                ),
          ),
        ),
      ),
    );
    app = result.app;
    createdApp = result.created;
  }

  yield* ensureAppImmutableIdentity(
    app,
    projectId,
    props.regionId ?? output?.regionId ?? app.region.id,
  );
  if (app.name !== props.appName || app.branchId !== branch.id) {
    app = yield* client.updateApp(app.id, {
      displayName: props.appName,
      branchId: branch.id,
      branchGitName: undefined,
    });
  }

  return { app, created: createdApp };
});

const ensureSkipCodeUploadCanFork = (
  props: ComputeProps,
  app: ApiApp | undefined,
) =>
  Effect.gen(function* () {
    if (!(props.skipCodeUpload ?? false)) return;
    if (app?.latestDeploymentId) return;
    return yield* Effect.fail(
      new Error(
        "skipCodeUpload requires an existing Prisma deployment to fork from. Upload and start a deployment first, or remove skipCodeUpload.",
      ),
    );
  });

const findEnvironmentVariable = (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  key: string,
  branchId?: string | null,
) =>
  client
    .listEnvironmentVariables({
      projectId,
      class: cls,
      key,
      ...(branchId ? { branchId } : {}),
      limit: 100,
    })
    .pipe(
      Effect.map((variables: ApiEnvironmentVariable[]) =>
        variables.find((variable) => variable.branchId === (branchId ?? null)),
      ),
    );

const systemManagedEnvironmentVariableError = (key: string) =>
  new Error(
    `Prisma environment variable '${key}' is managed by Prisma and cannot be managed by Alchemy.`,
  );

const ensureUserManagedEnvironmentVariable = (
  variable: ApiEnvironmentVariable,
) =>
  Effect.gen(function* () {
    if (variable.isManagedBySystem) {
      return yield* Effect.fail(
        systemManagedEnvironmentVariableError(variable.key),
      );
    }
  });

const environmentVariableOwnershipError = (key: string, variableId: string) =>
  new Error(
    `Prisma environment variable '${key}' (${variableId}) already exists in this branch/class scope but is not owned by this Compute resource. It may be foreign or left by an interrupted prior Compute deploy; the Management API exposes no ownership marker or plaintext value that would make takeover safe. Use one standalone Prisma.EnvironmentVariable resource as the independently manageable owner, choose a different key, explicitly adopt that resource, or remove the existing variable before deploying.`,
  );

interface ComputeEnvironmentScope {
  class: "production" | "preview";
  branchId: string | null;
}

const environmentScope = (
  cls: "production" | "preview",
  branchId?: string | null,
): ComputeEnvironmentScope => ({
  class: cls,
  branchId: branchId ?? null,
});

const sameEnvironmentScope = (
  left: ComputeEnvironmentScope,
  right: ComputeEnvironmentScope,
) => left.class === right.class && left.branchId === right.branchId;

const resolveComputeEnvironmentScope = Effect.fn(function* (
  client: PrismaManagementClient,
  app: ApiApp,
  props: ComputeProps,
) {
  if (!app.branchId) {
    return yield* Effect.fail(
      new Error(
        "Prisma.Compute requires an attached branch because deployment creation resolves environment variables from the App branch.",
      ),
    );
  }

  const branch = yield* client.getBranch(app.branchId);
  const inferredClass = branch.role;
  if (props.envClass !== undefined && props.envClass !== inferredClass) {
    return yield* Effect.fail(
      new Error(
        `Prisma.Compute envClass '${props.envClass}' does not match attached branch role '${inferredClass}'. Omit envClass to let Alchemy infer the correct environment variable scope.`,
      ),
    );
  }

  return environmentScope(
    inferredClass,
    inferredClass === "preview" ? app.branchId : null,
  );
});

interface ComputeEnvironmentPlan {
  key: string;
  value: string | null;
  variable: ApiEnvironmentVariable | undefined;
}

const rollbackCreatedEnvironmentVariables = Effect.fn(function* (
  client: PrismaManagementClient,
  createdIds: ReadonlyArray<{ key: string; id: string }>,
  originalError: unknown,
) {
  if (createdIds.length === 0) {
    return yield* Effect.fail(originalError);
  }
  const cleanupErrors: unknown[] = [];
  for (const created of [...createdIds].reverse()) {
    const result = yield* Effect.result(
      client
        .deleteEnvironmentVariable(created.id)
        .pipe(Effect.catchIf(isNotFound, () => Effect.void)),
    );
    if (Result.isFailure(result)) {
      cleanupErrors.push(result.failure);
    }
  }
  if (cleanupErrors.length > 0) {
    return yield* Effect.fail(
      new AggregateError(
        [originalError, ...cleanupErrors],
        `Failed to roll back newly created Prisma environment variables after reconcile failed. Manual cleanup: ${createdIds.map(({ id }) => `DELETE /v1/environment-variables/${id}`).join(", ")}.`,
      ),
    );
  }
  return yield* Effect.fail(originalError);
});

const syncComputeEnvironmentInternal = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
  branchId?: string | null,
  ownedIds: Readonly<Record<string, string>> = {},
) {
  const synced: string[] = [];
  const deleted: string[] = [];
  const nextOwnedIds: Record<string, string> = {};
  const createdIds: Array<{ key: string; id: string }> = [];
  const plans: ComputeEnvironmentPlan[] = [];

  // Observe and validate the entire scope before the first write. In
  // particular, a foreign/system-owned key discovered late in the input must
  // not leave earlier keys partially created.
  for (const [key, value] of Object.entries(plainEnv(env))) {
    if (value === null) {
      yield* validateComputeEnvironmentKey(key);
    } else {
      yield* validateComputeEnvironmentWrite(key, value);
    }
    const variable = yield* findEnvironmentVariable(
      client,
      projectId,
      cls,
      key,
      branchId,
    );
    if (variable) {
      yield* ensureUserManagedEnvironmentVariable(variable);
      if (ownedIds[key] !== variable.id) {
        return yield* Effect.fail(
          environmentVariableOwnershipError(key, variable.id),
        );
      }
    }
    plans.push({ key, value, variable });
  }

  const apply = Effect.gen(function* () {
    for (const { key, value, variable } of plans) {
      if (value === null) continue;
      if (variable) {
        yield* client.updateEnvironmentVariable(variable.id, { value });
        nextOwnedIds[key] = variable.id;
      } else {
        const created = yield* client.createEnvironmentVariable({
          projectId,
          ...(branchId ? { branchId } : {}),
          class: cls,
          key,
          value,
        });
        createdIds.push({ key, id: created.id });
        nextOwnedIds[key] = created.id;
      }
      synced.push(key);
    }
    // Apply explicit deletions only after all ownership checks and upserts.
    for (const { key, value, variable } of plans) {
      if (value !== null || !variable) continue;
      yield* client
        .deleteEnvironmentVariable(variable.id)
        .pipe(Effect.catchIf(isNotFound, () => Effect.void));
      deleted.push(key);
    }
    return { synced, deleted, ownedIds: nextOwnedIds, createdIds };
  });

  return yield* apply.pipe(
    Effect.catch((error) =>
      rollbackCreatedEnvironmentVariables(client, createdIds, error),
    ),
  );
});

export const syncComputeEnvironment = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  cls: "production" | "preview",
  env: Record<
    string,
    string | Redacted.Redacted<string> | null | undefined
  > = {},
  branchId?: string | null,
  ownedIds: Readonly<Record<string, string>> = {},
) {
  const result = yield* syncComputeEnvironmentInternal(
    client,
    projectId,
    cls,
    env,
    branchId,
    ownedIds,
  );
  return {
    synced: result.synced,
    deleted: result.deleted,
    ownedIds: result.ownedIds,
  };
});

const destroyComputeEnvironment = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  scope: ComputeEnvironmentScope,
  ownedIds: Readonly<Record<string, string>> = {},
) {
  const deleted: string[] = [];
  for (const [key, ownedId] of Object.entries(ownedIds)) {
    const variable = yield* findEnvironmentVariable(
      client,
      projectId,
      scope.class,
      key,
      scope.branchId,
    ).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
    if (!variable) continue;
    if (variable.id !== ownedId || variable.isManagedBySystem) continue;
    yield* client
      .deleteEnvironmentVariable(variable.id)
      .pipe(Effect.catchIf(isNotFound, () => Effect.void));
    deleted.push(key);
  }
  return { deleted };
});

const cleanupRemovedComputeEnvironment = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  oldScope: ComputeEnvironmentScope,
  oldOwnedIds: Readonly<Record<string, string>>,
  newScope: ComputeEnvironmentScope,
  newEnv:
    | Record<string, string | Redacted.Redacted<string> | null | undefined>
    | undefined,
) {
  const newValues = plainEnv(newEnv);
  const deleted: string[] = [];
  for (const [key, ownedId] of Object.entries(oldOwnedIds)) {
    if (sameEnvironmentScope(oldScope, newScope) && key in newValues) continue;
    const variable = yield* findEnvironmentVariable(
      client,
      projectId,
      oldScope.class,
      key,
      oldScope.branchId,
    );
    if (!variable) continue;
    if (variable.id !== ownedId || variable.isManagedBySystem) continue;
    yield* client
      .deleteEnvironmentVariable(variable.id)
      .pipe(Effect.catchIf(isNotFound, () => Effect.void));
    deleted.push(key);
  }
  return { deleted };
});

const startDev = Effect.fn(function* (id: string, props: ComputeProps) {
  const path = yield* Path.Path;
  const dev = props.dev;
  const processKey = `dev:${id}`;
  const localUrl =
    dev?.url ??
    ((dev?.port ?? props.port)
      ? `http://localhost:${dev?.port ?? props.port}`
      : undefined);
  if (!dev?.command) {
    return localUrl;
  }

  yield* stopTrackedDevProcess(processKey);

  const cwd = dev.cwd ? path.resolve(dev.cwd) : path.resolve(props.path ?? ".");
  const env = {
    ...processEnv(props.env),
    ...processEnv(dev.env),
    ...((dev.port ?? props.port)
      ? { PORT: String(dev.port ?? props.port) }
      : {}),
  };
  const handle = yield* ChildProcess.make(dev.command, [], {
    shell: true,
    cwd,
    env,
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: false,
  });
  devProcesses.set(processKey, handle);
  return localUrl;
});

const activeBindingEnv = (
  bindings: ResourceBinding<Compute["Binding"]>[],
): Record<string, string | Redacted.Redacted<string> | null | undefined> =>
  bindings
    .filter(
      (binding: ResourceBinding<Compute["Binding"]> & { action?: string }) =>
        binding.action !== "delete",
    )
    .map((binding) => binding.data?.env)
    .reduce<
      Record<string, string | Redacted.Redacted<string> | null | undefined>
    >(
      (acc, env) => (env ? { ...acc, ...env } : acc),
      {} as Record<
        string,
        string | Redacted.Redacted<string> | null | undefined
      >,
    );

const ProviderLive = () =>
  Provider.effect(
    Compute,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["appId"],
        // Compute is a composite over App + Deployment. AppProvider owns nuke
        // enumeration to avoid deleting the same canonical App twice.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (output?.local || isPrismaDevId(output?.appId)) {
            return { action: "update" } as const;
          }
          const oldProjectId =
            output?.projectId ?? unresolvedProjectIdOf(olds.project);
          const newProjectId = isResolved(news.project)
            ? unresolvedProjectIdOf(news.project)
            : undefined;
          if (concreteIdsChanged(oldProjectId, newProjectId)) {
            // A different project is a distinct API uniqueness scope, so the
            // old and replacement Apps can safely coexist.
            return { action: "replace" } as const;
          }
          if (isResolved(news.regionId) && news.regionId !== undefined) {
            const currentRegionId = output?.regionId ?? olds.regionId;
            if (
              currentRegionId !== undefined &&
              news.regionId !== currentRegionId
            ) {
              return yield* Effect.fail(
                new Error(
                  `Prisma Compute App region is immutable and cannot be changed atomically without deleting the live App first. Deploy a second Compute App under a different appName in the target region, cut traffic over, then remove the original.`,
                ),
              );
            }
          }
          // Source files/build output can change with no prop change, so
          // reconcile must rerun and decide from the computed artifact hash.
          return { action: "update" } as const;
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          if (output?.local) return output;
          const appId =
            output?.appId && !isPrismaDevId(output.appId)
              ? output.appId
              : undefined;
          const app = appId
            ? yield* client
                .getApp(appId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findApp(
                      client,
                      projectId,
                      yield* createAppName(id, olds.appName),
                      olds,
                    )
                  : undefined;
              });
          if (!app) return undefined;
          const readDeployment = (id: string) =>
            observeDeployment(client, id).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
          const outputDeployment = output?.deploymentId
            ? yield* readDeployment(output.deploymentId)
            : undefined;
          if (outputDeployment) {
            yield* ensureDeploymentMembership(
              client,
              app.id,
              outputDeployment,
              app.latestDeploymentId,
            );
          }
          const latestDeployment =
            !outputDeployment && app.latestDeploymentId
              ? yield* readDeployment(app.latestDeploymentId)
              : undefined;
          const deployment = outputDeployment ?? latestDeployment;
          const deploymentUrl = toDeploymentUrl(
            deployment?.previewDomain ?? undefined,
          );
          const appUrl = toDeploymentUrl(app.appEndpointDomain);
          const promoted =
            app.latestDeploymentId !== null &&
            deployment?.id === app.latestDeploymentId;
          const attrs: Compute["Attributes"] = {
            appId: app.id,
            deploymentId: deployment?.id,
            projectId: app.projectId ?? output?.projectId,
            appName: app.name,
            regionId: app.region.id,
            deploymentEndpointDomain: deployment?.previewDomain ?? undefined,
            deploymentUrl,
            appEndpointDomain:
              app.appEndpointDomain ?? output?.appEndpointDomain,
            url: promoted ? (appUrl ?? deploymentUrl) : deploymentUrl,
            promoted,
            previousDeploymentId: output?.previousDeploymentId,
            previousDeploymentAction: output?.previousDeploymentAction,
            readinessStatus: output?.readinessStatus,
            pendingDeploymentCleanup: output?.pendingDeploymentCleanup,
            environmentKeys: output?.environmentKeys,
            environmentVariableIds: output?.environmentVariableIds,
            environmentClass: output?.environmentClass ?? olds.envClass,
            environmentBranchId: output?.environmentBranchId,
            // A latest-deployment fallback is unrelated to a missing saved
            // deployment. Never transfer its artifact identity to other code.
            artifactHash: outputDeployment ? output?.artifactHash : undefined,
            local: false,
          };
          return appId ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, bindings }) {
          const bindingEnv = activeBindingEnv(bindings);
          const effectiveNews = {
            ...news,
            appName: yield* createAppName(id, news.appName),
            env: {
              ...bindingEnv,
              ...news.env,
            },
          };
          yield* validateComputeProps(effectiveNews);
          const projectId = yield* resolveProjectId(effectiveNews.project);
          const artifact = yield* resolveArtifact(effectiveNews);
          const cleanupArtifact = artifact.file?.cleanup ?? Effect.void;
          const releaseArtifactOnFailure = <A, E, R>(
            effect: Effect.Effect<A, E, R>,
          ) =>
            effect.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : cleanupArtifact,
              ),
            );
          const observedApp = effectiveNews.skipCodeUpload
            ? yield* releaseArtifactOnFailure(
                findExistingApp(client, output).pipe(
                  Effect.retry({
                    while: isAppProvisioningNotFound,
                    schedule: projectConsistencySchedule,
                  }),
                ),
              )
            : undefined;
          yield* releaseArtifactOnFailure(
            ensureSkipCodeUploadCanFork(effectiveNews, observedApp),
          );
          const ensuredApp = yield* releaseArtifactOnFailure(
            ensureApp(
              client,
              projectId,
              effectiveNews,
              output,
              observedApp,
            ).pipe(
              Effect.retry({
                while: isAppProvisioningNotFound,
                schedule: projectConsistencySchedule,
              }),
            ),
          );
          let app = ensuredApp.app;
          let preserveCreatedAppOnFailure = false;
          const cleanupCreatedAppOnFailure = (error: unknown) =>
            ensuredApp.created && !preserveCreatedAppOnFailure
              ? destroyApp(client, app.id).pipe(
                  Effect.catch((cleanupError) =>
                    Effect.fail(
                      aggregateCleanupFailure(
                        "App",
                        app.id,
                        `/v1/apps/${app.id}`,
                        error,
                        cleanupError,
                      ),
                    ),
                  ),
                  Effect.andThen(() => Effect.fail(error)),
                )
              : Effect.fail(error);

          let createdEnvironmentVariableIds: Array<{
            key: string;
            id: string;
          }> = [];
          let deploymentConverged = false;

          return yield* Effect.gen(function* () {
            const currentEnvironmentScope =
              yield* resolveComputeEnvironmentScope(client, app, effectiveNews);
            const deploymentHash = yield* sha256Object({
              artifact: artifact.hash,
              branchId: app.branchId,
              environmentClass: currentEnvironmentScope.class,
              environmentBranchId: currentEnvironmentScope.branchId,
            });
            const outputArtifactHash = persistedArtifactHashValue(
              output?.artifactHash as
                | Redacted.Redacted<string>
                | string
                | undefined,
            );
            const persistedDeployment = output?.deploymentId
              ? yield* observeDeployment(client, output.deploymentId).pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
              : undefined;
            const terminalFailedDeploymentId =
              persistedDeployment?.status === "failed"
                ? persistedDeployment.id
                : undefined;
            const promotionRequested = !(effectiveNews.skipPromote ?? false);
            let persistedPendingCleanup = output?.pendingDeploymentCleanup;
            const cleanupPreviousDeployment = Effect.fn(function* (
              deploymentId: string,
              action: "stop" | "destroy",
            ) {
              const observed = yield* observeDeployment(
                client,
                deploymentId,
              ).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
              if (!observed) {
                return (action === "destroy" ? "destroyed" : "stopped") as
                  | "destroyed"
                  | "stopped";
              }
              yield* ensureDeploymentMembership(
                client,
                app.id,
                observed,
                app.latestDeploymentId,
              );
              if (action === "destroy") {
                yield* destroyDeployment(client, deploymentId, effectiveNews);
                return "destroyed" as const;
              }
              yield* stopDeploymentIdempotent(client, deploymentId).pipe(
                Effect.catchIf(isNotFound, () => Effect.void),
              );
              yield* waitForDeploymentStatus(
                client,
                deploymentId,
                "stopped",
                effectiveNews,
              ).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
              return "stopped" as const;
            });

            if (
              terminalFailedDeploymentId !== undefined &&
              promotionRequested &&
              output?.promoted === true &&
              app.latestDeploymentId !== null &&
              app.latestDeploymentId !== terminalFailedDeploymentId
            ) {
              return yield* Effect.fail(
                new AggregateError(
                  [],
                  `Prisma Compute state preserves terminal failed deployment '${terminalFailedDeploymentId}', but App '${app.id}' reports deployment '${app.latestDeploymentId}' as latest. Alchemy cannot prove that the live deployment is the interrupted replacement, and the persisted failed deployment is not a safe rollback target. No new deployment was created and neither deployment was deleted.`,
                ),
              );
            }

            // Apply persists the previous stable Attributes before reconcile.
            // If a prior attempt promoted a new generation, failed its stable
            // health check, and could not roll back, that durable output still
            // identifies the deployment we must restore while the App points
            // at the displaced unhealthy generation. Recover that transition
            // before changing env or creating another deployment, otherwise a
            // retry would use the unhealthy generation as its rollback target.
            if (
              promotionRequested &&
              output?.promoted === true &&
              output.deploymentId !== undefined &&
              terminalFailedDeploymentId === undefined &&
              outputArtifactHash !== deploymentHash &&
              app.latestDeploymentId !== null &&
              app.latestDeploymentId !== output.deploymentId
            ) {
              const persistedDeploymentId = output.deploymentId;
              const displacedDeploymentId = app.latestDeploymentId;
              const rollback = yield* client
                .rollbackApp(app.id, {
                  deploymentId: persistedDeploymentId,
                })
                .pipe(Effect.result);
              const observedAfterRollback = yield* waitForAppDeploymentTarget(
                client,
                app.id,
                persistedDeploymentId,
                effectiveNews,
              ).pipe(Effect.result);

              if (Result.isFailure(observedAfterRollback)) {
                return yield* Effect.fail(
                  new AggregateError(
                    [
                      ...(Result.isFailure(rollback) ? [rollback.failure] : []),
                      ...(Result.isFailure(observedAfterRollback)
                        ? [observedAfterRollback.failure]
                        : []),
                    ],
                    `Prisma App '${app.id}' has live deployment '${displacedDeploymentId}', while Alchemy state preserves deployment '${persistedDeploymentId}' as the prior promoted generation. Recovery via POST /v1/apps/${app.id}/rollback did not converge, so no environment variables or new deployment were changed and neither deployment was deleted.`,
                  ),
                );
              }

              app = observedAfterRollback.success;
              yield* destroyDeployment(
                client,
                displacedDeploymentId,
                effectiveNews,
              ).pipe(
                Effect.catch((cleanupError) =>
                  Effect.fail(
                    new AggregateError(
                      [
                        ...(Result.isFailure(rollback)
                          ? [rollback.failure]
                          : []),
                        cleanupError,
                      ],
                      `Prisma App '${app.id}' was restored to deployment '${persistedDeploymentId}', but displaced deployment '${displacedDeploymentId}' could not be deleted. No new deployment was created; retry cleanup with DELETE /v1/deployments/${displacedDeploymentId}.`,
                    ),
                  ),
                ),
              );
            }

            if (
              output?.readinessStatus === "pending" &&
              outputArtifactHash !== deploymentHash
            ) {
              return yield* Effect.fail(
                new Error(
                  `Prisma Compute deployment '${output.deploymentId ?? "unknown"}' still has pending stable-endpoint readiness. Reconcile the existing generation before changing code or environment inputs.`,
                ),
              );
            }
            // Keep one cleanup candidate. A non-live older candidate is
            // drained before any env/deploy mutation; a candidate that is
            // still live is derived from app.latestDeploymentId below.
            if (
              persistedPendingCleanup !== undefined &&
              output?.readinessStatus !== "pending" &&
              persistedPendingCleanup.deploymentId !== app.latestDeploymentId
            ) {
              yield* cleanupPreviousDeployment(
                persistedPendingCleanup.deploymentId,
                persistedPendingCleanup.action,
              );
              persistedPendingCleanup = undefined;
            } else if (
              persistedPendingCleanup?.deploymentId === app.latestDeploymentId
            ) {
              persistedPendingCleanup = undefined;
            }
            const previousEnvironmentScope = environmentScope(
              olds?.envClass ?? output?.environmentClass ?? "production",
              output?.environmentBranchId,
            );
            const previousEnvironmentVariableIds =
              output?.environmentVariableIds ?? {};
            const environmentResult = yield* syncComputeEnvironmentInternal(
              client,
              projectId,
              currentEnvironmentScope.class,
              effectiveNews.env,
              currentEnvironmentScope.branchId,
              sameEnvironmentScope(
                previousEnvironmentScope,
                currentEnvironmentScope,
              )
                ? previousEnvironmentVariableIds
                : {},
            );
            createdEnvironmentVariableIds = environmentResult.createdIds;

            // Deployment creation snapshots the App branch environment. Remove
            // formerly-owned keys before creating it so deleted keys cannot be
            // captured into the new runtime. Any failure here happens before
            // deployment creation and rolls back newly-created variables.
            yield* cleanupRemovedComputeEnvironment(
              client,
              projectId,
              previousEnvironmentScope,
              previousEnvironmentVariableIds,
              currentEnvironmentScope,
              effectiveNews.env,
            );

            let deployment: ObservedDeployment | undefined =
              outputArtifactHash === deploymentHash
                ? persistedDeployment
                : undefined;
            // A failed deployment is terminal and cannot be repaired by
            // replaying start/promotion. Preserve it as the cleanup target,
            // but create a fresh generation and do not delete the failed one
            // until the replacement has passed preview + stable readiness and
            // promotion is observed.
            if (
              persistedDeployment !== undefined &&
              (deployment !== undefined ||
                terminalFailedDeploymentId !== undefined)
            ) {
              yield* ensureDeploymentMembership(
                client,
                app.id,
                persistedDeployment,
                app.latestDeploymentId,
              );
            }
            if (terminalFailedDeploymentId !== undefined) {
              deployment = undefined;
            }
            let createdDeploymentId: string | undefined;
            const cleanupCreatedDeploymentOnFailure = (
              failedDeploymentId: string,
              error: unknown,
            ) =>
              createdDeploymentId === failedDeploymentId
                ? destroyDeployment(
                    client,
                    failedDeploymentId,
                    effectiveNews,
                  ).pipe(
                    Effect.catch((cleanupError) =>
                      Effect.fail(
                        aggregateCleanupFailure(
                          "deployment",
                          failedDeploymentId,
                          `/v1/deployments/${failedDeploymentId}`,
                          error,
                          cleanupError,
                        ),
                      ),
                    ),
                    Effect.andThen(() => Effect.fail(error)),
                  )
                : Effect.fail(error);

            if (!deployment) {
              const created = yield* client.createAppDeployment(app.id, {
                portMapping: { http: artifact.port },
                skipCodeUpload: effectiveNews.skipCodeUpload,
              });
              createdDeploymentId = created.id;
              if (artifact.file !== undefined && !created.uploadUrl) {
                return yield* cleanupCreatedDeploymentOnFailure(
                  created.id,
                  new Error(
                    "Prisma deployment creation did not return an upload URL.",
                  ),
                );
              }
              if (created.uploadUrl && artifact.file !== undefined) {
                yield* uploadArtifact(
                  created.uploadUrl,
                  artifact.file,
                  "application/gzip",
                ).pipe(
                  Effect.catch((error) =>
                    cleanupCreatedDeploymentOnFailure(created.id, error),
                  ),
                );
              }
              deployment = yield* observeDeployment(client, created.id).pipe(
                Effect.catchIf(isNotFound, () =>
                  Effect.succeed({
                    id: created.id,
                    type: "deployment" as const,
                    url: created.url,
                    foundryVersionId: created.foundryVersionId,
                    status: "new",
                    previewDomain: null,
                    createdAt: undefined,
                  }),
                ),
                Effect.catch((error) =>
                  cleanupCreatedDeploymentOnFailure(created.id, error),
                ),
              );
            }
            if (!deployment) {
              return yield* Effect.fail(
                new Error(
                  "Prisma deployment could not be resolved after creation.",
                ),
              );
            }

            const previousDeploymentId =
              terminalFailedDeploymentId ??
              persistedPendingCleanup?.deploymentId ??
              (app.latestDeploymentId !== null &&
              app.latestDeploymentId !== deployment.id
                ? app.latestDeploymentId
                : null);
            const rollbackDeploymentId =
              previousDeploymentId === terminalFailedDeploymentId
                ? null
                : previousDeploymentId;

            if (effectiveNews.start ?? true) {
              const currentDeployment = deployment;
              const currentDeploymentId = currentDeployment.id;
              deployment = yield* Effect.gen(function* () {
                if (
                  currentDeployment.status !== "running" &&
                  currentDeployment.status !== "provisioning"
                ) {
                  yield* startDeploymentIdempotent(
                    client,
                    currentDeployment.id,
                  );
                }
                const running = yield* waitForDeploymentStatus(
                  client,
                  currentDeployment.id,
                  "running",
                  effectiveNews,
                );
                yield* waitForDeploymentUrl(
                  toDeploymentUrl(running.previewDomain),
                  effectiveNews,
                );
                return running;
              }).pipe(
                Effect.catch((error) =>
                  cleanupCreatedDeploymentOnFailure(currentDeploymentId, error),
                ),
              );
            }

            let appEndpointDomain = app.appEndpointDomain;
            let previousDeploymentAction:
              | "stopped"
              | "destroyed"
              | "still-active"
              | null = previousDeploymentId ? "still-active" : null;
            let promoted = app.latestDeploymentId === deployment.id;
            if (promotionRequested) {
              // Replay promotion even when latestDeploymentId already matches.
              // Promotion also repairs endpoint/custom-domain routing drift.
              preserveCreatedAppOnFailure = true;
              const promotedApp = yield* promoteAppObserved(
                client,
                app.id,
                deployment.id,
                effectiveNews,
              );
              appEndpointDomain = promotedApp.appEndpointDomain;
              promoted = true;
            }

            const deploymentUrl = toDeploymentUrl(deployment.previewDomain);
            const appUrl =
              toDeploymentUrl(appEndpointDomain) ??
              toDeploymentUrl(deployment.previewDomain);
            let readinessStatus: "ready" | "pending" | "skipped" = "skipped";
            if (promoted && effectiveNews.verifyUrl !== false) {
              const readiness = yield* waitForDeploymentUrl(
                appUrl,
                effectiveNews,
              ).pipe(Effect.result);
              if (Result.isSuccess(readiness)) {
                readinessStatus = "ready";
              } else if (rollbackDeploymentId) {
                const rollback = yield* client
                  .rollbackApp(app.id, {
                    deploymentId: rollbackDeploymentId,
                  })
                  .pipe(Effect.result);
                const observedAfterRollback = yield* waitForAppDeploymentTarget(
                  client,
                  app.id,
                  rollbackDeploymentId,
                  effectiveNews,
                ).pipe(Effect.result);
                if (Result.isSuccess(observedAfterRollback)) {
                  return yield* cleanupCreatedDeploymentOnFailure(
                    deployment.id,
                    Result.isSuccess(rollback)
                      ? readiness.failure
                      : new AggregateError(
                          [readiness.failure, rollback.failure],
                          `Prisma App '${app.id}' endpoint was restored to deployment '${rollbackDeploymentId}', but the rollback response was lost.`,
                        ),
                  );
                }

                return yield* Effect.fail(
                  new AggregateError(
                    [
                      readiness.failure,
                      ...(Result.isFailure(rollback) ? [rollback.failure] : []),
                      observedAfterRollback.failure,
                    ],
                    `Prisma App '${app.id}' promoted deployment '${deployment.id}', but its stable endpoint failed readiness and rollback to deployment '${rollbackDeploymentId}' did not converge. Alchemy preserved the prior deployment in state and deleted neither deployment; the next reconcile will retry recovery via POST /v1/apps/${app.id}/rollback before making any new cloud changes.`,
                  ),
                );
              } else {
                // A first deployment has no safe rollback target. Never report
                // a successful stack deployment while the production endpoint
                // is unreachable. A newly created App can be fully cleaned up;
                // a pre-existing App is preserved for observed-state recovery.
                if (ensuredApp.created) {
                  preserveCreatedAppOnFailure = false;
                } else {
                  deploymentConverged = true;
                }
                if (terminalFailedDeploymentId !== undefined) {
                  return yield* Effect.fail(
                    new AggregateError(
                      [readiness.failure],
                      `Prisma App '${app.id}' promoted replacement deployment '${deployment.id}', but stable readiness failed and persisted deployment '${terminalFailedDeploymentId}' is terminal failed, so no safe rollback target exists. Neither deployment was deleted; a retry will refuse to create another generation while the live target differs from persisted state.`,
                    ),
                  );
                }
                return yield* Effect.fail(readiness.failure);
              }
            }

            deploymentConverged = true;
            let pendingDeploymentCleanup =
              promoted &&
              previousDeploymentId &&
              previousDeploymentId !== deployment.id
                ? {
                    deploymentId: previousDeploymentId,
                    action:
                      persistedPendingCleanup?.deploymentId ===
                      previousDeploymentId
                        ? persistedPendingCleanup.action
                        : previousDeploymentId === terminalFailedDeploymentId
                          ? ("destroy" as const)
                          : effectiveNews.destroyOldDeployment
                            ? ("destroy" as const)
                            : ("stop" as const),
                  }
                : undefined;
            if (promoted && pendingDeploymentCleanup) {
              const cleanup = yield* cleanupPreviousDeployment(
                pendingDeploymentCleanup.deploymentId,
                pendingDeploymentCleanup.action,
              ).pipe(Effect.result);
              if (Result.isSuccess(cleanup)) {
                previousDeploymentAction = cleanup.success;
                pendingDeploymentCleanup = undefined;
              } else {
                yield* Effect.logWarning(
                  `Prisma deployment '${pendingDeploymentCleanup.deploymentId}' cleanup is pending and will be retried before another Compute generation is created.`,
                );
              }
            }

            return {
              appId: app.id,
              deploymentId: deployment.id,
              projectId,
              appName: app.name,
              regionId: app.region.id,
              deploymentEndpointDomain: deployment.previewDomain ?? undefined,
              deploymentUrl,
              appEndpointDomain,
              url: promoted ? appUrl : deploymentUrl,
              promoted,
              previousDeploymentId,
              previousDeploymentAction,
              readinessStatus,
              pendingDeploymentCleanup,
              environmentKeys: managedEnvKeys(effectiveNews.env),
              environmentVariableIds: environmentResult.ownedIds,
              environmentClass: currentEnvironmentScope.class,
              environmentBranchId: currentEnvironmentScope.branchId,
              artifactHash: Redacted.make(deploymentHash),
              local: false,
            };
          }).pipe(
            Effect.catch((error) =>
              deploymentConverged
                ? Effect.fail(error)
                : rollbackCreatedEnvironmentVariables(
                    client,
                    createdEnvironmentVariableIds,
                    error,
                  ),
            ),
            Effect.catch(cleanupCreatedAppOnFailure),
            Effect.ensuring(cleanupArtifact),
          );
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          if (output.local || isPrismaDevId(output.appId)) {
            yield* stopTrackedDevProcess(output.appId);
            return;
          }
          yield* destroyComputeEnvironment(
            client,
            output.projectId,
            environmentScope(
              olds?.envClass ?? output.environmentClass ?? "production",
              output.environmentBranchId,
            ),
            output.environmentVariableIds,
          );
          yield* destroyApp(client, output.appId);
        }),
        tail: ({ output }) =>
          output.deploymentId
            ? tailDeploymentLogs(client, output.deploymentId)
            : Stream.empty,
      };
    }),
  );

export const ComputeDevProvider = () =>
  Provider.effect(
    Compute,
    Effect.gen(function* () {
      const ctx = yield* AlchemyContext;
      return {
        stables: ["appId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* () {
          return { action: "update" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          return output?.local ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          const bindingEnv = activeBindingEnv(bindings);
          const effectiveNews = {
            ...news,
            env: {
              ...bindingEnv,
              ...news.env,
            },
          };
          yield* validateComputeProps(effectiveNews);
          const projectId = yield* resolveProjectId(effectiveNews.project);
          if (!ctx.dev) {
            return yield* Effect.fail(
              new Error("ComputeDevProvider requires Alchemy dev mode."),
            );
          }
          const localUrl = yield* startDev(id, effectiveNews);
          return {
            appId: output?.appId ?? `dev:${id}`,
            deploymentId: undefined,
            projectId,
            appName: effectiveNews.appName ?? id,
            regionId: effectiveNews.regionId ?? "us-east-1",
            deploymentEndpointDomain: localUrl,
            deploymentUrl: localUrl,
            appEndpointDomain: localUrl,
            url: localUrl,
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            readinessStatus: "skipped",
            pendingDeploymentCleanup: undefined,
            environmentKeys: managedEnvKeys(effectiveNews.env),
            environmentVariableIds: {},
            environmentClass: effectiveNews.envClass ?? "production",
            environmentBranchId: null,
            artifactHash: undefined,
            local: true,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* stopTrackedDevProcess(output.appId);
        }),
      };
    }),
  );

export const ComputeProvider = () =>
  ProviderLayer.dual(Compute, {
    local: () => ComputeDevProvider(),
    live: () => ProviderLive(),
  });
