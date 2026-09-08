import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { constants as fsConstants } from "node:fs";
import { builtinModules } from "node:module";
import { parse as parseYaml } from "yaml";
import { exec } from "../Util/exec.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import { BundleError } from "./Bundle.ts";

export interface InstalledPackageFile {
  readonly path: string;
  readonly content: Uint8Array<ArrayBufferLike>;
  /** Complete Unix mode, including the file type bits. */
  readonly mode?: number;
}

type JsonRecord = Record<string, unknown>;

export type PackageInstall =
  | ReadonlyArray<string>
  | Readonly<Record<string, string>>;

export type NpmInstallRunner = (
  directory: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<void, unknown>;

export interface ResolveInstallTargetsOptions {
  readonly cwd: string;
  /** Normalized package-root → requested version map (from {@link normalizeInstallTargets}). */
  readonly requested: Readonly<Record<string, string>>;
}

export type PackageOverride = string | PackageOverrideMap;

export interface PackageOverrideMap {
  readonly [dependencyName: string]: PackageOverride;
}

export type PackageOverrides = Readonly<Record<string, PackageOverride>>;

export interface PackageInstallPlan {
  readonly resolved: Readonly<Record<string, string>>;
  readonly overrides: PackageOverrides;
}

export interface PackageInstallIdentity extends PackageInstallPlan {
  readonly lockfile?: {
    readonly name: string;
    readonly hash: string;
  };
}

export interface HashPackageInstallIdentityOptions {
  readonly bundleHash: string;
  readonly identity: PackageInstallIdentity;
  readonly architecture: "x86_64" | "arm64";
}

export interface InstallResolvedPackagesOptions {
  /** Package-root → concrete npm version map (from {@link resolveInstallTargets}). */
  readonly resolved: Readonly<Record<string, string>>;
  /** Locked parent-package → child-package versions used to pin transitives. */
  readonly overrides?: PackageOverrides;
  readonly architecture: "x86_64" | "arm64";
  readonly runNpmInstall?: NpmInstallRunner;
}

export interface InstallPackagesOptions {
  readonly cwd: string;
  readonly install?: PackageInstall;
  readonly architecture: "x86_64" | "arm64";
  readonly runNpmInstall?: NpmInstallRunner;
}

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly catalog?: Record<string, string>;
  readonly catalogs?: Record<string, Record<string, string>>;
  readonly workspaces?: unknown;
}

interface CatalogSource {
  readonly catalog?: Record<string, string>;
  readonly catalogs?: Record<string, Record<string, string>>;
}

const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);

/**
 * Unix mode for symlink entries in the ZIP archive. Effect's FileSystem
 * exposes `readLink` but not `lstat`, so the symlink type bits must be
 * synthesized after identifying a link. The permission bits are conventional
 * for symlinks and are ignored by Unix filesystems.
 */
const symbolicLinkMode = fsConstants.S_IFLNK | 0o777;

const incompatibleVersionPrefixes = [
  "workspace:",
  "file:",
  "link:",
  "portal:",
  "patch:",
] as const;

const lockfileNames = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

/**
 * Parses a module specifier into its package root, or `undefined` when the
 * specifier is not a bare package import (relative path, builtin, glob, subpath
 * imports, etc.).
 */
export function parsePackageRoot(specifier: string): string | undefined {
  const root = parsePackageRootFromSpecifier(specifier);
  return root === specifier ? root : undefined;
}

/**
 * Parses a bare package specifier or subpath import into its package root.
 */
export function parsePackageRootFromSpecifier(
  specifier: string,
): string | undefined {
  if (
    specifier.length === 0 ||
    builtins.has(specifier) ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.includes("*") ||
    specifier.includes("?") ||
    specifier.includes(":") ||
    specifier.includes("\0")
  ) {
    return undefined;
  }

  const segments = specifier.split("/");
  if (specifier.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0];
}

/** Whether `moduleId` is `root` itself or a subpath import of it. */
export function matchesPackageRoot(moduleId: string, root: string): boolean {
  return moduleId === root || moduleId.startsWith(`${root}/`);
}

export function npmInstallArgs(
  architecture: "x86_64" | "arm64",
): ReadonlyArray<string> {
  return npmCommandArgs("ci", architecture);
}

export function npmLockfileArgs(
  architecture: "x86_64" | "arm64",
): ReadonlyArray<string> {
  return [
    ...npmCommandArgs("install", architecture),
    "--package-lock-only",
    "--ignore-scripts",
  ];
}

export function npmPlainInstallArgs(
  architecture: "x86_64" | "arm64",
): ReadonlyArray<string> {
  return npmCommandArgs("install", architecture);
}

const npmCommandArgs = (
  command: "ci" | "install",
  architecture: "x86_64" | "arm64",
): ReadonlyArray<string> => {
  const npmArchitecture = architecture === "arm64" ? "arm64" : "x64";
  return [
    command,
    "--force",
    "--platform=linux",
    "--os=linux",
    `--arch=${npmArchitecture}`,
    `--cpu=${npmArchitecture}`,
    "--libc=glibc",
  ];
};

/**
 * Normalizes and validates a `build.install` declaration to a
 * package-root → requested-version map. Array entries default to `"*"`.
 */
export function normalizeInstallTargets(
  install: PackageInstall | undefined,
): Effect.Effect<Record<string, string>, BundleError> {
  if (!install) return Effect.succeed({});
  const entries: ReadonlyArray<readonly [string, string]> = Array.isArray(
    install,
  )
    ? install.map((dep) => [dep, "*"] as const)
    : Object.entries(install);

  const requested: Record<string, string> = {};
  for (const [dep, version] of entries) {
    const root = parsePackageRoot(dep);
    if (root === undefined) {
      return Effect.fail(
        new BundleError({
          message: `Invalid package name '${dep}' in build.install. Use a package root like 'sharp', not a subpath or bare specifier.`,
        }),
      );
    }
    requested[root] = version;
  }
  return Effect.succeed(requested);
}

/**
 * Resolves the npm-compatible version for every requested package, reading the
 * nearest source `package.json` and pnpm/Bun catalogs. Does not run npm.
 */
export function resolveInstallTargets(
  options: ResolveInstallTargetsOptions,
): Effect.Effect<
  Record<string, string>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  return resolvePackageInstallPlan(options).pipe(
    Effect.map((plan) => ({ ...plan.resolved })),
  );
}

