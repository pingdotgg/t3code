#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BRAND_ASSET_PATHS, PUBLISH_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import serverPackageJson from "../package.json" with { type: "json" };

interface PackageJson {
  name: string;
  description: string;
  license: string;
  repository: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new CliError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

function redactOtpArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.map((arg, index) => {
    if (args[index - 1] === "--otp") return "<redacted>";
    if (arg.startsWith("--otp=")) return "--otp=<redacted>";
    return arg;
  });
}

interface PublishIconBackup {
  readonly targetPath: string;
  readonly backupPath: string;
}

interface PublishPackageFileBackup {
  readonly targetPath: string;
  readonly backupPath: string | null;
}

const PUBLISH_PACKAGE_FILE_PATHS = [
  "README.md",
  "LICENSE",
  BRAND_ASSET_PATHS.salchiReadmeLogoPng,
] as const;

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const backupDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "salchi-publish-icons-",
  });
  const backups: PublishIconBackup[] = [];

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);
    const backupPath = path.join(backupDirectory, `${backups.length}-${path.basename(targetPath)}`);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing publish icon target: ${targetPath}. Run the build subcommand first.`,
      });
    }

    yield* fs.copyFile(targetPath, backupPath);
    yield* fs.copyFile(sourcePath, targetPath);
    backups.push({ targetPath, backupPath });
  }

  yield* Effect.log("[cli] Applied publish icon overrides to dist/client");
  return backups as ReadonlyArray<PublishIconBackup>;
});

const copyPublishPackageFiles = Effect.fn("copyPublishPackageFiles")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const backupDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "salchi-publish-root-files-",
  });
  const backups: PublishPackageFileBackup[] = [];

  for (const relativePath of PUBLISH_PACKAGE_FILE_PATHS) {
    const sourcePath = path.join(repoRoot, relativePath);
    const targetPath = path.join(serverDir, relativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing publish root file source: ${sourcePath}`,
      });
    }

    const backupPath = (yield* fs.exists(targetPath))
      ? path.join(backupDirectory, `${backups.length}-${path.basename(relativePath)}`)
      : null;
    if (backupPath) {
      yield* fs.copyFile(targetPath, backupPath);
    }

    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true });
    yield* fs.copyFile(sourcePath, targetPath);
    backups.push({ targetPath, backupPath });
  }

  yield* Effect.log("[cli] Copied publish package files into package root");
  return backups as ReadonlyArray<PublishPackageFileBackup>;
});

const restorePublishIconOverrides = Effect.fn("restorePublishIconOverrides")(function* (
  backups: ReadonlyArray<PublishIconBackup>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const backup of backups) {
    if (!(yield* fs.exists(backup.backupPath))) {
      continue;
    }
    yield* fs.rename(backup.backupPath, backup.targetPath);
  }
});

const restorePublishPackageFiles = Effect.fn("restorePublishPackageFiles")(function* (
  backups: ReadonlyArray<PublishPackageFileBackup>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const backup of backups) {
    if (backup.backupPath) {
      if (yield* fs.exists(backup.backupPath)) {
        yield* fs.rename(backup.backupPath, backup.targetPath);
      }
      continue;
    }

    yield* fs.remove(backup.targetPath, { force: true });
  }
});

const applyProductionIconOverrides = Effect.fn("applyProductionIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new CliError({
        message: `Missing production icon source: ${sourcePath}`,
      });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new CliError({
        message: `Missing production icon target: ${targetPath}. Build web first.`,
      });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied production icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running Vite+ pack...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          // Windows needs shell mode to resolve `.cmd` shims on PATH.
          shell: process.platform === "win32",
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyProductionIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (Vite+ pack + bundle web client)."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    otp: Flag.string("otp").pipe(
      Flag.withDescription("One-time password for npm two-factor authentication."),
      Flag.optional,
    ),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const packageJsonPath = path.join(serverDir, "package.json");
      const backupPath = `${packageJsonPath}.bak`;

      // Assert build assets exist
      for (const relPath of ["dist/bin.mjs", "dist/client/index.html"]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new CliError({
            message: `Missing build asset: ${abs}. Run the build subcommand first.`,
          });
        }
      }

      yield* Effect.acquireUseRelease(
        // Acquire: backup package.json, resolve catalog dependencies, and strip devDependencies/scripts
        Effect.gen(function* () {
          const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
          const workspaceConfig = yield* readWorkspaceConfig();
          const workspaceCatalog = workspaceConfig.catalog ?? {};
          const workspaceOverrides = workspaceConfig.overrides ?? {};
          const pkg: PackageJson = {
            name: serverPackageJson.name,
            description: serverPackageJson.description,
            license: serverPackageJson.license,
            repository: serverPackageJson.repository,
            bin: serverPackageJson.bin,
            type: serverPackageJson.type,
            version,
            engines: serverPackageJson.engines,
            files: serverPackageJson.files,
            dependencies: resolveCatalogDependencies(
              serverPackageJson.dependencies,
              workspaceCatalog,
              "apps/server",
            ),
            overrides: resolveCatalogDependencies(
              workspaceOverrides,
              workspaceCatalog,
              "apps/server",
            ),
          };

          const original = yield* fs.readFileString(packageJsonPath);
          const packageJsonString = yield* encodePackageJson(pkg);
          yield* fs.writeFileString(backupPath, original);
          yield* fs.writeFileString(packageJsonPath, `${packageJsonString}\n`);
          yield* Effect.log("[cli] Prepared package.json for publish");

          const iconBackups = yield* applyPublishIconOverrides(repoRoot, serverDir);
          const packageFileBackups = yield* copyPublishPackageFiles(repoRoot, serverDir);
          return { iconBackups, packageFileBackups };
        }),
        // Use: npm publish
        () =>
          Effect.gen(function* () {
            const args = ["publish", "--access", config.access, "--tag", config.tag];
            if (config.provenance) args.push("--provenance");
            if (config.dryRun) args.push("--dry-run");
            if (Option.isSome(config.otp)) args.push("--otp", config.otp.value);

            yield* Effect.log(`[cli] Running: npm ${redactOtpArgs(args).join(" ")}`);
            yield* runCommand(
              ChildProcess.make("npm", [...args], {
                cwd: serverDir,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                // Windows needs shell mode to resolve .cmd shims.
                shell: process.platform === "win32",
              }),
            );
          }),
        // Release: restore
        (resource: {
          readonly iconBackups: ReadonlyArray<PublishIconBackup>;
          readonly packageFileBackups: ReadonlyArray<PublishPackageFileBackup>;
        }) =>
          Effect.gen(function* () {
            yield* restorePublishPackageFiles(resource.packageFileBackups).pipe(
              Effect.catch((error) =>
                Effect.logError(`[cli] Failed to restore publish package files: ${String(error)}`),
              ),
            );
            yield* restorePublishIconOverrides(resource.iconBackups).pipe(
              Effect.catch((error) =>
                Effect.logError(`[cli] Failed to restore publish icon overrides: ${String(error)}`),
              ),
            );
            yield* fs.rename(backupPath, packageJsonPath);
            if (config.verbose) yield* Effect.log("[cli] Restored original package.json");
          }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
