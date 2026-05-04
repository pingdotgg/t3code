import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type AcpRegistryAgent,
  type AcpRegistryInstallBinaryResult,
  type AcpRegistryListResult,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";

const ACP_BINARY_INSTALLS_DIR = "acp_agents";
const ACP_BINARY_MANIFEST_FILE = "install.json";

type BinaryDistributionTarget = {
  readonly archive: string;
  readonly cmd: string;
};

class AcpRegistryBinaryInstallError extends Data.TaggedError("AcpRegistryBinaryInstallError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const AcpBinaryInstallManifest = Schema.Struct({
  layoutVersion: Schema.Literal(2),
  agentId: Schema.String,
  version: Schema.String,
  platformKey: Schema.String,
  command: Schema.String,
  archiveUrl: Schema.String,
});

type AcpBinaryInstallManifest = typeof AcpBinaryInstallManifest.Type;

function getAcpBinaryPlatformKey(): string {
  const os = process.platform;
  const cpu = process.arch;
  const osKey =
    os === "darwin" ? "darwin" : os === "win32" ? "windows" : os === "linux" ? "linux" : os;
  const archKey = cpu === "arm64" ? "aarch64" : cpu === "x64" ? "x86_64" : cpu;
  return `${osKey}-${archKey}`;
}

function getBinaryTarget(agent: AcpRegistryAgent): BinaryDistributionTarget | null {
  const binary = agent.distribution.binary;
  if (!binary || typeof binary !== "object" || globalThis.Array.isArray(binary)) return null;
  const target = (binary as Record<string, unknown>)[getAcpBinaryPlatformKey()];
  if (!target || typeof target !== "object" || globalThis.Array.isArray(target)) return null;
  const record = target as Record<string, unknown>;
  if (typeof record.archive !== "string" || typeof record.cmd !== "string") return null;
  return { archive: record.archive, cmd: record.cmd };
}

function resolveHomeDirectory(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

const normalizeArchiveCommandPath = (command: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const trimmed = command.trim();
    if (!trimmed) {
      return yield* Effect.fail(new Error("Registry binary command must not be empty."));
    }
    if (path.isAbsolute(trimmed)) {
      return yield* Effect.fail(
        new Error("Registry binary command must be a relative archive path."),
      );
    }
    const withoutLeadingDot = trimmed.replace(/^(?:\.[/\\])+/u, "");
    const parts = withoutLeadingDot
      .split(/[/\\]+/u)
      .filter((part) => part.length > 0 && part !== ".");
    if (parts.length === 0 || parts.some((part) => part === "..")) {
      return yield* Effect.fail(new Error("Registry binary command resolves outside the archive."));
    }
    return path.join(...parts);
  });

const resolveInstallRootFromBinaryPath = (binaryPath: string, commandRelativePath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const depth = commandRelativePath.split(/[/\\]+/u).filter((part) => part.length > 0).length;
    let installRoot = binaryPath;
    for (let index = 0; index < depth; index += 1) {
      installRoot = path.dirname(installRoot);
    }
    return installRoot;
  });

const resolveAcpBinaryInstallPath = (
  config: { readonly stateDir: string },
  agent: AcpRegistryAgent,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const commandPath = yield* normalizeArchiveCommandPath(getBinaryTarget(agent)?.cmd ?? agent.id);
    return path.join(
      config.stateDir,
      ACP_BINARY_INSTALLS_DIR,
      agent.id,
      agent.version,
      commandPath,
    );
  });

const expandUserPath = (inputPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = resolveHomeDirectory();
    if (!home) return inputPath;
    if (inputPath === "~") return home;
    if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
      return path.join(home, inputPath.slice(2));
    }
    return inputPath;
  });

const normalizeAcpBinaryInstallPath = (inputPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const expanded = yield* expandUserPath(inputPath.trim());
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  });

const displayPath = (inputPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = resolveHomeDirectory();
    return home && (inputPath === home || inputPath.startsWith(`${home}${path.sep}`))
      ? `~${inputPath.slice(home.length)}`
      : inputPath;
  });

const isPathInside = (parent: string, child: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const relativePath = path.relative(parent, child);
    return (
      relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
  });