export function resolvePackageInstallPlan(
  options: ResolveInstallTargetsOptions,
): Effect.Effect<
  PackageInstallPlan,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  const packageNames = Object.keys(options.requested).sort();
  if (packageNames.length === 0) {
    return Effect.succeed({ resolved: {}, overrides: {} });
  }

  return Effect.gen(function* () {
    const sourcePackageJson = yield* readSourcePackageJson(options.cwd);
    const resolved: Record<string, string> = {};
    for (const packageName of packageNames) {
      resolved[packageName] = yield* resolveInstallVersion(
        options.cwd,
        sourcePackageJson,
        packageName,
        options.requested[packageName],
      );
    }
    const lockfilePath = yield* findUp(options.cwd, lockfileNames);
    if (lockfilePath === undefined) {
      return { resolved, overrides: {} };
    }
    return yield* pinInstallVersionsFromLockfile({
      cwd: options.cwd,
      lockfilePath,
      packageJson: sourcePackageJson,
      requested: options.requested,
      resolved,
    });
  }).pipe(Effect.mapError(toBundleError));
}

/**
 * Resolves the package install identity used by Lambda diffing. The lockfile
 * fingerprint makes range-preserving dependency updates trigger a new artifact.
 */
export function resolvePackageInstallIdentity(
  options: ResolveInstallTargetsOptions,
): Effect.Effect<
  PackageInstallIdentity,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const plan = yield* resolvePackageInstallPlan(options);
    if (Object.keys(plan.resolved).length === 0) {
      return plan;
    }
    const lockfile = yield* readNearestLockfileFingerprint(options.cwd);
    return { ...plan, lockfile };
  });
}

export function hashPackageInstallIdentity(
  options: HashPackageInstallIdentityOptions,
): Effect.Effect<string> {
  return sha256Object({
    bundle: options.bundleHash,
    install: options.identity.resolved,
    overrides: options.identity.overrides,
    lockfile: options.identity.lockfile,
    architecture: options.architecture,
  });
}

/**
 * Installs already-resolved dependencies into an isolated npm artifact targeting
 * Linux and the function's architecture, returning the artifact's files.
 */
export function installResolvedPackages(
  options: InstallResolvedPackagesOptions,
): Effect.Effect<
  ReadonlyArray<InstalledPackageFile>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  const packageNames = Object.keys(options.resolved).sort();
  if (packageNames.length === 0) return Effect.succeed([]);

  const runInstall = (
    directory: string,
    args: ReadonlyArray<string>,
  ): Effect.Effect<void, BundleError, ChildProcessSpawner> =>
    options.runNpmInstall === undefined
      ? runNpmInstall(directory, args)
      : options
          .runNpmInstall(directory, args)
          .pipe(Effect.mapError(toBundleError));

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;

    return yield* Effect.acquireUseRelease(
      fileSystem.makeTempDirectory({ prefix: "alchemy-lambda-packages-" }),
      (directory) =>
        Effect.gen(function* () {
          const hasOverrides =
            options.overrides !== undefined &&
            Object.keys(options.overrides).length > 0;
          const manifest = JSON.stringify(
            {
              private: true,
              dependencies: options.resolved,
              ...(hasOverrides ? { overrides: options.overrides } : {}),
            },
            null,
            2,
          );
          yield* fileSystem.writeFileString(
            pathService.join(directory, "package.json"),
            `${manifest}\n`,
          );
          if (hasOverrides) {
            // Generate a lock so `npm ci` reproduces the override-pinned graph.
            yield* runInstall(directory, npmLockfileArgs(options.architecture));
            yield* runInstall(directory, npmInstallArgs(options.architecture));
          } else {
            yield* runInstall(
              directory,
              npmPlainInstallArgs(options.architecture),
            );
          }
          return yield* readArtifactFiles(directory);
        }),
      (directory) =>
        fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore),
    );
  }).pipe(Effect.mapError(toBundleError));
}

/**
 * Convenience flow for callers that do not need to defer installation.
 */
export function installPackages(
  options: InstallPackagesOptions,
): Effect.Effect<
  ReadonlyArray<InstalledPackageFile>,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const requested = yield* normalizeInstallTargets(options.install);
    const plan = yield* resolvePackageInstallPlan({
      cwd: options.cwd,
      requested,
    });
    return yield* installResolvedPackages({
      ...plan,
      architecture: options.architecture,
      runNpmInstall: options.runNpmInstall,
    });
  });
}

const runNpmInstall = (
  directory: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, BundleError, ChildProcessSpawner> =>
  Effect.sync(() =>
    ChildProcess.setCwd(
      ChildProcess.make("npm", args, {
        shell: false,
        env: { ...process.env },
      }),
      directory,
    ),
  ).pipe(
    Effect.flatMap(exec),
    Effect.scoped,
    Effect.mapError((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return new BundleError({
        message: message.includes("ENOENT")
          ? "Failed to run 'npm install' for build.install: 'npm' was not found on PATH. build.install shells out to npm (even in Bun/pnpm projects), so Node.js/npm must be installed."
          : `Failed to run 'npm install' for build.install: ${message}`,
        cause,
      });
    }),
    Effect.flatMap(({ exitCode, stderr }) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new BundleError({
              message: `npm install for build.install failed with exit code ${exitCode}: ${stderr}`,
            }),
          ),
    ),
  );

const printBunBinaryLockfile = (
  lockfilePath: string,
): Effect.Effect<string, BundleError, ChildProcessSpawner> =>
  Effect.sync(() =>
    ChildProcess.make("bun", [lockfilePath], {
      shell: false,
      env: { ...process.env },
    }),
  ).pipe(
    Effect.flatMap(exec),
    Effect.scoped,
    Effect.mapError((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return new BundleError({
        message: message.includes("ENOENT")
          ? `Failed to inspect legacy Bun lockfile '${lockfilePath}': 'bun' was not found on PATH. Reading a binary bun.lockb shells out to bun; install Bun or migrate to the text-based bun.lock format.`
          : `Failed to inspect legacy Bun lockfile '${lockfilePath}'`,
        cause,
      });
    }),
    Effect.flatMap(({ exitCode, stdout, stderr }) =>
      exitCode === 0
        ? Effect.succeed(stdout)
        : Effect.fail(
            new BundleError({
              message: `Failed to inspect legacy Bun lockfile '${lockfilePath}': bun exited with code ${exitCode}: ${stderr}`,
            }),
          ),
    ),
  );

