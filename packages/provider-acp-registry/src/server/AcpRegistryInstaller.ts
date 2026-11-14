// @effect-diagnostics effectFnOpportunity:off
import {
  ACP_REGISTRY_MAX_AGENTS,
  AcpRegistryOperationError,
  AcpRegistryOperationErrorReason,
  TrimmedNonEmptyString,
  type AcpRegistryManagedBinaryUninstallInput,
  type AcpRegistryManagedBinaryUninstallResult,
  type AcpRegistryPrepareInput,
  type AcpRegistryPrepareResult,
  type AcpRegistrySearchInput,
  type AcpRegistrySearchResult,
  type AcpRegistryDistribution as AcpRegistryDistributionKind,
} from "@t3tools/contracts";
import type { AcpRegistryDistributionPreference } from "../settings.ts";
import type { AcpRegistrySettings } from "../settings.ts";
import { cliArchiveTarCommand } from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  mergePathEntries,
  resolveSpawnCommand,
  SpawnExecutableResolution,
} from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { sha256 } from "@noble/hashes/sha2";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";


import {
  MAX_ARCHIVE_BYTES,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_ARCHIVE_LISTING_BYTES,
  MAX_PACKAGE_MANIFEST_BYTES,
  ARCHIVE_REQUEST_TIMEOUT,
  PACKAGE_INSTALL_TIMEOUT,
  PACKAGE_QUERY_TIMEOUT,
  AcpRegistryBinaryTarget,
  type AcpRegistryAgent,
  NpmPackageManifest,
  type AcpRegistryPackageInstallReceipt,
  decodeNpmPackageManifest,
  decodePackageInstallReceipt,
  encodePackageInstallReceipt,
  type AcpRegistryErrorReason,
  AcpRegistryError,
  isAcpRegistryError,
  resolveAcpRegistryPlatformTargetCandidates,
  parseNpxPackageSpec,
  parseUvxPackageSpec,
  packageManagerFor,
  packageCommandCandidates,
  withPreferredPath,
  AcpRegistryCatalog,
  INSTALL_LOCK_RETRY_COUNT,
  INSTALL_LOCK_RETRY_DELAY,
  INSTALL_LOCK_STALE_MS,
  isAlreadyExists,
  normalizeRegistryCommandPath,
  validateArchiveEntries,
  archiveKind,
  archiveFileName,
  compareText,
} from "./AcpRegistryModel.ts";
import type { AcpRegistryIndexState } from "./AcpRegistryIndex.ts";

