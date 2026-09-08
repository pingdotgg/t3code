/**
 * Internal helpers shared by the Kubernetes workload platforms
 * (`Kubernetes.Deployment`, `Kubernetes.Job`): image-source dispatch
 * through the cluster adapter, binding-env collection, connection
 * identity, and the platform-neutral generated container entries.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory } from "../../Command/Memo.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Self } from "../../Self.ts";
import { sha256Object } from "../../Util/sha256.ts";
import type {
  ClusterAdapterService,
  IdentityState,
  RegistryState,
  WorkloadBindingContract,
  WorkloadImageSource,
} from "../ClusterAdapter.ts";
import type { ClusterLike, Connection, ConnectionAuth } from "../Connection.ts";

/**
 * Structural deep merge: objects merge recursively; arrays and primitives
 * from `override` replace the base value wholesale. Powers escape hatches
 * like `Kubernetes.Deployment.podTemplate`.
 */
export const deepMerge = <T>(base: T, override: unknown): T => {
  if (override === undefined) return base;
  if (
    base === null ||
    override === null ||
    typeof base !== "object" ||
    typeof override !== "object" ||
    Array.isArray(base) ||
    Array.isArray(override)
  ) {
    return override as T;
  }
  const out: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      key in (base as Record<string, unknown>)
        ? deepMerge((base as Record<string, unknown>)[key], value)
        : value;
  }
  return out as T;
};

export const imagePlatformOf = (
  architecture: "amd64" | "arm64" | undefined,
): string => (architecture === "arm64" ? "linux/arm64" : "linux/amd64");

/**
 * Best-effort {@link Connection} of a `cluster` prop value — `undefined`
 * instead of throwing, for plan-time diffs where the referenced resource
 * may resolve to stables-only (or `{}`).
 */
export const tryConnectionOf = (
  cluster: ClusterLike | undefined,
): Connection | undefined => {
  if (cluster === undefined) return undefined;
  if ("auth" in cluster && cluster.auth !== undefined) return cluster;
  if ("connection" in cluster && cluster.connection !== undefined) {
    return cluster.connection;
  }
  return undefined;
};

const sortKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, sortKeysDeep(entry)]),
  );
};

/**
 * A stable identity string for a connection's *target cluster* — the auth
 * descriptor (which names the cluster for managed clouds and the
 * kubeconfig context otherwise). Changing it means the workload moves
 * clusters, which is a replacement. Deliberately excludes `endpoint` /
 * CA: managed clusters can rotate those in place.
 */
export const connectionIdentity = (
  connection: Connection | undefined,
): string | undefined =>
  connection === undefined
    ? undefined
    : JSON.stringify(sortKeysDeep(connection.auth));

/**
 * The persisted connection of a workload's attributes, tolerating legacy
 * pre-rename rows (`AWS.EKS.*` attributes carried a flat `clusterName`
 * instead of a `connection`) by synthesizing an `aws-eks` connection —
 * the only platform those legacy types could target.
 */
export const connectionOfOutput = (
  output: Record<string, unknown>,
): Connection | undefined => {
  const connection = output.connection as Connection | undefined;
  if (connection?.auth !== undefined) return connection;
  if (typeof output.clusterName === "string") {
    return {
      auth: {
        kind: "aws-eks",
        clusterName: output.clusterName,
      } as unknown as ConnectionAuth,
    };
  }
  return undefined;
};

/**
 * Collect environment variables from a host's active bindings and report
 * which cloud-grant channels (any binding-data key besides `env`, e.g.
 * AWS `policyStatements`) are in play — the caller fails when grants
 * exist but the cluster has no identity adapter to materialize them.
 */
export const collectBindingEnv = (
  bindings: ResourceBinding<WorkloadBindingContract>[],
): { env: Record<string, any>; grantKeys: string[] } => {
  const activeBindings = bindings.filter(
    (
      binding: ResourceBinding<WorkloadBindingContract> & {
        action?: string;
      },
    ) => binding.action !== "delete",
  );

  const env = activeBindings
    .map((binding) => binding?.data?.env)
    .reduce<Record<string, any>>((acc, value) => ({ ...acc, ...value }), {});

  const grantKeys = [
    ...new Set(
      activeBindings.flatMap((binding) =>
        Object.keys(binding?.data ?? {}).filter(
          (key) =>
            key !== "env" &&
            (binding.data as Record<string, unknown>)[key] !== undefined,
        ),
      ),
    ),
  ];

  return { env, grantKeys };
};

export type ImageSourceKind = "main" | "context" | "image";

/** Which image source a props bag declares (`main` always wins). */
export const imageSourceKind = (
  source: WorkloadImageSource,
): ImageSourceKind | undefined =>
  source.main !== undefined
    ? "main"
    : source.image !== undefined
      ? "image"
      : source.context !== undefined || source.dockerfile !== undefined
        ? "context"
        : undefined;

/**
 * Content hash for image sources whose identity is computable without a
 * bundler: `image` (the ref + platform) and `context` (the build-context
 * directory + Dockerfile content + platform). `main` returns `undefined`
 * — its hash comes from the bundle output inside the registry adapter.
 */