const readSourcePackageJson = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* fs.readFileString(path.join(cwd, "package.json"));
    return yield* Effect.try({
      try: () => JSON.parse(content) as PackageJson,
      catch: (cause) =>
        new BundleError({
          message: `Failed to parse package.json for Lambda externals from '${cwd}'`,
          cause,
        }),
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BundleError({
          message: `Failed to read package.json for Lambda externals from '${cwd}'`,
          cause,
        }),
    ),
  );

const resolveInstallVersion = (
  cwd: string,
  packageJson: PackageJson,
  packageName: string,
  installVersion: string | undefined,
) =>
  Effect.gen(function* () {
    let version = installVersion;
    if (version === undefined || version === "" || version === "*") {
      version =
        packageJson.dependencies?.[packageName] ??
        packageJson.optionalDependencies?.[packageName] ??
        packageJson.devDependencies?.[packageName] ??
        "*";
    }

    if (version.startsWith("catalog:")) {
      return yield* resolveCatalogVersion(cwd, packageName, version);
    }

    for (const prefix of incompatibleVersionPrefixes) {
      if (version.startsWith(prefix)) {
        return yield* Effect.fail(
          new BundleError({
            message: `External package '${packageName}' uses '${version}', which cannot be installed in an isolated Lambda artifact. Pin an npm-compatible version in package.json or build.install.`,
          }),
        );
      }
    }

    return version;
  });

const pinInstallVersionsFromLockfile = (options: {
  readonly cwd: string;
  readonly lockfilePath: string;
  readonly packageJson: PackageJson;
  readonly requested: Readonly<Record<string, string>>;
  readonly resolved: Readonly<Record<string, string>>;
}): Effect.Effect<
  PackageInstallPlan,
  BundleError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockfileName = path.basename(options.lockfilePath);
    const lockfileDirectory = path.dirname(options.lockfilePath);
    const importer = path
      .relative(lockfileDirectory, options.cwd)
      .replaceAll("\\", "/");
    const candidates = Object.keys(options.resolved).filter((packageName) => {
      const requested = options.requested[packageName];
      const declared = declaredPackageVersion(options.packageJson, packageName);
      return (
        declared !== undefined &&
        (requested === undefined ||
          requested === "" ||
          requested === "*" ||
          requested === declared)
      );
    });
    if (candidates.length === 0) {
      return { resolved: { ...options.resolved }, overrides: {} };
    }

    const content =
      lockfileName === "bun.lockb"
        ? yield* printBunBinaryLockfile(options.lockfilePath)
        : yield* fs.readFileString(options.lockfilePath).pipe(
            Effect.mapError(
              (cause) =>
                new BundleError({
                  message: `Failed to read package-manager lockfile for Lambda externals from '${options.cwd}'`,
                  cause,
                }),
            ),
          );
    const plan = yield* Effect.try({
      try: () =>
        parseLockedInstallPlan({
          name: lockfileName === "bun.lockb" ? "yarn.lock" : lockfileName,
          content,
          importer,
          candidates,
          packageJson: options.packageJson,
          resolved: Object.fromEntries(
            Object.entries(options.resolved).filter(
              ([packageName]) => !candidates.includes(packageName),
            ),
          ),
        }),
      catch: (cause) =>
        new BundleError({
          message: `Failed to resolve locked Lambda package versions from '${options.lockfilePath}'`,
          cause,
        }),
    });

    for (const packageName of candidates) {
      if (plan.resolved[packageName] === undefined) {
        return yield* Effect.fail(
          new BundleError({
            message: `Could not resolve a locked version for '${packageName}' from '${options.lockfilePath}'. Pin an exact npm-compatible version in build.install or refresh the package-manager lockfile.`,
          }),
        );
      }
    }

    return plan;
  });

interface LockParseOptions {
  readonly name: string;
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
  readonly resolved: Readonly<Record<string, string>>;
}

type MutablePackageOverride = string | MutablePackageOverrideMap;
interface MutablePackageOverrideMap {
  [dependencyName: string]: MutablePackageOverride;
}
type MutablePackageOverrides = Record<string, MutablePackageOverride>;

interface LockedGraphRoot<Node> {
  readonly node: Node;
  readonly rootSelector: string;
}

interface LockedGraphDependency<Node> {
  readonly dependencyName: string;
  readonly installSpec: string;
  readonly node?: Node;
}

/**
 * Builds npm `overrides` pinning every dependency name reachable from each
 * root. npm override keys apply to the whole subtree below the matched
 * package (most-specific rule wins), so a name that resolves to a single
 * version anywhere under the root needs one flat rule. Nested rules are only
 * emitted along the branches where the lockfile resolves the same name to
 * different versions, which keeps the overrides object proportional to the
 * dependency graph instead of to its (potentially exponential) path count.
 */
