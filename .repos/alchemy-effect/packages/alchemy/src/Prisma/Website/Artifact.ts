import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { dotAlchemyDirectory } from "../../AlchemyContext.ts";
import { isPathWithin } from "../../Util/isPathWithin.ts";
import type { PlatformError } from "effect/PlatformError";
import { createRequire } from "node:module";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { initialCwd } from "../../Util/Node.ts";
import { packSiteExtraFiles } from "../../Website/packExtraFiles.ts";
import { createComputeArchive } from "../ComputeArchive.ts";
import { loadFrontendCore } from "../../Website/FrontendCore.ts";

/** Resolved framework output to stage after Website.Server has built it. */
export interface WebsiteArtifactProps {
  /** Application root, relative to the initial working directory. */
  root: string;
  /** Build output directory, relative to the initial working directory. */
  distDir: string;
  /** Node serve entry, relative to the initial working directory. */
  serverEntry?: string;
  /** Generate the shared static-file server instead of tracing a framework entry. */
  static?: {
    /** Unmatched-path behavior. @default "none" */
    notFoundHandling?: "none" | "spa" | "404-page";
    /** Extensionless HTML handling. @default "none" */
    htmlHandling?: "none" | "drop-trailing-slash";
    /** HTML file served for misses, relative to the static output. @default "404.html" */
    errorPage?: string;
  };
  /** Next.js keeps its output and configuration beside the serve entry. */
  layout?: "output" | "next";
  /** Build output fingerprint; keeps the build dependency explicit. */
  buildHash?: string;
}

/** Internal, filesystem-only artifact lifecycle; never creates cloud resources. */
export interface WebsiteArtifact extends Resource<
  "Prisma.WebsiteArtifact",
  WebsiteArtifactProps,
  {
    /** Private directory owned by this artifact resource. */
    directory: string;
    /** Verified Compute tarball path. */
    artifactPath: string;
    /** SHA-256 of the tarball uploaded by Compute. */
    hash: string;
  }
> {}

export const WebsiteArtifact = Resource<WebsiteArtifact>(
  "Prisma.WebsiteArtifact",
);

const MAX_ENTRIES = 50_000;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const excluded = (relative: string) =>
  relative
    .split(/[\\/]/)
    .some((part) =>
      /^(?:\.git|\.alchemy|\.env(?:\..*)?|\.envrc|\.npmrc|\.yarnrc.*|\.netrc|\.pypirc|\.aws|\.ssh)$/.test(
        part,
      ),
    );
const javascript = (file: string) => /\.[cm]?[jt]sx?$/.test(file);
const nextExcluded = (relative: string) =>
  /^\.next\/(?:cache|standalone|types|diagnostics|dev)(?:\/|$)/.test(
    relative,
  ) || /^\.next\/trace(?:-|$)/.test(relative);

const fail = (message: string) => Effect.fail(new Error(message));

/**
 * Stage real build files and NFT's reachable runtime graph without relocating
 * individual modules. Keeping their relative layout preserves import.meta.url,
 * package scopes, pnpm links, and dynamically loaded framework chunks.
 * The caller owns the surrounding Scope and must archive before it closes.
 */
