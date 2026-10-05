import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type { PlatformError } from "effect/PlatformError";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { createPhysicalName } from "../../PhysicalName.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { initialCwd } from "../../Util/Node.ts";
import { sha256 } from "../../Util/sha256.ts";
import { zipFiles, type ZipFile } from "../../Util/zip.ts";
import { packSiteExtraFiles } from "../../Website/packExtraFiles.ts";
import { validateFunctionZip } from "../FunctionArtifact.ts";
import { traceWebsiteFiles } from "./Trace.ts";
import { packageWebsiteInChild } from "./Package.ts";
import {
  nativeArtifactError,
  neonRuntimeTarget as runtimeTarget,
} from "../NativeArtifact.ts";
import { loadFrontendCore } from "../../Website/FrontendCore.ts";

/** Build output staged after Website.Server finishes. */
export interface WebsiteArtifactProps {
  /** Application directory relative to the initial working directory. */
  root: string;
  /** Dedicated output directory, or the application root for Next.js. */
  distDir: string;
  /** Fetch entrypoint relative to the initial working directory. */
  serverEntry?: string;
  /** Static-file handler configuration, instead of a framework entrypoint. */
  static?: {
    /** Unmatched-path behavior. @default "none" */
    notFoundHandling?: "none" | "spa" | "404-page";
    /** Extensionless HTML behavior. @default "none" */
    htmlHandling?: "none" | "drop-trailing-slash";
    /** HTML file returned for misses, relative to output. @default "404.html" */
    errorPage?: string;
  };
  /** Next.js includes .next, public assets, and configuration. */
  layout?: "output" | "next";
  /** Build dependency fingerprint; traced dependencies are also hashed. */
  buildHash?: string;
}

/** Filesystem-only staging lifecycle; never owns cloud resources. */
export interface WebsiteArtifact extends Resource<
  "Neon.WebsiteArtifact",
  WebsiteArtifactProps,
  {
    /** Private directory owned by this artifact resource. */
    directory: string;
    /** Validated, deterministic Function ZIP. */
    artifactPath: string;
    /** SHA-256 of the complete ZIP, including traced dependencies. */
    hash: string;
  }
> {}

export const WebsiteArtifact = Resource<WebsiteArtifact>(
  "Neon.WebsiteArtifact",
);

/** Packaging failed before any Function deployment. */
export class WebsiteArtifactError extends Data.TaggedError(
  "WebsiteArtifactError",
)<{
  /** Sanitized explanation of the unsupported or unsafe artifact. */
  message: string;
}> {}

const MAX_ENTRIES = 50_000;
const MAX_BYTES = 250 * 1024 * 1024;
const excluded = (file: string) =>
  file
    .split(/[\\/]/)
    .some(
      (part) =>
        /^(?:\.git|\.alchemy|\.env.*|\.npmrc|\.yarnrc.*|\.netrc|\.pypirc|\.aws|\.ssh|credentials(?:\.json)?|service-account.*\.json|id_rsa|id_ed25519)$/.test(
          part,
        ) || /\.(?:pem|key|p12|pfx)$/.test(part),
    );
const sourceOnly = (file: string) => /(?:\.map|\.d\.[cm]?ts)$/.test(file);
const native = (file: string) =>
  /\.(?:node|dylib|dll|so(?:\.\d+)*)$/.test(file);
const javascript = (file: string) => /\.[cm]?[jt]sx?$/.test(file);
const nextExcluded = (relative: string) =>
  /^\.next\/(?:cache|standalone|types|diagnostics|dev)(?:\/|$)/.test(
    relative,
  ) || /^\.next\/trace(?:-|$)/.test(relative);
const fail = (message: string) =>
  Effect.fail(new WebsiteArtifactError({ message }));

const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
interface PackageManifest {
  name?: string;
  version?: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  optionalDependencies?: Record<string, string>;
}
const compatible = (manifest: PackageManifest) =>
  Object.entries(runtimeTarget).every(([key, value]) => {
    const field = manifest[key as keyof typeof runtimeTarget];
    return (
      field === undefined ||
      (Array.isArray(field) &&
        field.every((item) => typeof item === "string") &&
        !field.includes(`!${value}`) &&
        (field.every((item) => item.startsWith("!")) || field.includes(value)))
    );
  });

const validateBinary = (file: string, content: Uint8Array) => {
  const message = nativeArtifactError(file, content);
  if (message) throw new WebsiteArtifactError({ message });
};