const addLockedGraphOverrides = <Node>(
  overrides: MutablePackageOverrides,
  roots: ReadonlyArray<LockedGraphRoot<Node>>,
  nodeId: (node: Node) => unknown,
  dependencies: (node: Node) => ReadonlyArray<LockedGraphDependency<Node>>,
): void => {
  const edgeMemo = new Map<
    unknown,
    ReadonlyArray<LockedGraphDependency<Node>>
  >();
  const edgesOf = (node: Node): ReadonlyArray<LockedGraphDependency<Node>> => {
    const id = nodeId(node);
    let edges = edgeMemo.get(id);
    if (edges === undefined) {
      edges = dependencies(node);
      edgeMemo.set(id, edges);
    }
    return edges;
  };

  // name → set of install specs observed anywhere in the subtree (memoized).
  const specsMemo = new Map<
    unknown,
    ReadonlyMap<string, ReadonlySet<string>>
  >();
  const specsOf = (start: Node): ReadonlyMap<string, ReadonlySet<string>> => {
    const startId = nodeId(start);
    const memoized = specsMemo.get(startId);
    if (memoized !== undefined) return memoized;
    const specs = new Map<string, Set<string>>();
    const visited = new Set<unknown>([startId]);
    const queue: Node[] = [start];
    while (queue.length > 0) {
      const node = queue.pop()!;
      for (const edge of edgesOf(node)) {
        let set = specs.get(edge.dependencyName);
        if (set === undefined) {
          set = new Set();
          specs.set(edge.dependencyName, set);
        }
        set.add(edge.installSpec);
        if (edge.node === undefined) continue;
        const childId = nodeId(edge.node);
        if (visited.has(childId)) continue;
        visited.add(childId);
        queue.push(edge.node);
      }
    }
    specsMemo.set(startId, specs);
    return specs;
  };

  const asOverrideMap = (
    parent: MutablePackageOverrideMap,
    dependencyName: string,
  ): MutablePackageOverrideMap => {
    const existing = parent[dependencyName];
    if (typeof existing === "object") return existing;
    const record: MutablePackageOverrideMap = {};
    if (typeof existing === "string") record["."] = existing;
    parent[dependencyName] = record;
    return record;
  };

  // Resolves the still-conflicted names inside `node`'s subtree, nesting only
  // as deep as required to disambiguate. Names that stay ambiguous along an
  // identical override path are left unpinned (npm overrides cannot express
  // them); everything else is pinned exactly.
  const resolveConflicts = (
    out: MutablePackageOverrideMap,
    node: Node,
    conflicted: ReadonlySet<string>,
    path: ReadonlySet<unknown>,
  ): void => {
    const still = new Set<string>();
    const specs = specsOf(node);
    for (const name of conflicted) {
      const set = specs.get(name);
      if (set === undefined) continue;
      if (set.size === 1) {
        const spec = [...set][0]!;
        const existing = out[name];
        if (existing === undefined) out[name] = spec;
        else if (typeof existing === "object" && existing["."] === undefined) {
          existing["."] = spec;
        }
      } else {
        still.add(name);
      }
    }
    if (still.size === 0) return;
    for (const edge of edgesOf(node)) {
      // Pin the direct occurrence of a name that stays conflicted deeper down.
      if (still.has(edge.dependencyName)) {
        const record = asOverrideMap(out, edge.dependencyName);
        if (record["."] === undefined) record["."] = edge.installSpec;
      }
      if (edge.node === undefined) continue;
      const childId = nodeId(edge.node);
      if (path.has(childId)) continue;
      const childSpecs = specsOf(edge.node);
      if (![...still].some((name) => childSpecs.has(name))) continue;
      const record = asOverrideMap(out, edge.dependencyName);
      if (record["."] === undefined) record["."] = edge.installSpec;
      resolveConflicts(record, edge.node, still, new Set([...path, childId]));
    }
  };

  for (const { node, rootSelector } of roots) {
    const existing = overrides[rootSelector];
    const rootMap: MutablePackageOverrideMap =
      typeof existing === "object" ? existing : {};
    if (typeof existing === "string") rootMap["."] = existing;
    const specs = specsOf(node);
    if (specs.size === 0) continue;
    overrides[rootSelector] = rootMap;
    const conflicted = new Set<string>();
    for (const [name, set] of specs) {
      if (set.size === 1) rootMap[name] = [...set][0]!;
      else conflicted.add(name);
    }
    if (conflicted.size > 0) {
      resolveConflicts(rootMap, node, conflicted, new Set([nodeId(node)]));
    }
  }
};

const parseLockedInstallPlan = (
  options: LockParseOptions,
): PackageInstallPlan => {
  switch (options.name) {
    case "package-lock.json":
      return parsePackageLock(options);
    case "pnpm-lock.yaml":
      return parsePnpmLock(options);
    case "bun.lock":
      return parseBunLock(options);
    case "yarn.lock":
      return parseYarnLock(options);
    default:
      return { resolved: { ...options.resolved }, overrides: {} };
  }
};

const parsePackageLock = (options: {
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
  readonly resolved: Readonly<Record<string, string>>;
}): PackageInstallPlan => {
  const lockfile = asRecord(JSON.parse(options.content));
  const packages = asRecord(lockfile?.packages);
  const dependencies = asRecord(lockfile?.dependencies);
  const importerKey = options.importer === "." ? "" : options.importer;
  const importer = asRecord(packages?.[importerKey]);
  const resolved = { ...options.resolved };
  const overrides: MutablePackageOverrides = {};
  const roots: Array<LockedGraphRoot<string>> = [];

  for (const packageName of options.candidates) {
    const importerSpec = dependencyValue(importer, packageName);
    const declared = declaredPackageVersion(options.packageJson, packageName);
    if (
      importerSpec !== undefined &&
      declared !== undefined &&
      importerSpec !== declared
    ) {
      continue;
    }

    for (const packagePath of nodeModulesLookupPaths(
      importerKey,
      packageName,
    )) {
      const version = stringValue(asRecord(packages?.[packagePath])?.version);
      if (version !== undefined) {
        const entry = asRecord(packages?.[packagePath]);
        resolved[packageName] = npmLockedInstallSpec(
          packageName,
          entry,
          version,
        );
        roots.push({
          node: packagePath,
          rootSelector: `${stringValue(entry?.name) ?? packageName}@${version}`,
        });
        break;
      }
    }

    if (
      resolved[packageName] === options.resolved[packageName] &&
      importerKey === ""
    ) {
      const entry = asRecord(dependencies?.[packageName]);
      const version = stringValue(entry?.version);
      if (version !== undefined) {
        resolved[packageName] = npmLockedInstallSpec(
          packageName,
          entry,
          version,
        );
      }
    }
  }

  if (packages !== undefined) {
    addLockedGraphOverrides(
      overrides,
      roots,
      (packagePath) => packagePath,
      (packagePath) => {
        const value = packages[packagePath];
        const entry = asRecord(value);
        if (entry === undefined) return [];
        return Object.keys(dependencySpecifiers(entry)).flatMap(
          (dependencyName): ReadonlyArray<LockedGraphDependency<string>> => {
            const childPath = resolvePackageLockDependencyPath(
              packages,
              packagePath,
              dependencyName,
            );
            if (childPath === undefined) return [];
            const child = asRecord(packages[childPath]);
            const childVersion = stringValue(child?.version);
            if (childVersion === undefined) return [];
            return [
              {
                dependencyName,
                installSpec: npmLockedInstallSpec(
                  dependencyName,
                  child,
                  childVersion,
                ),
                node: childPath,
              },
            ];
          },
        );
      },
    );
  } else if (dependencies !== undefined) {
    addPackageLockV1Overrides(dependencies, overrides, options.candidates);
  }
  return { resolved, overrides };
};