const toBinaryInstallPreview = (
  config: { readonly stateDir: string },
  agent: AcpRegistryAgent,
  target: BinaryDistributionTarget,
) =>
  Effect.gen(function* () {
    const defaultInstallPath = yield* resolveAcpBinaryInstallPath(config, agent);
    return {
      archiveUrl: target.archive,
      defaultInstallPath: yield* displayPath(defaultInstallPath),
      platformKey: getAcpBinaryPlatformKey(),
      command: target.cmd,
    };
  });

const resolveAcpBinaryManifestPath = (
  config: { readonly stateDir: string },
  agent: AcpRegistryAgent,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const installPath = yield* resolveAcpBinaryInstallPath(config, agent);
    return path.join(path.dirname(installPath), ACP_BINARY_MANIFEST_FILE);
  });

const readAcpBinaryManifest = (config: { readonly stateDir: string }, agent: AcpRegistryAgent) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const manifestPath = yield* resolveAcpBinaryManifestPath(config, agent);
    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.option);
    if (raw._tag === "None") return null;
    const json = yield* Effect.try({
      try: () => JSON.parse(raw.value) as unknown,
      catch: () => null,
    });
    if (json === null) return null;
    const parsed = yield* Schema.decodeUnknownEffect(AcpBinaryInstallManifest)(json).pipe(
      Effect.option,
    );
    if (parsed._tag === "None") return null;
    const manifest = parsed.value;
    if (
      manifest.agentId === agent.id &&
      manifest.version === agent.version &&
      manifest.platformKey === getAcpBinaryPlatformKey() &&
      (yield* fs.exists(manifest.command))
    ) {
      return manifest;
    }
    return null;
  });

const downloadFile = (url: string, destination: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Download failed with status ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      catch: (cause) =>
        new AcpRegistryBinaryInstallError({
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
    yield* fs.writeFile(destination, bytes);
  });

const runArchiveCommand = (command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, [...args]));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      return yield* Effect.fail(
        new Error(
          `Archive command '${command}' failed with exit code ${String(exitCode)}: ${
            stderr || stdout
          }`,
        ),
      );
    }
  }).pipe(Effect.scoped);

const extractArchive = (archivePath: string, destinationDir: string) => {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    return runArchiveCommand("tar", ["-xzf", archivePath, "-C", destinationDir]);
  }
  if (archivePath.endsWith(".zip")) {
    if (process.platform === "win32") {
      return runArchiveCommand("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archivePath,
        "-DestinationPath",
        destinationDir,
        "-Force",
      ]);
    }
    return runArchiveCommand("unzip", ["-q", archivePath, "-d", destinationDir]);
  }
  return Effect.fail(new Error("Unsupported binary archive format."));
};

function toInstallError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const installAcpBinaryAgent = (input: {
  readonly config: { readonly stateDir: string };
  readonly agent: AcpRegistryAgent;
  readonly installPath?: string | undefined;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = getBinaryTarget(input.agent);
    if (!target) {
      return yield* Effect.fail(
        new Error(`No binary is available for ${getAcpBinaryPlatformKey()}.`),
      );
    }
    const defaultInstallPath = yield* resolveAcpBinaryInstallPath(input.config, input.agent);
    const installPath = yield* normalizeAcpBinaryInstallPath(
      input.installPath?.trim() || defaultInstallPath,
    );
    const commandPath = yield* normalizeArchiveCommandPath(target.cmd);
    const installRoot = yield* resolveInstallRootFromBinaryPath(installPath, commandPath);
    if (installRoot === path.dirname(installRoot)) {
      return yield* Effect.fail(
        new Error(`Binary path is too shallow for registry command '${target.cmd}'.`),
      );
    }
    const manifestPath = yield* resolveAcpBinaryManifestPath(input.config, input.agent);
    const tempDir = yield* fs.makeTempDirectory({ prefix: "t3-acp-agent-" });
    yield* Effect.addFinalizer(() =>
      fs.remove(tempDir, { recursive: true, force: true }).pipe(Effect.ignore),
    );

    const archivePath = path.join(
      tempDir,
      path.basename(new URL(target.archive).pathname) || "agent.archive",
    );
    const extractDir = path.join(tempDir, "extract");
    yield* fs.makeDirectory(extractDir, { recursive: true });
    yield* downloadFile(target.archive, archivePath);
    yield* extractArchive(archivePath, extractDir);

    const extractedCommand = path.resolve(extractDir, commandPath);
    if (!(yield* isPathInside(extractDir, extractedCommand))) {
      return yield* Effect.fail(new Error("Registry binary command resolves outside the archive."));
    }
    if (!(yield* fs.exists(extractedCommand))) {
      return yield* Effect.fail(
        new Error(`Installed archive did not contain expected command '${target.cmd}'.`),
      );
    }
    yield* fs.makeDirectory(installRoot, { recursive: true });
    yield* fs.copy(extractDir, installRoot, { overwrite: true });
    if (!(yield* fs.exists(installPath))) {
      yield* fs.makeDirectory(path.dirname(installPath), { recursive: true });
      yield* fs.copyFile(extractedCommand, installPath);
    }
    if (process.platform !== "win32") {
      yield* fs.chmod(installPath, 0o755);
    }
    const manifest: AcpBinaryInstallManifest = {
      layoutVersion: 2,
      agentId: input.agent.id,
      version: input.agent.version,
      platformKey: getAcpBinaryPlatformKey(),
      command: installPath,
      archiveUrl: target.archive,
    };
    yield* fs.makeDirectory(path.dirname(manifestPath), { recursive: true });
    yield* fs.writeFileString(manifestPath, JSON.stringify(manifest, null, 2));
    return { ...target, command: installPath };
  }).pipe(Effect.scoped);