/** Fetch only an exact platform package; never re-resolve the application's dependency graph. */
const platformPackage = Effect.fn(
  function* (name: string, version: string) {
    if (
      !/^@img\/sharp-(?:libvips-)?linux-arm64$/.test(name) ||
      !exactVersion.test(version)
    )
      return yield* fail(
        "Sharp must declare exact Linux ARM64 platform package versions.",
      );
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    );
    const metadataResponse = yield* client.get(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`,
    );
    const metadata = (yield* metadataResponse.json) as PackageManifest & {
      dist?: { integrity?: string; tarball?: string };
    };
    if (
      metadata.name !== name ||
      metadata.version !== version ||
      !compatible(metadata) ||
      !metadata.dist?.integrity?.match(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
    )
      return yield* fail(
        `Invalid registry identity or integrity for ${name}@${version}.`,
      );
    const url = yield* Effect.try({
      try: () => new URL(metadata.dist!.tarball!),
      catch: () =>
        new WebsiteArtifactError({
          message: "Invalid platform package tarball URL.",
        }),
    });
    if (
      url.origin !== "https://registry.npmjs.org" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/${name}/-/${name.split("/")[1]}-${version}.tgz`
    )
      return yield* fail(
        "Platform packages must use the canonical npm registry tarball.",
      );
    const response = yield* client.get(url.href);
    let compressedBytes = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        compressedBytes += chunk.length;
        return compressedBytes > MAX_BYTES
          ? fail("Platform tarball exceeds its byte limit.")
          : Effect.succeed(chunk);
      }),
      Stream.runCollect,
      Effect.map((chunks) => [...chunks]),
    );
    const files = yield* Effect.try({
      try: () => {
        const compressed = Buffer.concat(chunks);
        const integrity = `sha512-${createHash("sha512").update(compressed).digest("base64")}`;
        if (integrity !== metadata.dist!.integrity)
          throw new Error("Registry integrity mismatch");
        const tar = gunzipSync(compressed, { maxOutputLength: MAX_BYTES });
        const files = new Map<string, Uint8Array>();
        const text = (start: number, size: number) =>
          new TextDecoder()
            .decode(tar.subarray(start, start + size))
            .replace(/\0.*$/s, "");
        let entries = 0;
        for (let offset = 0; offset < tar.length;) {
          if (++entries > MAX_ENTRIES) throw new Error("Too many tar entries");
          if (tar.subarray(offset, offset + 512).every((byte) => byte === 0))
            break;
          if (offset + 512 > tar.length)
            throw new Error("Truncated tar header");
          const header = tar.subarray(offset, offset + 512);
          const checksum = Number.parseInt(text(offset + 148, 8).trim(), 8);
          const actual = header.reduce(
            (sum, byte, index) =>
              sum + (index >= 148 && index < 156 ? 32 : byte),
            0,
          );
          if (checksum !== actual) throw new Error("Invalid tar checksum");
          const prefix = text(offset + 345, 155);
          const entry = `${prefix ? `${prefix}/` : ""}${text(offset, 100)}`;
          const sizeText = text(offset + 124, 12).trim();
          if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid tar size");
          const size = Number.parseInt(sizeText, 8);
          const type = header[156];
          if (
            !entry.startsWith("package/") ||
            entry.includes("\\") ||
            entry
              .replace(/\/$/, "")
              .split("/")
              .some((part) => !part || part === ".." || part === ".") ||
            excluded(entry)
          )
            throw new Error("Unsafe tar path");
          if (![0, 48, 53].includes(type!))
            throw new Error("Non-regular tar entry");
          if (
            !Number.isSafeInteger(size) ||
            size < 0 ||
            offset + 512 + size > tar.length
          )
            throw new Error("Truncated tar entry");
          if (type !== 53) {
            const file = entry.slice(8);
            if (!file || files.has(file) || files.size >= MAX_ENTRIES)
              throw new Error("Invalid tar entries");
            const content = tar.subarray(offset + 512, offset + 512 + size);
            validateBinary(file, content);
            files.set(file, content);
          }
          offset += 512 + Math.ceil(size / 512) * 512;
        }
        const manifest = JSON.parse(
          Buffer.from(files.get("package.json")!).toString("utf8"),
        ) as PackageManifest;
        if (
          manifest.name !== name ||
          manifest.version !== version ||
          !compatible(manifest)
        )
          throw new Error("Package identity or platform mismatch");
        if (![...files.keys()].some(native))
          throw new Error("Platform package contains no native library");
        return files;
      },
      catch: () =>
        new WebsiteArtifactError({
          message: `Failed integrity, archive, or Linux ARM64 validation for ${name}@${version}.`,
        }),
    });
    return files;
  },
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  Effect.timeout("45 seconds"),
);

