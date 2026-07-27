import * as ecr from "@distilled.cloud/aws/ecr";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import { Docker } from "../../Docker/Docker.ts";
import { Self } from "../../Self.ts";
import {
  isInlineDockerfile,
  type InlineDockerfile,
} from "../../Docker/Dockerfile.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { buildAndPushEcrImage, getEcrRegistryCredentials } from "./Image.ts";

/**
 * INTERNAL — shared container image-source machinery for AWS container
 * platforms (`AWS.ECS.Task`, `AWS.ECS.Service`, `AWS.EKS.*`).
 *
 * NOT exported from the AWS barrel or `ECR/index.ts`. Consumers import the
 * module path directly.
 *
 * A platform's props separate the ENVIRONMENT (what the container is) from
 * the PROGRAM (`main` — "and run my bundled Effect program in it"):
 *
 * - environment (at most one): `image` (registry ref) | `context` +
 *   `dockerfile`-as-path (docker build) | inline `dockerfile` content
 *   (`Dockerfile.inline`) | the default bun base when `main` stands alone.
 * - `main` present → the bundle is injected into the environment (COPY +
 *   ENTRYPOINT) and pushed as a derived image. `main` absent → the
 *   environment runs verbatim: `image` is mirrored into ECR
 *   (docker pull → tag → push, content-addressed on the ref), a Dockerfile
 *   builds as-is.
 *
 * `dockerfile` is a string PATH (relative to the cwd, defaulting to
 * `${context}/Dockerfile`) or an `InlineDockerfile`
 * (`{ content: Input<string> }`, usually via `Dockerfile.inline`). Inline
 * content may interpolate Outputs (e.g. `FROM ${base.imageUri}`), creating
 * a real dependency edge; never interpolate secrets — content is baked
 * into image layers.
 *
 * Every source lands in an auto-created (caller-named) private ECR
 * repository so the compute platform pulls from a registry that is reliable
 * from private VPCs and IAM-authenticated.
 */

/**
 * Bundle an Effect program into a generated image. Alchemy bundles `main`
 * with rolldown and bakes it into a Dockerfile generated from the
 * environment (`image`, `dockerfile`, or the default bun base).
 */
export interface BundledImageSource {
  /**
   * Module entrypoint for the bundled program. This should typically be
   * `import.meta.url` from an inline Effect program.
   */
  main: string;
  /**
   * Environment image: used as the generated Dockerfile's `FROM`. Any
   * registry ref works (private non-ECR registries require docker
   * credentials on the build machine); the image must be able to run the
   * bun runtime. Exclusive with {@link dockerfile} / {@link context}.
   * @default "oven/bun:1"
   */
  image?: string;
  /**
   * Environment Dockerfile: a string is a PATH (built in {@link context},
   * then the bundle is layered on top in a second stage); an
   * {@link InlineDockerfile} is inline content used as the environment
   * preamble (built with no context — its own `COPY`s are unsupported).
   * The resulting environment must be able to run the bun runtime.
   * Exclusive with {@link image}.
   */
  dockerfile?: string | InlineDockerfile;
  /**
   * Build context for a path {@link dockerfile} environment. Exclusive
   * with {@link image} and inline dockerfiles.
   */
  context?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Bundler configuration for the entrypoint.
   */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
}

/**
 * Build the image from the user's own Dockerfile and build context — no
 * Effect program is bundled.
 */
export interface DockerfileImageSource {
  /**
   * Docker build context directory. Optional when {@link dockerfile} is
   * inline content (which builds with an empty context).
   */
  context?: string;
  /**
   * Path to the Dockerfile relative to the cwd (NOT the context), or
   * {@link InlineDockerfile} content. The Dockerfile must define its own
   * `CMD`/`ENTRYPOINT` (no program is injected).
   * @default `${context}/Dockerfile`
   */
  dockerfile?: string | InlineDockerfile;
}

/**
 * Mirror a pre-built registry image into ECR (docker pull → tag → push).
 */
export interface RegistryImageSource {
  /**
   * A pre-built image reference, e.g.
   * `public.ecr.aws/docker/library/busybox:stable`.
   */
  image: string;
}

/**
 * The image-source union. Discriminated by presence: exactly one of
 * `main`, `context`, or `image`.
 */
export type ImageSourceProps =
  | BundledImageSource
  | DockerfileImageSource
  | RegistryImageSource;