/** Package-manager discovery and binary installation for the ACP catalog. */
export const makeAcpRegistryInstaller = (index: AcpRegistryIndexState) =>
  Effect.gen(function* () {
  const sha256Hex = index.sha256Hex;
  const fileSystem = index.fileSystem;
  const path = index.path;
  const httpClient = index.httpClient;
  const spawner = index.spawner;
  const platform = index.platform;
  const architecture = index.architecture;
  const hostEnvironment = index.hostEnvironment;
  const resolveExecutable = index.resolveExecutable;
  const platformTarget = index.platformTarget;
  const agentInstallRoot = index.agentInstallRoot;
  const packageInstallRoot = index.packageInstallRoot;
  const packageBinDirectory = index.packageBinDirectory;
  const packageReceiptsDirectory = index.packageReceiptsDirectory;
  const managerBinDirectory = index.managerBinDirectory;

  const runCommand = Effect.fn("AcpRegistryCatalog.runCommand")(function* (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeout?: Duration.Input;
      readonly truncatedOutputReason?: AcpRegistryErrorReason;
      readonly maxStdoutBytes?: number;
    } = {},
  ) {
    const collect = Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(
        command,
        args,
        options.env === undefined ? {} : { env: options.env },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env === undefined ? {} : { env: options.env }),
          shell: resolved.shell,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES,
          }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_COMMAND_OUTPUT_BYTES }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(exitCode) !== 0) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry install command '${command}' exited with code ${Number(exitCode)}: ${stderr.text.trim()}`,
        });
      }
      // Truncated listings would bypass archive traversal validation.
      if (stdout.truncated) {
        return yield* new AcpRegistryError({
          reason: options.truncatedOutputReason ?? "archive_invalid",
          detail: `ACP Registry install command '${command}' produced more output than expected.`,
        });
      }
      return stdout.text;
    });
    const scoped = collect.pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not run ACP Registry install command '${command}'.`,
              cause,
            }),
      ),
    );
    return yield* options.timeout === undefined
      ? scoped
      : scoped.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              Effect.fail(
                new AcpRegistryError({
                  reason: "install_failed",
                  detail: `Timed out running ACP Registry install command '${command}'.`,
                }),
              ),
          }),
        );
  });

  const packageReceiptPath = (agentId: string, distribution: "npx" | "uvx", managerPath: string) =>
    sha256Hex(new TextEncoder().encode(`${distribution}\0${managerPath}`)).pipe(
      Effect.map((digest) =>
        path.join(packageReceiptsDirectory, `${agentId}-${digest.slice(0, 16)}.json`),
      ),
    );

  const readPackageReceipt = Effect.fn("AcpRegistryCatalog.readPackageReceipt")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    managerPath: string,
  ) {
    const receipt = yield* fileSystem
      .readFileString(yield* packageReceiptPath(agent.id, distribution, managerPath))
      .pipe(
        Effect.map(decodePackageInstallReceipt),
        Effect.orElseSucceed(() => Option.none()),
      );
    if (
      Option.isNone(receipt) ||
      receipt.value.agentId !== agent.id ||
      receipt.value.agentVersion !== agent.version ||
      receipt.value.distribution !== distribution ||
      receipt.value.packageSpec !== packageSpec ||
      receipt.value.managerPath !== managerPath ||
      receipt.value.binDirectory !== packageBinDirectory(agent, distribution) ||
      path.dirname(receipt.value.executablePath) !== receipt.value.binDirectory
    ) {
      return Option.none<AcpRegistryPackageInstallReceipt>();
    }
    const executableExists = yield* fileSystem
      .exists(receipt.value.executablePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!executableExists) return Option.none<AcpRegistryPackageInstallReceipt>();

    if (distribution === "npx") {
      const packageIdentity = parseNpxPackageSpec(packageSpec);
      if (receipt.value.packageRoot === undefined || receipt.value.packageVersion === undefined) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const manifest = yield* fileSystem
        .readFileString(path.join(receipt.value.packageRoot, "package.json"))
        .pipe(Effect.flatMap(decodeNpmPackageManifest), Effect.option);
      if (
        Option.isNone(manifest) ||
        manifest.value.name !== packageIdentity.name ||
        manifest.value.version !== packageIdentity.version ||
        receipt.value.packageVersion !== packageIdentity.version
      ) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
    }
    return receipt;
  });

  const writePackageReceipt = Effect.fn("AcpRegistryCatalog.writePackageReceipt")(
    function* (receipt: AcpRegistryPackageInstallReceipt) {
      const receiptPath = yield* packageReceiptPath(
        receipt.agentId,
        receipt.distribution,
        receipt.managerPath,
      );
      const temporaryPath = `${receiptPath}.${process.pid}.tmp`;
      yield* fileSystem.makeDirectory(packageReceiptsDirectory, { recursive: true });
      yield* fileSystem.remove(temporaryPath, { force: true });
      yield* fileSystem.writeFileString(temporaryPath, `${encodePackageInstallReceipt(receipt)}\n`);
      yield* fileSystem.remove(receiptPath, { force: true });
      yield* fileSystem.rename(temporaryPath, receiptPath);
    },
    Effect.mapError((cause) =>
      isAcpRegistryError(cause)
        ? cause
        : new AcpRegistryError({
            reason: "install_failed",
            detail: "Could not record the globally installed ACP Registry command.",
            cause,
          }),
    ),
  );

  const parsePackageManagerPath = Effect.fn("AcpRegistryCatalog.parsePackageManagerPath")(
    function* (managerPath: string, output: string) {
      const lines = output
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length !== 1 || !path.isAbsolute(lines[0]!)) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry package manager '${managerPath}' returned an invalid global path.`,
        });
      }
      return lines[0]!;
    },
  );

  const npmCommandName = (
    agent: AcpRegistryAgent,
    packageName: string,
    manifest: typeof NpmPackageManifest.Type,
  ): string | undefined => {
    const packageBaseName = packageName.split("/").pop() ?? packageName;
    if (typeof manifest.bin === "string") return packageBaseName;
    const entries = Object.entries(manifest.bin).toSorted(([left], [right]) =>
      compareText(left, right),
    );
    if (entries.length === 1) return entries[0]![0];
    if (manifest.bin[packageBaseName] !== undefined) return packageBaseName;
    if (manifest.bin[agent.id] !== undefined) return agent.id;
    return new Set(entries.map(([, commandPath]) => commandPath)).size === 1
      ? entries[0]?.[0]
      : undefined;
  };

  const discoverNpmGlobalPackage = Effect.fn("AcpRegistryCatalog.discoverNpmGlobalPackage")(
    function* (
      agent: AcpRegistryAgent,
      packageSpec: string,
      managerPath: string,
      environment: NodeJS.ProcessEnv,
    ) {
      const packageIdentity = parseNpxPackageSpec(packageSpec);
      const commandOptions = {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed" as const,
      } as const;
      const globalRoot = yield* runCommand(managerPath, ["root", "--global"], commandOptions).pipe(
        Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)),
      );
      const globalPrefix = yield* runCommand(
        managerPath,
        ["prefix", "--global"],
        commandOptions,
      ).pipe(Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)));
      const packageRoot = path.join(globalRoot, ...packageIdentity.name.split("/"));
      const manifestPath = path.join(packageRoot, "package.json");
      const manifestInfo = yield* fileSystem.stat(manifestPath).pipe(Effect.option);
      if (Option.isNone(manifestInfo) || manifestInfo.value.size > MAX_PACKAGE_MANIFEST_BYTES) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const manifest = yield* fileSystem
        .readFileString(manifestPath)
        .pipe(Effect.flatMap(decodeNpmPackageManifest), Effect.option);
      if (
        Option.isNone(manifest) ||
        manifest.value.name !== packageIdentity.name ||
        manifest.value.version !== packageIdentity.version
      ) {
        return Option.none<AcpRegistryPackageInstallReceipt>();
      }
      const commandName = npmCommandName(agent, packageIdentity.name, manifest.value);
      if (commandName === undefined) return Option.none<AcpRegistryPackageInstallReceipt>();
      const binDirectory = platform === "win32" ? globalPrefix : path.join(globalPrefix, "bin");
      const executablePath = resolveExecutable(
        commandName,
        platform,
        withPreferredPath(environment, binDirectory, platform),
      );
      return executablePath === undefined
        ? Option.none<AcpRegistryPackageInstallReceipt>()
        : Option.some<AcpRegistryPackageInstallReceipt>({
            agentId: agent.id,
            agentVersion: agent.version,
            distribution: "npx" as const,
            packageSpec,
            managerPath,
            binDirectory,
            executablePath,
            packageRoot,
            packageVersion: manifest.value.version,
          });
    },
  );

  const discoverUvGlobalPackage = Effect.fn("AcpRegistryCatalog.discoverUvGlobalPackage")(
    function* (
      agent: AcpRegistryAgent,
      packageSpec: string,
      managerPath: string,
      environment: NodeJS.ProcessEnv,
    ) {
      const packageIdentity = parseUvxPackageSpec(packageSpec);
      const installedTools = yield* runCommand(managerPath, ["tool", "list"], {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
      const normalizedPackageName = packageIdentity.name.toLowerCase().replace(/[._-]+/gu, "-");
      const exactVersionInstalled = installedTools.split(/\r?\n/u).some((line) => {
        const match = /^(\S+) v(\S+)(?:\s|$)/u.exec(line);
        return (
          match?.[1]?.toLowerCase().replace(/[._-]+/gu, "-") === normalizedPackageName &&
          match[2] === packageIdentity.version
        );
      });
      if (!exactVersionInstalled) return Option.none<AcpRegistryPackageInstallReceipt>();
      const binDirectory = yield* runCommand(managerPath, ["tool", "dir", "--bin"], {
        env: environment,
        timeout: PACKAGE_QUERY_TIMEOUT,
        truncatedOutputReason: "install_failed",
      }).pipe(Effect.flatMap((output) => parsePackageManagerPath(managerPath, output)));
      const commandEnvironment = withPreferredPath(environment, binDirectory, platform);
      const executablePath = packageCommandCandidates(agent, packageIdentity.name)
        .map((candidate) => resolveExecutable(candidate, platform, commandEnvironment))
        .find((candidate): candidate is string => candidate !== undefined);
      return executablePath === undefined
        ? Option.none<AcpRegistryPackageInstallReceipt>()
        : Option.some<AcpRegistryPackageInstallReceipt>({
            agentId: agent.id,
            agentVersion: agent.version,
            distribution: "uvx" as const,
            packageSpec,
            managerPath,
            binDirectory,
            executablePath,
            packageVersion: packageIdentity.version,
          });
    },
  );

  const ensureGlobalPackage = Effect.fn("AcpRegistryCatalog.ensureGlobalPackage")(function* (
    agent: AcpRegistryAgent,
    distribution: "npx" | "uvx",
    packageSpec: string,
    environment: NodeJS.ProcessEnv,
  ) {
    const managerName = packageManagerFor(distribution)!;
    const managerPath = resolveExecutable(managerName, platform, environment);
    if (managerPath === undefined) {
      return yield* new AcpRegistryError({
        reason: "runner_unavailable",
        detail: `ACP Registry agent ${agent.id} requires '${managerName}', but it is not available on this environment's PATH.`,
      });
    }
    const receipt = yield* readPackageReceipt(agent, distribution, packageSpec, managerPath);
    if (Option.isSome(receipt) && distribution === "npx") return receipt.value;

    const packageRoot = packageInstallRoot(agent, distribution);
    yield* fileSystem.makeDirectory(packageRoot, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not create the managed install directory for ${agent.id}.`,
            cause,
          }),
      ),
    );
    const packageEnvironment =
      distribution === "npx"
        ? { ...environment, npm_config_prefix: packageRoot }
        : {
            ...environment,
            UV_TOOL_DIR: packageRoot,
            UV_TOOL_BIN_DIR: packageBinDirectory(agent, distribution),
          };
    if (Option.isSome(receipt)) {
      const installed = yield* discoverUvGlobalPackage(
        agent,
        packageSpec,
        managerPath,
        packageEnvironment,
      );
      if (Option.isSome(installed)) return installed.value;
    }

    const discover =
      distribution === "npx"
        ? () => discoverNpmGlobalPackage(agent, packageSpec, managerPath, packageEnvironment)
        : () => discoverUvGlobalPackage(agent, packageSpec, managerPath, packageEnvironment);
    const existing = yield* discover();
    if (Option.isSome(existing)) {
      yield* writePackageReceipt(existing.value);
      return existing.value;
    }

    const managerDirectory = yield* managerBinDirectory(managerPath);
    const installEnvironment = withPreferredPath(packageEnvironment, managerDirectory, platform);
    if (distribution === "npx") {
      yield* runCommand(managerPath, ["install", "--global", packageSpec], {
        env: installEnvironment,
        timeout: PACKAGE_INSTALL_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
    } else {
      yield* runCommand(managerPath, ["tool", "install", "--force", packageSpec], {
        env: installEnvironment,
        timeout: PACKAGE_INSTALL_TIMEOUT,
        truncatedOutputReason: "install_failed",
      });
    }

    if (distribution === "npx") {
      const installed = yield* discoverNpmGlobalPackage(
        agent,
        packageSpec,
        managerPath,
        packageEnvironment,
      );
      if (Option.isNone(installed)) {
        return yield* new AcpRegistryError({
          reason: "install_failed",
          detail: `ACP Registry installed ${packageSpec}, but could not resolve its global command.`,
        });
      }
      yield* writePackageReceipt(installed.value);
      return installed.value;
    }

    const installed = yield* discoverUvGlobalPackage(
      agent,
      packageSpec,
      managerPath,
      packageEnvironment,
    );
    if (Option.isNone(installed)) {
      return yield* new AcpRegistryError({
        reason: "install_failed",
        detail: `ACP Registry installed ${packageSpec}, but could not resolve its global command.`,
      });
    }
    yield* writePackageReceipt(installed.value);
    return installed.value;
  });

  const acquireInstallLock = Effect.fn("AcpRegistryCatalog.acquireInstallLock")(function* (
    lockPath: string,
  ) {
    for (let attempt = 0; attempt < INSTALL_LOCK_RETRY_COUNT; attempt += 1) {
      const acquired = yield* fileSystem.writeFileString(lockPath, "", { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => isAlreadyExists(error),
          () => Effect.succeed(false),
        ),
      );
      if (acquired) return;
      const now = yield* Clock.currentTimeMillis;
      const lockInfo = yield* fileSystem.stat(lockPath).pipe(Effect.option);
      const mtime = Option.flatMap(lockInfo, (info) => info.mtime);
      if (Option.isSome(mtime) && now - mtime.value.getTime() > INSTALL_LOCK_STALE_MS) {
        yield* fileSystem.remove(lockPath, { force: true });
        continue;
      }
      yield* Effect.sleep(INSTALL_LOCK_RETRY_DELAY);
    }
    return yield* new AcpRegistryError({
      reason: "install_failed",
      detail: `Timed out waiting for ACP Registry install lock ${lockPath}.`,
    });
  });

  const assertExecutableInRoot = Effect.fn("AcpRegistryCatalog.assertExecutableInRoot")(function* (
    root: string,
    executablePath: string,
  ) {
    const rootRealPath = yield* fileSystem.realPath(root);
    const executableRealPath = yield* fileSystem.realPath(executablePath);
    const relative = path.relative(rootRealPath, executableRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command resolves outside its installation directory.",
      });
    }
    const info = yield* fileSystem.stat(executableRealPath);
    const hasExecutableMode = platform === "win32" || (info.mode & 0o111) !== 0;
    if (info.type !== "File" || !hasExecutableMode) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: "ACP Registry archive command is not a regular executable file.",
      });
    }
    return executableRealPath;
  });

  const binaryPaths = (agent: AcpRegistryAgent, target: typeof AcpRegistryBinaryTarget.Type) => {
    const commandSegments = normalizeRegistryCommandPath(target.cmd);
    const matchedPlatformTarget =
      resolveAcpRegistryPlatformTargetCandidates(platformTarget).find(
        (candidate) => agent.distribution.binary?.[candidate] === target,
      ) ?? platformTarget;
    if (matchedPlatformTarget === undefined || commandSegments === undefined) return undefined;
    const installRoot = path.join(agentInstallRoot(agent), matchedPlatformTarget);
    return {
      commandSegments,
      installRoot,
      platformTarget: matchedPlatformTarget,
      executablePath: path.join(installRoot, ...commandSegments),
    };
  };

  const installBinary = Effect.fn("AcpRegistryCatalog.installBinary")(function* (
    agent: AcpRegistryAgent,
    target: typeof AcpRegistryBinaryTarget.Type,
  ) {
    if (platformTarget === undefined) {
      return yield* new AcpRegistryError({
        reason: "unsupported_platform",
        detail: `ACP Registry does not support platform ${platform}-${architecture}.`,
      });
    }
    const paths = binaryPaths(agent, target);
    if (paths === undefined) {
      return yield* new AcpRegistryError({
        reason: "archive_invalid",
        detail: `ACP Registry agent ${agent.id} declares an unsafe command path '${target.cmd}'.`,
      });
    }
    const { commandSegments, installRoot, executablePath } = paths;
    if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
      return yield* assertExecutableInRoot(installRoot, executablePath).pipe(
        Effect.mapError((cause) =>
          isAcpRegistryError(cause)
            ? cause
            : new AcpRegistryError({
                reason: "install_failed",
                detail: `Could not validate cached ACP Registry agent ${agent.id}.`,
                cause,
              }),
        ),
      );
    }

    yield* fileSystem.makeDirectory(path.dirname(installRoot), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new AcpRegistryError({
            reason: "install_failed",
            detail: `Could not create ACP Registry cache for ${agent.id}.`,
            cause,
          }),
      ),
    );
    const lockPath = `${installRoot}.lock`;
    yield* acquireInstallLock(lockPath).pipe(
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not acquire install lock for ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );

    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(executablePath).pipe(Effect.orElseSucceed(() => false))) {
        return yield* assertExecutableInRoot(installRoot, executablePath);
      }
      const temporaryRoot = yield* fileSystem.makeTempDirectoryScoped({
        directory: path.dirname(installRoot),
        prefix: `.${agent.id}-install-`,
      });
      const extractionRoot = path.join(temporaryRoot, "extracted");
      yield* fileSystem.makeDirectory(extractionRoot, { recursive: true });
      const kind = archiveKind(target.archive);
      const archivePath = path.join(temporaryRoot, archiveFileName(kind));
      const response = yield* httpClient.execute(HttpClientRequest.get(target.archive)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(
          (cause) =>
            new AcpRegistryError({
              reason: "download_failed",
              detail: `Could not download ACP Registry agent ${agent.id} ${agent.version}.`,
              cause,
            }),
        ),
        Effect.timeoutOrElse({
          duration: ARCHIVE_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new AcpRegistryError({
                reason: "download_failed",
                detail: `Timed out downloading ACP Registry agent ${agent.id} ${agent.version}.`,
              }),
            ),
        }),
      );
      // Stream hashes to avoid buffering large archives; Effect Crypto requires a whole buffer.
      const hash = sha256.create();
      let downloadedBytes = 0;
      yield* response.stream.pipe(
        Stream.tap((chunk) => {
          if (downloadedBytes + chunk.byteLength > MAX_ARCHIVE_BYTES) {
            return Effect.fail(
              new AcpRegistryError({
                reason: "archive_invalid",
                detail: `ACP Registry agent ${agent.id} archive exceeds ${MAX_ARCHIVE_BYTES} bytes.`,
              }),
            );
          }
          downloadedBytes += chunk.byteLength;
          hash.update(chunk);
          return Effect.void;
        }),
        Stream.run(fileSystem.sink(archivePath)),
        Effect.mapError((cause) =>
          isAcpRegistryError(cause)
            ? cause
            : new AcpRegistryError({
                reason: "download_failed",
                detail: `Could not save ACP Registry agent ${agent.id} ${agent.version}.`,
                cause,
              }),
        ),
        Effect.timeoutOrElse({
          duration: ARCHIVE_REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new AcpRegistryError({
                reason: "download_failed",
                detail: `Timed out reading ACP Registry agent ${agent.id} download.`,
              }),
            ),
        }),
      );
      if (target.sha256 !== undefined) {
        const actual = Hex.encode(hash.digest());
        if (actual !== target.sha256.toLowerCase()) {
          return yield* new AcpRegistryError({
            reason: "checksum_mismatch",
            detail: `ACP Registry agent ${agent.id} download did not match its declared SHA-256.`,
          });
        }
      }

      if (kind === "raw") {
        const targetPath = path.join(extractionRoot, ...commandSegments);
        yield* fileSystem.makeDirectory(path.dirname(targetPath), { recursive: true });
        yield* fileSystem.rename(archivePath, targetPath);
      } else {
        const tarCommand =
          platformTarget === "windows-aarch64" &&
          paths.platformTarget === "windows-x86_64" &&
          kind === "zip"
            ? cliArchiveTarCommand(platform, hostEnvironment)
            : "tar";
        const listArgs =
          kind === "tar_gz"
            ? ["-tzf", archivePath]
            : kind === "tar_bz2"
              ? ["-tjf", archivePath]
              : platform === "win32"
                ? ["-tf", archivePath]
                : undefined;
        const listingOptions = { maxStdoutBytes: MAX_ARCHIVE_LISTING_BYTES };
        const entries =
          listArgs === undefined
            ? yield* runCommand("unzip", ["-Z1", archivePath], listingOptions)
            : yield* runCommand(tarCommand, listArgs, listingOptions);
        if (!validateArchiveEntries(entries)) {
          return yield* new AcpRegistryError({
            reason: "archive_invalid",
            detail: `ACP Registry agent ${agent.id} archive contains an unsafe path.`,
          });
        }
        if (kind === "zip" && platform !== "win32") {
          yield* runCommand("unzip", ["-q", archivePath, "-d", extractionRoot]);
        } else {
          const extractFlag = kind === "tar_gz" ? "-xzf" : kind === "tar_bz2" ? "-xjf" : "-xf";
          yield* runCommand(tarCommand, [extractFlag, archivePath, "-C", extractionRoot]);
        }
      }

      const stagedExecutable = path.join(extractionRoot, ...commandSegments);
      if (!(yield* fileSystem.exists(stagedExecutable).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new AcpRegistryError({
          reason: "archive_invalid",
          detail: `ACP Registry archive for ${agent.id} did not contain '${target.cmd}'.`,
        });
      }
      if (platform !== "win32") yield* fileSystem.chmod(stagedExecutable, 0o755);
      yield* assertExecutableInRoot(extractionRoot, stagedExecutable);
      yield* fileSystem.remove(installRoot, { recursive: true, force: true });
      yield* fileSystem.rename(extractionRoot, installRoot);
      return yield* assertExecutableInRoot(installRoot, executablePath);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(fileSystem.remove(lockPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) =>
        isAcpRegistryError(cause)
          ? cause
          : new AcpRegistryError({
              reason: "install_failed",
              detail: `Could not install ACP Registry agent ${agent.id}.`,
              cause,
            }),
      ),
    );
  });

  return {
    ...index,
    runCommand,
    packageReceiptPath,
    readPackageReceipt,
    writePackageReceipt,
    parsePackageManagerPath,
    npmCommandName,
    discoverNpmGlobalPackage,
    discoverUvGlobalPackage,
    ensureGlobalPackage,
    acquireInstallLock,
    assertExecutableInRoot,
    binaryPaths,
    installBinary,
  };
  });
