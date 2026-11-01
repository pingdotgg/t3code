/**
 * INTERNAL — Artifact Registry image-source machinery for GKE workloads.
 * Not exported from the GCP barrel or `ArtifactRegistry/index.ts`.
 *
 * Mirrors `AWS/ECR/ImageSource.ts`: bundle / docker-build / mirror into a
 * per-workload Docker repository so `Kubernetes.*` workloads on GKE pull
 * from Artifact Registry.
 */
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
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
import {
  isInlineDockerfile,
  type InlineDockerfile,
} from "../../Docker/Dockerfile.ts";
import {
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
  type PackageInstall,
} from "../../Bundle/InstalledPackages.ts";
import { tagRecord } from "../../Tags.ts";
import {
  contextRootOf,
  copyExtraFiles,
  hashExtraFiles,
  posixRelUnder,
  resolveExtraSource,
  type ExtraFile,
} from "../../Util/extraFiles.ts";
import { sha256, sha256Object } from "../../Util/sha256.ts";
import { Credentials } from "../Credentials.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import { waitForDeleteOperation, waitForOperation } from "./internal.ts";

export interface BundledImageSource {
  main: string;
  image?: string;
  dockerfile?: string | InlineDockerfile;
  context?: string;
  handler?: string;
  build?: Bundle.BundleConfig;
  /**
   * Host files baked into the image next to `main`. With an external
   * (`isExternal`) `main`, this selects the unbundled Node program mode:
   * `main` is copied as-is and run by `node` (website serve entries).
   */
  extraFiles?: ReadonlyArray<ExtraFile>;
  /** Packages `npm install`ed into the Node program image. */
  install?: PackageInstall;
}

export interface DockerfileImageSource {
  context?: string;
  dockerfile?: string | InlineDockerfile;
}

export interface RegistryImageSource {
  image: string;
}

export interface ImageSourceLike {
  main?: string;
  handler?: string;
  build?: BundledImageSource["build"];
  context?: string;
  dockerfile?: string | InlineDockerfile;
  image?: string;
  extraFiles?: ReadonlyArray<ExtraFile>;
  install?: PackageInstall;
}

/** Base image for unbundled Node programs (website serve entries). */
const NODE_PROGRAM_BASE_IMAGE = "node:26-slim";

const isNodeProgram = (
  source: ImageSourceLike,
  isExternal: boolean | undefined,
) =>
  isExternal === true &&
  source.main !== undefined &&
  source.extraFiles !== undefined;

const nodeProgramManifest = (dependencies: Record<string, string>) =>
  `${JSON.stringify(
    { private: true, type: "module", dependencies },
    null,
    2,
  )}\n`;

const nodeProgramDockerfile = (options: {
  image: string | undefined;
  entry: string;
  install: boolean;
  port: number | undefined;
}) => {
  const lines = [
    `FROM ${options.image ?? NODE_PROGRAM_BASE_IMAGE}`,
    `WORKDIR /app`,
    `ENV NODE_ENV=production`,
  ];
  if (options.install) {
    lines.push(
      `COPY package.json /app/package.json`,
      // Drop npm's download cache so it does not ship (and push) with the image.
      `RUN npm install --omit=dev --no-fund --no-audit && npm cache clean --force`,
    );
  }
  lines.push(`COPY . /app`, `ENV HOST=0.0.0.0`);
  if (options.port !== undefined) {
    lines.push(
      `ENV PORT=${String(options.port)}`,
      `EXPOSE ${String(options.port)}`,
    );
  }
  lines.push(`ENTRYPOINT ["node", ${JSON.stringify(`/app/${options.entry}`)}]`);
  return `${lines.join("\n")}\n`;
};

export type ImageSourceKind = "main" | "context" | "image";

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