/** Loose bag shape used to sniff which source variant a props object is. */
export interface ImageSourceLike {
  main?: string;
  handler?: string;
  build?: BundledImageSource["build"];
  context?: string;
  dockerfile?: string | InlineDockerfile;
  image?: string;
}

export type ImageSourceKind = "main" | "context" | "image";

/**
 * Which image source a props bag declares. `main` always wins (the other
 * fields then describe its ENVIRONMENT); without `main`, `image` is the
 * mirrored-verbatim source and any `context`/`dockerfile` (path or inline)
 * is an external docker build.
 */
export const imageSourceKind = (
  source: ImageSourceLike,
): ImageSourceKind | undefined =>
  source.main !== undefined
    ? "main"
    : source.image !== undefined
      ? "image"
      : source.context !== undefined || source.dockerfile !== undefined
        ? "context"
        : undefined;

/**
 * Validate environment-source exclusivity. Dies (plan-time defect) on
 * `image`+`dockerfile`, `image`+`context`, or inline-`dockerfile`+`context`.
 */
export const validateImageSource = (
  id: string,
  source: ImageSourceLike,
): Effect.Effect<void> => {
  if (source.image !== undefined && source.dockerfile !== undefined) {
    return Effect.die(
      new Error(
        `'${id}': 'image' and 'dockerfile' are both set — declare exactly one environment source (an 'image' ref, or a Dockerfile)`,
      ),
    );
  }
  if (source.image !== undefined && source.context !== undefined) {
    return Effect.die(
      new Error(
        `'${id}': 'image' and 'context' are both set — declare exactly one environment source`,
      ),
    );
  }
  if (
    source.dockerfile !== undefined &&
    isInlineDockerfile(source.dockerfile) &&
    source.context !== undefined
  ) {
    return Effect.die(
      new Error(
        `'${id}': inline 'dockerfile' content builds with no context — use a path dockerfile with 'context', or drop 'context'`,
      ),
    );
  }
  return Effect.void;
};

/** The resolved (built/mirrored + pushed) image. */
export interface ResolvedImage {
  /** Full image reference, `<repositoryUri>:<codeHash>`. */
  imageUri: string;
  /** Name of the ECR repository the image was pushed to. */
  repositoryName: string;
  /** URI of the ECR repository the image was pushed to. */
  repositoryUri: string;
  /** Content hash identifying the image (also the image tag). */
  codeHash: string;
}

export interface ResolveImageOptions {
  /** Logical resource id — keys the stable build-context directory. */
  id: string;
  /**
   * The props bag carrying the image source fields (`main` / `context` /
   * `image` plus their modifiers).
   */
  source: ImageSourceLike;
  /** Name of the ECR repository to (auto-create and) push into. */
  repositoryName: string;
  /**
   * Known repository URI (from prior Attributes). When provided, repository
   * creation is skipped.
   */
  repositoryUri?: string;
  /** Tags applied to the auto-created repository. */
  tags?: Record<string, string>;
  /**
   * Target image platform.
   * @default "linux/amd64"
   */
  platform?: string;
  /**
   * Port the generated Dockerfile should `ENV PORT=` + `EXPOSE`
   * (`main` source only).
   */
  port?: number;
  /**
   * True when the resource was declared without an inline Effect impl —
   * `main` is then bundled as-is without the virtual-entry bootstrap.
   */
  isExternal?: boolean;
  /**
   * The virtual-entry bootstrap wrapped around `main` for Effect-native
   * programs: receives the resolved entry import path and returns the
   * generated entry module source. Platform-specific (server vs one-shot
   * differ per platform), so the caller supplies it.
   */
  bootstrap: (importPath: string) => string;
  /** Plan-status session used to emit build/push progress notes. */
  session: { note: (message: string) => Effect.Effect<void> };
}

/**
 * The standard bun bootstrap used by `AWS.ECS.Task` / `AWS.ECS.Service`
 * generated entries: resolves the bundled program's registered runners
 * (`host.run` loops and served `fetch`/`run` handlers) and runs them with a
 * Bun HTTP server bound to `PORT`.
 */