const parsePnpmLock = (options: {
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
  readonly resolved: Readonly<Record<string, string>>;
}): PackageInstallPlan => {
  const lockfile = asRecord(parseYaml(options.content));
  const importers = asRecord(lockfile?.importers);
  const importerKey = options.importer === "" ? "." : options.importer;
  const importer =
    asRecord(importers?.[importerKey]) ??
    (importerKey === "." ? lockfile : undefined);
  const resolved = { ...options.resolved };
  const overrides: MutablePackageOverrides = {};
  const packages =
    asRecord(lockfile?.snapshots) ?? asRecord(lockfile?.packages) ?? {};
  const roots: Array<LockedGraphRoot<string>> = [];

  for (const packageName of options.candidates) {
    const entry = dependencyEntry(importer, packageName);
    const record = asRecord(entry);
    const specifier = stringValue(record?.specifier);
    const declared = declaredPackageVersion(options.packageJson, packageName);
    if (
      specifier !== undefined &&
      declared !== undefined &&
      specifier !== declared
    ) {
      continue;
    }
    const rawVersion =
      typeof entry === "string" ? entry : stringValue(record?.version);
    const installSpec = pnpmInstallSpec(packageName, rawVersion);
    if (installSpec !== undefined) {
      resolved[packageName] = installSpec;
      const packageKey = findPnpmPackageKey(packages, packageName, rawVersion);
      const root =
        packageKey === undefined ? undefined : parsePnpmPackageKey(packageKey);
      if (packageKey !== undefined && root !== undefined) {
        roots.push({
          node: packageKey,
          rootSelector: `${root.name}@${root.version}`,
        });
      }
    }
  }

  addLockedGraphOverrides(
    overrides,
    roots,
    (packageKey) => packageKey,
    (packageKey) => {
      const value = packages[packageKey];
      const parent = parsePnpmPackageKey(packageKey);
      const entry = asRecord(value);
      if (parent === undefined || entry === undefined) return [];
      return Object.entries(dependencySpecifiers(entry)).flatMap(
        ([dependencyName, dependencyEntryValue]): ReadonlyArray<
          LockedGraphDependency<string>
        > => {
          const rawVersion =
            typeof dependencyEntryValue === "string"
              ? dependencyEntryValue
              : stringValue(asRecord(dependencyEntryValue)?.version);
          const installSpec = pnpmInstallSpec(dependencyName, rawVersion);
          if (installSpec === undefined) return [];
          const childKey = findPnpmPackageKey(
            packages,
            dependencyName,
            rawVersion,
          );
          return [{ dependencyName, installSpec, node: childKey }];
        },
      );
    },
  );
  return { resolved, overrides };
};

const parseBunLock = (options: {
  readonly content: string;
  readonly importer: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
  readonly resolved: Readonly<Record<string, string>>;
}): PackageInstallPlan => {
  const lockfile = asRecord(parseJsonc(options.content));
  const packages = asRecord(lockfile?.packages);
  const workspaces = asRecord(lockfile?.workspaces);
  const importerKey = options.importer === "." ? "" : options.importer;
  const workspace = asRecord(workspaces?.[importerKey]);
  const workspaceName = stringValue(workspace?.name);
  const resolved = { ...options.resolved };
  const overrides: MutablePackageOverrides = {};
  const roots: Array<LockedGraphRoot<string>> = [];
  if (packages === undefined) return { resolved, overrides };

  for (const packageName of options.candidates) {
    const declared = declaredPackageVersion(options.packageJson, packageName);
    const workspaceSpecifier = dependencyValue(workspace, packageName);
    if (
      declared === undefined ||
      workspaceSpecifier === undefined ||
      workspaceSpecifier !== declared
    )
      continue;
    const expectedName = npmAliasName(packageName, declared);
    const direct = findBunPackageDescriptor(
      packages,
      [
        ...(workspaceName === undefined
          ? []
          : [`${workspaceName}/${packageName}`]),
        packageName,
      ],
      expectedName,
    );
    if (direct !== undefined) {
      resolved[packageName] = lockedInstallSpec(
        packageName,
        direct.name,
        direct.version,
      );
      roots.push({
        node: direct.key,
        rootSelector: `${direct.name}@${direct.version}`,
      });
    }
  }

  addLockedGraphOverrides(
    overrides,
    roots,
    (packageKey) => packageKey,
    (packageKey) => {
      const value = packages[packageKey];
      const parent = parseBunPackageDescriptor(value);
      const metadata = Array.isArray(value) ? asRecord(value[2]) : undefined;
      if (parent === undefined || metadata === undefined) return [];
      return Object.entries(dependencySpecifiers(metadata)).flatMap(
        ([dependencyName, dependencySpecifier]): ReadonlyArray<
          LockedGraphDependency<string>
        > => {
          if (typeof dependencySpecifier !== "string") return [];
          const expectedName = npmAliasName(
            dependencyName,
            dependencySpecifier,
          );
          const child = findBunPackageDescriptor(
            packages,
            [`${packageKey}/${dependencyName}`, dependencyName],
            expectedName,
          );
          if (child === undefined) return [];
          return [
            {
              dependencyName,
              installSpec: lockedInstallSpec(
                dependencyName,
                child.name,
                child.version,
              ),
              node: child.key,
            },
          ];
        },
      );
    },
  );
  return { resolved, overrides };
};

const parseYarnLock = (options: {
  readonly content: string;
  readonly candidates: ReadonlyArray<string>;
  readonly packageJson: PackageJson;
  readonly resolved: Readonly<Record<string, string>>;
}): PackageInstallPlan => {
  const entries = parseYarnEntries(options.content);
  const resolved = { ...options.resolved };
  const overrides: MutablePackageOverrides = {};
  const roots: Array<LockedGraphRoot<YarnLockEntry>> = [];
  for (const packageName of options.candidates) {
    const specifier = declaredPackageVersion(options.packageJson, packageName);
    if (specifier === undefined) continue;
    const entry = findYarnEntry(entries, packageName, specifier);
    if (entry !== undefined) {
      const actualName = yarnResolutionName(entry.resolution) ?? packageName;
      resolved[packageName] = lockedInstallSpec(
        packageName,
        actualName,
        entry.version,
      );
      roots.push({
        node: entry,
        rootSelector: `${actualName}@${entry.version}`,
      });
    }
  }

  addLockedGraphOverrides(
    overrides,
    roots,
    (entry) => entry,
    (entry) =>
      Object.entries(entry.dependencies).flatMap(
        ([dependencyName, dependencySpecifier]): ReadonlyArray<
          LockedGraphDependency<YarnLockEntry>
        > => {
          const child = findYarnEntry(
            entries,
            dependencyName,
            dependencySpecifier,
          );
          if (child === undefined) return [];
          const actualName =
            yarnResolutionName(child.resolution) ?? dependencyName;
          return [
            {
              dependencyName,
              installSpec: lockedInstallSpec(
                dependencyName,
                actualName,
                child.version,
              ),
              node: child,
            },
          ];
        },
      ),
  );
  return { resolved, overrides };
};