export const stageWebsiteArtifact = Effect.fn(function* (
  props: WebsiteArtifactProps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(initialCwd, props.root));
  const runtimeBase = process.cwd();
  const dotAlchemy = yield* dotAlchemyDirectory;
  const dist = yield* fs.realPath(path.resolve(initialCwd, props.distDir));
  const entry =
    props.serverEntry === undefined
      ? undefined
      : yield* fs.realPath(path.resolve(initialCwd, props.serverEntry));
  if (entry === undefined && props.static === undefined) {
    return yield* fail(
      "A website artifact requires a Node server entry or static serving options.",
    );
  }
  if (entry !== undefined && (yield* fs.stat(entry)).type !== "File") {
    return yield* fail(`Website server entry is not a file: ${entry}`);
  }
  if (props.layout !== "next" && dist === root) {
    return yield* fail(
      "Website output must be a dedicated build directory, not the application root.",
    );
  }
  const files = new Set<string>(entry === undefined ? [] : [entry]);
  const seeds = new Set<string>(entry === undefined ? [] : [entry]);
  const manifests: string[] = [];
  let visited = 0;
  const collect: (
    source: string,
    ancestors?: ReadonlySet<string>,
    runtimePackage?: boolean,
    boundary?: string,
  ) => Effect.Effect<void, Error | PlatformError> = Effect.fn(function* (
    source,
    ancestors = new Set(),
    runtimePackage = false,
    boundary,
  ) {
    if (++visited > MAX_ENTRIES)
      return yield* fail(
        "Website artifact exceeds the 50,000-entry safety limit.",
      );
    const relative = path.relative(root, source).replaceAll("\\", "/");
    if (
      excluded(relative) ||
      isPathWithin(dotAlchemy, source, runtimeBase) ||
      (runtimePackage && /(?:\.map|\.d\.ts)$/.test(source)) ||
      (props.layout === "next" && nextExcluded(relative))
    )
      return;
    const real = yield* fs.realPath(source);
    const relativeToBoundary = path.relative(boundary ?? real, real);
    if (
      relativeToBoundary === ".." ||
      relativeToBoundary.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToBoundary)
    ) {
      return yield* fail(
        `Website output symlink escapes its selected directory: ${source}`,
      );
    }
    const stat = yield* fs.stat(real);
    if (stat.type === "Directory") {
      if (ancestors.has(real))
        return yield* fail(`Cyclic website output symlink: ${source}`);
      const next = new Set([...ancestors, real]);
      for (const name of yield* fs.readDirectory(source)) {
        // Runtime dependencies are traced, never copied wholesale.
        if (name === "node_modules") continue;
        yield* collect(
          path.join(source, name),
          next,
          runtimePackage,
          boundary ?? real,
        );
      }
    } else if (stat.type === "File") {
      files.add(source);
      if (!runtimePackage && props.static === undefined && javascript(source))
        seeds.add(source);
      if (props.layout === "next" && source.endsWith(".nft.json"))
        manifests.push(source);
    } else {
      return yield* fail(`Unsupported website output file: ${source}`);
    }
  });

  const extras = yield* packSiteExtraFiles(
    props.layout === "next" ? root : dist,
    props.layout === "next" ? "next" : "client",
  );
  if (
    props.layout === "next" &&
    !(yield* fs.exists(path.join(root, ".next", "BUILD_ID")))
  ) {
    return yield* fail(
      "Next.js output is missing .next/BUILD_ID; run the production build before packaging.",
    );
  }
  for (const extra of extras ?? []) yield* collect(extra.source);
  // Also include config extensions not currently listed by packSiteExtraFiles.
  if (props.layout === "next") {
    for (const name of ["next.config.mts", "next.config.cts"]) {
      const config = path.join(root, name);
      if (yield* fs.exists(config)) yield* collect(config);
    }
  }

  if (props.layout === "next") {
    const nextPackage = yield* Effect.try(() =>
      createRequire(path.join(root, "package.json")).resolve(
        "next/package.json",
      ),
    );
    const nextRoot = path.dirname(nextPackage);
    // Next's custom server resolves internal modules through runtime alias
    // tables that NFT cannot evaluate. Keep that package, not node_modules.
    yield* collect(nextRoot, undefined, true);
    yield* collect(path.join(nextRoot, "dist", "compiled", "webpack"));
  }

  for (const manifest of manifests) {
    const text = yield* fs.readFileString(manifest);
    const parsed = yield* Effect.try(
      () => JSON.parse(text) as { files?: unknown },
    );
    if (
      !Array.isArray(parsed.files) ||
      !parsed.files.every((file): file is string => typeof file === "string")
    ) {
      return yield* fail(`Invalid Next.js trace manifest: ${manifest}`);
    }
    for (const file of parsed.files) {
      const source = path.resolve(path.dirname(manifest), file);
      if (
        excluded(path.relative(root, source)) ||
        isPathWithin(dotAlchemy, source, runtimeBase)
      )
        return yield* fail(
          `A Next.js runtime dependency is a sensitive file: ${source}`,
        );
      files.add(source);
      if (javascript(source)) seeds.add(source);
    }
  }

  const traceBase = path.parse(root).root;
  const trace =
    seeds.size === 0
      ? undefined
      : yield* Effect.tryPromise({
          try: () =>
            import("@vercel/nft").then(({ nodeFileTrace }) =>
              nodeFileTrace([...seeds], {
                base: traceBase,
                processCwd: root,
                conditions: ["node", "production"],
                analysis: {
                  emitGlobs: true,
                  computeFileReferences: true,
                  evaluatePureExpressions: true,
                },
              }),
            ),
          catch: (cause) =>
            new Error(
              "Failed to trace website runtime dependencies. Install @vercel/nft in the deployment workspace.",
              { cause },
            ),
        }).pipe(Effect.timeout("90 seconds"));
  if (trace !== undefined) {
    for (const file of trace.fileList) {
      const source = path.resolve(traceBase, file);
      // NFT records symlinks encountered while resolving optional imports,
      // even when their targets are absent. They are lookup evidence, not
      // runtime files. Explicit build/manifest files remain required.
      if (
        !files.has(source) &&
        trace.reasons.get(file)?.type.every((type) => type === "resolve") &&
        !(yield* fs.exists(source))
      )
        continue;
      files.add(source);
    }
  }
  if (files.size > MAX_ENTRIES)
    return yield* fail(
      "Website dependency trace exceeds the 50,000-entry safety limit.",
    );

  const links = new Map<string, string>();
  const selected = new Set<string>();
  for (const file of files) {
    if (
      excluded(path.relative(root, file)) ||
      isPathWithin(dotAlchemy, file, runtimeBase)
    )
      return yield* fail(
        `A website runtime dependency is a sensitive file: ${file}`,
      );
    const link = yield* fs
      .readLink(file)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (link !== undefined) {
      const target = yield* fs.realPath(file);
      links.set(file, target);
      if ((yield* fs.stat(target)).type === "File")
        selected.add(yield* fs.realPath(target));
    } else {
      const stat = yield* fs.stat(file);
      if (stat.type !== "File")
        return yield* fail(
          `A traced runtime dependency is not a file: ${file}`,
        );
      selected.add(file);
    }
  }
  let base = root;
  const within = (directory: string, file: string) => {
    const relative = path.relative(directory, file);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  for (const file of [...selected, ...links.keys(), ...links.values()]) {
    while (!within(base, file)) base = path.dirname(base);
  }
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-prisma-website-",
  });
  const staged = (file: string) =>
    path.join(directory, "files", path.relative(base, file));
  let bytes = 0;
  for (const file of [...selected].sort()) {
    const stat = yield* fs.stat(file);
    const size = Number(stat.size);
    bytes += size;
    if (size > MAX_FILE_BYTES || bytes > MAX_BYTES)
      return yield* fail(
        "Website artifact exceeds Prisma Compute's file or total byte safety limit.",
      );
    const dest = staged(file);
    yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
    yield* fs.copyFile(file, dest);
    yield* fs.chmod(dest, stat.mode & 0o777);
  }
  for (const [file, target] of links) {
    // NFT also reports resolution-only links with no retained runtime files.
    if (!(yield* fs.exists(staged(target)))) continue;
    const dest = staged(file);
    if (yield* fs.exists(dest)) continue;
    yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
    yield* fs.symlink(path.relative(path.dirname(dest), staged(target)), dest);
  }
  if (props.static !== undefined) {
    const { makeNodeServeEntrySource } = yield* loadFrontendCore;
    const client = path.relative(directory, staged(dist)).replaceAll("\\", "/");
    yield* fs.writeFileString(
      path.join(directory, "server.mjs"),
      makeNodeServeEntrySource({
        ...props.static,
        clientDirExpression: `fileURLToPath(new URL(${JSON.stringify(`./${client}/`)}, import.meta.url))`,
      }),
    );
    return { directory, entrypoint: "server.mjs", requiredFiles: [] };
  }
  if (entry === undefined) return yield* fail("Missing website server entry.");
  const entryRelative = path
    .relative(directory, staged(entry))
    .replaceAll("\\", "/");
  const cwdRelative = path
    .relative(directory, staged(root))
    .replaceAll("\\", "/");
  yield* fs.makeDirectory(staged(root), { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "server.mjs"),
    [
      'import { fileURLToPath } from "node:url";',
      `process.chdir(fileURLToPath(new URL(${JSON.stringify(`./${cwdRelative}/`)}, import.meta.url)));`,
      `await import(new URL(${JSON.stringify(`./${entryRelative}`)}, import.meta.url).href);`,
      "",
    ].join("\n"),
  );
  return {
    directory,
    entrypoint: "server.mjs",
    requiredFiles: [entryRelative],
  };
});