export const makeBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Region from "@distilled.cloud/aws/Region";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export: an inline-effect class default export is
// an Effect resolving the platform instance, while the tagged form
// (X.make(props, impl)) exports a Layer providing the Self tag. Both fold
// into a Layer via makeEntrypointLayer (same pattern as the Lambda and
// Cloudflare Container bridges).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.effect(
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
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is actually served and host.run loops stay alive. A pure one-shot
// { run } program completes and the process exits 0.
const program = tag.pipe(
  Effect.flatMap((task) => task.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      // Full provider chain, not fromEnv: Fargate tasks receive credentials
      // from the container-credentials endpoint
      // (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI), not environment variables.
      Layer.provideMerge(Credentials.fromChain()),
      Layer.provideMerge(Region.fromEnv()),
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

console.log("Task bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Task bootstrap failed:", err);
  process.exit(1);
});
`;

/**
 * Resolve the Dockerfile path for a `context` source: always relative to the
 * cwd (absolute paths pass through), defaulting to `${context}/Dockerfile`.
 */
const resolveContextPaths = Effect.fn(function* (source: {
  context: string | undefined;
  dockerfile?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = path.resolve(source.context ?? ".");
  const dockerfile = source.dockerfile
    ? path.resolve(source.dockerfile)
    : path.join(context, "Dockerfile");
  if (!(yield* fs.exists(context))) {
    return yield* Effect.die(
      new Error(`Docker build context does not exist: ${context}`),
    );
  }
  if (!(yield* fs.exists(dockerfile))) {
    return yield* Effect.die(
      new Error(`Dockerfile does not exist: ${dockerfile}`),
    );
  }
  return { context, dockerfile };
});

/**
 * Content hash for the sources whose identity is computable WITHOUT running
 * a bundler:
 *
 * - `context` — hash of the build-context directory + Dockerfile content +
 *   platform.
 * - `image` — hash of the image reference + platform (re-mirror only when
 *   the ref changes).
 * - `main` — `undefined`: the hash comes from the bundle output, so it is
 *   only known inside `resolve`.
 *
 * Providers use this in `diff` to surface content drift (files changed under
 * an unchanged `context` path) as an update.
 */
export const computeStaticSourceHash = Effect.fn(function* (
  source: ImageSourceLike,
  platform?: string,
) {
  const kind = imageSourceKind(source);
  if (kind === "image") {
    return (yield* sha256Object({
      image: source.image!,
      platform: platform ?? "linux/amd64",
    })).slice(0, 16);
  }
  if (kind === "context") {
    if (
      source.dockerfile !== undefined &&
      isInlineDockerfile(source.dockerfile)
    ) {
      // Inline content builds with no context; an unresolved (Output)
      // content can't be hashed at plan time — defer to reconcile.
      if (typeof source.dockerfile.content !== "string") return undefined;
      return (yield* sha256Object({
        dockerfile: source.dockerfile.content,
        platform: platform ?? "linux/amd64",
      })).slice(0, 16);
    }
    const fs = yield* FileSystem.FileSystem;
    const { context, dockerfile } = yield* resolveContextPaths({
      context: source.context!,
      dockerfile: source.dockerfile,
    });
    const contextHash = yield* hashDirectory({ cwd: context });
    const dockerfileContent = yield* fs.readFileString(dockerfile);
    return (yield* sha256Object({
      contextHash,
      dockerfile: dockerfileContent,
      platform: platform ?? "linux/amd64",
    })).slice(0, 16);
  }
  return undefined;
});

/**
 * Init-time constructor for the image-source resolver. Resolves the services
 * that are only available at provider-layer construction (Docker, the
 * `.alchemy` directory, the rolldown virtual-entry plugin) and returns
 * `resolve`, the per-reconcile entrypoint.
 */
export const makeImageSource = Effect.gen(function* () {
  const docker = yield* Docker;
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  /** Bundle the Effect program behind a `main` source. */
  const bundleProgram = Effect.fn(function* (options: {
    source: BundledImageSource;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
  }) {
    const { source } = options;
    const realMain = yield* resolveMainPath(source.main);
    const cwd = yield* findCwdForBundle(realMain);

    const buildBundle = Effect.fn(function* (
      entry: string,
      plugins?: rolldown.RolldownPluginOption,
    ) {
      return yield* Bundle.build(
        {
          ...source.build?.input,
          input: entry,
          cwd,
          platform: "node",
          // The container runs on `bun`; keep `bun`/`bun:*` external (the
          // runtime provides them) and resolve the `bun` export condition
          // so `@effect/platform-bun` picks its Bun implementations.
          external: [
            "bun",
            "bun:*",
            ...((source.build?.input?.external as string[] | undefined) ?? []),
          ],
          resolve: {
            conditionNames: ["bun", "import", "module", "default"],
            ...source.build?.input?.resolve,
          },
          plugins: [source.build?.input?.plugins, plugins],
        },
        {
          ...source.build?.output,
          format: "esm",
          sourcemap: source.build?.output?.sourcemap ?? false,
          minify: source.build?.output?.minify ?? false,
          entryFileNames: "index.mjs",
        },
      );
    });

    const bundleOutput = options.isExternal
      ? yield* buildBundle(realMain)
      : yield* buildBundle(realMain, virtualEntryPlugin(options.bootstrap));

    // Return every emitted file (entry + shared chunks). Dynamic imports in
    // the Bun HTTP server / AWS SDK split into chunks; dropping any of them
    // crashes the container with `Cannot find module './chunk-XXX.js'`.
    const files = bundleOutput.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content,
    }));

    return { files, hash: bundleOutput.hash };
  });

  /**
   * Bundle a `main` source and compute its content-addressed code hash.
   *
   * The hash covers the FULL image identity: the bundle output (which
   * includes the generated bootstrap entry, so bootstrap-template changes
   * invalidate it), the generated Dockerfile, and the target platform.
   * `resolve` and `hash` share this so the plan-time diff hash and the
   * pushed image tag always agree.
   */
  const computeMainCodeHash = Effect.fn(function* (options: {
    source: BundledImageSource;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
    port?: number;
    platform: string;
  }) {
    const bundled = yield* bundleProgram({
      source: options.source,
      isExternal: options.isExternal,
      bootstrap: options.bootstrap,
    });
    // A path-`dockerfile` environment is built as a separate local stage in
    // `resolve`; hash its identity (context files + Dockerfile content)
    // explicitly since the generated Dockerfile only references the local
    // env tag. Inline environments flow through the generated Dockerfile
    // text itself; `image` environments through its FROM line.
    const df = options.source.dockerfile;
    const isPathEnv = df !== undefined && !isInlineDockerfile(df);
    let envIdentity: Record<string, string> = {};
    if (isPathEnv) {
      const fs = yield* FileSystem.FileSystem;
      const { context, dockerfile } = yield* resolveContextPaths({
        context: options.source.context!,
        dockerfile: df,
      });
      envIdentity = {
        envContextHash: yield* hashDirectory({ cwd: context }),
        envDockerfile: yield* fs.readFileString(dockerfile),
      };
    }
    const dockerfile = generateDockerfile(
      options.source,
      options.port,
      isPathEnv ? "<env>" : undefined,
    );
    const codeHash = (yield* sha256Object({
      bundleHash: bundled.hash,
      dockerfile,
      platform: options.platform,
      ...envIdentity,
    })).slice(0, 16);
    return { bundled, dockerfile, codeHash };
  });

  /**
   * Generated Dockerfile for a bundled `main` program. The environment
   * preamble is, in order of precedence: `envFrom` (a locally-built
   * environment tag from a path-`dockerfile` two-stage build), inline
   * `dockerfile` content (already resolved), the `image` ref, or the
   * default bun base (`oven/bun` is Docker-Hub only — there is no
   * `docker/library/bun` and no `public.ecr.aws/oven/bun`).
   */
  const generateDockerfile = (
    source: BundledImageSource,
    port?: number,
    envFrom?: string,
  ) => {
    const preamble =
      envFrom !== undefined
        ? `FROM ${envFrom}`
        : source.dockerfile !== undefined &&
            isInlineDockerfile(source.dockerfile)
          ? String(source.dockerfile.content).trimEnd()
          : `FROM ${source.image ?? "oven/bun:1"}`;
    const lines = [
      preamble,
      `WORKDIR /app`,
      `COPY index.mjs /app/index.mjs`,
      // Copy any additional rolldown chunks (`chunk-XXX.js`,
      // `BunServices-YYY.js`, …). Non-trivial bundles always emit at
      // least one; minimal bundles emit none and the COPY no-ops.
      `COPY *.js /app/`,
    ];
    if (port !== undefined) {
      lines.push(`ENV PORT=${String(port)}`, `EXPOSE ${String(port)}`);
    }
    lines.push(`ENTRYPOINT ["bun", "/app/index.mjs"]`);
    return `${lines.join("\n")}\n`;
  };

  /**
   * Ensure the target ECR repository exists. Idempotent: tolerates
   * `RepositoryAlreadyExistsException` as a race / re-run and re-describes.
   */
  const ensureRepository = Effect.fn(function* (options: {
    repositoryName: string;
    tags?: Record<string, string>;
  }) {
    const created = yield* ecr
      .createRepository({
        repositoryName: options.repositoryName,
        imageTagMutability: "MUTABLE",
        imageScanningConfiguration: {
          scanOnPush: true,
        },
        tags: Object.entries(options.tags ?? {}).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      })
      .pipe(
        Effect.catchTag("RepositoryAlreadyExistsException", () =>
          Effect.gen(function* () {
            const existing = yield* ecr.describeRepositories({
              repositoryNames: [options.repositoryName],
            });
            return {
              repository: existing.repositories?.[0],
            };
          }),
        ),
      );
    const repository = created.repository;
    if (!repository?.repositoryUri) {
      return yield* Effect.die(
        new Error(
          `Failed to resolve ECR repository '${options.repositoryName}'`,
        ),
      );
    }
    return repository.repositoryUri;
  });

  /** Observe a pushed tag in ECR. Missing repository or tag → undefined. */
  const describeImage = Effect.fn(function* (
    repositoryName: string,
    imageTag: string,
  ) {
    const described = yield* ecr
      .describeImages({
        repositoryName,
        imageIds: [{ imageTag }],
      })
      .pipe(
        Effect.catchTag(
          ["ImageNotFoundException", "RepositoryNotFoundException"],
          () => Effect.succeed(undefined),
        ),
      );
    return described?.imageDetails?.[0];
  });

  /**
   * Resolve the image for a props bag: ensure the repository, compute the
   * content-addressed tag, then build/mirror + push only when that exact
   * tag is not already in ECR (crash-safe convergence).
   */
  const resolve = Effect.fn(function* (options: ResolveImageOptions) {
    const { id, source, repositoryName, session } = options;
    const platform = options.platform ?? "linux/amd64";
    const kind = imageSourceKind(source);
    if (kind === undefined) {
      return yield* Effect.die(
        new Error(
          `'${id}' must declare exactly one image source: 'main' (bundled Effect program), 'context' (Dockerfile build), or 'image' (registry reference)`,
        ),
      );
    }

    yield* validateImageSource(id, source);

    const repositoryUri =
      options.repositoryUri ??
      (yield* ensureRepository({ repositoryName, tags: options.tags }));

    if (kind === "main") {
      // Bundle → hash → (skip if pushed) → materialize generated Dockerfile
      // → build + push.
      const df = source.dockerfile;
      if (
        df !== undefined &&
        isInlineDockerfile(df) &&
        typeof df.content !== "string"
      ) {
        return yield* Effect.die(
          new Error(
            `'${id}': inline dockerfile content did not resolve to a string — Outputs in Dockerfile.inline must be resolvable at deploy time`,
          ),
        );
      }
      yield* session.note(`Bundling ${id} program...`);
      const { bundled, dockerfile, codeHash } = yield* computeMainCodeHash({
        source: source as BundledImageSource,
        isExternal: options.isExternal,
        bootstrap: options.bootstrap,
        port: options.port,
        platform,
      });
      const imageUri = `${repositoryUri}:${codeHash}`;

      if (yield* describeImage(repositoryName, codeHash)) {
        return { imageUri, repositoryName, repositoryUri, codeHash };
      }

      // A path-`dockerfile` environment builds first as a local stage in the
      // USER's context (so its COPYs resolve), then the generated Dockerfile
      // FROMs the local tag and layers the bundle on top.
      let envFrom: string | undefined;
      if (df !== undefined && !isInlineDockerfile(df)) {
        const env = yield* resolveContextPaths({
          context: source.context!,
          dockerfile: df,
        });
        envFrom = `alchemy-env-${id.toLowerCase()}:${codeHash}`;
        yield* session.note(`Building environment image for ${id}...`);
        yield* docker.image.build({
          context: env.context,
          file: env.dockerfile,
          tag: envFrom,
          platform,
        });
      }
      const finalDockerfile =
        envFrom === undefined
          ? dockerfile
          : generateDockerfile(
              source as BundledImageSource,
              options.port,
              envFrom,
            );

      const realMain = yield* resolveMainPath(
        (source as BundledImageSource).main,
      );
      const contextDir = yield* getStableContextDir(
        realMain,
        dotAlchemy,
        `${id}-image`,
      );
      yield* docker.materialize({
        context: contextDir,
        dockerfile: finalDockerfile,
        // Entry chunk becomes `index.mjs`; all other chunks keep their
        // emitted `*.js` names so the entry's relative imports resolve.
        files: bundled.files.map((file, index) => ({
          path: index === 0 ? "index.mjs" : file.path,
          content: file.content,
        })),
      });
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPushEcrImage(docker, {
        imageUri,
        context: contextDir,
        platform,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

    if (kind === "image") {
      // Mirror: pull → tag → push. Content-addressed on the image ref, so
      // an already-mirrored ref is a no-op.
      const ref = (source as RegistryImageSource).image;
      const codeHash = (yield* computeStaticSourceHash(source, platform))!;
      const imageUri = `${repositoryUri}:${codeHash}`;

      if (yield* describeImage(repositoryName, codeHash)) {
        return { imageUri, repositoryName, repositoryUri, codeHash };
      }

      yield* session.note(`Pulling container image ${ref}...`);
      // A registry pull can wedge indefinitely under Docker Hub throttling /
      // credential-helper contention — bound it so a stuck pull fails the
      // deploy loudly instead of hanging the plan.
      yield* docker.image.pull(ref, platform).pipe(Effect.timeout("4 minutes"));
      yield* docker.image.tag(ref, imageUri);
      yield* session.note(`Pushing mirrored image ${imageUri}...`);
      const credentials = yield* getEcrRegistryCredentials;
      // Pin the platform on push: with the containerd image store a bare
      // push of a multi-arch tag sends every locally-present variant — a
      // stale other-arch variant in the local cache would reach ECR and the
      // task would crash with `exec format error`.
      yield* docker.image.push(imageUri, credentials, platform);
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

    // kind === "context": docker build the user's Dockerfile — from a path
    // (in their context) or from inline content (empty stable context).
    const externalDf = (source as DockerfileImageSource).dockerfile;
    if (externalDf !== undefined && isInlineDockerfile(externalDf)) {
      if (typeof externalDf.content !== "string") {
        return yield* Effect.die(
          new Error(
            `'${id}': inline dockerfile content did not resolve to a string — Outputs in Dockerfile.inline must be resolvable at deploy time`,
          ),
        );
      }
      const codeHash = (yield* computeStaticSourceHash(source, platform))!;
      const imageUri = `${repositoryUri}:${codeHash}`;
      if (yield* describeImage(repositoryName, codeHash)) {
        return { imageUri, repositoryName, repositoryUri, codeHash };
      }
      const contextDir = yield* getStableContextDir(
        dotAlchemy,
        dotAlchemy,
        `${id}-image`,
      );
      yield* docker.materialize({
        context: contextDir,
        dockerfile: externalDf.content,
        files: [],
      });
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPushEcrImage(docker, {
        imageUri,
        context: contextDir,
        platform,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

    const { context, dockerfile } = yield* resolveContextPaths({
      context: (source as DockerfileImageSource).context!,
      dockerfile: externalDf,
    });
    const codeHash = (yield* computeStaticSourceHash(source, platform))!;
    const imageUri = `${repositoryUri}:${codeHash}`;

    if (yield* describeImage(repositoryName, codeHash)) {
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

    yield* session.note(`Building container image ${imageUri}...`);
    yield* buildAndPushEcrImage(docker, {
      imageUri,
      context,
      dockerfile,
      platform,
    });
    yield* session.note(`Pushed ${imageUri}`);
    return { imageUri, repositoryName, repositoryUri, codeHash };
  });

  /**
   * Content hash for ANY source kind without building or pushing an image.
   *
   * For `main` sources this runs the bundler (bootstrap entry included) so
   * the hash reflects the exact image `resolve` would push — bootstrap
   * template changes and user-code edits both surface as drift. Providers
   * call this from `diff` and compare against `output.code.hash`; static
   * sources (`context` / `image`) delegate to
   * {@link computeStaticSourceHash}.
   */
  const hash = Effect.fn(function* (options: {
    source: ImageSourceLike;
    platform?: string;
    port?: number;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
  }) {
    const platform = options.platform ?? "linux/amd64";
    if (imageSourceKind(options.source) === "main") {
      // Unresolved inline environment content (an Output) can't be hashed
      // at plan time — return undefined so the diff defers to reconcile.
      const df = options.source.dockerfile;
      if (
        df !== undefined &&
        isInlineDockerfile(df) &&
        typeof df.content !== "string"
      ) {
        return undefined;
      }
      const { codeHash } = yield* computeMainCodeHash({
        source: options.source as BundledImageSource,
        isExternal: options.isExternal,
        bootstrap: options.bootstrap,
        port: options.port,
        platform,
      });
      return codeHash;
    }
    return yield* computeStaticSourceHash(options.source, platform);
  });

  return { resolve, hash };
});

/** The resolver service returned by {@link makeImageSource}. */
export interface ImageSource extends Effect.Success<typeof makeImageSource> {}