const dependencySpecifiers = (entry: JsonRecord): JsonRecord => ({
  ...asRecord(entry.dependencies),
  ...asRecord(entry.optionalDependencies),
  ...asRecord(entry.peerDependencies),
});

const lockedInstallSpec = (
  dependencyName: string,
  actualName: string,
  version: string,
): string =>
  actualName === dependencyName ? version : `npm:${actualName}@${version}`;

const npmLockedInstallSpec = (
  dependencyName: string,
  entry: JsonRecord | undefined,
  version: string,
): string =>
  lockedInstallSpec(
    dependencyName,
    stringValue(entry?.name) ?? dependencyName,
    version,
  );

const resolvePackageLockDependencyPath = (
  packages: JsonRecord,
  packagePath: string,
  dependencyName: string,
): string | undefined => {
  let current = packagePath;
  while (true) {
    const candidate = `${current}/node_modules/${dependencyName}`;
    if (packages[candidate] !== undefined) return candidate;
    const marker = current.lastIndexOf("/node_modules/");
    if (marker === -1) break;
    current = current.slice(0, marker);
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  return packages[rootCandidate] === undefined ? undefined : rootCandidate;
};

const addPackageLockV1Overrides = (
  dependencies: JsonRecord,
  overrides: MutablePackageOverrides,
  rootNames: ReadonlyArray<string>,
): void => {
  type Node = {
    readonly entry: JsonRecord;
    readonly scopes: ReadonlyArray<JsonRecord>;
  };
  const roots = rootNames.flatMap(
    (rootName): ReadonlyArray<LockedGraphRoot<Node>> => {
      const entry = asRecord(dependencies[rootName]);
      const version = stringValue(entry?.version);
      return entry === undefined || version === undefined
        ? []
        : [
            {
              node: { entry, scopes: [dependencies] },
              rootSelector: `${stringValue(entry.name) ?? rootName}@${version}`,
            },
          ];
    },
  );
  addLockedGraphOverrides(
    overrides,
    roots,
    ({ entry }) => entry,
    ({ entry, scopes }) => {
      const nested = asRecord(entry.dependencies) ?? {};
      const requires = asRecord(entry.requires) ?? {};
      return Object.keys(requires).flatMap(
        (dependencyName): ReadonlyArray<LockedGraphDependency<Node>> => {
          const child = [nested, ...scopes]
            .map((scope) => asRecord(scope[dependencyName]))
            .find((candidate) => candidate !== undefined);
          const version = stringValue(child?.version);
          if (child === undefined || version === undefined) return [];
          return [
            {
              dependencyName,
              installSpec: npmLockedInstallSpec(dependencyName, child, version),
              node: { entry: child, scopes: [nested, ...scopes] },
            },
          ];
        },
      );
    },
  );
};

const pnpmInstallSpec = (
  dependencyName: string,
  rawVersion: string | undefined,
): string | undefined => {
  if (
    rawVersion === undefined ||
    rawVersion.startsWith("link:") ||
    rawVersion.startsWith("workspace:") ||
    rawVersion.startsWith("file:")
  ) {
    return undefined;
  }
  let version = rawVersion.startsWith("/") ? rawVersion.slice(1) : rawVersion;
  const peerSuffix = version.indexOf("(");
  if (peerSuffix !== -1) version = version.slice(0, peerSuffix);
  if (version.startsWith("npm:")) {
    const descriptor = parsePackageDescriptor(version.slice("npm:".length));
    return descriptor === undefined
      ? undefined
      : lockedInstallSpec(dependencyName, descriptor.name, descriptor.version);
  }
  if (version.startsWith(`${dependencyName}@`)) {
    version = version.slice(dependencyName.length + 1);
  }
  return version;
};

const findPnpmPackageKey = (
  packages: JsonRecord,
  dependencyName: string,
  rawVersion: string | undefined,
): string | undefined => {
  if (rawVersion === undefined) return undefined;
  let version = rawVersion.startsWith("/") ? rawVersion.slice(1) : rawVersion;
  let actualName = dependencyName;
  if (version.startsWith("npm:")) {
    const descriptor = parsePackageDescriptor(version.slice("npm:".length));
    if (descriptor === undefined) return undefined;
    actualName = descriptor.name;
    version = descriptor.version;
  } else if (version.startsWith(`${dependencyName}@`)) {
    version = version.slice(dependencyName.length + 1);
  }
  const candidate = `${actualName}@${version}`;
  if (packages[candidate] !== undefined) return candidate;
  const legacyCandidate = `/${candidate}`;
  return packages[legacyCandidate] === undefined ? undefined : legacyCandidate;
};

const parsePnpmPackageKey = (
  packageKey: string,
): { name: string; version: string } | undefined => {
  let descriptor = packageKey.startsWith("/")
    ? packageKey.slice(1)
    : packageKey;
  const peerSuffix = descriptor.indexOf("(");
  if (peerSuffix !== -1) descriptor = descriptor.slice(0, peerSuffix);
  return parsePackageDescriptor(descriptor);
};

const parsePackageDescriptor = (
  descriptor: string,
): { name: string; version: string } | undefined => {
  const separator = descriptor.lastIndexOf("@");
  if (separator <= 0 || separator === descriptor.length - 1) return undefined;
  return {
    name: descriptor.slice(0, separator),
    version: descriptor.slice(separator + 1),
  };
};

const npmAliasName = (dependencyName: string, specifier: string): string => {
  if (!specifier.startsWith("npm:")) return dependencyName;
  return (
    parsePackageDescriptor(specifier.slice("npm:".length))?.name ??
    dependencyName
  );
};

const findBunPackageDescriptor = (
  packages: JsonRecord,
  candidateKeys: ReadonlyArray<string>,
  expectedName: string,
): { key: string; name: string; version: string } | undefined => {
  for (const candidateKey of candidateKeys) {
    const descriptor = parseBunPackageDescriptor(packages[candidateKey]);
    if (descriptor?.name === expectedName)
      return { key: candidateKey, ...descriptor };
  }
  const matches = Object.entries(packages)
    .map(([key, value]) => {
      const descriptor = parseBunPackageDescriptor(value);
      return descriptor === undefined ? undefined : { key, ...descriptor };
    })
    .filter(
      (entry): entry is { key: string; name: string; version: string } =>
        entry?.name === expectedName,
    );
  return matches.length === 1 ? matches[0] : undefined;
};

interface YarnLockEntry {
  readonly selectors: ReadonlyArray<string>;
  readonly version: string;
  readonly resolution?: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

/**
 * Parses a yarn lockfile into a top-level record. Yarn berry lockfiles are
 * valid YAML; the frozen v1 format (`key "value"` pairs without colons) gets
 * a small dedicated parser so no yarn dependency is required.
 */
const parseYarnLockfile = (content: string): JsonRecord => {
  if (!content.includes("# yarn lockfile v1")) {
    try {
      const parsed = asRecord(parseYaml(content));
      if (parsed !== undefined) return parsed;
    } catch {
      // Fall through to the v1 parser for YAML-incompatible files.
    }
  }
  return parseYarnV1Lockfile(content);
};

const parseYarnV1Lockfile = (content: string): JsonRecord => {
  const root: JsonRecord = {};
  const stack: Array<{ indent: number; node: JsonRecord }> = [
    { indent: -1, node: root },
  ];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!.node;
    if (text.endsWith(":")) {
      // Block header: an entry selector list or a nested map like
      // `dependencies:`. Individual selectors may be quoted.
      const key = text
        .slice(0, -1)
        .split(",")
        .map((selector) => stripYarnQuotes(selector.trim()))
        .join(", ");
      const child: JsonRecord = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      // `key "value"` pair; the key itself may be quoted (scoped packages).
      let key: string;
      let rest: string;
      if (text.startsWith('"')) {
        const end = text.indexOf('"', 1);
        if (end === -1) continue;
        key = text.slice(1, end);
        rest = text.slice(end + 1).trim();
      } else {
        const separator = text.indexOf(" ");
        if (separator === -1) continue;
        key = text.slice(0, separator);
        rest = text.slice(separator + 1).trim();
      }
      parent[key] = stripYarnQuotes(rest);
    }
  }
  return root;
};

const stripYarnQuotes = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1)
    : value;