export const validateImageSource = (
  id: string,
  source: ImageSourceLike,
): Effect.Effect<void> => {
  if (source.image !== undefined && source.dockerfile !== undefined) {
    return Effect.die(
      new Error(
        `'${id}': 'image' and 'dockerfile' are both set — declare exactly one environment source`,
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

export interface ResolvedImage {
  imageUri: string;
  repositoryName: string;
  repositoryUri: string;
  codeHash: string;
}

export interface ResolveImageOptions {
  id: string;
  source: ImageSourceLike;
  repositoryName: string;
  repositoryUri?: string;
  tags?: Record<string, string>;
  platform?: string;
  port?: number;
  isExternal?: boolean;
  bootstrap: (importPath: string) => string;
  session: { note: (message: string) => Effect.Effect<void> };
}

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

const IMAGE_NAME = "app";

const resourceName = (
  project: string,
  location: string,
  repositoryId: string,
) => `projects/${project}/locations/${location}/repositories/${repositoryId}`;

const dockerRepositoryUri = (
  project: string,
  location: string,
  repositoryId: string,
) => `${location}-docker.pkg.dev/${project}/${repositoryId}/${IMAGE_NAME}`;

const tagResourceName = (
  project: string,
  location: string,
  repositoryId: string,
  tag: string,
) =>
  `${resourceName(project, location, repositoryId)}/packages/${IMAGE_NAME}/tags/${tag}`;

export interface ArtifactRegistryResolveOptions extends ResolveImageOptions {
  /** Artifact Registry location (`us-central1`, …). */
  location: string;
}

export const getArtifactRegistryCredentials = Effect.fn(function* (
  location: string,
) {
  const creds = yield* yield* Credentials;
  return {
    username: "oauth2accesstoken",
    password: creds.accessToken,
    server: `${location}-docker.pkg.dev`,
  };
});

export const buildAndPushArtifactRegistryImage = Effect.fn(function* (
  docker: Docker["Service"],
  options: {
    imageUri: string;
    context: string;
    dockerfile?: string;
    platform?: string;
    location: string;
  },
) {
  const credentials = yield* getArtifactRegistryCredentials(options.location);
  yield* docker.image.build({
    tag: options.imageUri,
    context: options.context,
    file: options.dockerfile,
    platform: options.platform,
  });
  yield* docker.image
    .push(options.imageUri, credentials, options.platform)
    .pipe(
      Effect.retry({
        while: (): boolean => true,
        schedule: Schedule.exponential("2 seconds"),
        times: 3,
      }),
    );
  return options.imageUri;
});

/**
 * Init-time constructor for the Artifact Registry image-source resolver.
 */
/** Delete the Artifact Registry repository `name`; missing is success. */
export const destroyImageRepository = Effect.fn(function* (name: string) {
  const operation = yield* artifactregistry
    .deleteProjectsLocationsRepositories({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  if (operation !== undefined) {
    yield* waitForDeleteOperation(operation);
  }
});

/**
 * Delete the image repository an Effect-native host built into on
 * reconcile (`{hostId}-src`, normalized by the host's `rfc1035`).
 *
 * Not gated on `output.codeHash`: an update that failed after creating the
 * repository leaves state without a hash. The repository is deleted only
 * when it carries this logical id's ownership labels, so a same-named
 * foreign repository is never touched.
 */
export const destroyHostImageRepository = Effect.fn(function* (
  id: string,
  output: {
    project: string;
    location: string;
  },
  repositoryId: string,
) {
  const name = resourceName(output.project, output.location, repositoryId);
  const repository = yield* artifactregistry
    .getProjectsLocationsRepositories({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  if (repository === undefined) return;
  if (!(yield* hasAlchemyLabels(id, tagRecord(repository.labels)))) return;
  yield* destroyImageRepository(name);
});

export const makeImageSource = Effect.gen(function* () {
  const docker = yield* Docker;
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

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
    outputOptions: {
      ...source.build?.output,
      format: "esm",
      sourcemap: source.build?.output?.sourcemap ?? false,
      minify: source.build?.output?.minify ?? false,
      entryFileNames: "index.mjs",
    },
  });

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

    const files = bundleOutput.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content,
    }));

    return { files, hash: bundleOutput.hash };
  });

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
      `COPY *.js /app/`,
    ];
    if (port !== undefined) {
      lines.push(`ENV PORT=${String(port)}`, `EXPOSE ${String(port)}`);
    }
    lines.push(`ENTRYPOINT ["bun", "/app/index.mjs"]`);
    return `${lines.join("\n")}\n`;
  };

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
   * Hash an unbundled Node program: the entry bytes, every extra file
   * tree, the generated Dockerfile, and the resolved install identity.
   */
  const computeNodeProgram = Effect.fn(function* (options: {
    source: BundledImageSource;
    port?: number;
    platform: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { source } = options;
    const realMain = yield* resolveMainPath(source.main);
    const extras = source.extraFiles ?? [];
    const root = contextRootOf(realMain, extras, path, (file) =>
      resolveExtraSource(file, path),
    );
    const entry =
      posixRelUnder(root, realMain, path) || path.basename(realMain);
    const requested = yield* normalizeInstallTargets(source.install);
    const identity =
      Object.keys(requested).length > 0
        ? yield* resolvePackageInstallIdentity({
            cwd: yield* findCwdForBundle(realMain),
            requested,
          })
        : undefined;
    const packageJson =
      identity !== undefined && Object.keys(identity.resolved).length > 0
        ? nodeProgramManifest(identity.resolved)
        : undefined;
    const dockerfile = nodeProgramDockerfile({
      image: source.image,
      entry,
      install: packageJson !== undefined,
      port: options.port,
    });
    const codeHash = (yield* sha256Object({
      main: yield* sha256(yield* fs.readFile(realMain)),
      entry,
      dockerfile,
      packageJson,
      lockfile: identity?.lockfile,
      extraFiles: yield* hashExtraFiles(extras),
      platform: options.platform,
    })).slice(0, 16);
    return { realMain, entry, dockerfile, packageJson, codeHash };
  });

  const ensureRepository = Effect.fn(function* (options: {
    id: string;
    repositoryId: string;
    location: string;
    tags?: Record<string, string>;
  }) {
    const env = yield* GcpEnvironment.current;
    const name = resourceName(
      env.project,
      options.location,
      options.repositoryId,
    );
    const desiredLabels = {
      ...toLabels(options.tags),
      ...(yield* createInternalLabels(options.id)),
    };
    const existing = yield* artifactregistry
      .getProjectsLocationsRepositories({ name })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing?.name) {
      return {
        name: existing.name,
        created: false,
        repositoryUri:
          existing.registryUri !== undefined && existing.registryUri.length > 0
            ? `${existing.registryUri.replace(/\/+$/, "")}/${IMAGE_NAME}`
            : dockerRepositoryUri(
                env.project,
                options.location,
                options.repositoryId,
              ),
      };
    }
    const created = yield* artifactregistry
      .createProjectsLocationsRepositories({
        parent: `projects/${env.project}/locations/${options.location}`,
        repositoryId: options.repositoryId,
        body: {
          format: "DOCKER",
          mode: "STANDARD_REPOSITORY",
          labels: desiredLabels,
        },
      })
      .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
    if (created !== undefined) {
      yield* waitForOperation(created);
    }
    const observed = yield* artifactregistry
      .getProjectsLocationsRepositories({ name })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          times: 8,
          schedule: Schedule.spaced("1 second"),
        }),
      );
    return {
      name: observed.name ?? name,
      // Created by THIS call (a lost create race reports Conflict).
      created: created !== undefined,
      repositoryUri:
        observed.registryUri !== undefined && observed.registryUri.length > 0
          ? `${observed.registryUri.replace(/\/+$/, "")}/${IMAGE_NAME}`
          : dockerRepositoryUri(
              env.project,
              options.location,
              options.repositoryId,
            ),
    };
  });

  const describeImage = Effect.fn(function* (
    project: string,
    location: string,
    repositoryId: string,
    imageTag: string,
  ) {
    return yield* artifactregistry
      .getProjectsLocationsRepositoriesPackagesTags({
        name: tagResourceName(project, location, repositoryId, imageTag),
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

  const resolve = Effect.fn(function* (
    options: ArtifactRegistryResolveOptions,
  ) {
    const { id, source, repositoryName, session, location } = options;
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

    const ensured = yield* ensureRepository({
      id,
      repositoryId: repositoryName,
      location,
      tags: options.tags,
    });
    // A failed first build/push never reaches state, so destroy could not
    // find a repository created here. Remove it before surfacing the error.
    return yield* buildImage(options, ensured.repositoryUri).pipe(
      Effect.onError(() =>
        ensured.created
          ? destroyImageRepository(ensured.name).pipe(Effect.ignore)
          : Effect.void,
      ),
    );
  });

  const buildImage = Effect.fn(function* (
    options: ArtifactRegistryResolveOptions,
    ensuredRepositoryUri: string,
  ) {
    const { id, source, repositoryName, session, location } = options;
    const platform = options.platform ?? "linux/amd64";
    const kind = imageSourceKind(source);
    const env = yield* GcpEnvironment.current;
    const repositoryUri = options.repositoryUri ?? ensuredRepositoryUri;

    if (isNodeProgram(source, options.isExternal)) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const program = yield* computeNodeProgram({
        source: source as BundledImageSource,
        port: options.port,
        platform,
      });
      const { codeHash } = program;
      const imageUri = `${repositoryUri}:${codeHash}`;
      if (
        yield* describeImage(env.project, location, repositoryName, codeHash)
      ) {
        return { imageUri, repositoryName, repositoryUri, codeHash };
      }
      // Hash-keyed so a stale tree from an earlier build never leaks in.
      const contextDir = yield* getStableContextDir(
        program.realMain,
        dotAlchemy,
        `${id}-node-${codeHash}`,
      );
      yield* docker.materialize({
        context: contextDir,
        dockerfile: program.dockerfile,
        files:
          program.packageJson !== undefined
            ? [{ path: "package.json", content: program.packageJson }]
            : [],
      });
      yield* copyExtraFiles(contextDir, source.extraFiles);
      const entryPath = path.join(contextDir, program.entry);
      if (
        !(yield* fs.exists(entryPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fs.copy(program.realMain, entryPath, { overwrite: true });
      }
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPushArtifactRegistryImage(docker, {
        imageUri,
        context: contextDir,
        platform,
        location,
      }).pipe(
        Effect.ensuring(
          fs.remove(contextDir, { recursive: true }).pipe(Effect.ignore),
        ),
      );
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

    if (kind === "main") {
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
      if (
        yield* describeImage(env.project, location, repositoryName, codeHash)
      ) {
        return { imageUri, repositoryName, repositoryUri, codeHash };
      }

      let envFrom: string | undefined;
      if (df !== undefined && !isInlineDockerfile(df)) {
        const envPaths = yield* resolveContextPaths({
          context: source.context!,
          dockerfile: df,
        });
        envFrom = `alchemy-env-${id.toLowerCase()}:${codeHash}`;
        yield* session.note(`Building environment image for ${id}...`);
        yield* docker.image.build({
          context: envPaths.context,
          file: envPaths.dockerfile,
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
        files: bundled.files.map((file, index) => ({
          path: index === 0 ? "index.mjs" : file.path,
          content: file.content,
        })),
      });
      yield* session.note(`Building container image ${imageUri}...`);
      yield* buildAndPushArtifactRegistryImage(docker, {
        imageUri,
        context: contextDir,
        platform,
        location,
      });
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

    if (kind === "image") {
      const ref = (source as RegistryImageSource).image;
      const codeHash = (yield* computeStaticSourceHash(source, platform))!;
      const imageUri = `${repositoryUri}:${codeHash}`;
      if (
        yield* describeImage(env.project, location, repositoryName, codeHash)
      ) {
        return { imageUri, repositoryName, repositoryUri, codeHash };
      }
      yield* session.note(`Pulling container image ${ref}...`);
      yield* docker.image.pull(ref, platform).pipe(Effect.timeout("4 minutes"));
      yield* docker.image.tag(ref, imageUri);
      yield* session.note(`Pushing mirrored image ${imageUri}...`);
      const credentials = yield* getArtifactRegistryCredentials(location);
      yield* docker.image.push(imageUri, credentials, platform).pipe(
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.exponential("2 seconds"),
          times: 3,
        }),
      );
      yield* session.note(`Pushed ${imageUri}`);
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }

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
      if (
        yield* describeImage(env.project, location, repositoryName, codeHash)
      ) {
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
      yield* buildAndPushArtifactRegistryImage(docker, {
        imageUri,
        context: contextDir,
        platform,
        location,
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
    if (yield* describeImage(env.project, location, repositoryName, codeHash)) {
      return { imageUri, repositoryName, repositoryUri, codeHash };
    }
    yield* session.note(`Building container image ${imageUri}...`);
    yield* buildAndPushArtifactRegistryImage(docker, {
      imageUri,
      context,
      dockerfile,
      platform,
      location,
    });
    yield* session.note(`Pushed ${imageUri}`);
    return { imageUri, repositoryName, repositoryUri, codeHash };
  });

  const hash = Effect.fn(function* (options: {
    source: ImageSourceLike;
    platform?: string;
    port?: number;
    isExternal?: boolean;
    bootstrap: (importPath: string) => string;
  }) {
    const platform = options.platform ?? "linux/amd64";
    if (isNodeProgram(options.source, options.isExternal)) {
      const { codeHash } = yield* computeNodeProgram({
        source: options.source as BundledImageSource,
        port: options.port,
        platform,
      });
      return codeHash;
    }
    if (imageSourceKind(options.source) === "main") {
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

  return {
    resolve,
    hash,
    destroyRepository: destroyImageRepository,
    resourceName,
  };
});

export type ImageSource = Effect.Success<typeof makeImageSource>;
