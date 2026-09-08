import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { Docker } from "../../Docker/Docker.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Stack } from "../../Stack.ts";
import { sha256Object } from "../../Util/sha256.ts";
import type { AnyContainerApplicationProps } from "./ContainerApplication.ts";

/**
 * Fold the runtime-context `env` map (populated by `Binding.Service`s and
 * `Config` injection — see `ContainerPlatform.set`) into the application's
 * `environmentVariables`.
 *
 * Unlike Cloudflare Workers, container `secrets` are *references to the
 * account Secrets Store by name* — they cannot carry an inline value — so
 * runtime-bound values (e.g. a minted API token) must travel as plain
 * `environmentVariables`. The value is the JSON-encoded payload produced by
 * `ContainerPlatform.set` (a `{_tag:"Redacted",value}` marker for secrets,
 * a JSON string otherwise), which `ContainerPlatform.get` parses back into
 * the original `Redacted`/plain value at runtime.
 *
 * `precreate` receives the raw, unevaluated props (the engine only resolves
 * Output expressions for the real `reconcile`/create), so env values that
 * reference other resources are still unresolved `Output`s there — skip them.
 * They are applied when reconcile runs against the resolved props.
 *
 * When `accountId` is provided it is injected as `ALCHEMY_CLOUDFLARE_ACCOUNT_ID`
 * (mirroring the Worker runtime) so the container bootstrap can build
 * `CloudflareEnvironment` for HTTP capability bindings (R2/KV/Queue `*Http`).
 *
 * `bindings` carries the resource's binding contract — the `{ env }` a
 * `Binding.Service` attaches with ``host.bind`${resource}`({ env })`` when the
 * container is the host (`Prisma.Connect`, and any other capability whose
 * runtime config travels as environment variables). Bindings are resolved by
 * the engine before `reconcile`, so they land here already evaluated. They are
 * applied FIRST, at the lowest precedence: an explicitly declared `env` or
 * `environmentVariables` entry always wins over a capability-injected one.
 */