export const WebsiteArtifactProvider = () =>
  Provider.effect(
    WebsiteArtifact,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotAlchemy = yield* dotAlchemyDirectory;
      return {
        list: () => Effect.succeed([]),
        // Traced dependencies can change independently of the framework's hash.
        diff: () => Effect.succeed({ action: "update" as const }),
        reconcile: Effect.fn(function* ({ id, news }) {
          const name = yield* createPhysicalName({ id, maxLength: 80 });
          const directory = path.join(dotAlchemy, "prisma-websites", name);
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const staged = yield* stageWebsiteArtifact(news);
              const archive = yield* createComputeArchive({
                ...staged,
                output: "file",
              });
              return yield* Effect.gen(function* () {
                yield* fs.makeDirectory(directory, { recursive: true });
                const artifactPath = path.join(
                  directory,
                  `${archive.sha256}.tar.gz`,
                );
                yield* fs.copyFile(archive.path, artifactPath);
                for (const old of yield* fs.readDirectory(directory)) {
                  if (
                    old !== path.basename(artifactPath) &&
                    /^[a-f0-9]{64}\.tar\.gz$/.test(old)
                  ) {
                    yield* fs.remove(path.join(directory, old), {
                      force: true,
                    });
                  }
                }
                return { directory, artifactPath, hash: archive.sha256 };
              }).pipe(Effect.ensuring(archive.cleanup));
            }),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* fs.remove(output.directory, { recursive: true, force: true });
        }),
      };
    }),
  );