const parseYarnEntries = (content: string): ReadonlyArray<YarnLockEntry> => {
  return Object.entries(parseYarnLockfile(content)).flatMap(
    ([selectorList, value]): ReadonlyArray<YarnLockEntry> => {
      if (selectorList === "__metadata") return [];
      const entry = asRecord(value);
      const version = stringValue(entry?.version);
      if (version === undefined) return [];
      const dependencies = Object.fromEntries(
        Object.entries({
          ...asRecord(entry?.dependencies),
          ...asRecord(entry?.optionalDependencies),
        }).filter(
          (item): item is [string, string] => typeof item[1] === "string",
        ),
      );
      return [
        {
          selectors: selectorList.split(",").map((selector) => selector.trim()),
          version,
          resolution: stringValue(entry?.resolution),
          dependencies,
        },
      ];
    },
  );
};

const findYarnEntry = (
  entries: ReadonlyArray<YarnLockEntry>,
  dependencyName: string,
  specifier: string,
): YarnLockEntry | undefined => {
  const expected = `${dependencyName}@${specifier}`;
  const berryExpected = specifier.startsWith("npm:")
    ? expected
    : `${dependencyName}@npm:${specifier}`;
  return entries.find((entry) =>
    entry.selectors.some(
      (selector) => selector === expected || selector === berryExpected,
    ),
  );
};

const yarnResolutionName = (
  resolution: string | undefined,
): string | undefined => {
  if (resolution === undefined) return undefined;
  const npmMarker = resolution.indexOf("@npm:");
  return npmMarker === -1 ? undefined : resolution.slice(0, npmMarker);
};

const dependencyEntry = (
  importer: JsonRecord | undefined,
  packageName: string,
): unknown =>
  asRecord(importer?.dependencies)?.[packageName] ??
  asRecord(importer?.optionalDependencies)?.[packageName] ??
  asRecord(importer?.devDependencies)?.[packageName];

const dependencyValue = (
  importer: JsonRecord | undefined,
  packageName: string,
): string | undefined => stringValue(dependencyEntry(importer, packageName));

const declaredPackageVersion = (
  packageJson: PackageJson,
  packageName: string,
): string | undefined =>
  packageJson.dependencies?.[packageName] ??
  packageJson.optionalDependencies?.[packageName] ??
  packageJson.devDependencies?.[packageName];

const nodeModulesLookupPaths = (
  importer: string,
  packageName: string,
): ReadonlyArray<string> => {
  const paths: string[] = [];
  let current = importer;
  while (true) {
    paths.push(
      current === ""
        ? `node_modules/${packageName}`
        : `${current}/node_modules/${packageName}`,
    );
    if (current === "") break;
    const separator = current.lastIndexOf("/");
    current = separator === -1 ? "" : current.slice(0, separator);
  }
  return paths;
};

const parseBunPackageDescriptor = (
  value: unknown,
): { name: string; version: string } | undefined => {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    return undefined;
  }
  return parsePackageDescriptor(value[0]);
};

/**
 * Parses `bun.lock` JSONC (comments + trailing commas) without relying on the
 * Bun runtime, so lockfile pinning also works when alchemy runs under Node.
 */
const parseJsonc = (content: string): unknown =>
  JSON.parse(stripJsonc(content));