export const toAcpLaunchSpec = (agent: AcpRegistryAgent) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (agent.distribution.npx) {
      return {
        supported: true as const,
        distributionType: "npx" as const,
        launch: {
          command: "npx",
          args: ["-y", agent.distribution.npx.package, ...(agent.distribution.npx.args ?? [])],
          env: agent.distribution.npx.env ?? {},
        },
      };
    }
    if (agent.distribution.uvx) {
      return {
        supported: true as const,
        distributionType: "uvx" as const,
        launch: {
          command: "uvx",
          args: [agent.distribution.uvx.package, ...(agent.distribution.uvx.args ?? [])],
          env: agent.distribution.uvx.env ?? {},
        },
      };
    }
    const manifest = yield* readAcpBinaryManifest(config, agent);
    const target = getBinaryTarget(agent);
    if (manifest) {
      return {
        supported: true as const,
        distributionType: "binary" as const,
        launch: {
          command: manifest.command,
          args: [],
          env: {},
        },
        ...(target ? { binaryInstall: yield* toBinaryInstallPreview(config, agent, target) } : {}),
      };
    }
    return {
      supported: false as const,
      distributionType: "binaryUnsupported" as const,
      launch: null,
      ...(target ? { binaryInstall: yield* toBinaryInstallPreview(config, agent, target) } : {}),
    };
  });

export const listAcpRegistryAgents = (registry: {
  readonly version: string;
  readonly agents: ReadonlyArray<AcpRegistryAgent>;
}) =>
  Effect.gen(function* () {
    const agents = yield* Effect.forEach(registry.agents, (agent) =>
      toAcpLaunchSpec(agent).pipe(
        Effect.map((resolved) => ({
          agent,
          supported: resolved.supported,
          distributionType: resolved.distributionType,
          launch: resolved.launch,
          ...("binaryInstall" in resolved && resolved.binaryInstall
            ? { binaryInstall: resolved.binaryInstall }
            : {}),
        })),
      ),
    );
    return {
      registryVersion: registry.version,
      agents: agents.toSorted((left, right) => left.agent.name.localeCompare(right.agent.name)),
    } satisfies AcpRegistryListResult;
  });

export const installAcpRegistryBinaryAgent = (input: {
  readonly registry: {
    readonly agents: ReadonlyArray<AcpRegistryAgent>;
  };
  readonly agentId: string;
  readonly installPath?: string | undefined;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const agent = input.registry.agents.find((entry) => entry.id === input.agentId);
    if (!agent) {
      return {
        ok: false,
        error: `No ACP registry agent found for '${input.agentId}'.`,
      } satisfies AcpRegistryInstallBinaryResult;
    }
    const installed = yield* installAcpBinaryAgent({
      config,
      agent,
      installPath: input.installPath,
    });
    return {
      ok: true,
      agent: {
        agent,
        supported: true,
        distributionType: "binary",
        binaryInstall: yield* toBinaryInstallPreview(config, agent, installed),
        launch: {
          command: installed.command,
          args: [],
          env: {},
        },
      },
    } satisfies AcpRegistryInstallBinaryResult;
  }).pipe(
    Effect.catch((cause: unknown) =>
      Effect.succeed({
        ok: false,
        error: toInstallError(cause),
      } satisfies AcpRegistryInstallBinaryResult),
    ),
  );