/**
 * Preserve the traced module layout, materializing only selected symlink targets.
 * Node 24 resolution hooks restore canonical package identity without ZIP links.
 * The caller must archive the temporary directory before its Scope closes.
 */
export const stageWebsiteArtifact = Effect.fn(function* (
  props: WebsiteArtifactProps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(path.resolve(initialCwd, props.root));
  const dist = yield* fs.realPath(path.resolve(initialCwd, props.distDir));
  const entry =
    props.serverEntry === undefined
      ? undefined
      : yield* fs.realPath(path.resolve(initialCwd, props.serverEntry));
  const within = (directory: string, file: string) => {
    const relative = path.relative(directory, file);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  if (!entry && !props.static)
    return yield* fail("A Fetch entrypoint or static options are required.");
  if (props.layout !== "next" && root === dist)
    return yield* fail(
      "Output must be a dedicated directory, not the application root.",
    );
  if (!within(root, dist))
    return yield* fail("Website output must be inside the application root.");
  if (entry && !within(props.layout === "next" ? root : dist, entry))
    return yield* fail("Fetch entrypoint escapes the build output.");
  if (
    props.static?.errorPage &&
    (path.isAbsolute(props.static.errorPage) ||
      !within(dist, path.resolve(dist, props.static.errorPage)))
  )
    return yield* fail("Error page escapes the build output.");
  const standaloneConfig =
    props.layout === "next" &&
    entry !== undefined &&
    (yield* fs.readFileString(entry)).includes(
      "__NEXT_PRIVATE_STANDALONE_CONFIG",
    );
  const files = new Set<string>(entry ? [entry] : []);
  const seeds = new Set<string>(entry ? [entry] : []);
  const manifests: string[] = [];
  let visited = 0;
  const collect: (
    source: string,
    boundary?: string,
    ancestors?: ReadonlySet<string>,
    runtimePackage?: boolean,
  ) => Effect.Effect<void, WebsiteArtifactError | PlatformError> = Effect.fn(
    function* (
      source,
      boundary,
      ancestors = new Set(),
      runtimePackage = false,
    ) {
      if (++visited > MAX_ENTRIES)
        return yield* fail("Website exceeds the 50,000-entry safety limit.");
      const relative = path.relative(root, source).replaceAll("\\", "/");
      if (
        excluded(source) ||
        sourceOnly(source) ||
        (props.layout === "next" && nextExcluded(relative))
      )
        return;
      const real = yield* fs.realPath(source);
      if (excluded(real))
        return yield* fail("An output symlink targets a sensitive file.");
      if (!within(boundary ?? real, real))
        return yield* fail("An output symlink escapes its selected directory.");
      const stat = yield* fs.stat(real);
      if (stat.type === "Directory") {
        if (ancestors.has(real)) return yield* fail("Cyclic output symlink.");
        const next = new Set([...ancestors, real]);
        for (const name of (yield* fs.readDirectory(source)).sort()) {
          if (name !== "node_modules")
            yield* collect(
              path.join(source, name),
              boundary ?? real,
              next,
              runtimePackage,
            );
        }
      } else if (stat.type === "File") {
        files.add(source);
        if (!runtimePackage && !props.static && javascript(source))
          seeds.add(source);
        if (props.layout === "next" && source.endsWith(".nft.json"))
          manifests.push(source);
      } else return yield* fail("Website output contains a non-regular file.");
    },
  );
  const extras = yield* packSiteExtraFiles(
    props.layout === "next" ? root : dist,
    props.layout === "next" ? "next" : "client",
  );
  if (
    props.layout === "next" &&
    !(yield* fs.exists(path.join(root, ".next", "BUILD_ID")))
  )
    return yield* fail("Next.js output is missing .next/BUILD_ID.");
  for (const extra of extras ?? []) {
    if (standaloneConfig && /^next\.config\./.test(path.basename(extra.source)))
      continue;
    yield* collect(extra.source);
  }
  let nextPackageRoot: string | undefined;
  if (props.layout === "next") {
    for (const name of ["next.config.mts", "next.config.cts"]) {
      const config = path.join(root, name);
      if (!standaloneConfig && (yield* fs.exists(config)))
        yield* collect(config);
    }
    const nextPackage = yield* Effect.try(() =>
      createRequire(path.join(root, "package.json")).resolve(
        "next/package.json",
      ),
    );
    nextPackageRoot = path.dirname(nextPackage);
    // Next's runtime alias tables are not statically evaluable by NFT.
    yield* collect(nextPackageRoot, undefined, undefined, true);
  }
  for (const manifest of manifests) {
    const text = yield* fs.readFileString(manifest);
    const parsed = yield* Effect.try(
      () => JSON.parse(text) as { files?: unknown },
    );
    if (
      !Array.isArray(parsed.files) ||
      !parsed.files.every((file): file is string => typeof file === "string")
    )
      return yield* fail("Invalid Next.js dependency manifest.");
    for (const file of parsed.files) {
      const source = path.resolve(path.dirname(manifest), file);
      if (excluded(source))
        return yield* fail("A Next.js trace selects a sensitive file.");
      if (sourceOnly(source)) continue;
      files.add(source);
    }
  }
  let workspace = root;
  for (let candidate = root; ; candidate = path.dirname(candidate)) {
    if (yield* fs.exists(path.join(candidate, "pnpm-workspace.yaml"))) {
      workspace = candidate;
      break;
    }
    if (candidate === path.dirname(candidate)) break;
  }
  const traceBase = path.parse(root).root;
  const tracedFiles =
    seeds.size === 0
      ? []
      : yield* traceWebsiteFiles({
          seeds: [...seeds],
          base: traceBase,
          root,
          next: props.layout === "next",
        }).pipe(
          Effect.timeout("60 seconds"),
          Effect.mapError(
            () =>
              new WebsiteArtifactError({
                message:
                  "Runtime tracing failed. Node 24 and @vercel/nft are required in the deployment workspace.",
              }),
          ),
        );
  for (const file of tracedFiles)
    if (!sourceOnly(file)) files.add(path.resolve(traceBase, file));
  if (files.size > MAX_ENTRIES)
    return yield* fail("Dependency trace exceeds the 50,000-entry limit.");
  const selected = new Set<string>();
  const links = new Map<string, string>();
  const generated = new Map<string, Uint8Array>();
  const replaced = new Set<string>();
  const packageRoot = (file: string) => {
    const parts = file.split(path.sep);
    const index = parts.lastIndexOf("node_modules");
    if (index < 0 || !parts[index + 1]) return undefined;
    return parts
      .slice(0, index + (parts[index + 1]!.startsWith("@") ? 3 : 2))
      .join(path.sep);
  };
  const sharpRoots = new Set<string>();
  for (const file of files) {
    const real = yield* fs.realPath(file);
    const pkg = packageRoot(real);
    // Metadata-only trace entries do not load Sharp's native runtime.
    if (pkg && path.basename(pkg) === "sharp" && javascript(real))
      sharpRoots.add(pkg);
  }
  for (const sharpRoot of sharpRoots) {
    if (!within(workspace, sharpRoot))
      return yield* fail("Sharp escapes the application workspace.");
    const installed = yield* fs.readFileString(
      path.join(sharpRoot, "package.json"),
    );
    const sharp = yield* Effect.try(
      () => JSON.parse(installed) as PackageManifest,
    );
    const packages = [
      "@img/sharp-linux-arm64",
      "@img/sharp-libvips-linux-arm64",
    ];
    for (const name of packages) {
      const version = sharp.optionalDependencies?.[name];
      if (!version || !exactVersion.test(version))
        return yield* fail(
          "This Sharp version does not declare exact Linux ARM64 prebuilt packages.",
        );
      const targetFiles = yield* platformPackage(name, version);
      for (const [file, content] of targetFiles)
        generated.set(path.join(path.dirname(sharpRoot), name, file), content);
    }
    // Only discard platform variants after their exact target replacements validated.
    for (const name of Object.keys(sharp.optionalDependencies ?? {})) {
      if (!name.startsWith("@img/sharp-")) continue;
      const alias = path.join(path.dirname(sharpRoot), name);
      replaced.add(alias);
      if (yield* fs.exists(alias)) replaced.add(yield* fs.realPath(alias));
    }
  }
  const isReplaced = (file: string) =>
    [...replaced].some((pkg) => within(pkg, file));
  for (const file of files) {
    const real = yield* fs.realPath(file);
    if (!within(workspace, file) || !within(workspace, real))
      return yield* fail(
        "A traced dependency escapes the application workspace.",
      );
    if (excluded(file) || excluded(real)) {
      const sensitive = path
        .relative(workspace, excluded(file) ? file : real)
        .replaceAll("\\", "/")
        .replace(/[^a-zA-Z0-9_./@+-]/g, "_");
      return yield* fail(
        `A traced dependency selects a sensitive file: ${sensitive}`,
      );
    }
    if (isReplaced(file) || isReplaced(real)) continue;
    const stat = yield* fs.stat(real);
    if (stat.type === "File") selected.add(real);
    else if (stat.type !== "Directory" || file === real)
      return yield* fail("A traced dependency is not a regular file.");
    if (file !== real) links.set(file, real);
  }
  if (nextPackageRoot)
    links.set(path.join(root, "node_modules/next"), nextPackageRoot);
  let base = root;
  for (const file of [
    ...selected,
    ...generated.keys(),
    ...links.keys(),
    ...links.values(),
  ])
    while (!within(base, file)) base = path.dirname(base);
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-neon-website-",
  });
  const relative = (file: string) =>
    path.join("files", path.relative(base, file)).replaceAll("\\", "/");
  const staged = (file: string) => path.join(directory, relative(file));
  let bytes = 0;
  let entries = 0;
  const copy = Effect.fn(function* (source: string, dest: string) {
    if (yield* fs.exists(dest)) return;
    const info = yield* fs.stat(source);
    bytes += Number(info.size);
    if (++entries > MAX_ENTRIES || bytes > MAX_BYTES)
      return yield* fail(
        "Materialized artifact exceeds its entry or expanded byte limit.",
      );
    const content = yield* fs.readFile(source);
    yield* Effect.try({
      try: () => validateBinary(path.relative(workspace, source), content),
      catch: (error) =>
        error instanceof WebsiteArtifactError
          ? error
          : new WebsiteArtifactError({ message: "Native validation failed." }),
    });
    if (native(source)) {
      const pkg = packageRoot(source);
      if (pkg && (yield* fs.exists(path.join(pkg, "package.json")))) {
        const text = yield* fs.readFileString(path.join(pkg, "package.json"));
        const manifest = yield* Effect.try(
          () => JSON.parse(text) as PackageManifest,
        );
        if (!compatible(manifest))
          return yield* fail("Native package excludes Linux ARM64 glibc.");
      }
    }
    yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
    yield* fs.writeFile(dest, content);
    yield* fs.chmod(dest, info.mode & 0o777);
  });
  for (const [file, content] of generated) {
    bytes += content.length;
    if (++entries > MAX_ENTRIES || bytes > MAX_BYTES)
      return yield* fail(
        "Materialized artifact exceeds its entry or expanded byte limit.",
      );
    yield* fs.makeDirectory(path.dirname(staged(file)), { recursive: true });
    yield* fs.writeFile(staged(file), content);
  }
  const sorted = [...selected].sort();
  for (const file of sorted) yield* copy(file, staged(file));
  // Workspace packages and npm aliases cannot self-resolve from a canonical node_modules name.
  for (const [alias, target] of links) {
    const parts = alias.split(path.sep);
    const index = parts.lastIndexOf("node_modules");
    const name = parts.slice(index + 1).join(path.sep);
    if (
      index < 0 ||
      target.endsWith(`${path.sep}node_modules${path.sep}${name}`)
    )
      continue;
    if (selected.has(target)) yield* copy(target, staged(alias));
    else
      for (const file of sorted)
        if (within(target, file))
          yield* copy(
            file,
            path.join(staged(alias), path.relative(target, file)),
          );
  }
  if (props.static) {
    const { makeNeonServeEntrySource } = yield* loadFrontendCore;
    let source = makeNeonServeEntrySource({
      ...props.static,
      clientDirExpression: `fileURLToPath(new URL(${JSON.stringify(`./${relative(dist)}/`)}, import.meta.url))`,
    });
    if (props.static.errorPage)
      source = source.replace(
        'lookup("/404.html")',
        `lookup(${JSON.stringify(`/${props.static.errorPage}`)})`,
      );
    yield* fs.writeFileString(path.join(directory, "index.mjs"), source);
  } else {
    if (!entry) return yield* fail("Missing Fetch entrypoint.");
    const aliases = [...links]
      .map(([alias, target]) => [relative(alias), relative(target)])
      .sort(([a], [b]) => b!.length - a!.length);
    yield* fs.makeDirectory(staged(root), { recursive: true });
    yield* fs.writeFileString(
      path.join(directory, "index.mjs"),
      [
        'import { registerHooks, createRequire } from "node:module";',
        'import { fileURLToPath } from "node:url";',
        `const aliases = ${JSON.stringify(aliases)}.map(([from, to]) => [new URL(from, import.meta.url).href, new URL(to, import.meta.url).href]);`,
        'const canonical = url => { for (const [from, to] of aliases) if (url === from || url.startsWith(from + "/")) return to + url.slice(from.length); return url; };',
        "registerHooks({ resolve(specifier, context, next) {",
        '  if (context.parentURL && !specifier.startsWith("node:") && !specifier.startsWith("#")) {',
        '    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {',
        "      const url = new URL(specifier, context.parentURL).href; const mapped = canonical(url); if (mapped !== url) return next(mapped, context);",
        '    } else if (!specifier.includes(":")) {',
        '      const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");',
        '      if (aliases.some(([, target]) => target.endsWith("/node_modules/" + name) && context.parentURL.startsWith(target + "/"))) return next(specifier, context);',
        '      for (let dir = new URL(".", context.parentURL); ; dir = new URL("..", dir)) {',
        '        const candidate = new URL("node_modules/" + name, dir).href;',
        "        const target = aliases.find(([from]) => from === candidate)?.[1];",
        '        if (target?.endsWith("/node_modules/" + name)) { if (context.parentURL.startsWith(target + "/")) return next(specifier, context); const parentURL = target + "/__alchemy_resolve__.mjs"; return context.conditions.includes("require") ? next(createRequire(parentURL).resolve(specifier), context) : next(specifier, { ...context, parentURL }); }',
        '        if (new URL("..", dir).href === dir.href) break;',
        "      }",
        "    }",
        "  }",
        "  const result = next(specifier, context); return { ...result, url: canonical(result.url) };",
        "} });",
        `process.chdir(fileURLToPath(new URL(${JSON.stringify(`./${relative(root)}/`)}, import.meta.url)));`,
        `const entry = await import(new URL(${JSON.stringify(`./${relative(entry)}`)}, import.meta.url).href);`,
        "export default entry.default;",
        "",
      ].join("\n"),
    );
  }
  return { directory };
});

