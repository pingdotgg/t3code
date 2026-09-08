import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle } from "../../Bundle/TempRoot.ts";
import { Stack } from "../../Stack.ts";

/**
 * The AWS-managed base image MicroVM Dockerfiles build on. The MicroVM build
 * runs the Dockerfile server-side and snapshots the result with Firecracker.
 */
export const MICROVM_BASE_DOCKER_IMAGE =
  "public.ecr.aws/lambda/microvms:al2023-minimal";

/** The default port the in-VM HTTP server listens on. */
export const DEFAULT_MICROVM_PORT = 8080;

/**
 * Build the final Dockerfile for an effectful MicroVM image. Starts from the
 * user-provided base (or the managed MicroVM base), installs the JS runtime,
 * copies the bundled program, and runs it as the entrypoint. Mirrors the
 * Cloudflare Container `buildFinalDockerfile`, but targets the MicroVM base.
 */
export const buildMicrovmDockerfile = (
  userDockerfile: string | undefined,
  runtime: "bun" | "node",
  port: number,
): string => {
  const base = userDockerfile?.trim() ?? `FROM ${MICROVM_BASE_DOCKER_IMAGE}`;
  const installRuntime =
    runtime === "bun"
      ? // `bun.sh/install` unpacks a zip, so the minimal MicroVM base needs
        // `unzip` (and `tar`) present before the installer runs.
        "RUN dnf install -y unzip tar && curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun && dnf clean all"
      : "RUN dnf install -y nodejs && dnf clean all";
  const runtimeBin = runtime === "bun" ? "bun" : "node";
  return [
    base,
    "",
    installRuntime,
    "WORKDIR /app",
    // The entry (`index.mjs`) and every rolldown chunk are emitted with a
    // `.mjs` extension, which Node always treats as ESM — so the entry's named
    // imports of a chunk resolve without needing a `package.json` `"type"`
    // marker (which would risk clobbering a user-provided base image's file).
    "COPY *.mjs /app/",
    `EXPOSE ${port}`,
    `ENV PORT=${port}`,
    `ENTRYPOINT ["${runtimeBin}", "/app/index.mjs"]`,
    "",
  ].join("\n");
};

/**
 * Bundle an Effect-native MicroVM program with Rolldown and wrap it in a
 * generated bootstrap that boots an HTTP server (the MicroVM endpoint). Returns
 * every emitted file so the full set can be zipped into the code artifact.
 *
 * Mirrors `bundleContainerProgram`; the bootstrap provides AWS runtime services
 * (FetchHttpClient + region from env) so in-VM HTTP capability bindings
 * (e.g. S3 `*Http`) resolve against the MicroVM's execution role.
 */
export const bundleMicrovmProgram = Effect.fn(function* ({
  main,
  runtime,
  handler = "default",
  isExternal = false,
  external = [],
  port,
  build,
}: {
  main: string;
  runtime: "bun" | "node";
  handler?: string | undefined;
  isExternal?: boolean;
  external?: string[];
  port: number;
  build?: Bundle.BundleConfig;
}) {
  const fs = yield* FileSystem.FileSystem;
  const stack = yield* Stack;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const realMain = yield* fs.realPath(main);
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
          "@aws-sdk/*",
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
        entryFileNames: "index.mjs",
        // Emit chunks as `.mjs` too so Node treats them as ESM unconditionally
        // (no `package.json` `"type":"module"` needed in the image).
        chunkFileNames: "[name]-[hash].mjs",
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
              ? "alchemy/Runtime/Bootstrap/MicrovmBun"
              : "alchemy/Runtime/Bootstrap/MicrovmNode",
          )};
import ${handler === "default" ? "entrypoint" : `{ ${handler} as entrypoint }`} from ${JSON.stringify(importPath)};

await bootstrap(entrypoint, ${JSON.stringify({
            port,
            stack: { name: stack.name, stage: stack.stage },
          })});
`,
        ),
      );

  const files = bundleOutput.files.map((f) => ({
    path: f.path,
    content:
      typeof f.content === "string"
        ? new TextEncoder().encode(f.content)
        : f.content,
  }));

  return { files, hash: bundleOutput.hash };
});

export interface ArtifactFile {
  path: string;
  content: string | Uint8Array;
}

/**
 * Zip a flat list of files into a deterministic (fixed mtime) archive. Used to
 * package the MicroVM code artifact (Dockerfile + bundled program, or a build
 * context) before uploading it to S3.
 */
export const zipFiles = Effect.fn(function* (
  files: ReadonlyArray<ArtifactFile>,
) {
  const zip = new (yield* Effect.promise(() => import("jszip"))).default();
  const date = new Date("1980-01-01T00:00:00.000Z");
  for (const file of files) {
    zip.file(file.path, file.content, { date });
  }
  return yield* Effect.promise(() =>
    zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      platform: "UNIX",
    }),
  );
});

/**
 * Recursively read a build-context directory into a flat list of files
 * (relative paths + bytes) for zipping into the code artifact. Used by the
 * external (bring-your-own-Dockerfile) MicroVM mode.
 */
export const readContextDirectory = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(dir);

  const walk = (
    current: string,
  ): Effect.Effect<{ path: string; content: Uint8Array }[], any, never> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(current);
      const out: { path: string; content: Uint8Array }[] = [];
      for (const entry of entries) {
        const abs = path.join(current, entry);
        const info = yield* fs.stat(abs);
        if (info.type === "Directory") {
          out.push(...(yield* walk(abs)));
        } else {
          const content = yield* fs.readFile(abs);
          out.push({ path: path.relative(root, abs), content });
        }
      }
      return out;
    });

  return yield* walk(root);
});
