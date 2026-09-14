#!/usr/bin/env node
/**
 * Turns the per-platform CLI archives of one release into the npm packages
 * behind `npx t3` / `npm i -g t3`: one `@t3code/t3-<platformKey>` package per
 * archive holding the archive's contents verbatim, plus the `t3` launcher
 * that lists them as optionalDependencies and execs the one npm installed.
 * The bytes a user gets from npm are therefore the release archive's, and
 * running them needs neither a Node runtime, npm, nor a native build.
 *
 * Output layout under `--output-dir`:
 *
 *   @t3code/t3-<platformKey>/      archive contents flattened + package.json
 *   @t3code/t3-<platformKey>.tgz   the same tree as an npm tarball
 *   t3/                             launcher: package.json, bin/t3.js, README.md
 *   t3.tgz                          the launcher as an npm tarball
 *
 * The tarballs are what gets published. `npm publish <dir>` always drops
 * `node_modules/` (npm-packlist ignores it whatever `files` says, and
 * bundleDependencies needs an arborist tree these flattened installs are
 * not), whereas `npm publish <tarball>` uploads the bytes as given.
 */
import { legacyCliLauncherScript } from "@t3tools/shared/legacyCliLauncher";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  cliArchiveFileName,
  type CliArchivePlatformKey,
} from "@t3tools/shared/cliRelease";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { isCommandAvailable } from "@t3tools/shared/shell";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { windowsSystemTar } from "./build-cli-archive.ts";

export const NPM_PLATFORM_PACKAGE_SCOPE = "@t3code";
export const NPM_LAUNCHER_PACKAGE_NAME = "t3";

const encodePackageJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export class NpmPackagesCommandFailedError extends Schema.TaggedError<NpmPackagesCommandFailedError>()(
  "NpmPackagesCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class NpmPackagesToolMissingError extends Schema.TaggedError<NpmPackagesToolMissingError>()(
  "NpmPackagesToolMissingError",
  { tool: Schema.String, purpose: Schema.String },
) {
  override get message(): string {
    return `\`${this.tool}\` is not on PATH; it is needed to ${this.purpose}.`;
  }
}

export class NpmPackagesArchivesMissingError extends Schema.TaggedError<NpmPackagesArchivesMissingError>()(
  "NpmPackagesArchivesMissingError",
  { archivesDir: Schema.String, missing: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.archivesDir} lacks archives for ${this.missing.join(", ")}. A launcher published without them would silently skip those platforms; pass --allow-missing for a deliberately partial build.`;
  }
}

export class NpmPackagesArchiveLayoutError extends Schema.TaggedError<NpmPackagesArchiveLayoutError>()(
  "NpmPackagesArchiveLayoutError",
  { archive: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.archive}: ${this.detail}`;
  }
}

export function npmPlatformPackageName(platformKey: CliArchivePlatformKey): string {
  return `${NPM_PLATFORM_PACKAGE_SCOPE}/t3-${platformKey}`;
}

/**
 * package.json for one platform package; `os`/`cpu` let npm skip the other
 * five. The archive's runtime `node_modules` (native addons and their
 * loaders) ships inside the tarball, and npm only keeps a nested tree it can
 * account for: anything not declared is extraneous and pruned on the next
 * `npm install` in that project, which then breaks the executable. Declaring
 * every bundled package as a bundled dependency at the exact version on disk
 * makes npm treat the tree as part of this package and leave it alone.
 */
export function npmPlatformPackageManifest(
  platformKey: CliArchivePlatformKey,
  version: string,
  bundled: Readonly<Record<string, string>>,
) {
  const [os, cpu] = platformKey.split("-") as [string, string];
  const bundleDependencies = Object.keys(bundled).sort();
  return {
    name: npmPlatformPackageName(platformKey),
    version,
    description: `T3 Code CLI executable for ${platformKey}`,
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    os: [os],
    cpu: [cpu],
    files: ["t3", "t3.exe", "client", "resource-monitor", "node_modules"],
    preferUnplugged: true,
    dependencies: Object.fromEntries(bundleDependencies.map((name) => [name, bundled[name]])),
    bundleDependencies,
  };
}

const PackageVersion = Schema.Struct({ version: Schema.String });
const decodePackageVersion = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageVersion));

