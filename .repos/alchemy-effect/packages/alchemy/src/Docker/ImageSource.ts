import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../Bundle/TempRoot.ts";
import { hashDirectory } from "../Command/Memo.ts";
import { sha256Object } from "../Util/sha256.ts";
import { Docker, type RegistryCredentials } from "./Docker.ts";
import { isInlineDockerfile, type InlineDockerfile } from "./Dockerfile.ts";

/**
 * INTERNAL — registry-agnostic container image-source machinery shared by
 * the container platforms (`AWS.ECS.*`, `AWS.EKS.*` via ECR, and
 * `Kubernetes.*` workloads pushing to any registry).
 *
 * NOT exported from any barrel. Consumers import the module path directly.
 *
 * A platform's props separate the ENVIRONMENT (what the container is) from
 * the PROGRAM (`main` — "and run my bundled Effect program in it"):
 *
 * - environment (at most one): `image` (registry ref) | `context` +
 *   `dockerfile`-as-path (docker build) | inline `dockerfile` content
 *   (`Dockerfile.inline`) | the default bun base when `main` stands alone.
 * - `main` present → the bundle is injected into the environment (COPY +
 *   ENTRYPOINT) and pushed as a derived image. `main` absent → the
 *   environment runs verbatim: `image` is mirrored (docker pull → tag →
 *   push, content-addressed on the ref), a Dockerfile builds as-is.
 *
 * Where images land is an {@link ImageRegistryTarget}: ECR supplies one that
 * auto-creates a private repository; a plain registry (a local `registry`
 * container, GHCR, Docker Hub, …) supplies one that pushes to
 * `<server>/<name>`.
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
   * Bundler configuration for the entrypoint. Unused code is tree-shaken.
   * `effect`, alchemy, and `@distilled.cloud` are marked pure so unused
   * parts prune more aggressively. List extra packages with
   * `pure.packages`, or disable with `pure: false`.
   */
  build?: Bundle.BundleConfig;
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
 * Run a pre-built registry image. Registry-backed platforms may mirror it
 * into their own registry (ECR: docker pull → tag → push).
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

/**
 * Where a resolved image is pushed. Each field is an Effect so a target can
 * create resources lazily (ECR creates the repository on first use).
 */
export interface ImageRegistryTarget<R = never> {
  /** The repository URI images are tagged into (`<repositoryUri>:<hash>`). */
  readonly repositoryUri: Effect.Effect<string, any, R>;
  /**
   * Whether the content-addressed tag is already in the registry. `true`
   * skips the build and push entirely.
   */
  readonly hasTag: (tag: string) => Effect.Effect<boolean, any, R>;
  /**
   * Push credentials. `undefined` pushes with the build machine's own
   * Docker configuration (`docker login`, credential helpers).
   */
  readonly credentials: Effect.Effect<RegistryCredentials | undefined, any, R>;
}

export interface ResolveContainerImageOptions {
  /** Logical resource id — keys the stable build-context directory. */
  id: string;
  /**
   * The props bag carrying the image source fields (`main` / `context` /
   * `image` plus their modifiers).
   */
  source: ImageSourceLike;
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
   * generated entry module source.
   */
  bootstrap: (importPath: string) => string;
  /** Plan-status session used to emit build/push progress notes. */
  session: { note: (message: string) => Effect.Effect<void> };
}

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
 * `resolve` (build/mirror + push to an {@link ImageRegistryTarget}), `hash`,
 * and `watchMain`.
 */
