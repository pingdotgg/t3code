import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { builtinModules } from "node:module";
import { parse as parseYaml } from "yaml";
import { ChildProcess } from "effect/unstable/process";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { exec } from "../Util/exec.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import { BundleError } from "./Bundle.ts";

export interface InstalledPackageFile {
  readonly path: string;
  readonly content: Uint8Array<ArrayBufferLike>;
}

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

export interface PackageInstallIdentity {
  readonly resolved: Readonly<Record<string, string>>;
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
  _packageNames: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const npmArchitecture = architecture === "arm64" ? "arm64" : "x64";
  return [
    "install",
    "--force",
    "--platform=linux",
    "--os=linux",
    `--arch=${npmArchitecture}`,
    `--cpu=${npmArchitecture}`,
    "--libc=glibc",
  ];
}

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
  FileSystem.FileSystem | Path.Path
> {
  const packageNames = Object.keys(options.requested).sort();
  if (packageNames.length === 0) return Effect.succeed({});

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
    return resolved;
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
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const resolved = yield* resolveInstallTargets(options);
    if (Object.keys(resolved).length === 0) {
      return { resolved };
    }
    const lockfile = yield* readNearestLockfileFingerprint(options.cwd);
    return { resolved, lockfile };
  });
}

export function hashPackageInstallIdentity(
  options: HashPackageInstallIdentityOptions,
): Effect.Effect<string> {
  return sha256Object({
    bundle: options.bundleHash,
    install: options.identity.resolved,
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
          yield* fileSystem.writeFileString(
            pathService.join(directory, "package.json"),
            `${JSON.stringify(
              { private: true, dependencies: options.resolved },
              null,
              2,
            )}\n`,
          );
          yield* runInstall(
            directory,
            npmInstallArgs(options.architecture, packageNames),
          );
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
    const resolved = yield* resolveInstallTargets({
      cwd: options.cwd,
      requested,
    });
    return yield* installResolvedPackages({
      resolved,
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

const readSourcePackageJson = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const content = yield* fs.readFileString(path.join(cwd, "package.json"));
    return JSON.parse(content) as PackageJson;
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
      const stat = yield* fs.stat(absolutePath);
      if (stat.type !== "File") continue;
      files.push({
        path: relativePath.replaceAll("\\", "/"),
        content: yield* fs.readFile(absolutePath),
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