/** Every top-level package under `node_modules`, scoped ones included, at the version its manifest names. */
const readBundledPackages = Effect.fn("readBundledPackages")(function* (nodeModulesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundled: Record<string, string> = {};
  const packageDirs: Array<{ readonly name: string; readonly dir: string }> = [];
  for (const entry of yield* fs.readDirectory(nodeModulesDir)) {
    if (entry.startsWith(".")) continue;
    const dir = path.join(nodeModulesDir, entry);
    if (entry.startsWith("@")) {
      for (const scoped of yield* fs.readDirectory(dir)) {
        packageDirs.push({ name: `${entry}/${scoped}`, dir: path.join(dir, scoped) });
      }
    } else {
      packageDirs.push({ name: entry, dir });
    }
  }
  for (const { name, dir } of packageDirs) {
    const manifest = yield* fs.readFileString(path.join(dir, "package.json"));
    bundled[name] = (yield* decodePackageVersion(manifest)).version;
  }
  return bundled;
});

/**
 * README for one platform package. Without one at the package root, npm
 * shows the first README it finds in the tarball, which is a bundled
 * dependency's (ffi-rs).
 */
export function npmPlatformPackageReadme(platformKey: CliArchivePlatformKey): string {
  return [
    `# ${npmPlatformPackageName(platformKey)}`,
    "",
    `The T3 Code CLI executable for ${platformKey}. Do not install this package directly:`,
    `it is an optional dependency of \`${NPM_LAUNCHER_PACKAGE_NAME}\`, which picks the package for the`,
    "current platform and runs the executable inside it.",
    "",
    "```sh",
    `npx ${NPM_LAUNCHER_PACKAGE_NAME}@latest`,
    "```",
    "",
    "Source and documentation: https://github.com/pingdotgg/t3code",
    "",
  ].join("\n");
}

/** package.json for the `t3` launcher. No engines: bin/t3.js is trivial CJS. */
export function npmLauncherPackageManifest(
  version: string,
  platformKeys: ReadonlyArray<CliArchivePlatformKey>,
) {
  return {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    version,
    description: "T3 Code CLI. Installs the self-contained executable for this platform.",
    license: serverPackageJson.license,
    repository: serverPackageJson.repository,
    bin: { t3: "./bin/t3.js" },
    files: ["bin", "dist"],
    optionalDependencies: Object.fromEntries(
      platformKeys.map((key) => [npmPlatformPackageName(key), version]),
    ),
  };
}

/**
 * The launcher every `npx t3` runs. Plain CommonJS with no dependencies so it
 * loads on any Node that npm itself runs on; the real work happens in the
 * single-executable it execs.
 */
export const NPM_LAUNCHER_SCRIPT = `#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const { constants } = require("node:os");
const { dirname, join } = require("node:path");

const SUPPORTED = [${CLI_ARCHIVE_PLATFORM_KEYS.map((key) => `"${key}"`).join(", ")}];
const key = process.platform + "-" + process.arch;

let packageDir;
try {
  packageDir = dirname(require.resolve("${NPM_PLATFORM_PACKAGE_SCOPE}/t3-" + key + "/package.json"));
} catch {
  process.stderr.write(
    [
      "t3: no T3 Code CLI build is available for this platform (" + key + ").",
      "Supported platforms: " + SUPPORTED.join(", ") + ".",
      "If yours is listed, reinstall t3 so npm fetches its optional dependency.",
      "The desktop app and release archives are at https://github.com/pingdotgg/t3code/releases",
      "",
    ].join("\\n"),
  );
  process.exit(1);
}

const executable = join(packageDir, process.platform === "win32" ? "t3.exe" : "t3");
const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  process.stderr.write("t3: failed to start " + executable + ": " + result.error.message + "\\n");
  process.exit(1);
}
// A child killed by a signal has no status; report it the way a shell would.
process.exit(result.status ?? 128 + (constants.signals[result.signal] || 1));
`;

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.StandardCommand,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command.command, command.args, {
      ...command.options,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new NpmPackagesCommandFailedError({ command: label, exitCode });
  }
});

/**
 * Extracts an archive and returns its single top-level directory. `.tar.gz`
 * goes through tar everywhere; `.zip` through the bsdtar Windows ships or,
 * elsewhere, `unzip`, since GNU tar cannot read zip.
 */