export const makeContainerImageSource = Effect.gen(function* () {
  const docker = yield* Docker;
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  /**
   * The exact rolldown input/output options `bundleProgram` hands to
   * `Bundle.build` — shared with {@link watchMain} so a dev watcher's
   * `Bundle.watch` observes the identical module graph.
   */
  const mainBundleOptions = (
    source: BundledImageSource,
    entry: string,
    cwd: string,
    plugins?: rolldown.RolldownPluginOption,
  ): {
    inputOptions: rolldown.InputOptions;
    outputOptions: rolldown.OutputOptions;
  } => ({
    inputOptions: {
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
        conditionNames: [...Bundle.BUN_CONDITION_NAMES],
        ...source.build?.input?.resolve,
      },
      plugins: [source.build?.input?.plugins, plugins],
    },
    outputOptions: {
      ...source.build?.output,
      format: "esm",
      sourcemap: source.build?.output?.sourcemap ?? false,
      minify: source.build?.output?.minify ?? false,
      entryFileNames: "index.mjs",
    },
  });

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
      const opts = mainBundleOptions(source, entry, cwd, plugins);
      return yield* Bundle.build(
        opts.inputOptions,
        opts.outputOptions,
        source.build,
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
   * Build (or mirror) and push an image to `target`, pushing with the
   * target's credentials or — when it has none — the build machine's own
   * Docker login.
   */
  const push = (
    imageUri: string,
    credentials: RegistryCredentials | undefined,
    platform?: string,
  ) =>
    (credentials === undefined
      ? docker.run([
          "image",
          "push",
          ...(platform !== undefined ? ["--platform", platform] : []),
          imageUri,
        ])
      : docker.image.push(imageUri, credentials, platform)
    ).pipe(
      // Pushes are idempotent; transient registry-transport failures
      // (Docker Desktop's embedded proxy timing out under load, registry
      // 503s, credential helper contention) resolve on a bounded re-attempt.
      Effect.retry({
        while: (): boolean => true,
        schedule: Schedule.exponential("2 seconds"),
        times: 3,
      }),
    );

  const buildAndPush = Effect.fnUntraced(function* <R>(
    target: ImageRegistryTarget<R>,
    options: {
      imageUri: string;
      context: string;
      dockerfile?: string;
      platform?: string;
    },
  ) {
    const credentials = yield* target.credentials;
    yield* docker.image.build({
      tag: options.imageUri,
      context: options.context,
      file: options.dockerfile,
      platform: options.platform,
    });
    yield* push(options.imageUri, credentials);
    return options.imageUri;
  });

  /**
   * Resolve the image for a props bag: resolve the target repository,
   * compute the content-addressed tag, then build/mirror + push only when
   * that exact tag is not already in the registry (crash-safe convergence).
   */
  const resolve = Effect.fnUntraced(function* <R>(
    options: ResolveContainerImageOptions,
    target: ImageRegistryTarget<R>,
  ) {
    const { id, source, session } = options;
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

    const repositoryUri = yield* target.repositoryUri;

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

      if (yield* target.hasTag(codeHash)) {
        return { imageUri, repositoryUri, codeHash };
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
      yield* buildAndPush(target, {
        imageUri,
        context: contextDir,
        platform,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash };
    }

    if (kind === "image") {
      // Mirror: pull → tag → push. Content-addressed on the image ref, so
      // an already-mirrored ref is a no-op.
      const ref = (source as RegistryImageSource).image;
      const codeHash = (yield* computeStaticSourceHash(source, platform))!;
      const imageUri = `${repositoryUri}:${codeHash}`;

      if (yield* target.hasTag(codeHash)) {
        return { imageUri, repositoryUri, codeHash };
      }

      yield* session.note(`Pulling container image ${ref}...`);
      // A registry pull can wedge indefinitely under Docker Hub throttling /
      // credential-helper contention — bound it so a stuck pull fails the
      // deploy loudly instead of hanging the plan.
      yield* docker.image.pull(ref, platform).pipe(Effect.timeout("4 minutes"));
      yield* docker.image.tag(ref, imageUri);
      yield* session.note(`Pushing mirrored image ${imageUri}...`);
      const credentials = yield* target.credentials;
      // Pin the platform on push: with the containerd image store a bare
      // push of a multi-arch tag sends every locally-present variant — a
      // stale other-arch variant in the local cache would reach the
      // registry and the container would crash with `exec format error`.
      yield* push(imageUri, credentials, platform);
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash };
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
      if (yield* target.hasTag(codeHash)) {
        return { imageUri, repositoryUri, codeHash };
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
      yield* buildAndPush(target, {
        imageUri,
        context: contextDir,
        platform,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryUri, codeHash };
    }

    const { context, dockerfile } = yield* resolveContextPaths({
      context: (source as DockerfileImageSource).context!,
      dockerfile: externalDf,
    });
    const codeHash = (yield* computeStaticSourceHash(source, platform))!;
    const imageUri = `${repositoryUri}:${codeHash}`;

    if (yield* target.hasTag(codeHash)) {
      return { imageUri, repositoryUri, codeHash };
    }

    yield* session.note(`Building container image ${imageUri}...`);
    yield* buildAndPush(target, {
      imageUri,
      context,
      dockerfile,
      platform,
    });
    yield* session.note(`Pushed ${imageUri}`);
    return { imageUri, repositoryUri, codeHash };
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

  /**
   * The rolldown watch plan for a `main` source — the exact input/output
   * options `resolve` bundles with, reusable verbatim with `Bundle.watch`
   * so a dev watcher observes the identical module graph and rebuild
   * triggers.
   */
  const watchMain = Effect.fn(function* (options: {
    source: BundledImageSource;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
  }) {
    const realMain = yield* resolveMainPath(options.source.main);
    const cwd = yield* findCwdForBundle(realMain);
    const opts = mainBundleOptions(
      options.source,
      realMain,
      cwd,
      options.isExternal ? undefined : virtualEntryPlugin(options.bootstrap),
    );
    return { ...opts, extra: options.source.build };
  });

  return { resolve, hash, watchMain };
});

/** The resolver service returned by {@link makeContainerImageSource}. */
export interface ContainerImageSource extends Effect.Success<
  typeof makeContainerImageSource
> {}