export const computeStaticWorkloadImageHash = Effect.fn(function* (
  source: WorkloadImageSource,
  platform: string,
) {
  const kind = imageSourceKind(source);
  if (kind === "image") {
    return (yield* sha256Object({ image: source.image!, platform })).slice(
      0,
      16,
    );
  }
  if (kind === "context") {
    if (
      source.dockerfile !== undefined &&
      isInlineDockerfile(source.dockerfile)
    ) {
      if (typeof source.dockerfile.content !== "string") return undefined;
      return (yield* sha256Object({
        dockerfile: source.dockerfile.content,
        platform,
      })).slice(0, 16);
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = path.resolve(source.context ?? ".");
    const dockerfile =
      typeof source.dockerfile === "string"
        ? path.resolve(source.dockerfile)
        : path.join(context, "Dockerfile");
    if (!(yield* fs.exists(context)) || !(yield* fs.exists(dockerfile))) {
      return undefined;
    }
    const contextHash = yield* hashDirectory({ cwd: context });
    const dockerfileContent = yield* fs.readFileString(dockerfile);
    return (yield* sha256Object({
      contextHash,
      dockerfile: dockerfileContent,
      platform,
    })).slice(0, 16);
  }
  return undefined;
});

export interface ResolveWorkloadImageOptions {
  adapter: ClusterAdapterService;
  id: string;
  source: WorkloadImageSource;
  platform: string;
  port?: number | undefined;
  isExternal?: boolean | undefined;
  bootstrap: (importPath: string) => string;
  tags: Record<string, string>;
  /** Persisted registry state hints (legacy-shape tolerant). */
  state: Record<string, unknown> | undefined;
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * Resolve the container image for a workload: through the cluster
 * adapter's managed registry when it has one (build/mirror + push), or —
 * on registry-less clusters — pass a pre-built `image` reference through
 * verbatim. `main`/`context` sources require a managed registry.
 */
export const resolveWorkloadImage = Effect.fn(function* (
  options: ResolveWorkloadImageOptions,
) {
  const { adapter, source } = options;
  if (adapter.registry !== undefined) {
    return yield* adapter.registry.resolve({
      id: options.id,
      source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap: options.bootstrap,
      tags: options.tags,
      state: options.state,
      session: options.session,
    });
  }

  const kind = imageSourceKind(source);
  if (kind === "image") {
    const codeHash = (yield* computeStaticWorkloadImageHash(
      source,
      options.platform,
    ))!;
    return {
      imageUri: source.image!,
      codeHash,
      state: undefined,
    };
  }

  return yield* Effect.die(
    new Error(
      `'${options.id}': this cluster has no managed image registry, so ` +
        "'main' and 'context' image sources cannot be built and pushed. " +
        "Use a pre-built 'image' reference the cluster can pull, or target " +
        "a cluster whose platform provides a registry (e.g. AWS.EKS → ECR).",
    ),
  );
});

/** Plan-time content hash for `diff` — adapter-aware. */
export const workloadImageHash = Effect.fn(function* (options: {
  adapter: ClusterAdapterService;
  source: WorkloadImageSource;
  platform: string;
  port?: number | undefined;
  isExternal?: boolean | undefined;
  bootstrap: (importPath: string) => string;
}) {
  if (options.adapter.registry !== undefined) {
    return yield* options.adapter.registry.hash({
      source: options.source,
      platform: options.platform,
      port: options.port,
      isExternal: options.isExternal,
      bootstrap: options.bootstrap,
    });
  }
  return yield* computeStaticWorkloadImageHash(
    options.source,
    options.platform,
  );
});

/** The identity-adapter state persisted on workload attributes. */
export type PersistedIdentityState = IdentityState | undefined;

/**
 * Platform-neutral generated container entry for an Effect-native server
 * workload: resolves the program's registered runners and serves the
 * returned `{ fetch }` handler on `PORT`. Cloud adapters override this
 * through {@link ClusterAdapterService.bootstrap} to wire their runtime
 * credential chains (e.g. EKS Pod Identity).
 */
export const makeServerBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import { provideProcessTelemetry } from "alchemy/Telemetry";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export: an inline-effect class default export is
// an Effect resolving the platform instance, while the tagged form
// (X.make(props, impl)) exports a Layer providing the Self tag. Both fold
// into a Layer via makeEntrypointLayer (same pattern as the ECS/Lambda/
// Cloudflare Container bridges).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is served and host.run loops stay alive.
const program = tag.pipe(
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes on graceful
  // shutdown.
  Effect.flatMap((host) =>
    host.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(host.RuntimeContext),
    ),
  ),
  Effect.provide(
    layer.pipe(Layer.provideMerge(Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    )),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log(\`Kubernetes Deployment bootstrap starting on port \${process.env.PORT ?? 3000}...\`);
await Effect.runPromise(program).catch((err) => {
  console.error("Kubernetes Deployment bootstrap failed:", err);
  process.exit(1);
});
`;

/**
 * Platform-neutral generated container entry for an Effect-native one-shot
 * Job: resolves the program's `run` effect, executes it to completion, and
 * exits.
 */
export const makeJobBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import { provideProcessTelemetry } from "alchemy/Telemetry";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export (see the server bootstrap).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program's registered one-shot runners (the shape's
// \`run\` effect and any host.run work) and execute them to completion.
const program = tag.pipe(
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes as the
  // one-shot program completes.
  Effect.flatMap((host) =>
    host.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(host.RuntimeContext),
    ),
  ),
  Effect.provide(
    layer.pipe(Layer.provideMerge(Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE")
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {}
        }))
      )
    )),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Kubernetes Job bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Kubernetes Job bootstrap failed:", err);
  process.exit(1);
});
// Run-to-completion semantics: exit 0 explicitly so lingering handles
// (sockets, timers) never keep the pod alive after the work is done.
process.exit(0);
`;