const extractArchive = Effect.fn("extractArchive")(function* (archive: string, into: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  if (!archive.endsWith(".zip")) {
    yield* runCommand(ChildProcess.make("tar", ["-xf", archive, "-C", into]), "tar -xf");
  } else if (platform === "win32") {
    yield* runCommand(
      ChildProcess.make(windowsSystemTar(), ["-xf", archive, "-C", into]),
      "tar.exe -xf (zip)",
    );
  } else {
    if (!(yield* isCommandAvailable("unzip"))) {
      return yield* new NpmPackagesToolMissingError({
        tool: "unzip",
        purpose: `extract ${path.basename(archive)} (GNU tar cannot read zip)`,
      });
    }
    yield* runCommand(ChildProcess.make("unzip", ["-q", archive, "-d", into]), "unzip");
  }
  const entries = yield* fs.readDirectory(into);
  const [root] = entries;
  if (root === undefined || entries.length !== 1) {
    return yield* new NpmPackagesArchiveLayoutError({
      archive: path.basename(archive),
      detail: `expected exactly one top-level directory, found ${String(entries.length)} entries`,
    });
  }
  return path.join(into, root);
});

/** Tar to build npm tarballs with; see build-cli-archive.ts for why Windows names bsdtar by path. */
const hostTar = Effect.map(HostProcessPlatform, (platform) =>
  platform === "win32" ? windowsSystemTar() : "tar",
);

/**
 * Writes `stageDir/package` as a gzipped npm tarball and then moves the tree
 * to `packageDir` so the contents stay inspectable beside the tarball.
 */