export const makeContainerEnv = (
  props: AnyContainerApplicationProps,
  accountId: string,
  bindings: readonly {
    data?: { env?: Record<string, any> } | undefined;
  }[] = [],
) => {
  const env: Record<string, string | Redacted.Redacted<string>> = {};
  for (const binding of bindings) {
    for (const [name, value] of Object.entries(binding.data?.env ?? {})) {
      if (Output.isOutput(value) || value === undefined) {
        continue;
      }
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries(props.env ?? {})) {
    if (Output.isOutput(value) || value === undefined) {
      continue;
    }
    env[name] = value;
  }
  for (const value of props.environmentVariables ?? []) {
    env[value.name] = value.value;
  }
  if (!env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID) {
    env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  return env;
};

/**
 * Derive the physical name for a container application. Shared between the
 * live and local providers so they agree on the deterministic name.
 */
export const createContainerApplicationName = (
  id: string,
  name: string | undefined,
) =>
  Effect.suspend(() => {
    if (name) return Effect.succeed(name);
    return createPhysicalName({
      id,
      lowercase: true,
    });
  });

/**
 * Validate the image-source composition on container props. Exactly one
 * environment/source may be declared:
 *
 * - `main` + optional `image` (environment base) OR inline `dockerfile`
 *   (environment preamble) — never both, and never a `context`.
 * - `image` alone — a pre-built remote image, exclusive with `dockerfile`
 *   and `context`.
 * - `dockerfile` (string path against `context`, or inline content with no
 *   `context`) — the user-Dockerfile build.
 *
 * Invalid combinations are programmer errors, surfaced as plan-time defects
 * (`Effect.die`) rather than typed errors.
 */
export const validateContainerImageProps = (
  props: Pick<
    AnyContainerApplicationProps,
    "main" | "image" | "dockerfile" | "context"
  >,
): Effect.Effect<void> => {
  const df = props.dockerfile;
  const hasInline = df !== undefined && isInlineDockerfile(df);
  if (props.main) {
    if (props.image !== undefined && df !== undefined) {
      return Effect.die(
        new Error(
          "`image` and `dockerfile` are mutually exclusive with `main` — both pick the environment for the bundled program; declare one.",
        ),
      );
    }
    if (df !== undefined && !hasInline) {
      return Effect.die(
        new Error(
          "A `dockerfile` PATH cannot be combined with `main` on Cloudflare containers — use `Dockerfile.inline` content or `image` to pick the bundled program's environment.",
        ),
      );
    }
    if (props.context !== undefined) {
      return Effect.die(
        new Error(
          "`context` cannot be combined with `main` — the build context for a bundled program is generated by Alchemy.",
        ),
      );
    }
    return Effect.void;
  }
  if (props.image !== undefined && df !== undefined) {
    return Effect.die(
      new Error(
        "`image` (pre-built remote image) and `dockerfile` (build your own) are mutually exclusive — declare one.",
      ),
    );
  }
  if (props.image !== undefined && props.context !== undefined) {
    return Effect.die(
      new Error(
        "`image` (pre-built remote image) and `context` (Dockerfile build) are mutually exclusive — declare one.",
      ),
    );
  }
  if (hasInline && props.context !== undefined) {
    return Effect.die(
      new Error(
        "Inline `dockerfile` content cannot be combined with `context` — inline content has no build context; use a `dockerfile` PATH for context-relative builds.",
      ),
    );
  }
  return Effect.void;
};

/**
 * Resolve the environment preamble for a generated (Effect-native) container
 * Dockerfile from the props' `image` / inline `dockerfile` composition:
 *
 * - inline `dockerfile` content → used verbatim as the preamble (it carries
 *   its own `FROM` and any extra build steps),
 * - `image` → a synthesized `FROM <image>` line,
 * - neither → `undefined` (callers fall back to the runtime default base).
 */
export const containerEnvPreamble = (
  props: Pick<AnyContainerApplicationProps, "image" | "dockerfile">,
): Effect.Effect<string | undefined> => {
  const df = props.dockerfile;
  if (df !== undefined && isInlineDockerfile(df)) {
    const content = df.content;
    if (typeof content !== "string") {
      return Effect.die(
        new Error(
          "Inline `dockerfile` content is an unresolved Output at image-build time. " +
            "Outputs in `Dockerfile.inline` resolve during a normal deploy; this container is being built before its dependencies resolved (e.g. during precreate of a circular binding). Break the cycle or inline the resolved value.",
        ),
      );
    }
    return Effect.succeed(content.trimEnd());
  }
  const ref = props.image?.trim();
  if (ref) {
    if (/\s/.test(ref)) {
      // A registry reference never contains whitespace — catch Dockerfile
      // content early with an actionable message instead of producing a
      // broken build.
      return Effect.die(
        new Error(
          `\`image\` must be a plain image reference (e.g. "oven/bun:latest"), got: ${JSON.stringify(props.image)}. ` +
            "For inline Dockerfile content use `dockerfile: Dockerfile.inline`.",
        ),
      );
    }
    return Effect.succeed(`FROM ${ref}`);
  }
  return Effect.succeed(undefined);
};

/**
 * Build the final Dockerfile used for a generated (Effect-native) container
 * image. Starts from the environment preamble (see
 * {@link containerEnvPreamble}) — or a runtime-appropriate default base —
 * then appends the statements that copy the bundled program and set the
 * entrypoint.
 */
export const buildFinalDockerfile = (
  envPreamble: string | undefined,
  runtime: "bun" | "node",
  external: string[] = [],
  autoInstallExternals = true,
): string => {
  const base =
    envPreamble ??
    (runtime === "bun" ? "FROM oven/bun:1" : "FROM node:22-slim");
  const runtimeBin = runtime === "bun" ? "bun" : "node";
  const installCmd = runtime === "bun" ? "bun add" : "npm install";
  const installStep =
    autoInstallExternals && external.length > 0
      ? `RUN ${installCmd} ${external.join(" ")}`
      : "";
  return [
    base,
    "",
    "WORKDIR /app",
    ...(installStep ? [installStep, ""] : []),
    "COPY index.mjs /app/index.mjs",
    // Copy any additional rolldown chunks (`chunk-XXX.js`,
    // `BunServices-YYY.js`, …). The glob matches zero or more files;
    // non-trivial bundles always emit at least one chunk, minimal
    // bundles emit none and the COPY no-ops.
    "COPY *.js /app/",
    "EXPOSE 3000",
    `ENTRYPOINT ["${runtimeBin}", "/app/index.mjs"]`,
    "",
  ].join("\n");
};

/**
 * Materialize resolved inline `dockerfile` content into a stable,
 * deterministic build-context directory (containing only the Dockerfile) so
 * both the live provider and the local dev runtime can `docker build` it.
 * Shared by the live and local providers so they agree on the path.
 */
export const materializeInlineDockerfileContext = Effect.fn(function* (
  id: string,
  content: string,
) {
  const { dotAlchemy } = yield* AlchemyContext;
  const docker = yield* Docker;
  const path = yield* Path.Path;
  const context = yield* getStableContextDir(
    dotAlchemy,
    dotAlchemy,
    `${id}-dockerfile`,
  );
  yield* docker.materialize({ context, dockerfile: content, files: [] });
  return { context, dockerfile: path.join(context, "Dockerfile") };
});

/**
 * Bundle the container entrypoint program with rolldown. Returns every emitted
 * file (entry chunk plus shared chunks) so the full set can be materialized
 * into the Docker build context, along with a content hash of the bundle.
 *
 * Shared between the live provider (which builds + pushes a Cloudflare image)
 * and the local provider (which writes the context to disk for the runtime to
 * `docker build`).
 */
export const bundleContainerProgram = Effect.fn(function* ({
  main,
  runtime,
  handler = "default",
  isExternal = false,
  external = [],
  outdir,
  build,
}: {
  id: string;
  main: string;
  runtime: "bun" | "node";
  handler?: string | undefined;
  isExternal?: boolean;
  external?: string[];
  outdir?: string;
  build?: Bundle.BundleConfig;
}) {
  const stack = yield* Stack;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const realMain = yield* resolveMainPath(main);
  const cwd = yield* findCwdForBundle(realMain);

  const buildBundle = Effect.fn(function* (
    entry: string,
    plugins?: rolldown.RolldownPluginOption,
  ) {
    return yield* Bundle.build(
      {
        ...build?.input,
        input: entry,
        cwd,
        external: [
          "cloudflare:workers",
          "cloudflare:workflows",
          ...(runtime === "bun" ? ["bun", "bun:*"] : []),
          ...external,
          ...((build?.input?.external as string[] | undefined) ?? []),
        ],
        platform: "node",
        resolve: {
          conditionNames:
            runtime === "bun"
              ? [...Bundle.BUN_CONDITION_NAMES]
              : [...Bundle.NODE_CONDITION_NAMES],
          ...build?.input?.resolve,
        },
        plugins: [build?.input?.plugins, plugins],
        treeshake: true,
      },
      {
        ...build?.output,
        format: "esm",
        sourcemap: build?.output?.sourcemap ?? false,
        minify: build?.output?.minify ?? false,
        dir: outdir,
        entryFileNames: "index.mjs",
      },
      build,
    );
  });

  const bundleOutput = isExternal
    ? yield* buildBundle(realMain)
    : yield* buildBundle(
        realMain,
        virtualEntryPlugin(
          (importPath) => `
import { bootstrap } from ${JSON.stringify(
            runtime === "bun"
              ? "alchemy/Runtime/Bootstrap/CloudflareContainerBun"
              : "alchemy/Runtime/Bootstrap/CloudflareContainerNode",
          )};
import ${handler === "default" ? "entrypoint" : `{ ${handler} as entrypoint }`} from ${JSON.stringify(importPath)};

await bootstrap(entrypoint, ${JSON.stringify({
            stack: { name: stack.name, stage: stack.stage },
          })});
`,
        ),
      );

  // Rolldown can emit multiple chunk files (entry + shared chunks).
  // Return every file so downstream code can materialize all of them
  // into the Docker build context — dropping any of them produces a
  // `Cannot find module './chunk-XXX.js'` runtime crash inside the
  // container (with zero stdout, because it crashes before any user
  // code runs).
  const files = bundleOutput.files.map((f) => ({
    path: f.path,
    content:
      typeof f.content === "string"
        ? new TextEncoder().encode(f.content)
        : f.content,
  }));

  return { files, hash: bundleOutput.hash };
});

/**
 * Bundle an Effect-native container `main` and materialize it (plus the
 * generated Dockerfile) into a stable Docker build context directory, then
 * return the paths + content hash of that context.
 *
 * This is the local-dev image shape (`ContainerImage.Build`) that
 * `@alchemy.run/cloudflare-runtime/core` consumes: it `docker build`s the
 * `dockerfile` against the `context` directory. Shared between the local
 * provider (which serves this context to the runtime as the `dev` image) and
 * the live provider (which persists the same deterministic context path as
 * `dev` so a subsequent `alchemy dev` run has an image to build even though the
 * live deploy pushed to Cloudflare's registry instead).
 *
 * The context directory is deterministic for a given resource id, so live and
 * local agree on the path. Callers that want to skip re-bundling on an
 * unchanged resource should wrap this in {@link Artifacts.cached}.
 */
export const prepareContainerBuildContext = Effect.fn(function* (
  id: string,
  news: AnyContainerApplicationProps,
) {
  const { dotAlchemy } = yield* AlchemyContext;
  const docker = yield* Docker;
  const path = yield* Path.Path;

  const main = news.main;
  if (!main) {
    return yield* Effect.die(
      new Error("Container requires a `main` entrypoint."),
    );
  }
  yield* validateContainerImageProps(news);
  const runtime = news.runtime ?? "bun";
  const context = yield* getStableContextDir(
    process.cwd(),
    dotAlchemy,
    `${id}-container`,
  );
  const dockerfileContent = buildFinalDockerfile(
    yield* containerEnvPreamble(news),
    runtime,
    news.external,
    news.autoInstallExternals,
  );
  const [bundle] = yield* Effect.all(
    [
      bundleContainerProgram({
        id,
        main,
        runtime,
        handler: news.handler,
        isExternal: news.isExternal,
        external: news.external,
        outdir: context,
        build: news.build,
      }),
      docker.materialize({
        context,
        dockerfile: dockerfileContent,
        files: [],
      }),
    ],
    { concurrency: "unbounded" },
  );
  return {
    context,
    dockerfile: path.join(context, "Dockerfile"),
    hash: yield* sha256Object({
      bundle: bundle.hash,
      dockerfileContent,
    }),
  };
});