const stripJsonc = (content: string): string => {
  let out = "";
  let i = 0;
  const length = content.length;
  while (i < length) {
    const char = content[i]!;
    if (char === '"') {
      out += char;
      i++;
      while (i < length) {
        const stringChar = content[i]!;
        out += stringChar;
        i++;
        if (stringChar === "\\") {
          if (i < length) {
            out += content[i];
            i++;
          }
        } else if (stringChar === '"') {
          break;
        }
      }
      continue;
    }
    if (char === "/" && content[i + 1] === "/") {
      while (i < length && content[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && content[i + 1] === "*") {
      i += 2;
      while (i < length && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (char === ",") {
      // Drop the comma when the next significant token closes the container.
      let j = i + 1;
      while (j < length) {
        const nextChar = content[j]!;
        if (nextChar === "/" && content[j + 1] === "/") {
          while (j < length && content[j] !== "\n") j++;
        } else if (nextChar === "/" && content[j + 1] === "*") {
          j += 2;
          while (j < length && !(content[j] === "*" && content[j + 1] === "/"))
            j++;
          j += 2;
        } else if (
          nextChar === " " ||
          nextChar === "\t" ||
          nextChar === "\n" ||
          nextChar === "\r"
        ) {
          j++;
        } else {
          break;
        }
      }
      if (content[j] === "}" || content[j] === "]") {
        i++;
        continue;
      }
      out += char;
      i++;
      continue;
    }
    out += char;
    i++;
  }
  return out;
};

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const resolveCatalogVersion = (
  cwd: string,
  packageName: string,
  version: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspacePath = yield* findUp(cwd, ["pnpm-workspace.yaml"]);
    if (workspacePath !== undefined) {
      const content = yield* fs.readFileString(workspacePath);
      const workspace = parseYaml(content) as CatalogSource;
      const resolved = resolveCatalogEntry(packageName, version, workspace);
      if (resolved === undefined) {
        return yield* Effect.fail(
          new BundleError({
            message: `Could not resolve catalog version for '${packageName}' (${version}) from ${workspacePath}. Pin an npm-compatible version explicitly.`,
          }),
        );
      }
      return resolved;
    }

    const bunResolved = yield* resolveBunCatalogVersion(
      cwd,
      packageName,
      version,
    );
    if (bunResolved !== undefined) {
      return bunResolved;
    }

    return yield* Effect.fail(
      new BundleError({
        message: `Could not resolve catalog version for '${packageName}' (${version}): no pnpm-workspace.yaml or Bun catalog found. Pin an npm-compatible version explicitly.`,
      }),
    );
  });

const findUp = (
  cwd: string,
  filenames: ReadonlyArray<string>,
): Effect.Effect<
  string | undefined,
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const filename of filenames) {
      const candidate = path.join(cwd, filename);
      if (yield* fs.exists(candidate).pipe(Effect.mapError(toBundleError))) {
        return candidate;
      }
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) {
      return undefined;
    }
    return yield* findUp(parent, filenames);
  });

const readNearestLockfileFingerprint = (
  cwd: string,
): Effect.Effect<
  PackageInstallIdentity["lockfile"],
  BundleError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lockfilePath = yield* findUp(cwd, lockfileNames);
    if (lockfilePath === undefined) {
      return undefined;
    }
    const content = yield* fs.readFile(lockfilePath);
    return {
      name: path.basename(lockfilePath),
      hash: yield* sha256(content),
    };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BundleError({
          message: `Failed to read package-manager lockfile for Lambda externals from '${cwd}'`,
          cause,
        }),
    ),
  );

const resolveBunCatalogVersion = (
  cwd: string,
  packageName: string,
  version: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let currentDir = cwd;
    while (true) {
      const packagePath = path.join(currentDir, "package.json");
      if (yield* fs.exists(packagePath)) {
        const content = yield* fs.readFileString(packagePath);
        const manifest = JSON.parse(content) as PackageJson;
        const source = parseBunCatalogSource(manifest);
        if (source !== undefined) {
          const resolved = resolveCatalogEntry(packageName, version, source);
          if (resolved === undefined) {
            return yield* Effect.fail(
              new BundleError({
                message: `Could not resolve catalog version for '${packageName}' (${version}) from ${packagePath}. Pin an npm-compatible version explicitly.`,
              }),
            );
          }
          return resolved;
        }
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        return undefined;
      }
      currentDir = parent;
    }
  });

const parseBunCatalogSource = (
  manifest: PackageJson,
): CatalogSource | undefined => {
  const workspaceSource = parseBunWorkspacesCatalogSource(manifest.workspaces);
  const catalog = workspaceSource?.catalog ?? manifest.catalog;
  const catalogs =
    manifest.catalogs !== undefined || workspaceSource?.catalogs !== undefined
      ? { ...manifest.catalogs, ...workspaceSource?.catalogs }
      : undefined;
  return catalog !== undefined || catalogs !== undefined
    ? { catalog, catalogs }
    : undefined;
};

const parseBunWorkspacesCatalogSource = (
  workspaces: unknown,
): CatalogSource | undefined => {
  if (
    typeof workspaces !== "object" ||
    workspaces === null ||
    Array.isArray(workspaces)
  ) {
    return undefined;
  }
  const record = workspaces as PackageJson;
  if (record.catalog === undefined && record.catalogs === undefined) {
    return undefined;
  }
  return {
    catalog: record.catalog,
    catalogs: record.catalogs,
  };
};

const resolveCatalogEntry = (
  packageName: string,
  version: string,
  source: CatalogSource,
): string | undefined => {
  const catalogName = version.slice("catalog:".length).trim();
  let catalog: Record<string, string> | undefined;
  if (catalogName === "" || catalogName === "default") {
    catalog = source.catalog ?? source.catalogs?.default;
  } else {
    catalog = source.catalogs?.[catalogName];
  }
  return catalog?.[packageName];
};

const readArtifactFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const relativePaths = yield* fs.readDirectory(directory, {
      recursive: true,
    });
    const files: InstalledPackageFile[] = [];
    for (const relativePath of [...relativePaths].sort((a, b) =>
      a.localeCompare(b),
    )) {
      const absolutePath = path.join(directory, relativePath);
      const linkTarget = yield* fs
        .readLink(absolutePath)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (linkTarget !== undefined) {
        files.push({
          path: relativePath.replaceAll("\\", "/"),
          content: yield* Effect.sync(() =>
            new TextEncoder().encode(linkTarget),
          ),
          mode: symbolicLinkMode,
        });
        continue;
      }
      const stat = yield* fs.stat(absolutePath);
      if (stat.type !== "File") continue;
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        content: yield* fs.readFile(absolutePath),
        mode: stat.mode,
      });
    }
    return files;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new BundleError({
          message: "Failed to read installed Lambda external packages",
          cause,
        }),
    ),
  );

function toBundleError(cause: unknown): BundleError {
  return cause instanceof BundleError
    ? cause
    : new BundleError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
}