const packAndPlace = Effect.fn("packAndPlace")(function* (input: {
  readonly stageDir: string;
  readonly packageDir: string;
  readonly tarball: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(input.tarball, { force: true });
  yield* runCommand(
    ChildProcess.make(yield* hostTar, ["-czf", input.tarball, "-C", input.stageDir, "package"]),
    `tar (${input.tarball})`,
  );
  yield* fs.remove(input.packageDir, { recursive: true, force: true });
  yield* fs.rename(`${input.stageDir}/package`, input.packageDir);
});

export interface NpmPackageOutput {
  readonly name: string;
  readonly packageDir: string;
  readonly tarball: string;
}

/**
 * Extracts one archive, adds its package.json, and emits the package dir and
 * tarball. The scratch dir lives inside the output dir so the extracted tree
 * is renamed into place rather than copied across filesystems.
 */
const stagePlatformPackage = Effect.fn("stagePlatformPackage")(function* (input: {
  readonly key: CliArchivePlatformKey;
  readonly archive: string;
  readonly outputDir: string;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.log(`[npm-packages] Extracting ${path.basename(input.archive)}...`);
  const scratch = yield* fs.makeTempDirectoryScoped({
    directory: input.outputDir,
    prefix: ".extract-",
  });
  const extractDir = path.join(scratch, "extract");
  yield* fs.makeDirectory(extractDir);
  const contentDir = yield* extractArchive(input.archive, extractDir);
  const executableName = input.key.startsWith("win32") ? "t3.exe" : "t3";
  const executable = path.join(contentDir, executableName);
  if (!(yield* fs.exists(executable))) {
    return yield* new NpmPackagesArchiveLayoutError({
      archive: path.basename(input.archive),
      detail: `missing ${executableName} at the archive root`,
    });
  }
  // The tarball carries the on-disk mode, so the bit must be set before packing.
  if (executableName === "t3") {
    yield* fs.chmod(executable, 0o755);
  }
  const bundled = yield* readBundledPackages(path.join(contentDir, "node_modules"));
  yield* fs.writeFileString(
    path.join(contentDir, "package.json"),
    `${yield* encodePackageJson(npmPlatformPackageManifest(input.key, input.version, bundled))}\n`,
  );
  yield* fs.writeFileString(
    path.join(contentDir, "README.md"),
    npmPlatformPackageReadme(input.key),
  );
  // npm tarballs root everything under `package/`.
  yield* fs.rename(contentDir, path.join(scratch, "package"));
  const name = npmPlatformPackageName(input.key);
  const output: NpmPackageOutput = {
    name,
    packageDir: path.join(input.outputDir, name),
    tarball: path.join(input.outputDir, `${name}.tgz`),
  };
  yield* packAndPlace({ stageDir: scratch, ...output });
  return output;
}, Effect.scoped);

/** Writes the launcher package (package.json, bin/t3.js, README) and its tarball. */
const stageLauncherPackage = Effect.fn("stageLauncherPackage")(function* (input: {
  readonly outputDir: string;
  readonly version: string;
  readonly platformKeys: ReadonlyArray<CliArchivePlatformKey>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scratch = yield* fs.makeTempDirectoryScoped({
    directory: input.outputDir,
    prefix: ".launcher-",
  });
  const stageDir = path.join(scratch, "package");
  yield* fs.makeDirectory(path.join(stageDir, "bin"), { recursive: true });
  yield* fs.writeFileString(
    path.join(stageDir, "package.json"),
    `${yield* encodePackageJson(npmLauncherPackageManifest(input.version, input.platformKeys))}\n`,
  );
  const launcherScript = path.join(stageDir, "bin/t3.js");
  yield* fs.writeFileString(launcherScript, NPM_LAUNCHER_SCRIPT);
  yield* fs.chmod(launcherScript, 0o755);
  // Older service updaters and launchers run this exact path with Node.
  // Keep it in the package so they can preflight and start the new executable.
  yield* fs.makeDirectory(path.join(stageDir, "dist"));
  yield* fs.writeFileString(path.join(stageDir, "dist/bin.mjs"), legacyCliLauncherScript("npm"));
  const readme = yield* path.fromFileUrl(new URL("../apps/server/README.md", import.meta.url));
  if (yield* fs.exists(readme)) {
    yield* fs.copyFile(readme, path.join(stageDir, "README.md"));
  }
  const output: NpmPackageOutput = {
    name: NPM_LAUNCHER_PACKAGE_NAME,
    packageDir: path.join(input.outputDir, NPM_LAUNCHER_PACKAGE_NAME),
    tarball: path.join(input.outputDir, `${NPM_LAUNCHER_PACKAGE_NAME}.tgz`),
  };
  yield* packAndPlace({ stageDir: scratch, ...output });
  return output;
}, Effect.scoped);

export const buildNpmPlatformPackages = Effect.fn("buildNpmPlatformPackages")(function* (input: {
  readonly archivesDir: string;
  readonly version: string;
  readonly outputDir: string;
  readonly allowMissing: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const present = yield* fs.readDirectory(input.archivesDir);
  const archives = CLI_ARCHIVE_PLATFORM_KEYS.flatMap((key) => {
    const fileName = cliArchiveFileName(input.version, key);
    return present.includes(fileName)
      ? [{ key, archive: path.join(input.archivesDir, fileName) }]
      : [];
  });
  const missing = CLI_ARCHIVE_PLATFORM_KEYS.filter(
    (key) => !archives.some((entry) => entry.key === key),
  );
  if (missing.length > 0 && (!input.allowMissing || archives.length === 0)) {
    return yield* new NpmPackagesArchivesMissingError({ archivesDir: input.archivesDir, missing });
  }

  yield* fs.makeDirectory(path.join(input.outputDir, NPM_PLATFORM_PACKAGE_SCOPE), {
    recursive: true,
  });
  const outputs: Array<NpmPackageOutput> = [];
  for (const { key, archive } of archives) {
    outputs.push(
      yield* stagePlatformPackage({
        key,
        archive,
        outputDir: input.outputDir,
        version: input.version,
      }),
    );
  }
  outputs.push(
    yield* stageLauncherPackage({
      outputDir: input.outputDir,
      version: input.version,
      platformKeys: archives.map((entry) => entry.key),
    }),
  );

  for (const output of outputs) {
    yield* Effect.log(`[npm-packages] Wrote ${output.packageDir} and ${output.tarball}`);
  }
  if (missing.length > 0) {
    yield* Effect.logWarning(
      `[npm-packages] Launcher omits ${missing.join(", ")} (--allow-missing).`,
    );
  }
  return outputs;
});

const command = Command.make(
  "build-npm-platform-packages",
  {
    archivesDir: Flag.string("archives-dir").pipe(
      Flag.withDescription("Directory holding the release's t3-<version>-<platform> archives."),
    ),
    version: Flag.string("version").pipe(
      Flag.withDescription(
        "Exact release version; selects the archives and versions the packages.",
      ),
    ),
    outputDir: Flag.string("output-dir").pipe(Flag.withDefault("npm-packages")),
    allowMissing: Flag.boolean("allow-missing").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Build a launcher that lists only the platforms present."),
    ),
  },
  buildNpmPlatformPackages,
).pipe(
  Command.withDescription(
    "Build the t3 launcher and @t3code/t3-<platform> npm packages from CLI release archives.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}
