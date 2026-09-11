import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { AlchemyProfile, ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { PlatformServices } from "../Util/PlatformServices.ts";
import { proxyChain } from "../Util/proxy-chain.ts";
import { PrismaAuth } from "./AuthProvider.ts";
import { App, AppProvider } from "./App.ts";
import { Branch, BranchProvider } from "./Branch.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { BucketAccessKey, BucketAccessKeyProvider } from "./BucketAccessKey.ts";
import {
  PrismaClient,
  PrismaClientLive,
  type PrismaManagementClient,
} from "./Client.ts";
import { Connection, ConnectionProvider } from "./Connection.ts";
import { Compute, ComputeProvider } from "./Compute.ts";
import { CustomDomain, CustomDomainProvider } from "./CustomDomain.ts";
import { Database, DatabaseProvider } from "./Database.ts";
import { Deployment, DeploymentProvider } from "./Deployment.ts";
import {
  EnvironmentVariable,
  EnvironmentVariableProvider,
} from "./EnvironmentVariable.ts";
import {
  PrismaHttpClientLive,
  PrismaUploadClientLive,
} from "./Internal/HttpClient.ts";
import { fromProfile } from "./PrismaEnvironment.ts";
import { Project, ProjectProvider } from "./Project.ts";
import {
  SourceRepository,
  SourceRepositoryProvider,
} from "./SourceRepository.ts";

export { PrismaEnvironment } from "./PrismaEnvironment.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Prisma",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Standalone operation helpers own a private auth registry because they run
 * outside a Stack. Credential resolution stays eager here so constructing
 * `managementApi()` preserves its existing fail-fast behavior.
 */
const standaloneManagementApiLayer = () =>
  PrismaClientLive.pipe(
    Layer.provideMerge(fromProfile()),
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        // The Prisma-scoped upload client (node transport) rides the
        // providers' output so artifact uploads can reach it at op time.
        PrismaUploadClientLive,
        Layer.provide(ProfileLive, PlatformServices),
        Layer.provide(CredentialsStoreLive, PlatformServices),
      ),
    ),
    // Provide (NOT provideMerge) the node transport privately: it must serve
    // only the Prisma management client. Exposing it from `providers()` would
    // override the ambient HttpClient for every other provider in the stack —
    // Cloudflare Worker script uploads then go out via node:http, which
    // streams multipart bodies as `Transfer-Encoding: chunked`, and
    // api.cloudflare.com never answers chunked uploads.
    Layer.provide(PrismaHttpClientLive),
  );

/**
 * Stack provider discovery must register auth without requiring credentials.
 * The management client is resolved on its first API operation, after
 * `alchemy login` has had a chance to configure the registered Prisma auth
 * provider. The nested client layer shares the provider layer's lifetime.
 */
const stackManagementApiLayer = () =>
  Layer.effect(
    PrismaClient,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const authProviders = yield* AuthProviders;
      const profile = yield* AlchemyProfile;
      const client = Layer.buildWithScope(
        PrismaClientLive.pipe(
          Layer.provideMerge(
            fromProfile().pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(AuthProviders, authProviders),
                  Layer.succeed(AlchemyProfile, profile),
                ),
              ),
            ),
          ),
          Layer.provide(PrismaHttpClientLive),
        ),
        scope,
      ).pipe(Effect.map((context) => Context.get(context, PrismaClient)));
      const cached = yield* Effect.cached(client);
      return proxyChain(cached) as PrismaManagementClient;
    }),
  ).pipe(
    Layer.provideMerge(PrismaAuth),
    Layer.provideMerge(
      Layer.mergeAll(
        // The Prisma-scoped upload client (node transport) rides the
        // providers' output so artifact uploads can reach it at op time.
        PrismaUploadClientLive,
        Layer.provide(ProfileLive, PlatformServices),
        Layer.provide(CredentialsStoreLive, PlatformServices),
      ),
    ),
  );

/**
 * Build a layer for Prisma Management API operation helpers.
 *
 * Use this when calling helpers like `Prisma.listProjects()` outside an
 * Alchemy stack or test. Inside a stack (or a `test.provider` body) deployed
 * with `Prisma.providers()`, the management client is already in context, so
 * operation helpers work without providing this layer.
 *
 * @example
 * ```typescript
 * const projects = yield* Prisma.listProjects().pipe(
 *   Effect.provide(Prisma.managementApi()),
 * );
 * ```
 */
export const managementApi = () =>
  standaloneManagementApiLayer().pipe(Layer.orDie);

/**
 * Build a layer that registers all Prisma resource providers, the Prisma
 * auth provider, resolved credentials, and an HTTP client.
 *
 * Every resource is registered with {@link ../Local/ProviderLayer.ts
 * ProviderLayer.dual}: a **live** implementation backed by the Prisma
 * Management API and a **local** implementation used by `alchemy dev`
 * (fabricated `dev:` identifiers; `Prisma.Database` boots a local
 * `@prisma/dev` server). The engine picks the variant per run and per
 * resource:
 *
 * - `alchemy deploy` resolves the live variant; `alchemy dev` resolves the
 *   local variant automatically.
 * - Wrap a resource in `Alchemy.remote(...)` to keep it live even during
 *   `alchemy dev`.
 * - To replace implementations wholesale, construct your own layer instead
 *   of this one: register the {@link Providers} collection and provide your
 *   own per-resource provider layers (compose the exported per-resource
 *   factories like {@link ProjectProvider} with your replacements, and
 *   {@link managementApi} when live operations are needed).
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Prisma from "alchemy/Prisma";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   { providers: Prisma.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const project = yield* Prisma.Project("app", {
 *       name: "app",
 *       region: "us-east-1",
 *     });
 *     return { projectId: project.projectId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Project,
      Database,
      Connection,
      Branch,
      Bucket,
      BucketAccessKey,
      Compute,
      App,
      Deployment,
      CustomDomain,
      EnvironmentVariable,
      SourceRepository,
    ]),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ProjectProvider(),
        DatabaseProvider(),
        ConnectionProvider(),
        BranchProvider(),
        BucketProvider(),
        BucketAccessKeyProvider(),
        ComputeProvider(),
        AppProvider(),
        DeploymentProvider(),
        CustomDomainProvider(),
        EnvironmentVariableProvider(),
        SourceRepositoryProvider(),
      ),
    ),
    // The management client layer is shared by every live variant. It is
    // built in both modes but stays inert until the first API operation:
    // auth registers without resolving credentials, so `alchemy dev` never
    // needs a Prisma token.
    Layer.provideMerge(stackManagementApiLayer()),
    Layer.orDie,
  );