/** Package a staging tree deterministically after all dependency changes. */
export const packageWebsiteArtifact = Effect.fn(function* (
  props: WebsiteArtifactProps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { directory } = yield* stageWebsiteArtifact(props);
  const files: ZipFile[] = [];
  const walk: (relative: string) => Effect.Effect<void, PlatformError> =
    Effect.fn(function* (relative) {
      for (const name of (yield* fs.readDirectory(
        path.join(directory, relative),
      )).sort()) {
        const file = path.join(relative, name);
        const absolute = path.join(directory, file);
        const stat = yield* fs.stat(absolute);
        if (stat.type === "Directory") yield* walk(file);
        else
          files.push({
            path: file.replaceAll("\\", "/"),
            content: yield* fs.readFile(absolute),
            mode: 0o100000 | (stat.mode & 0o777),
          });
      }
    });
  yield* walk("");
  const archive = yield* zipFiles(files);
  yield* validateFunctionZip(archive);
  return { archive, hash: yield* sha256(archive) };
});

export const WebsiteArtifactProvider = () =>
  Provider.effect(
    WebsiteArtifact,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      return {
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output)
            return { action: "update" as const };
          if (!(yield* fs.exists(output.artifactPath)))
            return { action: "update" as const };
          if (
            (yield* sha256(yield* fs.readFile(output.artifactPath))) !==
            output.hash
          )
            return { action: "update" as const };
          // Dependencies outside the framework root can change without its build hash.
          const { hash } = yield* packageWebsiteInChild(news).pipe(
            Effect.scoped,
          );
          return {
            action:
              hash === output.hash ? ("noop" as const) : ("update" as const),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news }) {
          const name = yield* createPhysicalName({ id, maxLength: 80 });
          const directory = path.join(
            initialCwd,
            ".alchemy",
            "neon-websites",
            name,
          );
          const { archive, hash } = yield* packageWebsiteInChild(news).pipe(
            Effect.scoped,
          );
          yield* fs.makeDirectory(directory, { recursive: true });
          const artifactPath = path.join(directory, `${hash}.zip`);
          yield* fs.writeFile(artifactPath, archive);
          for (const old of yield* fs.readDirectory(directory))
            if (/^[a-f0-9]{64}\.zip$/.test(old) && old !== `${hash}.zip`)
              yield* fs.remove(path.join(directory, old), { force: true });
          return { directory, artifactPath, hash };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* fs.remove(output.directory, { recursive: true, force: true });
        }),
      };
    }),
  );
