import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Hex from "effect/encoding/Hex";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { prefersHttpMcpTransport } from "./mcpTransport.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const registryUrl = "https://registry.test/registry.json";
const archiveUrl = "https://registry.test/example-agent.bin";
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function makeAgent(
  distribution: AcpRegistrySupport.AcpRegistryAgent["distribution"],
): AcpRegistrySupport.AcpRegistryAgent {
  return {
    id: "example-agent",
    name: "Example Agent",
    version: "1.2.3",
    description: "ACP Registry test agent",
    distribution,
  };
}

function makeRegistry(agent: AcpRegistrySupport.AcpRegistryAgent): string {
  return JSON.stringify({ version: "1.0.0", agents: [agent] });
}

function settings(input: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    agentId: "example-agent",
    ...input,
  });
}

function layerResolver(
  execute: Parameters<typeof HttpClient.make>[0],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    TestProviderHost.layer().pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, environment),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
  );
}

const makeFakeNpmToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeNpmToolchain")(function* (
  rootDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toolchainBin = path.join(rootDirectory, "fake-node", "bin");
  const globalPrefix = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "npm");
  const globalBin = path.join(globalPrefix, "bin");
  const executablePath = path.join(globalBin, "example-agent");
  const npmPath = path.join(toolchainBin, "npm");
  const logPath = path.join(rootDirectory, "npm.log");
  yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
  yield* fileSystem.makeDirectory(globalPrefix, { recursive: true });
  yield* fileSystem.writeFileString(logPath, "");
  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/AcpRegistrySupport.npm.fixture.sh", import.meta.url),
    ),
    npmPath,
  );
  yield* fileSystem.chmod(npmPath, 0o755);
  // The fake toolchain runs on the real host, not the simulated provider environment.
  const hostEnv = HostProcess.Environment.defaultValue();
  return {
    environment: {
      ...hostEnv,
      PATH: `${toolchainBin}:${hostEnv.PATH ?? ""}`,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_PREFIX: path.join(rootDirectory, "external-npm-global"),
      FAKE_NPM_MANIFEST: encodeUnknownJson({
        name: "@example/acp",
        version: "1.2.3",
        bin: { "example-agent": "dist/cli.js" },
      }),
    } satisfies NodeJS.ProcessEnv,
    executablePath,
    globalBin,
    logPath,
    npmPath,
  };
});

const makeFakeUvToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeUvToolchain")(function* (
  rootDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toolchainBin = path.join(rootDirectory, "fake-uv", "bin");
  const globalBin = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "python", "bin");
  const executablePath = path.join(globalBin, "fast-agent");
  const uvPath = path.join(toolchainBin, "uv");
  const logPath = path.join(rootDirectory, "uv.log");
  yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
  yield* fileSystem.writeFileString(logPath, "");
  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(new URL("./testing/AcpRegistrySupport.uv.fixture.sh", import.meta.url)),
    uvPath,
  );
  yield* fileSystem.chmod(uvPath, 0o755);
  // The fake toolchain runs on the real host, not the simulated provider environment.
  const hostEnv = HostProcess.Environment.defaultValue();
  return {
    environment: {
      ...hostEnv,
      PATH: `${toolchainBin}:${hostEnv.PATH ?? ""}`,
      FAKE_UV_LOG: logPath,
      FAKE_UV_BIN: path.join(rootDirectory, "external-uv-bin"),
      FAKE_UV_EXECUTABLE: executablePath,
    } satisfies NodeJS.ProcessEnv,
    executablePath,
    globalBin,
    logPath,
    uvPath,
  };
});

describe("AcpRegistrySupport", () => {
  it("selects the preferred compatible distribution", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp"],
        },
      },
      npx: {
        package: "@example/acp@1.2.3",
        args: ["--stdio"],
      },
    });

    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "auto",
        platformTarget: "linux-x86_64",
      }),
    ).toMatchObject({ kind: "binary", args: ["acp"] });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "npx",
        platformTarget: "linux-x86_64",
      }),
    ).toEqual({
      kind: "npx",
      packageName: "@example/acp@1.2.3",
      args: ["--stdio"],
      env: {},
    });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "binary",
        platformTarget: "darwin-aarch64",
      }),
    ).toBeUndefined();
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent: makeAgent({
          binary: {
            "windows-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-x64.exe",
              args: ["acp"],
            },
          },
        }),
        preference: "auto",
        platformTarget: "windows-aarch64",
      }),
    ).toMatchObject({
      kind: "binary",
      binaryTarget: { cmd: "./bin/example-agent-x64.exe" },
    });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent: makeAgent({
          binary: {
            "windows-aarch64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-arm64.exe",
              args: ["acp"],
            },
            "windows-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-x64.exe",
              args: ["acp"],
            },
          },
        }),
        preference: "auto",
        platformTarget: "windows-aarch64",
      }),
    ).toMatchObject({
      kind: "binary",
      binaryTarget: { cmd: "./bin/example-agent-arm64.exe" },
    });
  });

  it.effect("resolves a local command on the selected environment without the registry", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-local-" });
      const commandPath = `${cacheDir}/dsh`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const hostEnvironment = { PATH: "/missing-host-bin", INHERITED: "host", OVERRIDE: "host" };
      const environment = { ...hostEnvironment, PATH: cacheDir, OVERRIDE: "provider" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment));
      const localSettings = decodeAcpRegistrySettings({
        source: "local",
        commandPath: "dsh",
        commandArgs: ["--profile", "acp", "", " spaced ", "$(touch injected); $VALUE"],
      });

      expect(yield* resolver.inspect(localSettings)).toMatchObject({ status: "missing_runner" });
      expect(yield* resolver.inspect(localSettings, environment)).toEqual({
        status: "ready",
        agentId: "dsh",
        version: null,
        distribution: "local",
      });
      const resolved = yield* resolver.resolve(localSettings, "/workspace", environment);
      expect(resolved).toEqual({
        distribution: "local",
        spawn: {
          command: commandPath,
          args: ["--profile", "acp", "", " spaced ", "$(touch injected); $VALUE"],
          cwd: "/workspace",
          env: environment,
          shell: false,
        },
      });
      expect(requests).toEqual([]);
      expect(yield* fileSystem.exists(`${cacheDir}/tools`)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.die("unexpected registry request for a local provider");
        }),
      ),
    );
  });

  it.effect("resolves a local executable path and inherits the host environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-local-path-" });
      const commandPath = `${cacheDir}/dsh wrapper`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const environment = { PATH: "/unused", INHERITED: "host" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));
      const resolved = yield* resolver.resolve(
        decodeAcpRegistrySettings({ source: "local", commandPath }),
        "/workspace",
      );

      expect(resolved.spawn).toEqual({
        command: commandPath,
        args: [],
        cwd: "/workspace",
        env: environment,
        shell: false,
      });
      expect(resolved.agent).toBeUndefined();

      for (const extension of [".cmd", ".BAT"]) {
        const windowsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, async () => `C:\\bin\\dsh${extension}`),
        );
        const localSettings = decodeAcpRegistrySettings({ source: "local", commandPath: "dsh" });
        for (const failure of [
          yield* windowsResolver.inspect(localSettings).pipe(Effect.flip),
          yield* windowsResolver.resolve(localSettings, "/workspace").pipe(Effect.flip),
        ]) {
          expect(failure).toMatchObject({
            reason: "runner_unavailable",
            detail: expect.stringContaining("node.exe"),
          });
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("resolves the local Command Code configurations the HTTP selector matches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-command-code-",
      });
      const catalog = (executable: string) =>
        AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => executable),
        );

      const bare = decodeAcpRegistrySettings({ source: "local", commandPath: "cmdc" });
      expect(prefersHttpMcpTransport(bare)).toBe(true);
      expect(
        yield* (yield* catalog("C:\\bin\\cmdc.exe")).resolve(bare, "/workspace"),
      ).toMatchObject({ spawn: { command: "C:\\bin\\cmdc.exe", shell: false } });
      // A bare name that PATHEXT resolves to a batch shim never launches, so the transport it
      // selects cannot matter: there is no session to attach MCP servers to.
      expect(
        yield* (yield* catalog("C:\\bin\\cmdc.cmd")).resolve(bare, "/workspace").pipe(Effect.flip),
      ).toMatchObject({ reason: "runner_unavailable" });

      const vendored = decodeAcpRegistrySettings({
        source: "local",
        commandPath: "node.exe",
        commandArgs: [
          "C:\\Users\\me\\.t3\\bin\\cmdcode\\node_modules\\command-code\\dist\\index.mjs",
          "acp",
        ],
      });
      expect(prefersHttpMcpTransport(vendored)).toBe(true);
      expect(
        yield* (yield* catalog("C:\\Program Files\\nodejs\\node.exe")).resolve(
          vendored,
          "/workspace",
        ),
      ).toMatchObject({ spawn: { command: "C:\\Program Files\\nodejs\\node.exe" } });
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("reports missing or non-executable local commands without registry fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-local-missing-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const environment = { PATH: cacheDir };
      const unconfigured = decodeAcpRegistrySettings({ source: "local" });
      expect(yield* resolver.inspect(unconfigured, environment)).toEqual({
        status: "unconfigured",
      });
      expect(
        yield* resolver.resolve(unconfigured, "/workspace", environment).pipe(Effect.flip),
      ).toMatchObject({ reason: "agent_not_configured" });

      const nonExecutable = `${cacheDir}/non-executable`;
      yield* fileSystem.writeFileString(nonExecutable, "#!/bin/sh\n");
      yield* fileSystem.chmod(nonExecutable, 0o644);
      for (const commandPath of ["dsh", `${cacheDir}/missing`, cacheDir, nonExecutable]) {
        const localSettings = decodeAcpRegistrySettings({ source: "local", commandPath });
        expect(yield* resolver.inspect(localSettings, environment)).toEqual({
          status: "missing_runner",
          version: null,
          distribution: "local",
        });
        expect(
          yield* resolver.resolve(localSettings, "/workspace", environment).pipe(Effect.flip),
        ).toMatchObject({
          reason: "runner_unavailable",
          detail: "Local ACP executable is not available on this environment's PATH.",
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("resolves command overrides while preserving registry args and environment", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp", "--stdio"],
          env: { REGISTRY_VALUE: "registry", OVERRIDE_ME: "registry" },
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-override-",
      });
      const commandPath = `${cacheDir}/example-agent`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings({ commandPath }), "/workspace", {
        HOST_VALUE: "host",
        OVERRIDE_ME: "host",
      });

      expect(resolved.distribution).toBe("binary");
      expect(resolved.spawn).toEqual({
        command: commandPath,
        args: ["acp", "--stdio"],
        cwd: "/workspace",
        env: {
          HOST_VALUE: "host",
          OVERRIDE_ME: "registry",
          REGISTRY_VALUE: "registry",
        },
      });
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("installs into T3 home a package and launches its exposed command", () => {
    const agent = makeAgent({
      npx: { package: "@example/acp@V1.2.3", args: ["--stdio"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-global-package-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));

      const first = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);
      const second = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(first.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--stdio"],
        env: { PATH: expect.stringMatching(new RegExp(`^${toolchain.globalBin}:`, "u")) },
      });
      expect(second.spawn.command).toBe(toolchain.executablePath);
      const npmCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(npmCommands.match(/^install --global /gmu)).toHaveLength(1);
      expect(npmCommands).toContain("install --global @example/acp@V1.2.3");

      // A missing npm bin link must not select an unrelated command from the user's PATH.
      const userBin = `${cacheDir}/user-bin`;
      yield* fileSystem.makeDirectory(userBin);
      yield* fileSystem.writeFileString(`${userBin}/example-agent`, "#!/bin/sh\n");
      yield* fileSystem.chmod(`${userBin}/example-agent`, 0o755);
      yield* fileSystem.remove(toolchain.executablePath);
      const userEnvironment = {
        ...toolchain.environment,
        PATH: `${userBin}:${toolchain.environment.PATH}`,
      };
      const repaired = yield* resolver.resolve(settings(), "/workspace", userEnvironment);
      expect(repaired.spawn.command).toBe(toolchain.executablePath);
      const repairCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(repairCommands.match(/^install --global /gmu)).toHaveLength(2);

      yield* fileSystem.remove(toolchain.executablePath);
      const failedRepair = yield* resolver
        .resolve(settings(), "/workspace", { ...userEnvironment, npm_config_bin_links: "false" })
        .pipe(Effect.flip);
      expect(failedRepair.reason).toBe("install_failed");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("uses its managed prefix despite a system-owned npm prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-user-global-package-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const systemPrefix = path.join(cacheDir, "system-global");
      yield* fileSystem.makeDirectory(systemPrefix);
      yield* fileSystem.chmod(systemPrefix, 0o555);
      const userHome = path.join(cacheDir, "home");
      const environment = {
        ...toolchain.environment,
        HOME: userHome,
        FAKE_NPM_PREFIX: systemPrefix,
      };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const resolved = yield* resolver.resolve(settings(), "/workspace", environment);
      const userGlobalBin = toolchain.globalBin;
      expect(resolved.spawn).toMatchObject({
        command: path.join(userGlobalBin, "example-agent"),
        env: { PATH: expect.stringMatching(new RegExp(`^${userGlobalBin}:`, "u")) },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("gives Windows npm commands only the managed prefix spelling", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-windows-npm-prefix-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, NPM_CONFIG_PREFIX: "C:\\inherited-npm" };
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const npmEnvironments: Array<Record<string, unknown>> = [];
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "npm" ? toolchain.npmPath : undefined,
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.command === toolchain.npmPath) {
              npmEnvironments.push({ ...command.options.env });
            }
            return realSpawner.spawn(command);
          }),
        ),
      );

      yield* resolver.resolve(settings(), "C:\\workspace", environment).pipe(Effect.ignore);

      expect(npmEnvironments.length).toBeGreaterThan(0);
      for (const env of npmEnvironments) {
        expect(Object.keys(env).filter((key) => key.toLowerCase() === "npm_config_prefix")).toEqual(
          ["npm_config_prefix"],
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("keeps only the end of a failed install's output in its error", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-failed-install-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, FAKE_NPM_INSTALL_FAILURE_LINES: "40000" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const error = yield* resolver
        .resolve(settings(), "/workspace", environment)
        .pipe(Effect.flip);

      expect(error.reason).toBe("install_failed");
      expect(error.detail).toContain("exited with code 1");
      expect(error.detail).toMatch(/npm error see the complete log for details$/u);
      expect(error.detail.split("exited with code 1: ")[1]?.length).toBeLessThanOrEqual(1_000);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("launches the managed uv command over a PATH command named after the agent", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-uv-path-collision-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const userBin = path.join(cacheDir, "user-bin");
      const userCommand = path.join(userBin, "example-agent");
      yield* fileSystem.makeDirectory(userBin, { recursive: true });
      yield* fileSystem.writeFileString(userCommand, "#!/bin/sh\n");
      yield* fileSystem.chmod(userCommand, 0o755);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      const resolved = yield* resolver.resolve(settings(), "/workspace", {
        ...toolchain.environment,
        PATH: `${userBin}:${toolchain.environment.PATH}`,
      });

      expect(resolved.spawn.command).toBe(toolchain.executablePath);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("honors an exact Windows PATH override when launching a global package", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-windows-package-path-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const linuxResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* linuxResolver.resolve(settings(), "/workspace", toolchain.environment);

      const windowsEnvironment = {
        ...toolchain.environment,
        Path: "C:\\host\\bin",
        PATH: "C:\\provider\\bin",
      };
      const windowsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (command) => {
          if (command === "uv") return toolchain.uvPath;
          if (command === "fast-agent") return toolchain.executablePath;
          return undefined;
        }),
      );
      const resolved = yield* windowsResolver.resolve(
        settings(),
        "C:\\workspace",
        windowsEnvironment,
      );

      expect(resolved.spawn).toMatchObject({
        env: { PATH: `${toolchain.globalBin};C:\\provider\\bin` },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect(
    "installs, reuses, and replaces a registry binary in the managed cache when the artifact changes",
    () => {
      const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
      const replacementBytes = new TextEncoder().encode("#!/bin/sh\necho example-repackaged\n");
      const rehashedBytes = new TextEncoder().encode("#!/bin/sh\necho example-rehashed\n");
      const replacementArchiveUrl = "https://registry.test/example-agent-repackaged.bin";
      const replacementSha256 = Hex.encode(sha256(replacementBytes));
      const rehashedSha256 = Hex.encode(sha256(rehashedBytes));
      let serveRehashedAtReplacement = false;
      let currentAgent = makeAgent({
        binary: {
          "linux-x86_64": {
            archive: archiveUrl,
            cmd: "./bin/example-agent",
            args: ["acp"],
            sha256: "97b29a636d7ddf7bf3567ae4d48c0f2a9b03943fd808b6efbf74f1dd3db131b7",
          },
        },
      });
      const requests: Array<string> = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-install-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const first = yield* resolver.resolve(settings(), "/workspace");
        const second = yield* resolver.resolve(settings(), "/workspace");

        expect(first.spawn.command).toBe(second.spawn.command);
        expect(first.spawn.command).toContain(
          "/tools/example-agent/1.2.3/linux-x86_64/bin/example-agent",
        );
        expect(yield* fileSystem.readFileString(first.spawn.command)).toBe(
          "#!/bin/sh\necho example\n",
        );
        expect(requests).toEqual([registryUrl, archiveUrl]);

        // Repackaging at the same version installs into an immutable artifact-scoped sibling slot,
        // keeping the primary install intact for active sessions while preferring the new slot.
        currentAgent = makeAgent({
          binary: {
            "linux-x86_64": {
              archive: replacementArchiveUrl,
              cmd: "./bin/example-agent",
              args: ["acp"],
              sha256: replacementSha256,
            },
          },
        });
        yield* resolver.invalidateIndex();
        yield* resolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const third = yield* resolver.resolve(settings(), "/workspace");
        const fourth = yield* resolver.resolve(settings(), "/workspace");
        expect(third.spawn.command).not.toBe(first.spawn.command);
        expect(third.spawn.command).toMatch(
          /\/tools\/example-agent\/1\.2\.3\/linux-x86_64-[0-9a-f]{12}\/bin\/example-agent$/u,
        );
        expect(fourth.spawn.command).toBe(third.spawn.command);
        expect(third.launchIdentity).not.toBe(first.launchIdentity);
        expect(yield* fileSystem.readFileString(first.spawn.command)).toBe(
          "#!/bin/sh\necho example\n",
        );
        expect(yield* fileSystem.readFileString(third.spawn.command)).toBe(
          "#!/bin/sh\necho example-repackaged\n",
        );
        expect(requests).toEqual([registryUrl, archiveUrl, registryUrl, replacementArchiveUrl]);

        const path = yield* Path.Path;
        const managedDirs = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          platform: "linux",
          architecture: "x64",
        });
        expect(managedDirs.slice(0, 2)).toEqual([
          path.dirname(third.spawn.command),
          path.dirname(first.spawn.command),
        ]);

        // Rolling back to artifact A (in the primary receipted slot) ranks primary A ahead of the
        // newer hashed replacement slot B on terminal PATH.
        currentAgent = makeAgent({
          binary: {
            "linux-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent",
              args: ["acp"],
              sha256: "97b29a636d7ddf7bf3567ae4d48c0f2a9b03943fd808b6efbf74f1dd3db131b7",
            },
          },
        });
        yield* resolver.invalidateIndex();
        yield* resolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const rolledBackToPrimary = yield* resolver.resolve(settings(), "/workspace");
        expect(rolledBackToPrimary.spawn.command).toBe(first.spawn.command);
        const managedDirsAfterRollback =
          yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
            cacheDir,
            toolsDir: `${cacheDir}/tools`,
            platform: "linux",
            architecture: "x64",
          });
        expect(managedDirsAfterRollback.slice(0, 2)).toEqual([
          path.dirname(first.spawn.command),
          path.dirname(third.spawn.command),
        ]);

        // Changing only sha256 at the same archive URL & cmd must install into a new artifact slot.
        serveRehashedAtReplacement = true;
        currentAgent = makeAgent({
          binary: {
            "linux-x86_64": {
              archive: replacementArchiveUrl,
              cmd: "./bin/example-agent",
              args: ["acp"],
              sha256: rehashedSha256,
            },
          },
        });
        yield* resolver.invalidateIndex();
        yield* resolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const rehashed = yield* resolver.resolve(settings(), "/workspace");
        expect(rehashed.spawn.command).not.toBe(third.spawn.command);
        expect(yield* fileSystem.readFileString(rehashed.spawn.command)).toBe(
          "#!/bin/sh\necho example-rehashed\n",
        );
        expect(yield* fileSystem.readFileString(third.spawn.command)).toBe(
          "#!/bin/sh\necho example-repackaged\n",
        );

        // A failed replacement (checksum mismatch) leaves existing installed binaries intact.
        currentAgent = makeAgent({
          binary: {
            "linux-x86_64": {
              archive: replacementArchiveUrl,
              cmd: "./bin/example-agent",
              args: ["acp"],
              sha256: "0".repeat(64),
            },
          },
        });
        yield* resolver.invalidateIndex();
        yield* resolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const checksumError = yield* resolver.resolve(settings(), "/workspace").pipe(Effect.flip);
        expect(checksumError.reason).toBe("checksum_mismatch");
        expect(yield* fileSystem.readFileString(rehashed.spawn.command)).toBe(
          "#!/bin/sh\necho example-rehashed\n",
        );

        // Uninstalling removes the primary slot and all artifact-scoped sibling slots.
        expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
          agentId: "example-agent",
          removed: true,
        });
        expect(yield* fileSystem.exists(`${cacheDir}/tools/example-agent`)).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            requests.push(request.url);
            const payload =
              request.url === replacementArchiveUrl
                ? serveRehashedAtReplacement
                  ? rehashedBytes
                  : replacementBytes
                : binaryBytes;
            const response =
              request.url === registryUrl
                ? new Response(makeRegistry(currentAgent))
                : new Response(
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(payload.slice(0, 8));
                        controller.enqueue(payload.slice(8));
                        controller.close();
                      },
                    }),
                  );
            return Effect.succeed(HttpClientResponse.fromWeb(request, response));
          }),
        ),
      );
    },
  );

  it.effect(
    "preserves offline legacy binaries without fabricating a receipt, retries same-version archive swaps on download failure, and falls back to prior receipted versions",
    () => {
      const legacyArchiveUrl = "https://example.test/example-agent-1.0.0.bin";
      const swappedArchiveUrl = "https://example.test/example-agent-1.0.0-fixed.bin";
      const v2ArchiveUrl = "https://example.test/example-agent-2.0.0.bin";
      const v1PrimaryBytes = new TextEncoder().encode("#!/bin/sh\necho v1-primary\n");
      const v1Bytes = new TextEncoder().encode("#!/bin/sh\necho v1-fixed\n");
      const v2Bytes = new TextEncoder().encode("#!/bin/sh\necho v2\n");
      let offline = true;
      let failSwappedDownload = false;
      let failV2Download = true;
      let serveEmptyRegistry = false;
      let checksumGate: {
        readonly started: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;
      let requests: Array<string> = [];
      let currentAgent = {
        ...makeAgent({
          binary: {
            "linux-x86_64": {
              archive: legacyArchiveUrl,
              cmd: "./bin/example-agent",
              args: ["--v1"],
              env: { AGENT_CHANNEL: "v1" },
            },
          },
        }),
        version: "1.0.0",
      };
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-offline-fallback-",
        });
        const toolsDir = path.join(cacheDir, "tools");
        const legacyRoot = path.join(toolsDir, "example-agent", "1.0.0", "linux-x86_64");
        const legacyBinary = path.join(legacyRoot, "bin", "example-agent");
        const legacyReceipt = path.join(legacyRoot, ".t3-artifact.json");
        yield* fileSystem.makeDirectory(path.dirname(legacyBinary), { recursive: true });
        yield* fileSystem.writeFileString(legacyBinary, "#!/bin/sh\necho legacy-v1\n");
        yield* fileSystem.chmod(legacyBinary, 0o755);
        yield* fileSystem.makeDirectory(path.join(cacheDir, "acp-registry"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(cacheDir, "acp-registry", "registry.json"),
          makeRegistry(currentAgent),
        );

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir,
          registryUrl,
        });

        // 1. Pre-existing receipt-less binary works offline without downloading or fabricating a receipt.
        const offlineLegacy = yield* resolver.resolve(settings(), "/workspace");
        expect(offlineLegacy.agent?.version).toBe("1.0.0");
        expect(offlineLegacy.spawn.command).toBe(legacyBinary);
        expect(offlineLegacy.fallback).toBeUndefined();
        expect(requests).toEqual([]);
        expect(yield* fileSystem.exists(legacyReceipt)).toBe(false);

        // Changing only args/env while keeping archive/cmd/sha256 unchanged still reuses the legacy binary.
        offline = false;
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: legacyArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v1-updated-args"],
                env: { AGENT_CHANNEL: "v1-updated" },
              },
            },
          }),
          version: "1.0.0",
        };
        yield* resolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const legacyWithUpdatedArgs = yield* resolver.resolve(settings(), "/workspace");
        expect(legacyWithUpdatedArgs.spawn.command).toBe(legacyBinary);
        expect(legacyWithUpdatedArgs.spawn.args).toEqual(["--v1-updated-args"]);
        expect(yield* fileSystem.exists(legacyReceipt)).toBe(false);

        // 2. If the registry updates the same-version archive URL and the new download fails,
        // a durable baseline permanently rejects the receipt-less legacy binary for the new artifact
        // across repeated calls and server restarts.
        failSwappedDownload = true;
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: swappedArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v1-fixed"],
                env: { AGENT_CHANNEL: "v1-fixed" },
              },
            },
          }),
          version: "1.0.0",
        };
        yield* resolver.invalidateIndex();
        yield* resolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const changedArtifactFailure1 = yield* resolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(changedArtifactFailure1.reason).toBe("download_failed");
        const changedArtifactFailure2 = yield* resolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(changedArtifactFailure2.reason).toBe("download_failed");
        const restartedResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir,
          registryUrl,
        });
        const changedArtifactAfterRestart = yield* restartedResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(changedArtifactAfterRestart.reason).toBe("download_failed");
        // Superseded legacy primary slots are also excluded from managed terminal PATH directories.
        expect(
          yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
            cacheDir,
            toolsDir,
            platform: "linux",
            architecture: "x64",
          }),
        ).not.toContain(path.dirname(legacyBinary));

        // 2b. A version bump (1.0.0 legacy A -> 2.0.0) followed by a rollback to 1.0.0 (archive B)
        // still records legacy A's baseline during the bump so legacy A is never launched as B.
        const versionBumpCacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-legacy-bump-",
        });
        const versionBumpToolsDir = path.join(versionBumpCacheDir, "tools");
        const bumpLegacyBinary = path.join(
          versionBumpToolsDir,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(bumpLegacyBinary), { recursive: true });
        yield* fileSystem.writeFileString(bumpLegacyBinary, "#!/bin/sh\necho legacy-bump\n");
        yield* fileSystem.chmod(bumpLegacyBinary, 0o755);
        yield* fileSystem.makeDirectory(path.join(versionBumpCacheDir, "acp-registry"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(versionBumpCacheDir, "acp-registry", "registry.json"),
          makeRegistry({
            ...makeAgent({
              binary: {
                "linux-x86_64": { archive: legacyArchiveUrl, cmd: "./bin/example-agent" },
              },
            }),
            version: "1.0.0",
          }),
        );
        const bumpResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: versionBumpCacheDir,
          toolsDir: versionBumpToolsDir,
          registryUrl,
        });
        currentAgent = {
          ...makeAgent({
            binary: { "linux-x86_64": { archive: v2ArchiveUrl, cmd: "./bin/example-agent" } },
          }),
          version: "2.0.0",
        };
        yield* bumpResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        currentAgent = {
          ...makeAgent({
            binary: { "linux-x86_64": { archive: swappedArchiveUrl, cmd: "./bin/example-agent" } },
          }),
          version: "1.0.0",
        };
        yield* bumpResolver.invalidateIndex();
        yield* bumpResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const bumpRollbackError = yield* bumpResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(bumpRollbackError.reason).toBe("download_failed");

        // 2c. If persisting legacy-baselines.json fails, registry.json must stay on artifact A so
        // a restarted server never mistakes legacy A for artifact B.
        const unwritableBaselineDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-baseline-fail-",
        });
        const unwritableToolsDir = path.join(unwritableBaselineDir, "tools");
        const unwritableLegacyBin = path.join(
          unwritableToolsDir,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(unwritableLegacyBin), { recursive: true });
        yield* fileSystem.writeFileString(
          unwritableLegacyBin,
          "#!/bin/sh\necho legacy-unwritable\n",
        );
        yield* fileSystem.chmod(unwritableLegacyBin, 0o755);
        const unwritableRegistryPath = path.join(
          unwritableBaselineDir,
          "acp-registry",
          "registry.json",
        );
        yield* fileSystem.makeDirectory(path.dirname(unwritableRegistryPath), { recursive: true });
        const initialLegacyRegistryJson = makeRegistry({
          ...makeAgent({
            binary: {
              "linux-x86_64": { archive: legacyArchiveUrl, cmd: "./bin/example-agent" },
            },
          }),
          version: "1.0.0",
        });
        yield* fileSystem.writeFileString(unwritableRegistryPath, initialLegacyRegistryJson);
        const missingDirErr = yield* fileSystem
          .readFileString(path.join(unwritableBaselineDir, "missing-sentinel"))
          .pipe(Effect.flip);
        const failBaselineWriteFs: FileSystem.FileSystem = {
          ...fileSystem,
          writeFileString: (filePath, data, options) =>
            filePath.includes("legacy-baselines.json")
              ? Effect.fail(missingDirErr)
              : fileSystem.writeFileString(filePath, data, options),
        };
        const unwritableResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: unwritableBaselineDir,
          toolsDir: unwritableToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, failBaselineWriteFs));
        yield* unwritableResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(
          (yield* unwritableResolver.resolve(settings(), "/workspace").pipe(Effect.flip)).reason,
        ).toBe("download_failed");
        // Disk registry.json was NOT overwritten with B because baseline persistence failed.
        expect(yield* fileSystem.readFileString(unwritableRegistryPath)).toBe(
          initialLegacyRegistryJson,
        );
        // After restart while offline, the catalog still reads A from disk (never B).
        offline = true;
        const restartedOfflineResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: unwritableBaselineDir,
          toolsDir: unwritableToolsDir,
          registryUrl,
        });
        const offlineAfterFailedBaseline = yield* restartedOfflineResolver.resolve(
          settings(),
          "/workspace",
        );
        expect(offlineAfterFailedBaseline.spawn.command).toBe(unwritableLegacyBin);
        offline = false;

        // 3. A single resolve() starting from a stale failing archive URL refreshes the index,
        // retries the updated same-version archive URL, and succeeds.
        const retryCacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-stale-retry-",
        });
        const staleRetryAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/example-agent-1.0.0-removed.bin",
                cmd: "./bin/example-agent",
                args: ["--v1-old"],
              },
            },
          }),
          version: "1.0.0",
        };
        yield* fileSystem.makeDirectory(path.join(retryCacheDir, "acp-registry"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(retryCacheDir, "acp-registry", "registry.json"),
          makeRegistry(staleRetryAgent),
        );
        failSwappedDownload = false;
        requests = [];
        const retryResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: retryCacheDir,
          toolsDir: path.join(retryCacheDir, "tools"),
          registryUrl,
        });
        const retriedResolved = yield* retryResolver.resolve(settings(), "/workspace");
        expect(retriedResolved.agent?.version).toBe("1.0.0");
        expect(yield* fileSystem.readFileString(retriedResolved.spawn.command)).toBe(
          "#!/bin/sh\necho v1-fixed\n",
        );
        expect(requests).toEqual([
          "https://example.test/example-agent-1.0.0-removed.bin",
          registryUrl,
          swappedArchiveUrl,
        ]);

        // Install a receipted primary slot AND a newer receipted artifact slot in 1.0.0 on a clean cache
        // so prior-version fallback and terminal PATH ordering can be verified unambiguously.
        const fallbackCacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-prior-version-",
        });
        const fallbackToolsDir = path.join(fallbackCacheDir, "tools");
        const fallbackResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: fallbackCacheDir,
          toolsDir: fallbackToolsDir,
          registryUrl,
        });
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: legacyArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v1-primary"],
                env: { AGENT_CHANNEL: "v1-primary" },
              },
            },
          }),
          version: "1.0.0",
        };
        const primaryV1 = yield* fallbackResolver.resolve(settings(), "/workspace");
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: swappedArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v1-fixed"],
                env: { AGENT_CHANNEL: "v1-fixed" },
              },
            },
          }),
          version: "1.0.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const swappedResolved = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(swappedResolved.spawn.command).toMatch(
          /linux-x86_64-[0-9a-f]{12}[\\/]bin[\\/]example-agent$/,
        );

        // 4. A mismatched receipt at the same version is never reused when a repackaged download fails.
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/example-agent-1.0.0-broken.bin",
                cmd: "./bin/example-agent",
                args: ["--v1-broken"],
              },
            },
          }),
          version: "1.0.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const mismatchedSameVersionError = yield* fallbackResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(mismatchedSameVersionError.reason).toBe("download_failed");

        // 5. When upstream publishes 2.0.0 whose download fails (or checksum mismatches), resolve falls
        // back to the newest receipted prior slot (1.0.0 replacement) and terminal PATH keeps it first.
        failV2Download = true;
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: v2ArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v2"],
                env: { AGENT_CHANNEL: "v2" },
              },
            },
          }),
          version: "2.0.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackToV1 = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(fallbackToV1.fallback).toBe(true);
        expect(fallbackToV1.indexRevision).toBeUndefined();
        expect(fallbackToV1.agent?.version).toBe("1.0.0");
        expect(fallbackToV1.spawn.command).toBe(swappedResolved.spawn.command);
        expect(fallbackToV1.spawn.args).toEqual(["--v1-fixed"]);
        expect(fallbackToV1.spawn.env?.AGENT_CHANNEL).toBe("v1-fixed");
        expect(fallbackToV1.launchIdentity).toBe(swappedResolved.launchIdentity);

        const managedAfterV2Bump = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
          cacheDir: fallbackCacheDir,
          toolsDir: fallbackToolsDir,
          platform: "linux",
          architecture: "x64",
        });
        expect(managedAfterV2Bump.slice(0, 2)).toEqual([
          path.dirname(swappedResolved.spawn.command),
          path.dirname(primaryV1.spawn.command),
        ]);

        // A broken 2.0.0 checksum also falls back to receipted 1.0.0 rather than stranding the user.
        failV2Download = false;
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: v2ArchiveUrl,
                cmd: "./bin/example-agent",
                sha256: "0".repeat(64),
              },
            },
          }),
          version: "2.0.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const checksumFallback = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(checksumFallback.fallback).toBe(true);
        expect(checksumFallback.agent?.version).toBe("1.0.0");
        expect(checksumFallback.spawn.command).toBe(swappedResolved.spawn.command);

        // 6. Installing 2.0.0 and then rolling back upstream to 1.5.0 (which fails download) must fall
        // back only to versions strictly below 1.5.0 (1.0.0), never silently running newer 2.0.0.
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: v2ArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v2"],
              },
            },
          }),
          version: "2.0.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const installedV2 = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(installedV2.agent?.version).toBe("2.0.0");

        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/example-agent-1.5.0.bin",
                cmd: "./bin/example-agent",
              },
            },
          }),
          version: "1.5.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const rollbackFallback = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(rollbackFallback.fallback).toBe(true);
        expect(rollbackFallback.agent?.version).toBe("1.0.0");
        expect(rollbackFallback.failedTarget?.version).toBe("1.5.0");

        // 7. SemVer 2.0.0 §11 prerelease ordering: non-numeric "1a" has higher precedence than
        // numeric "2", so 2.1.0-1a must NOT be chosen as a fallback when 2.1.0-2 fails.
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": { archive: v2ArchiveUrl, cmd: "./bin/example-agent" },
            },
          }),
          version: "2.1.0-1a",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* fallbackResolver.resolve(settings(), "/workspace")).agent?.version).toBe(
          "2.1.0-1a",
        );
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/example-agent-2.1.0-2.bin",
                cmd: "./bin/example-agent",
              },
            },
          }),
          version: "2.1.0-2",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const semverFallback = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(semverFallback.fallback).toBe(true);
        expect(semverFallback.agent?.version).toBe("2.0.0");

        // 8. A corrupt tar archive (tar exits non-zero) triggers archive_invalid and falls back to
        // the newest receipted version below 2.2.0 (2.1.0-1a), whereas a locally corrupted cached
        // slot fails with install_failed.
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: "https://example.test/corrupt-2.2.0.tar.gz",
                cmd: "./bin/example-agent",
              },
            },
          }),
          version: "2.2.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const corruptArchiveFallback = yield* fallbackResolver.resolve(settings(), "/workspace");
        expect(corruptArchiveFallback.fallback).toBe(true);
        expect(corruptArchiveFallback.agent?.version).toBe("2.1.0-1a");
        expect(corruptArchiveFallback.failedTarget?.version).toBe("2.2.0");

        // Tampering with an already-installed cached executable must fail with install_failed
        // instead of silently falling back to an older version.
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: v2ArchiveUrl,
                cmd: "./bin/example-agent",
                args: ["--v2"],
              },
            },
          }),
          version: "2.0.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* fileSystem.chmod(installedV2.spawn.command, 0o644);
        const tamperedCacheError = yield* fallbackResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(tamperedCacheError.reason).toBe("install_failed");
        yield* fileSystem.chmod(installedV2.spawn.command, 0o755);

        // 9. A concurrent agent removal published while a checksum_mismatch download is in flight
        // is honored immediately instead of falling back to an older installed version.
        const removalGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        checksumGate = removalGate;
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": {
                archive: v2ArchiveUrl,
                cmd: "./bin/example-agent",
                sha256: "0".repeat(64),
              },
            },
          }),
          version: "2.3.0",
        };
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvingChecksum = yield* fallbackResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(removalGate.started);
        serveEmptyRegistry = true;
        yield* fallbackResolver.invalidateIndex();
        yield* fallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        checksumGate = null;
        yield* Deferred.succeed(removalGate.release, undefined);
        const removedDuringChecksumError = yield* Fiber.join(resolvingChecksum);
        expect(removedDuringChecksumError.reason).toBe("agent_not_found");
        serveEmptyRegistry = false;

        // 10. Stale-lock promotion interleaving never removes a concurrently published artifact slot.
        const raceCacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-stale-lock-race-",
        });
        const raceToolsDir = path.join(raceCacheDir, "tools");
        const raceBaseResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: raceCacheDir,
          toolsDir: raceToolsDir,
          registryUrl,
        });
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": { archive: legacyArchiveUrl, cmd: "./bin/example-agent" },
            },
          }),
          version: "1.0.0",
        };
        yield* raceBaseResolver.resolve(settings(), "/workspace");
        currentAgent = {
          ...makeAgent({
            binary: {
              "linux-x86_64": { archive: swappedArchiveUrl, cmd: "./bin/example-agent" },
            },
          }),
          version: "1.0.0",
        };
        const renameBlocked = yield* Deferred.make<void>();
        const releaseFirstRename = yield* Deferred.make<void>();
        let firstRenameIntercepted = false;
        let removedArtifactSlot = false;
        const raceFs: FileSystem.FileSystem = {
          ...fileSystem,
          remove: (targetPath, options) => {
            if (/linux-x86_64-[0-9a-f]{12}$/u.test(targetPath)) {
              removedArtifactSlot = true;
            }
            return fileSystem.remove(targetPath, options);
          },
          rename: (oldPath, newPath) => {
            if (!firstRenameIntercepted && /linux-x86_64-[0-9a-f]{12}$/u.test(newPath)) {
              firstRenameIntercepted = true;
              return Deferred.succeed(renameBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstRename)),
                Effect.andThen(fileSystem.rename(oldPath, newPath)),
              );
            }
            return fileSystem.rename(oldPath, newPath);
          },
        };
        const raceInstaller1 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: raceCacheDir,
          toolsDir: raceToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, raceFs));
        const raceInstaller2 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: raceCacheDir,
          toolsDir: raceToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, raceFs));
        yield* raceInstaller1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* raceInstaller2.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const install1Fiber = yield* raceInstaller1
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(renameBlocked);
        // Age the lock past INSTALL_LOCK_STALE_MS so installer 2 takes over and publishes artifactRoot.
        const lockPath = path.join(raceToolsDir, "example-agent", "1.0.0", "linux-x86_64.lock");
        yield* fileSystem.utimes(lockPath, 0, 0);
        yield* TestClock.adjust("6 minutes");
        const installedBy2 = yield* raceInstaller2.resolve(settings(), "/workspace");
        yield* Deferred.succeed(releaseFirstRename, undefined);
        const installedBy1 = yield* Fiber.join(install1Fiber);
        expect(removedArtifactSlot).toBe(false);
        expect(installedBy1.spawn.command).toBe(installedBy2.spawn.command);
        expect(yield* fileSystem.readFileString(installedBy1.spawn.command)).toBe(
          "#!/bin/sh\necho v1-fixed\n",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            requests.push(request.url);
            if (offline) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("offline", { status: 503 })),
              );
            }
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    serveEmptyRegistry
                      ? JSON.stringify({ version: "1.0.0", agents: [] })
                      : makeRegistry(currentAgent),
                  ),
                ),
              );
            }
            if (request.url === "https://example.test/corrupt-2.2.0.tar.gz") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("not-a-valid-tar-archive")),
              );
            }
            if (request.url === legacyArchiveUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(v1PrimaryBytes)),
              );
            }
            if (request.url === swappedArchiveUrl && !failSwappedDownload) {
              return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(v1Bytes)));
            }
            if (request.url === v2ArchiveUrl && !failV2Download) {
              const gate = checksumGate;
              const respond = Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(v2Bytes)),
              );
              return gate === null
                ? respond
                : Deferred.succeed(gate.started, undefined).pipe(
                    Effect.andThen(Deferred.await(gate.release)),
                    Effect.andThen(respond),
                  );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
            );
          }),
        ),
      );
    },
  );

  it.effect("gives Antigravity a T3-owned temp directory that is removed with the process", () => {
    const agent = {
      ...makeAgent({ binary: { "linux-x86_64": { archive: archiveUrl, cmd: "./agy" } } }),
      id: "antigravity-acp",
    };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runtime-temp-",
      });
      const runtimeTempDir = `${cacheDir}/antigravity-tmp/acp-registry`;
      yield* fileSystem.makeDirectory(`${runtimeTempDir}/run-killed/_MEI123`, { recursive: true });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        runtimeTempDir,
        registryUrl,
      });
      expect(yield* fileSystem.exists(`${runtimeTempDir}/run-killed`)).toBe(false);

      const temp = yield* Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* resolver.resolve(
            settings({ agentId: "antigravity-acp" }),
            "/workspace",
            { TMPDIR: "/tmp" },
          );
          const directory = resolved.spawn.env?.TMPDIR ?? "";
          expect(directory.startsWith(`${runtimeTempDir}/run-`)).toBe(true);
          expect(yield* fileSystem.exists(directory)).toBe(true);
          return directory;
        }),
      );
      expect(yield* fileSystem.exists(temp)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(request.url === registryUrl ? makeRegistry(agent) : "#!/bin/sh\n"),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("installs a contained binary whose name starts with two dots", () => {
    const agent = makeAgent({
      binary: { "linux-x86_64": { archive: archiveUrl, cmd: "..example-agent" } },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-dot-name-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings(), "/workspace");

      expect(resolved.spawn.command).toContain(
        "/tools/example-agent/1.2.3/linux-x86_64/..example-agent",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(request.url === registryUrl ? makeRegistry(agent) : "#!/bin/sh\n"),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("keeps a prepared binary ready after the registry advances its version", () => {
    const makeBinaryAgent = (version: string) => ({
      ...makeAgent({
        binary: {
          "linux-x86_64": {
            archive: `https://registry.test/example-agent-${version}.bin`,
            cmd: "./bin/example-agent",
          },
        },
      }),
      version,
    });
    let agent = makeBinaryAgent("1.2.3");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-advance-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* resolver.prepare({ agentId: agent.id });

      agent = makeBinaryAgent("1.2.4");
      yield* TestClock.adjust("6 minutes");
      yield* resolver.search({ query: "example" });

      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "ready",
        distribution: "binary",
      });
      const resolved = yield* resolver.resolve(settings(), "/workspace", {});
      expect(resolved.spawn.command).toContain(
        "/tools/example-agent/1.2.4/linux-x86_64/bin/example-agent",
      );
      expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
        "#!/bin/sh\necho 1.2.4\n",
      );

      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toMatchObject({
        removed: true,
      });
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "unprepared" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                request.url === registryUrl
                  ? makeRegistry(agent)
                  : `#!/bin/sh\necho ${agent.version}\n`,
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("refreshes a cached registry index according to maxAgeMs and explicit refresh", () => {
    const makeBinaryAgent = (version: string) => ({
      ...makeAgent({
        binary: {
          "linux-x86_64": {
            archive: `https://registry.test/example-agent-${version}.bin`,
            cmd: "./bin/example-agent",
          },
        },
      }),
      version,
    });
    let upstream = makeBinaryAgent("1.2.4");
    let online = true;
    let registryRequests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-index-",
      });
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${cacheDir}/acp-registry/registry.json`,
        makeRegistry(makeBinaryAgent("1.2.3")),
      );

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      // Cold inspection stays on disk with no network request.
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.3" });
      expect(registryRequests).toBe(0);

      // Refreshing a disk-loaded index fetches the latest version once, then reuses it until maxAgeMs.
      const refreshOptions = { maxAgeMs: 15 * 60 * 1_000, failureBackoffMs: 60_000 } as const;
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(1);
      expect(registryRequests).toBe(1);
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.4" });

      // Refreshing after maxAgeMs when upstream is unchanged renews freshness without advancing indexRevision.
      yield* TestClock.adjust("15 minutes");
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(1);
      expect(registryRequests).toBe(2);

      upstream = makeBinaryAgent("1.2.5");
      yield* TestClock.adjust("14 minutes");
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(1);
      expect(registryRequests).toBe(2);
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.4" });

      yield* TestClock.adjust("1 minute");
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(2);
      expect(registryRequests).toBe(3);
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.5" });

      // Explicit invalidation clears the reuse window without discarding the in-memory index.
      upstream = makeBinaryAgent("1.2.6");
      yield* resolver.invalidateIndex();
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.5" });
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(3);
      expect(registryRequests).toBe(4);
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.6" });

      // An offline refresh prefers the in-memory index over a stale disk cache and backs off background retries.
      yield* fileSystem.writeFileString(
        `${cacheDir}/acp-registry/registry.json`,
        makeRegistry(makeBinaryAgent("1.2.3")),
      );
      online = false;
      yield* resolver.invalidateIndex();
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(3);
      expect(registryRequests).toBe(5);
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.6" });

      online = true;
      upstream = makeBinaryAgent("1.2.7");
      yield* TestClock.adjust("59 seconds");
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(3);
      expect(registryRequests).toBe(5);

      yield* TestClock.adjust("1 second");
      expect(yield* resolver.refreshIndex(refreshOptions)).toBe(4);
      expect(registryRequests).toBe(6);
      expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.7" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          registryRequests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              online
                ? new Response(makeRegistry(upstream))
                : new Response("unavailable", { status: 503 }),
            ),
          );
        }),
      ),
    );
  });

  it.effect(
    "backs off queued and subsequent background refreshes when uncached and offline while keeping prepare eligible",
    () => {
      const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
      const newAgent = {
        ...makeAgent({
          binary: {
            "darwin-aarch64": { archive: archiveUrl, cmd: "new-agent" },
          },
        }),
        id: "new-agent",
        name: "New Agent",
      } satisfies AcpRegistrySupport.AcpRegistryAgent;
      let upstreamAgents: ReadonlyArray<AcpRegistrySupport.AcpRegistryAgent> = [agent];
      let online = false;
      let registryRequests = 0;
      let gate: {
        readonly started: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-cold-backoff-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const refreshOptions = { maxAgeMs: 15 * 60 * 1_000, failureBackoffMs: 60_000 } as const;

        const firstGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = firstGate;
        const firstRefresh = yield* resolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstGate.started);
        const queuedRefresh = yield* resolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));

        yield* Deferred.succeed(firstGate.release, undefined);
        const firstRefreshError = yield* Fiber.join(firstRefresh);
        expect(firstRefreshError.reason).toBe("registry_unavailable");
        expect(firstRefreshError.stage).toBe("http_request");
        expect((yield* Fiber.join(queuedRefresh)).reason).toBe("registry_unavailable");
        expect(registryRequests).toBe(1);

        // Subsequent background refreshes during the backoff window fail fast before acquiring the semaphore.
        yield* TestClock.adjust("59 seconds");
        const prepareHoldGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = prepareHoldGate;
        online = true;
        const holdingPrepare = yield* resolver
          .prepare({ agentId: "missing-agent" })
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(prepareHoldGate.started);
        expect((yield* resolver.refreshIndex(refreshOptions).pipe(Effect.flip)).reason).toBe(
          "registry_unavailable",
        );
        expect(holdingPrepare.pollUnsafe()).toBeUndefined();
        expect(registryRequests).toBe(2);
        yield* Deferred.succeed(prepareHoldGate.release, undefined);
        expect((yield* Fiber.join(holdingPrepare)).reason).toBe("agent_not_found");

        // Clock moving backwards below failedAtMs disables backoff suppression on both fast and semaphore paths.
        const clockBackDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-clock-back-",
        });
        const clockBackResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: clockBackDir,
          toolsDir: `${clockBackDir}/tools`,
          registryUrl,
        });
        gate = null;
        online = false;
        yield* TestClock.adjust("10 minutes");
        expect(
          (yield* clockBackResolver.refreshIndex(refreshOptions).pipe(Effect.flip)).reason,
        ).toBe("registry_unavailable");
        const requestsAfterClockFailure = registryRequests;
        online = true;
        yield* TestClock.setTime(0);
        expect(yield* clockBackResolver.refreshIndex(refreshOptions)).toBe(1);
        expect(registryRequests).toBe(requestsAfterClockFailure + 1);

        // Concurrent cold uncached inspect() calls coalesce behind one failing network fetch.
        const coldInspectDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-cold-inspect-coalesce-",
        });
        const coldCachePath = path.join(coldInspectDir, "acp-registry", "registry.json");
        const missingColdCacheError = yield* fileSystem
          .readFileString(coldCachePath)
          .pipe(Effect.flip);
        // Fail the missing cache read synchronously so the second inspect parks on the refresh semaphore before release.
        const coldInspectFs: FileSystem.FileSystem = {
          ...fileSystem,
          readFileString: (filePath, encoding) =>
            filePath === coldCachePath
              ? Effect.fail(missingColdCacheError)
              : fileSystem.readFileString(filePath, encoding),
        };
        const coldInspectResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coldInspectDir,
          toolsDir: path.join(coldInspectDir, "tools"),
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, coldInspectFs));
        const coldInspectGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = coldInspectGate;
        online = false;
        const requestsBeforeColdInspect = registryRequests;
        const firstInspect = yield* coldInspectResolver
          .inspect(settings())
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(coldInspectGate.started);
        const secondInspect = yield* coldInspectResolver
          .inspect(settings())
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        expect(secondInspect.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(coldInspectGate.release, undefined);
        expect((yield* Fiber.join(firstInspect)).reason).toBe("registry_unavailable");
        expect((yield* Fiber.join(secondInspect)).reason).toBe("registry_unavailable");
        expect(registryRequests).toBe(requestsBeforeColdInspect + 1);

        // A queued prepare() must not reuse a cached fallback from a failing background refresh.
        const queuedPrepareDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-queued-prepare-",
        });
        yield* fileSystem.makeDirectory(`${queuedPrepareDir}/acp-registry`, { recursive: true });
        yield* fileSystem.writeFileString(
          `${queuedPrepareDir}/acp-registry/registry.json`,
          makeRegistry({ ...agent, id: "older-agent" }),
        );
        const queuedPrepareResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: queuedPrepareDir,
          toolsDir: `${queuedPrepareDir}/tools`,
          registryUrl,
        });
        const fallbackGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        gate = fallbackGate;
        online = false;
        upstreamAgents = [agent, newAgent];
        const requestsBeforeQueuedPrepare = registryRequests;
        const failingBackground = yield* queuedPrepareResolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(fallbackGate.started);
        const queuedPrepare = yield* queuedPrepareResolver
          .prepare({ agentId: newAgent.id })
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        expect(queuedPrepare.pollUnsafe()).toBeUndefined();
        // Flip online after the background refresh already captured 503 so only the queued prepare retries online.
        online = true;
        gate = null;
        yield* Deferred.succeed(fallbackGate.release, undefined);
        expect(yield* Fiber.join(failingBackground)).toBe(0);
        // Reaching unsupported_distribution (instead of agent_not_found from older-agent) proves prepare retried.
        expect((yield* Fiber.join(queuedPrepare)).reason).toBe("unsupported_distribution");
        expect(registryRequests).toBe(requestsBeforeQueuedPrepare + 2);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            registryRequests += 1;
            const activeGate = gate;
            const shouldSucceed = online;
            const body = JSON.stringify({ version: "1.0.0", agents: upstreamAgents });
            const respond = Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                shouldSucceed ? new Response(body) : new Response("unavailable", { status: 503 }),
              ),
            );
            return activeGate === null
              ? respond
              : Deferred.succeed(activeGate.started, undefined).pipe(
                  Effect.andThen(Deferred.await(activeGate.release)),
                  Effect.andThen(respond),
                );
          }),
        ),
      );
    },
  );

  it.effect(
    "does not mark a refresh fresh or backed off when invalidated after response receipt",
    () => {
      const makeNpxAgent = (version: string) => ({
        ...makeAgent({ npx: { package: `@example/acp@${version}` } }),
        version,
      });
      let upstream = makeNpxAgent("1.2.4");
      let online = true;
      let registryRequests = 0;
      let fetchGate: {
        readonly started: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-invalidate-race-",
        });
        const registryDirectory = path.join(cacheDir, "acp-registry");
        const registryCachePath = path.join(registryDirectory, "registry.json");
        yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
        yield* fileSystem.writeFileString(registryCachePath, makeRegistry(makeNpxAgent("1.2.3")));

        let writeGate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        const gatedFileSystem: FileSystem.FileSystem = {
          ...fileSystem,
          writeFileString: (filePath, data, options) => {
            const activeGate =
              writeGate !== null && filePath.startsWith(`${registryCachePath}.`) ? writeGate : null;
            return activeGate === null
              ? fileSystem.writeFileString(filePath, data, options)
              : Deferred.succeed(activeGate.started, undefined).pipe(
                  Effect.andThen(Deferred.await(activeGate.release)),
                  Effect.andThen(fileSystem.writeFileString(filePath, data, options)),
                );
          },
        };
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, gatedFileSystem));
        const refreshOptions = { maxAgeMs: 15 * 60 * 1_000, failureBackoffMs: 60_000 } as const;

        // 1. Invalidate after HTTP response receipt (during writeRegistryCache) before cache publication.
        const firstWriteGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        writeGate = firstWriteGate;
        const firstRefresh = yield* resolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstWriteGate.started);
        expect(registryRequests).toBe(1);
        yield* resolver.invalidateIndex();
        yield* Deferred.succeed(firstWriteGate.release, undefined);

        // The fetched index is kept as fallback, while freshness stays unset so the next refresh fetches.
        expect(yield* Fiber.join(firstRefresh)).toBe(1);
        expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.4" });

        // 2. A post-invalidation caller queued behind an in-flight pre-invalidation fetch does not coalesce.
        upstream = makeNpxAgent("1.2.5");
        const secondWriteGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        writeGate = secondWriteGate;
        const secondRefresh = yield* resolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(secondWriteGate.started);
        expect(registryRequests).toBe(2);

        yield* resolver.invalidateIndex();
        upstream = makeNpxAgent("1.2.6");
        writeGate = null;
        const queuedPostInvalidation = yield* resolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(queuedPostInvalidation.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(secondWriteGate.release, undefined);

        expect(yield* Fiber.join(secondRefresh)).toBe(2);
        expect(yield* Fiber.join(queuedPostInvalidation)).toBe(3);
        expect(registryRequests).toBe(3);
        expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.6" });

        // Attempts that started after invalidation still set freshness normally.
        expect(yield* resolver.refreshIndex(refreshOptions)).toBe(3);
        expect(registryRequests).toBe(3);

        // 3. A failed refresh started before invalidation does not restore failure backoff.
        yield* resolver.invalidateIndex();
        online = false;
        const offlineGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        fetchGate = offlineGate;
        const failedRefresh = yield* resolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(offlineGate.started);
        expect(registryRequests).toBe(4);
        yield* resolver.invalidateIndex();
        yield* Deferred.succeed(offlineGate.release, undefined);
        expect(yield* Fiber.join(failedRefresh)).toBe(3);

        online = true;
        fetchGate = null;
        upstream = makeNpxAgent("1.2.7");
        expect(yield* resolver.refreshIndex(refreshOptions)).toBe(4);
        expect(registryRequests).toBe(5);
        expect(yield* resolver.inspect(settings())).toMatchObject({ version: "1.2.7" });

        // 4. A cold inspect() queued behind an invalidated in-flight fetch accepts the resulting index without refetching.
        const coldAcceptedDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-cold-accept-",
        });
        const coldAcceptedCachePath = path.join(coldAcceptedDir, "acp-registry", "registry.json");
        const missingAcceptedCacheError = yield* fileSystem
          .readFileString(coldAcceptedCachePath)
          .pipe(Effect.flip);
        const coldAcceptedFs: FileSystem.FileSystem = {
          ...fileSystem,
          readFileString: (filePath, encoding) =>
            filePath === coldAcceptedCachePath
              ? Effect.fail(missingAcceptedCacheError)
              : fileSystem.readFileString(filePath, encoding),
        };
        const coldAcceptedResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coldAcceptedDir,
          toolsDir: path.join(coldAcceptedDir, "tools"),
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, coldAcceptedFs));
        const coldFetchGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        fetchGate = coldFetchGate;
        upstream = makeNpxAgent("1.2.8");
        const requestsBeforeColdAccept = registryRequests;
        const inFlightRefresh = yield* coldAcceptedResolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(coldFetchGate.started);
        yield* coldAcceptedResolver.invalidateIndex();
        const queuedColdInspect = yield* coldAcceptedResolver
          .inspect(settings())
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(queuedColdInspect.pollUnsafe()).toBeUndefined();
        fetchGate = null;
        yield* Deferred.succeed(coldFetchGate.release, undefined);
        expect(yield* Fiber.join(inFlightRefresh)).toBe(1);
        expect(yield* Fiber.join(queuedColdInspect)).toMatchObject({
          version: "1.2.8",
          indexRevision: 1,
        });
        expect(registryRequests).toBe(requestsBeforeColdAccept + 1);

        // 5. An uncached cold failure started before invalidation also does not record backoff.
        const coldCacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-cold-invalidate-race-",
        });
        const coldResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coldCacheDir,
          toolsDir: `${coldCacheDir}/tools`,
          registryUrl,
        });
        online = false;
        const coldOfflineGate = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        fetchGate = coldOfflineGate;
        const coldFailedRefresh = yield* coldResolver
          .refreshIndex(refreshOptions)
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(coldOfflineGate.started);
        yield* coldResolver.invalidateIndex();
        yield* Deferred.succeed(coldOfflineGate.release, undefined);
        expect((yield* Fiber.join(coldFailedRefresh)).reason).toBe("registry_unavailable");

        online = true;
        fetchGate = null;
        expect(yield* coldResolver.refreshIndex(refreshOptions)).toBe(1);
        expect(registryRequests).toBe(8);

        // 6. launchIdentity tracks effective launch inputs for npx, commandOverride, and binary distributions.
        const packageSwapDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-launch-identity-",
        });
        const rawHostPlatform = HostProcess.Platform.defaultValue();
        const rawHostArchitecture = HostProcess.Architecture.defaultValue();
        const isSupportedHost =
          (rawHostPlatform === "darwin" ||
            rawHostPlatform === "linux" ||
            rawHostPlatform === "win32") &&
          (rawHostArchitecture === "arm64" || rawHostArchitecture === "x64");
        const hostPlatform: NodeJS.Platform = isSupportedHost ? rawHostPlatform : "linux";
        const hostArchitecture: NodeJS.Architecture = isSupportedHost ? rawHostArchitecture : "x64";
        const isWindowsHost = hostPlatform === "win32";
        const hostBinaryOs =
          hostPlatform === "darwin" ? "darwin" : isWindowsHost ? "windows" : "linux";
        const hostBinaryArch = hostArchitecture === "arm64" ? "aarch64" : "x86_64";
        const binaryTargetKey = `${hostBinaryOs}-${hostBinaryArch}` as const;
        const swapResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: packageSwapDir,
          toolsDir: `${packageSwapDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, hostPlatform),
          Effect.provideService(HostProcess.Architecture, hostArchitecture),
          Effect.provideService(SpawnExecutableResolution, (command) =>
            command === "npm" || command.endsWith("override-agent") ? command : undefined,
          ),
        );
        const swapEnvironment: NodeJS.ProcessEnv = {};
        upstream = {
          ...makeAgent({ npx: { package: "@example/old@1.0.0" } }),
          version: "1.0.0",
          website: "https://example.test/docs-a",
        };
        yield* swapResolver.refreshIndex(refreshOptions);
        const oldPackageInspection = yield* swapResolver.inspect(settings(), swapEnvironment);
        expect(oldPackageInspection).toMatchObject({
          status: "ready",
          version: "1.0.0",
          documentationUrl: "https://example.test/docs-a",
        });

        upstream = {
          ...makeAgent({ npx: { package: "@example/new@1.0.0" } }),
          version: "1.0.0",
          website: "https://example.test/docs-a",
        };
        yield* swapResolver.invalidateIndex();
        yield* swapResolver.refreshIndex(refreshOptions);
        const newPackageInspection = yield* swapResolver.inspect(settings(), swapEnvironment);
        expect(newPackageInspection).toMatchObject({ status: "ready", version: "1.0.0" });
        expect(
          oldPackageInspection.status === "ready" &&
            newPackageInspection.status === "ready" &&
            oldPackageInspection.launchIdentity !== newPackageInspection.launchIdentity,
        ).toBe(true);

        upstream = {
          ...makeAgent({ npx: { package: "@example/new@1.0.0" } }),
          version: "1.0.0",
          website: "https://example.test/docs-b",
        };
        yield* swapResolver.invalidateIndex();
        yield* swapResolver.refreshIndex(refreshOptions);
        const docsOnlyInspection = yield* swapResolver.inspect(settings(), swapEnvironment);
        expect(docsOnlyInspection).toMatchObject({
          status: "ready",
          version: "1.0.0",
          documentationUrl: "https://example.test/docs-b",
        });
        expect(
          newPackageInspection.status === "ready" &&
            docsOnlyInspection.status === "ready" &&
            newPackageInspection.launchIdentity === docsOnlyInspection.launchIdentity,
        ).toBe(true);

        // commandOverride ignores version/package bumps it does not launch, while tracking args and env separately.
        const overridePath = `${packageSwapDir}/override-agent`;
        yield* fileSystem.writeFileString(overridePath, "#!/bin/sh\necho override\n");
        if (!isWindowsHost) {
          yield* fileSystem.chmod(overridePath, 0o755);
        }
        const overrideSettings = settings({ commandPath: overridePath });
        const overrideBase = yield* swapResolver.inspect(overrideSettings, swapEnvironment);
        upstream = {
          ...makeAgent({ npx: { package: "@example/other@2.0.0" } }),
          version: "2.0.0",
        };
        yield* swapResolver.invalidateIndex();
        yield* swapResolver.refreshIndex(refreshOptions);
        const overrideBumped = yield* swapResolver.inspect(overrideSettings, swapEnvironment);
        expect(overrideBase.status === "ready" && overrideBumped.status === "ready").toBe(true);
        expect(
          overrideBase.status === "ready" && overrideBumped.status === "ready"
            ? overrideBase.launchIdentity === overrideBumped.launchIdentity
            : false,
        ).toBe(true);

        upstream = {
          ...makeAgent({
            npx: { package: "@example/other@2.0.0", args: ["--flag"] },
          }),
          version: "2.0.0",
        };
        yield* swapResolver.invalidateIndex();
        yield* swapResolver.refreshIndex(refreshOptions);
        const overrideArgsOnly = yield* swapResolver.inspect(overrideSettings, swapEnvironment);
        expect(
          overrideBumped.status === "ready" &&
            overrideArgsOnly.status === "ready" &&
            overrideBumped.launchIdentity !== overrideArgsOnly.launchIdentity,
        ).toBe(true);

        upstream = {
          ...makeAgent({
            npx: { package: "@example/other@2.0.0", env: { MODE: "acp" } },
          }),
          version: "2.0.0",
        };
        yield* swapResolver.invalidateIndex();
        yield* swapResolver.refreshIndex(refreshOptions);
        const overrideEnvOnly = yield* swapResolver.inspect(overrideSettings, swapEnvironment);
        expect(
          overrideBumped.status === "ready" &&
            overrideEnvOnly.status === "ready" &&
            overrideBumped.launchIdentity !== overrideEnvOnly.launchIdentity,
        ).toBe(true);

        // Binary launchIdentity tracks archive, sha256, cmd, args, and env while ignoring website/icon changes.
        const binaryExe = `${packageSwapDir}/tools/example-agent/1.0.0/${binaryTargetKey}/bin/agent`;
        yield* fileSystem.makeDirectory(
          `${packageSwapDir}/tools/example-agent/1.0.0/${binaryTargetKey}/bin`,
          {
            recursive: true,
          },
        );
        yield* fileSystem.writeFileString(binaryExe, "#!/bin/sh\necho bin\n");
        if (!isWindowsHost) {
          yield* fileSystem.chmod(binaryExe, 0o755);
        }
        const inspectBinary = (
          target: {
            readonly archive: string;
            readonly cmd: string;
            readonly sha256?: string;
            readonly args?: ReadonlyArray<string>;
            readonly env?: Readonly<Record<string, string>>;
          },
          meta?: { readonly website?: string; readonly icon?: string },
        ) =>
          Effect.gen(function* () {
            upstream = {
              ...makeAgent({ binary: { [binaryTargetKey]: target } }),
              version: "1.0.0",
              ...(meta?.website ? { website: meta.website } : {}),
              ...(meta?.icon ? { icon: meta.icon } : {}),
            };
            yield* swapResolver.invalidateIndex();
            yield* swapResolver.refreshIndex(refreshOptions);
            const inspected = yield* swapResolver.inspect(settings(), swapEnvironment);
            expect(inspected.status).toBe("ready");
            return inspected.status === "ready" ? inspected.launchIdentity : undefined;
          });
        const baseBinId = yield* inspectBinary(
          { archive: archiveUrl, cmd: "./bin/agent", sha256: "a".repeat(64) },
          {
            website: "https://example.test/a",
            icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/a.svg",
          },
        );
        expect(
          yield* inspectBinary(
            { archive: archiveUrl, cmd: "./bin/agent", sha256: "a".repeat(64) },
            {
              website: "https://example.test/b",
              icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/b.svg",
            },
          ),
        ).toBe(baseBinId);
        expect(
          yield* inspectBinary({
            archive: "https://registry.test/other.bin",
            cmd: "./bin/agent",
            sha256: "a".repeat(64),
          }),
        ).not.toBe(baseBinId);
        expect(
          yield* inspectBinary({
            archive: archiveUrl,
            cmd: "./bin/agent",
            sha256: "b".repeat(64),
          }),
        ).not.toBe(baseBinId);
        expect(
          yield* inspectBinary({
            archive: archiveUrl,
            cmd: "./bin/agent-v2",
            sha256: "a".repeat(64),
          }),
        ).not.toBe(baseBinId);
        expect(
          yield* inspectBinary({
            archive: archiveUrl,
            cmd: "./bin/agent",
            sha256: "a".repeat(64),
            args: ["--extra"],
          }),
        ).not.toBe(baseBinId);
        expect(
          yield* inspectBinary({
            archive: archiveUrl,
            cmd: "./bin/agent",
            sha256: "a".repeat(64),
            env: { EXTRA: "1" },
          }),
        ).not.toBe(baseBinId);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            registryRequests += 1;
            const activeGate = fetchGate;
            const respond = Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                online
                  ? new Response(makeRegistry(upstream))
                  : new Response("unavailable", { status: 503 }),
              ),
            );
            return activeGate === null
              ? respond
              : Deferred.succeed(activeGate.started, undefined).pipe(
                  Effect.andThen(Deferred.await(activeGate.release)),
                  Effect.andThen(respond),
                );
          }),
        ),
      );
    },
  );

  it.effect(
    "prepares the registry version despite an older PATH binary and permits explicit overrides",
    () => {
      const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho managed\n");
      const agent = makeAgent({
        binary: {
          "linux-x86_64": {
            archive: archiveUrl,
            cmd: "./bin/example-agent",
            args: ["acp"],
            sha256: "e1eb7c905b91c400af2ec858628aec22866bfda1383b93ceb73ae01d9769fb31",
          },
        },
      });
      const requests: Array<string> = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-system-",
        });
        const systemBinDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-system-bin-",
        });
        const systemBinary = path.join(systemBinDir, "example-agent");
        yield* fileSystem.writeFileString(systemBinary, "#!/bin/sh\necho system\n");
        yield* fileSystem.chmod(systemBinary, 0o755);
        const environment = { PATH: systemBinDir };

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(HostProcess.Environment, environment));
        yield* resolver.search({ query: "example" });
        expect(yield* resolver.inspect(settings(), environment)).toMatchObject({
          status: "unprepared",
        });

        const overridden = settings({ commandPath: systemBinary });
        expect(yield* resolver.inspect(overridden, environment)).toMatchObject({
          status: "ready",
          version: null,
        });
        const custom = yield* resolver.resolve(overridden, "/workspace", environment);
        expect(custom.spawn.command).toBe(systemBinary);
        expect(custom.spawn.args).toEqual(["acp"]);
        expect(requests).toEqual([registryUrl]);

        yield* resolver.prepare({ agentId: "example-agent" });
        const resolved = yield* resolver.resolve(settings(), "/workspace", environment);
        expect(resolved.spawn.command).not.toBe(systemBinary);
        expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
          "#!/bin/sh\necho managed\n",
        );
        expect(yield* fileSystem.readFileString(systemBinary)).toBe("#!/bin/sh\necho system\n");

        const inspection = yield* resolver.inspect(settings(), environment);
        expect(inspection).toMatchObject({
          status: "ready",
          distribution: "binary",
          version: "1.2.3",
        });

        expect(requests).toEqual([registryUrl, registryUrl, archiveUrl]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            requests.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response(binaryBytes.buffer as ArrayBuffer),
              ),
            );
          }),
        ),
      );
    },
  );

  it.effect("installs a tar archive with a root entry and a listing larger than 1 MiB", () => {
    const downloadUrl = "https://registry.test/agent.tar.gz";
    const agent = makeAgent({
      binary: { "linux-x86_64": { archive: downloadUrl, cmd: "./agent" } },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-root-entry-" });
      const source = `${cacheDir}/source`;
      yield* fileSystem.makeDirectory(source);
      yield* fileSystem.writeFileString(`${source}/agent`, "#!/bin/sh\necho managed\n");
      // 5,000 long names list past the generic 1 MiB command output cap.
      const entries = `${source}/entries`;
      yield* fileSystem.makeDirectory(entries);
      yield* Effect.forEach(
        Array.from({ length: 5_000 }, (_, index) => index),
        (index) => fileSystem.writeFileString(`${entries}/${index}-${"e".repeat(240)}`, ""),
        { concurrency: 16 },
      );
      const archivePath = `${cacheDir}/agent.tar.gz`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const tar = yield* spawner.spawn(
        ChildProcess.make("tar", ["-czf", archivePath, "-C", source, "."]),
      );
      expect(yield* tar.exitCode).toBe(0);
      const archive = yield* fileSystem.readFile(archivePath);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response(archive),
              ),
            ),
          ),
        ),
      );
      yield* resolver.prepare({ agentId: agent.id });
      const resolved = yield* resolver.resolve(settings(), "/workspace", {});
      expect(resolved.spawn.command).toBe(
        yield* fileSystem.realPath(`${cacheDir}/tools/example-agent/1.2.3/linux-x86_64/agent`),
      );
      expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
        "#!/bin/sh\necho managed\n",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          TestProviderHost.layer().pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Architecture, "x64"),
    );
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "leaves the mode of a file outside the install root when the command links to it",
    () => {
      const downloadUrl = "https://registry.test/agent.tar.gz";
      const agent = makeAgent({
        binary: { "linux-x86_64": { archive: downloadUrl, cmd: "./agent" } },
      });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-outside-link-",
        });
        const outsideFile = `${cacheDir}/outside`;
        yield* fileSystem.writeFileString(outsideFile, "private\n");
        yield* fileSystem.chmod(outsideFile, 0o600);
        const source = `${cacheDir}/source`;
        yield* fileSystem.makeDirectory(source);
        yield* fileSystem.symlink(outsideFile, `${source}/agent`);
        const archivePath = `${cacheDir}/agent.tar.gz`;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const tar = yield* spawner.spawn(
          ChildProcess.make("tar", ["-czf", archivePath, "-C", source, "agent"]),
        );
        expect(yield* tar.exitCode).toBe(0);
        const archive = yield* fileSystem.readFile(archivePath);
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === registryUrl
                    ? new Response(makeRegistry(agent))
                    : new Response(archive),
                ),
              ),
            ),
          ),
        );

        const error = yield* resolver.prepare({ agentId: agent.id }).pipe(Effect.flip);

        expect(error.reason).toBe("archive_invalid");
        expect((yield* fileSystem.stat(outsideFile)).mode & 0o777).toBe(0o600);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            TestProviderHost.layer().pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
      );
    },
  );

  it.effect("searches compatible agents with deterministic ranking and bounded metadata", () => {
    const exact = {
      ...makeAgent({ npx: { package: "@example/acp@1.2.3" } }),
      id: "codex-acp",
      name: "Codex",
      authors: ["OpenAI", "Zed Industries"],
      license: "Apache-2.0",
      website: "https://example.test/codex",
      repository: "https://example.test/codex/source",
      icon: "https://example.test/codex.svg",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    const descriptionMatch = {
      ...makeAgent({ npx: { package: "other-agent@1.2.3" } }),
      id: "other-agent",
      name: "Other Agent",
      description: "An adapter for Codex workflows",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    const incompatible = {
      ...makeAgent({
        binary: {
          "darwin-aarch64": { archive: archiveUrl, cmd: "agent" },
        },
      }),
      id: "darwin-only",
      name: "Codex Darwin",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;

    const lookups: string[] = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-search-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(SpawnExecutableResolution, async (command) => {
          lookups.push(command);
          return "/bin/npm";
        }),
      );
      const result = yield* resolver.search({ query: "codex" });

      expect(lookups).toEqual(["npm"]);
      expect(result.agents.map((agent) => agent.id)).toEqual(["codex-acp", "other-agent"]);
      expect(result.agents[0]).toMatchObject({
        authors: ["OpenAI", "Zed Industries"],
        distribution: "npx",
        integrity: "registry",
        license: "Apache-2.0",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: "1.0.0",
                  agents: [descriptionMatch, incompatible, exact],
                }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("searches reuse an index fetched in the last five minutes", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* Effect.all(
        [resolver.search({ query: "example" }), resolver.search({ query: "example" })],
        { concurrency: "unbounded" },
      );
      expect(requests).toBe(1);

      yield* TestClock.adjust("4 minutes");
      yield* resolver.search({ query: "other" });
      expect(requests).toBe(1);

      yield* TestClock.adjust("1 minute");
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.yieldNow.pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          );
        }),
      ),
    );
  });

  it.effect("searches retry the network after falling back to the cached index", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-retry-",
      });
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${cacheDir}/acp-registry/registry.json`,
        makeRegistry(agent),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const offline = yield* resolver.search({ query: "example" });
      expect(offline.agents.map((result) => result.id)).toEqual([agent.id]);
      expect(requests).toBe(1);

      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              requests === 1
                ? new Response("unavailable", { status: 503 })
                : new Response(makeRegistry(agent)),
            ),
          );
        }),
      ),
    );
  });

  it.effect("searches retry the network after a refresh falls back within the reuse window", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    let online = true;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-fallback-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(1);

      // Prepare always refreshes; an unknown agent stops it right after the refresh.
      online = false;
      const missing = yield* resolver.prepare({ agentId: "missing-agent" }).pipe(Effect.flip);
      expect(missing.reason).toBe("agent_not_found");
      expect(requests).toBe(2);

      online = true;
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(3);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              online
                ? new Response(makeRegistry(agent))
                : new Response("unavailable", { status: 503 }),
            ),
          );
        }),
      ),
    );
  });

  it.effect("filters runner recipes that the environment cannot prepare", () => {
    const runnerAgent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    const binaryAgent = {
      ...makeAgent({
        binary: {
          "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
        },
      }),
      id: "binary-agent",
      name: "Binary Agent",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-filter-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents.map((agent) => agent.id)).toEqual(["binary-agent"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({ version: "1.0.0", agents: [runnerAgent, binaryAgent] }),
                ),
              ),
            ),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("discards registry agents with blank names or unsafe versions", () => {
    const distribution = {
      binary: {
        "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
      },
    } satisfies AcpRegistrySupport.AcpRegistryAgent["distribution"];
    const valid = makeAgent(distribution);
    const blankName = { ...valid, id: "blank-name", name: "   " };
    const blankVersion = { ...valid, id: "blank-version", version: "\t" };
    const parentVersion = { ...valid, id: "parent-version", version: ".." };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-blank-fields-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents.map((agent) => agent.id)).toEqual([valid.id]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: "1.0.0",
                  agents: [blankName, blankVersion, parentVersion, valid],
                }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("ignores unpinned runner recipes from the registry", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@latest" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-unpinned-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("rejects package syntax for the wrong runner", () => {
    const invalidAgents = [
      { ...makeAgent({ npx: { package: "example-agent==1.2.3" } }), id: "bad-npx" },
    ];
    const validAgents = [
      { ...makeAgent({ uvx: { package: "minion-code@0.1.44" } }), id: "valid-at" },
      { ...makeAgent({ uvx: { package: "fast-agent-acp==0.9.30" } }), id: "valid-equals" },
    ];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-syntax-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const invalid = yield* resolver.prepare({ agentId: "bad-npx" }).pipe(Effect.flip);
      const validAt = yield* resolver.prepare({ agentId: "valid-at" }).pipe(Effect.flip);
      const validEquals = yield* resolver.prepare({ agentId: "valid-equals" }).pipe(Effect.flip);

      expect(invalid.reason).toBe("agent_not_found");
      expect(validAt.reason).toBe("runner_unavailable");
      expect(validEquals.reason).toBe("runner_unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({ version: "1.0.0", agents: [...invalidAgents, ...validAgents] }),
                ),
              ),
            ),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("verifies declared SHA-256 before installing a binary", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "example-agent",
          sha256: "0".repeat(64),
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("not the declared binary");

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-checksum-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.prepare({ agentId: agent.id }).pipe(Effect.flip);

      expect(error.reason).toBe("checksum_mismatch");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(binaryBytes.buffer as ArrayBuffer),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("falls back to a valid cached registry index when refresh fails", () => {
    const agent = makeAgent({
      npx: {
        package: "@example/acp@1.2.3",
        args: ["--stdio"],
      },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cache-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--stdio"],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
          ),
        ),
      ),
    );
  });

  it.effect(
    "installs the registry's current version when a cached index pins a removed build",
    () => {
      const binaryAgent = (version: string) => ({
        ...makeAgent({
          binary: {
            "linux-x86_64": {
              archive: `https://registry.test/example-agent-${version}.bin`,
              cmd: "./bin/example-agent",
              args: ["acp"],
            },
          },
        }),
        version,
      });
      const requests: Array<string> = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-stale-",
        });
        yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
        yield* fileSystem.writeFileString(
          `${cacheDir}/acp-registry/registry.json`,
          makeRegistry(binaryAgent("1.2.3")),
        );
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const resolved = yield* resolver.resolve(settings(), "/workspace");

        expect(resolved.agent?.version).toBe("1.2.4");
        expect(resolved.spawn.command).toContain("/tools/example-agent/1.2.4/");
        expect(requests).toContain(registryUrl);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            requests.push(request.url);
            const response =
              request.url === registryUrl
                ? new Response(makeRegistry(binaryAgent("1.2.4")))
                : request.url.endsWith("-1.2.4.bin")
                  ? new Response("#!/bin/sh\necho example\n")
                  : new Response("forbidden", { status: 403 });
            return Effect.succeed(HttpClientResponse.fromWeb(request, response));
          }),
        ),
      );
    },
  );

  it.effect("rejects unsafe command paths before downloading an archive", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "../outside",
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-invalid-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.resolve(settings(), "/workspace").pipe(Effect.flip);

      expect(error.reason).toBe("archive_invalid");
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("inspects from disk without waiting for a registry refresh", () => {
    const makeNpxAgent = (version: string) => ({
      ...makeAgent({ npx: { package: `@example/acp@${version}` } }),
      version,
    });
    const agent = makeNpxAgent("1.2.3");
    let requests = 0;
    let refreshGate: {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null = null;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cold-inspect-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      const registryCachePath = `${registryDirectory}/registry.json`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(registryCachePath, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const inspection = yield* resolver.inspect(settings());

      expect(inspection).toMatchObject({ status: "ready", agentId: agent.id, version: "1.2.3" });
      expect(requests).toBe(0);

      // Cold inspection returns the disk cache immediately even while a refresh holds the semaphore.
      refreshGate = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const resolverWhileRefreshing = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const refreshFiber = yield* resolverWhileRefreshing
        .refreshIndex({ maxAgeMs: 15 * 60 * 1_000, failureBackoffMs: 60_000 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(refreshGate.started);
      expect(yield* resolverWhileRefreshing.inspect(settings())).toMatchObject({
        status: "ready",
        version: "1.2.3",
      });
      yield* Deferred.succeed(refreshGate.release, undefined);
      yield* Fiber.join(refreshFiber);
      expect(yield* resolverWhileRefreshing.inspect(settings())).toMatchObject({
        status: "ready",
        version: "1.2.4",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          const gate = refreshGate;
          const respond = Effect.sync(() =>
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(makeNpxAgent("1.2.4")))),
          );
          return gate === null
            ? respond
            : Deferred.succeed(gate.started, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
                Effect.andThen(respond),
              );
        }),
      ),
    );
  });

  it.effect("keeps a refreshed index when an overlapping disk read finishes later", () => {
    const makeNpxAgent = (version: string) => ({
      ...makeAgent({ npx: { package: `@example/acp@${version}` } }),
      version,
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-disk-race-",
      });
      const registryDirectory = path.join(cacheDir, "acp-registry");
      const registryCachePath = path.join(registryDirectory, "registry.json");
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(registryCachePath, makeRegistry(makeNpxAgent("1.2.3")));

      const diskReadStarted = yield* Deferred.make<void>();
      const releaseDiskRead = yield* Deferred.make<void>();
      const delayedFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        readFileString: (filePath, encoding) =>
          filePath === registryCachePath
            ? fileSystem.readFileString(filePath, encoding).pipe(
                Effect.tap(() => Deferred.succeed(diskReadStarted, undefined)),
                Effect.tap(() => Deferred.await(releaseDiskRead)),
              )
            : fileSystem.readFileString(filePath, encoding),
      };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(FileSystem.FileSystem, delayedFileSystem));

      const diskInspectFiber = yield* resolver
        .inspect(settings())
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(diskReadStarted);
      expect(
        yield* resolver.refreshIndex({ maxAgeMs: 15 * 60 * 1_000, failureBackoffMs: 60_000 }),
      ).toBe(1);
      yield* Deferred.succeed(releaseDiskRead, undefined);

      expect(yield* Fiber.join(diskInspectFiber)).toMatchObject({
        status: "ready",
        version: "1.2.4",
      });
      expect(yield* resolver.inspect(settings())).toMatchObject({
        status: "ready",
        version: "1.2.4",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(makeNpxAgent("1.2.4")))),
          ),
        ),
      ),
    );
  });

  it.effect("recovers inspection from a corrupt cache once the registry is reachable", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let online = false;
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-offline-",
      });
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fileSystem.writeFileString(`${cacheDir}/acp-registry/registry.json`, "{not json");
      const options = { cacheDir, toolsDir: `${cacheDir}/tools`, registryUrl };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog(options);

      const offline = yield* resolver.inspect(settings()).pipe(Effect.flip);
      expect(offline.reason).toBe("registry_unavailable");

      online = true;
      const concurrent = yield* Effect.all(
        [resolver.inspect(settings()), resolver.inspect(settings())],
        { concurrency: "unbounded" },
      );
      expect(concurrent).toMatchObject([{ status: "ready" }, { status: "ready" }]);
      expect(requests).toBe(2);

      const restarted = yield* AcpRegistrySupport.makeAcpRegistryCatalog(options);
      expect(yield* restarted.inspect(settings())).toMatchObject({ status: "ready" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              online
                ? new Response(makeRegistry(agent))
                : new Response("unavailable", { status: 503 }),
            ),
          );
        }),
      ),
    );
  });

  it.effect("uses the effective provider environment for inspection and resolution", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-effective-env-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const hostInspection = yield* resolver.inspect(settings());
      const providerEnvironment = toolchain.environment;
      const instanceInspection = yield* resolver.inspect(settings(), providerEnvironment);
      const resolved = yield* resolver.resolve(settings(), "/workspace", providerEnvironment);

      expect(hostInspection).toMatchObject({ status: "missing_runner", runner: "npm" });
      expect(instanceInspection).toMatchObject({ status: "ready", distribution: "npx" });
      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        env: { PATH: expect.stringMatching(new RegExp(`^${toolchain.globalBin}:`, "u")) },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("requires a regular executable file in the managed binary cache", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "bin/example-agent",
        },
      },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-non-file-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      const fakeExecutable = `${cacheDir}/tools/example-agent/1.2.3/linux-x86_64/bin/example-agent`;
      yield* fileSystem.makeDirectory(fakeExecutable, { recursive: true });
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const directoryError = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(directoryError.reason).toBe("archive_invalid");

      yield* fileSystem.remove(fakeExecutable, { recursive: true });
      yield* fileSystem.writeFileString(fakeExecutable, "#!/bin/sh\n");
      yield* fileSystem.chmod(fakeExecutable, 0o644);
      const modeError = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(modeError.reason).toBe("archive_invalid");

      yield* fileSystem.chmod(fakeExecutable, 0o755);
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "ready" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "legacy registry", source: undefined, agentId: "example-agent", referenced: true },
    { name: "registry", source: "registry", agentId: "example-agent", referenced: true },
    { name: "padded registry", source: "registry", agentId: " example-agent ", referenced: true },
    { name: "local command", source: "local", agentId: "example-agent", referenced: false },
  ] as const)(
    "checks $name references before uninstalling only managed binaries",
    ({ source, agentId, referenced }) => {
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-uninstall-",
        });
        const agentRoot = `${cacheDir}/tools/example-agent`;
        const runnerCache = `${cacheDir}/external-npx-cache/example-agent/package.json`;
        yield* fileSystem.makeDirectory(`${agentRoot}/1.2.3/linux-x86_64`, { recursive: true });
        yield* fileSystem.writeFileString(`${agentRoot}/1.2.3/linux-x86_64/agent`, "binary");
        yield* fileSystem.makeDirectory(`${cacheDir}/external-npx-cache/example-agent`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(runnerCache, "{}");

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
        const instanceId = ProviderInstanceId.make("uninstall-reference");
        yield* hostSettings.set({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Uninstall reference",
              enabled: true,
              config: {
                agentId,
                commandPath: "/local/agent",
                ...(source ? { source } : {}),
              },
            },
          },
        });
        const first = yield* resolver.uninstallManagedBinary({ agentId: "example-agent" });
        expect(first).toEqual({ agentId: "example-agent", removed: !referenced });
        expect(yield* fileSystem.exists(agentRoot)).toBe(referenced);
        yield* hostSettings.set(DEFAULT_SERVER_SETTINGS);
        const second = yield* resolver.uninstallManagedBinary({ agentId: "example-agent" });

        expect(second).toEqual({ agentId: "example-agent", removed: referenced });
        expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
          agentId: "example-agent",
          removed: false,
        });
        expect(yield* fileSystem.exists(agentRoot)).toBe(false);
        expect(yield* fileSystem.exists(runnerCache)).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused"))),
          ),
        ),
      );
    },
  );

  it.effect("keeps managed package installs when removing the same agent's binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-uninstall-packages-",
      });
      const versionRoot = `${cacheDir}/tools/example-agent/1.2.3`;
      yield* fileSystem.makeDirectory(`${versionRoot}/linux-x86_64`, { recursive: true });
      yield* fileSystem.writeFileString(`${versionRoot}/linux-x86_64/agent`, "binary");
      yield* fileSystem.makeDirectory(`${versionRoot}/npm/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${versionRoot}/npm/bin/agent`, "package command");
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
        agentId: "example-agent",
        removed: true,
      });
      expect(yield* fileSystem.exists(`${versionRoot}/linux-x86_64`)).toBe(false);
      expect(yield* fileSystem.readFileString(`${versionRoot}/npm/bin/agent`)).toBe(
        "package command",
      );
      expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
        agentId: "example-agent",
        removed: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected HTTP request"))),
    ),
  );

  it.effect("keeps a binary prepared by another client while an uninstall is waiting", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const releaseDownload = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-uninstall-race-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });

        const prepareFiber = yield* resolver
          .prepare({ agentId: agent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(downloadStarted);
        const uninstallFiber = yield* resolver
          .uninstallManagedBinary({ agentId: agent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));

        expect(uninstallFiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseDownload, undefined);

        expect(yield* Fiber.join(prepareFiber)).toMatchObject({ prepared: true });
        expect(yield* Fiber.join(uninstallFiber)).toEqual({
          agentId: agent.id,
          removed: false,
        });
        const agentRoot = `${cacheDir}/tools/${agent.id}`;
        expect(yield* fileSystem.exists(agentRoot)).toBe(true);

        const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
        const instanceId = ProviderInstanceId.make("registry-reference");
        yield* hostSettings.set({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Registry reference",
              enabled: true,
              config: { agentId: agent.id },
            },
          },
        });
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: false,
        });
        yield* hostSettings.set(DEFAULT_SERVER_SETTINGS);
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: true,
        });
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: false,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
              );
            }
            return Deferred.succeed(downloadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDownload)),
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(binaryBytes.buffer as ArrayBuffer),
                ),
              ),
            );
          }),
        ),
      );
    });
  });

  it.effect("resolves an installed agent while another agent's download is still running", () => {
    const slowArchiveUrl = "https://registry.test/slow-agent.bin";
    const agent = makeAgent({
      binary: { "linux-x86_64": { archive: archiveUrl, cmd: "./bin/example-agent" } },
    });
    const slowAgent = {
      ...agent,
      distribution: {
        binary: { "linux-x86_64": { archive: slowArchiveUrl, cmd: "./bin/slow-agent" } },
      },
      id: "slow-agent",
      name: "Slow Agent",
    };
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const releaseDownload = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-parallel-install-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });

        yield* resolver.resolve(settings(), "/workspace");

        const prepareFiber = yield* resolver
          .prepare({ agentId: slowAgent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(downloadStarted);

        const resolved = yield* resolver.resolve(settings(), "/workspace");
        expect(resolved.spawn.command).toContain(
          "/tools/example-agent/1.2.3/linux-x86_64/bin/example-agent",
        );
        expect(prepareFiber.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(releaseDownload, undefined);
        expect(yield* Fiber.join(prepareFiber)).toMatchObject({ prepared: true });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ version: "1.0.0", agents: [slowAgent, agent] })),
                ),
              );
            }
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(binaryBytes.buffer as ArrayBuffer),
            );
            if (request.url !== slowArchiveUrl) return Effect.succeed(response);
            return Deferred.succeed(downloadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDownload)),
              Effect.as(response),
            );
          }),
        ),
      );
    });
  });

  it.effect("reserves a prepared binary until a configured instance inspects it", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-uninstall-reservation-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      yield* resolver.prepare({ agentId: agent.id });
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: false,
      });
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "ready" });
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(binaryBytes.buffer as ArrayBuffer),
            ),
          ),
        ),
      ),
    );
  });

  it.effect(
    "repairs broken artifact slots, recovers corrupt or transiently unreadable legacy baselines, and prunes uninstalled baselines",
    () => {
      const archiveAUrl = "https://registry.test/v1-a.bin";
      const archiveBUrl = "https://registry.test/v1-b.bin";
      const archiveCUrl = "https://registry.test/v2-c.bin";
      const bytesA = new TextEncoder().encode("#!/bin/sh\necho archive-a\n");
      const bytesB = new TextEncoder().encode("#!/bin/sh\necho archive-b\n");
      const bytesC = new TextEncoder().encode("#!/bin/sh\necho archive-c\n");
      const binaryAgent = (version: string, archive: string) => ({
        ...makeAgent({
          binary: {
            "linux-x86_64": { archive, cmd: "./bin/example-agent" },
          },
        }),
        version,
      });
      let upstream = binaryAgent("1.2.3", archiveAUrl);
      let extraUpstreamAgents: ReadonlyArray<AcpRegistrySupport.AcpRegistryAgent> = [];
      let upstreamEmpty = false;
      let archiveRequestsDuringLockedSlot = 0;
      let countArchiveRequests = false;

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        // 1. A broken artifact-scoped slot (receipt present, executable deleted) self-repairs on resolve().
        const repairDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-repair-slot-",
        });
        const repairResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: repairDir,
          toolsDir: `${repairDir}/tools`,
          registryUrl,
        });
        const resolvedA = yield* repairResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedA.spawn.command)).toBe(
          "#!/bin/sh\necho archive-a\n",
        );

        upstream = binaryAgent("1.2.3", archiveBUrl);
        yield* repairResolver.invalidateIndex();
        yield* repairResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvedB = yield* repairResolver.resolve(settings(), "/workspace");
        expect(resolvedB.spawn.command).toMatch(/linux-x86_64-[0-9a-f]{12}\/bin\/example-agent$/u);
        expect(yield* fileSystem.readFileString(resolvedB.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // Delete B's executable while leaving the artifact slot directory and receipt behind.
        yield* fileSystem.remove(resolvedB.spawn.command);
        expect(yield* fileSystem.exists(resolvedB.spawn.command)).toBe(false);
        const repairedB = yield* repairResolver.resolve(settings(), "/workspace");
        expect(repairedB.spawn.command).toBe(resolvedB.spawn.command);
        expect(yield* fileSystem.readFileString(repairedB.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // If moving a broken artifact slot fails (e.g., locked files on Windows), fail fast with
        // install_failed before making any archive download request.
        yield* fileSystem.remove(repairedB.spawn.command);
        const brokenSlotRoot = path.dirname(path.dirname(repairedB.spawn.command));
        archiveRequestsDuringLockedSlot = 0;
        countArchiveRequests = true;
        const unmovableSlotFs: FileSystem.FileSystem = {
          ...fileSystem,
          rename: (oldPath, newPath) =>
            oldPath === brokenSlotRoot
              ? fileSystem.readFileString(repairDir).pipe(Effect.asVoid)
              : fileSystem.rename(oldPath, newPath),
        };
        const lockedSlotResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: repairDir,
          toolsDir: `${repairDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, unmovableSlotFs));
        const lockedSlotError = yield* lockedSlotResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        countArchiveRequests = false;
        expect(lockedSlotError.reason).toBe("install_failed");
        expect(archiveRequestsDuringLockedSlot).toBe(0);

        // 2. A transient I/O failure reading legacy-baselines.json preserves A's baseline in memory
        // so the next successful refresh still persists A and updates registry.json to B.
        const ioDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-baseline-io-",
        });
        const ioRegistryDir = path.join(ioDir, "acp-registry");
        const ioRegistryPath = path.join(ioRegistryDir, "registry.json");
        const ioBaselinesPath = path.join(ioRegistryDir, "legacy-baselines.json");
        const ioLegacyExe = path.join(
          ioDir,
          "tools",
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(ioLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(ioLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(ioLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(ioRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          ioRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveAUrl)),
        );

        let failLegacyRead = true;
        const flakyBaselinesFs: FileSystem.FileSystem = {
          ...fileSystem,
          readFileString: (filePath, encoding) =>
            failLegacyRead && filePath === ioBaselinesPath
              ? fileSystem.readFileString(ioDir, encoding)
              : fileSystem.readFileString(filePath, encoding),
        };
        upstream = binaryAgent("1.0.0", archiveBUrl);
        const ioResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: ioDir,
          toolsDir: path.join(ioDir, "tools"),
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, flakyBaselinesFs));
        yield* ioResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(ioRegistryPath)).toContain(archiveAUrl);
        expect(yield* fileSystem.exists(ioBaselinesPath)).toBe(false);

        failLegacyRead = false;
        yield* ioResolver.invalidateIndex();
        yield* ioResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(ioRegistryPath)).toContain(archiveBUrl);
        const persistedBaselines = yield* fileSystem.readFileString(ioBaselinesPath);
        expect(persistedBaselines).toContain("example-agent\\u00001.0.0\\u0000linux-x86_64");
        expect(persistedBaselines).toContain(archiveAUrl);

        // Restarting against the recovered disk files must install B instead of reusing legacy A.
        const restartedIoResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: ioDir,
          toolsDir: path.join(ioDir, "tools"),
          registryUrl,
        });
        const resolvedAfterIoRecovery = yield* restartedIoResolver.resolve(
          settings(),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedAfterIoRecovery.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // 2b. Non-directory files and unreadable unrelated tool directories in shared tools/
        // (e.g., tools/codex/active.json, tools/.DS_Store, tools/chrome-headless-shell, or a
        // non-directory file at a candidate platform slot) must not break legacy baseline scanning.
        const sharedToolsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-shared-tools-",
        });
        const sharedRegistryDir = path.join(sharedToolsDir, "acp-registry");
        const sharedRegistryPath = path.join(sharedRegistryDir, "registry.json");
        const sharedBaselinesPath = path.join(sharedRegistryDir, "legacy-baselines.json");
        const sharedToolsRoot = path.join(sharedToolsDir, "tools");
        const sharedLegacyExe = path.join(
          sharedToolsRoot,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(sharedLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(sharedLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(sharedLegacyExe, 0o755);
        // Place a regular file at a candidate installRoot slot to exercise the directory check.
        const nonDirSlotDir = path.join(sharedToolsRoot, "example-agent", "0.9.0");
        yield* fileSystem.makeDirectory(nonDirSlotDir, { recursive: true });
        yield* fileSystem.writeFileString(path.join(nonDirSlotDir, "linux-x86_64"), "not-a-dir");
        yield* fileSystem.makeDirectory(path.join(sharedToolsRoot, "codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(sharedToolsRoot, "codex", "active.json"),
          '{"version":"1.0.0"}',
        );
        yield* fileSystem.writeFileString(path.join(sharedToolsRoot, ".DS_Store"), "finder");
        const unreadableOtherTool = path.join(sharedToolsRoot, "chrome-headless-shell");
        yield* fileSystem.makeDirectory(unreadableOtherTool, { recursive: true });
        yield* fileSystem.makeDirectory(sharedRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          sharedRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveAUrl)),
        );
        const sharedToolsFs: FileSystem.FileSystem = {
          ...fileSystem,
          readDirectory: (dirPath, options) =>
            dirPath === unreadableOtherTool
              ? fileSystem.readDirectory(sharedLegacyExe, options)
              : fileSystem.readDirectory(dirPath, options),
        };
        upstream = binaryAgent("1.0.0", archiveBUrl);
        const sharedToolsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: sharedToolsDir,
          toolsDir: sharedToolsRoot,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, sharedToolsFs));
        yield* sharedToolsResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(sharedRegistryPath)).toContain(archiveBUrl);
        expect(yield* fileSystem.readFileString(sharedBaselinesPath)).toContain(archiveAUrl);
        expect(yield* fileSystem.readFileString(sharedBaselinesPath)).not.toContain("0.9.0");
        const resolvedWithSharedTools = yield* sharedToolsResolver.resolve(
          settings(),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedWithSharedTools.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // 2c. An incomplete tools-directory scan during A -> B keeps disk registry.json on A AND
        // blocks live resolution from launching legacy A as B even before the scan recovers; once
        // readable again, recovery persists A and clears the incomplete flag for eligible slots.
        const scanDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-scan-error-",
        });
        const scanRegistryDir = path.join(scanDir, "acp-registry");
        const scanRegistryPath = path.join(scanRegistryDir, "registry.json");
        const scanBaselinesPath = path.join(scanRegistryDir, "legacy-baselines.json");
        const scanToolsDir = path.join(scanDir, "tools");
        const scanAgentDir = path.join(scanToolsDir, "example-agent");
        const scanLegacyExe = path.join(
          scanAgentDir,
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(scanLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(scanLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(scanLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(scanRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          scanRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveAUrl)),
        );
        let failToolsScan = true;
        const flakyScanFs: FileSystem.FileSystem = {
          ...fileSystem,
          readDirectory: (dirPath, options) =>
            failToolsScan && dirPath === scanAgentDir
              ? fileSystem.readDirectory(scanLegacyExe, options)
              : fileSystem.readDirectory(dirPath, options),
        };
        upstream = binaryAgent("1.0.0", archiveBUrl);
        const scanResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: scanDir,
          toolsDir: scanToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, flakyScanFs));
        yield* scanResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(scanRegistryPath)).toContain(archiveAUrl);
        expect(yield* fileSystem.exists(scanBaselinesPath)).toBe(false);

        // Resolving BEFORE clearing the scan failure must install B instead of running legacy A.
        const resolvedDuringScanFailure = yield* scanResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedDuringScanFailure.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // A failed scan after restart must NOT overwrite a durable legacy baseline with registry.json:
        // with legacy A on disk, durable baseline A, and registry.json at B, failing a scan on
        // B -> C and rolling back to B while still failing must install B, not run legacy A as B.
        const durableScanDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-durable-scan-",
        });
        const durableRegistryDir = path.join(durableScanDir, "acp-registry");
        const durableRegistryPath = path.join(durableRegistryDir, "registry.json");
        const durableBaselinesPath = path.join(durableRegistryDir, "legacy-baselines.json");
        const durableToolsDir = path.join(durableScanDir, "tools");
        const durableAgentDir = path.join(durableToolsDir, "example-agent");
        const durableLegacyExe = path.join(
          durableAgentDir,
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(durableLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(durableLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(durableLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(durableRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          durableRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveBUrl)),
        );
        yield* fileSystem.writeFileString(
          durableBaselinesPath,
          JSON.stringify({
            "example-agent\u00001.0.0\u0000linux-x86_64": JSON.stringify({
              archive: archiveAUrl,
              cmd: "./bin/example-agent",
              sha256: null,
            }),
          }),
        );
        const failDurableScanFs: FileSystem.FileSystem = {
          ...fileSystem,
          readDirectory: (dirPath, options) =>
            dirPath === durableAgentDir
              ? fileSystem.readDirectory(durableLegacyExe, options)
              : fileSystem.readDirectory(dirPath, options),
        };
        const durableScanResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: durableScanDir,
          toolsDir: durableToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, failDurableScanFs));
        upstream = binaryAgent("1.0.0", archiveCUrl);
        yield* durableScanResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        upstream = binaryAgent("1.0.0", archiveBUrl);
        yield* durableScanResolver.invalidateIndex();
        yield* durableScanResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvedAgainstDurable = yield* durableScanResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedAgainstDurable.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // A transient I/O error reading registry.json during baseline discovery must also keep
        // disk registry.json untouched rather than treating it as missing.
        const regIoDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-reg-io-",
        });
        const regIoRegistryDir = path.join(regIoDir, "acp-registry");
        const regIoRegistryPath = path.join(regIoRegistryDir, "registry.json");
        const regIoLegacyExe = path.join(
          regIoDir,
          "tools",
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(regIoLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(regIoLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(regIoLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(regIoRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          regIoRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveAUrl)),
        );
        const failRegistryReadFs: FileSystem.FileSystem = {
          ...fileSystem,
          readFileString: (filePath, encoding) =>
            filePath === regIoRegistryPath
              ? fileSystem.readFileString(regIoDir, encoding)
              : fileSystem.readFileString(filePath, encoding),
        };
        const regIoResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: regIoDir,
          toolsDir: path.join(regIoDir, "tools"),
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, failRegistryReadFs));
        yield* regIoResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(regIoRegistryPath)).toContain(archiveAUrl);
        // Live resolution during an unreadable disk registry.json must also install B rather than
        // launching the unverified legacy A executable.
        const resolvedDuringRegIo = yield* regIoResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedDuringRegIo.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // A transient stat I/O error on tools/ itself must keep disk registry.json on A and
        // block live resolution from launching unverified legacy A.
        const statIoDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-stat-io-",
        });
        const statIoRegistryDir = path.join(statIoDir, "acp-registry");
        const statIoRegistryPath = path.join(statIoRegistryDir, "registry.json");
        const statIoToolsDir = path.join(statIoDir, "tools");
        const statIoLegacyExe = path.join(
          statIoToolsDir,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(statIoLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(statIoLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(statIoLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(statIoRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          statIoRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveAUrl)),
        );
        const failToolsStatFs: FileSystem.FileSystem = {
          ...fileSystem,
          stat: (filePath) =>
            filePath === statIoToolsDir
              ? fileSystem
                  .readFileString(statIoToolsDir)
                  .pipe(Effect.andThen(fileSystem.stat(filePath)))
              : fileSystem.stat(filePath),
        };
        const statIoResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: statIoDir,
          toolsDir: statIoToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, failToolsStatFs));
        yield* statIoResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(statIoRegistryPath)).toContain(archiveAUrl);
        const resolvedDuringStatIo = yield* statIoResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedDuringStatIo.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // Removing an agent present in the initial disk registry.json must still record its
        // legacy baseline on the first refresh after restart so a later re-add at the same
        // version with a different archive installs B instead of executing legacy A.
        const removedAgentDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-removed-baseline-",
        });
        const removedRegistryDir = path.join(removedAgentDir, "acp-registry");
        const removedRegistryPath = path.join(removedRegistryDir, "registry.json");
        const removedBaselinesPath = path.join(removedRegistryDir, "legacy-baselines.json");
        const removedToolsDir = path.join(removedAgentDir, "tools");
        const removedLegacyExe = path.join(
          removedToolsDir,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(removedLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(removedLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(removedLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(removedRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          removedRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveAUrl)),
        );
        upstreamEmpty = true;
        const removedAgentResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: removedAgentDir,
          toolsDir: removedToolsDir,
          registryUrl,
        });
        yield* removedAgentResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(removedBaselinesPath)).toContain(archiveAUrl);
        upstreamEmpty = false;
        upstream = binaryAgent("1.0.0", archiveBUrl);
        yield* removedAgentResolver.invalidateIndex();
        yield* removedAgentResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvedAfterReadd = yield* removedAgentResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedAfterReadd.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        failToolsScan = false;
        yield* scanResolver.invalidateIndex();
        yield* scanResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(scanRegistryPath)).toContain(archiveBUrl);
        expect(yield* fileSystem.readFileString(scanBaselinesPath)).toContain(archiveAUrl);
        // Once the scan recovers and baselines persist, legacyBaselineDiscoveryIncomplete is reset
        // so an eligible unreceipted legacy slot at a matching version can be reused cleanly.
        const scanLegacyV2Exe = path.join(
          scanAgentDir,
          "2.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(scanLegacyV2Exe), { recursive: true });
        yield* fileSystem.writeFileString(scanLegacyV2Exe, "#!/bin/sh\necho legacy-v2\n");
        yield* fileSystem.chmod(scanLegacyV2Exe, 0o755);
        upstream = binaryAgent("2.0.0", archiveCUrl);
        yield* scanResolver.invalidateIndex();
        yield* scanResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const reusedAfterRecovery = yield* scanResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(reusedAfterRecovery.spawn.command)).toBe(
          "#!/bin/sh\necho legacy-v2\n",
        );
        upstream = binaryAgent("1.0.0", archiveBUrl);
        const restartedScanResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: scanDir,
          toolsDir: scanToolsDir,
          registryUrl,
        });
        yield* restartedScanResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvedAfterScanRecovery = yield* restartedScanResolver.resolve(
          settings(),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedAfterScanRecovery.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // 3. A corrupt legacy-baselines.json is copied aside and rebuilt cleanly without inferring
        // provenance from an unverified cached registry index: even on a B -> C refresh after
        // restart, the unreceipted slot is marked "unknown" so a later rollback to B installs B
        // instead of executing legacy A as B. uninstallManagedBinary prunes removed agents.
        const corruptDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-baseline-corrupt-",
        });
        const corruptRegistryDir = path.join(corruptDir, "acp-registry");
        const corruptRegistryPath = path.join(corruptRegistryDir, "registry.json");
        const corruptBaselinesPath = path.join(corruptRegistryDir, "legacy-baselines.json");
        const corruptToolsDir = path.join(corruptDir, "tools");
        const corruptLegacyExe = path.join(
          corruptToolsDir,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        const corruptUnreadableOtherTool = path.join(corruptToolsDir, "chrome-headless-shell");
        const corruptReadableRemovedExe = path.join(
          corruptToolsDir,
          "removed-readable-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        const corruptUnreadableRemovedDir = path.join(corruptToolsDir, "removed-unreadable-agent");
        const corruptUnreadableRemovedExe = path.join(
          corruptUnreadableRemovedDir,
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(corruptLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(corruptLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(corruptLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(path.dirname(corruptReadableRemovedExe), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(corruptReadableRemovedExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(corruptReadableRemovedExe, 0o755);
        yield* fileSystem.makeDirectory(path.dirname(corruptUnreadableRemovedExe), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          corruptUnreadableRemovedExe,
          "#!/bin/sh\necho legacy-a\n",
        );
        yield* fileSystem.chmod(corruptUnreadableRemovedExe, 0o755);
        yield* fileSystem.makeDirectory(corruptUnreadableOtherTool, { recursive: true });
        yield* fileSystem.makeDirectory(corruptRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          corruptRegistryPath,
          makeRegistry(binaryAgent("1.0.0", archiveBUrl)),
        );
        yield* fileSystem.writeFileString(corruptBaselinesPath, "{not json");
        let failRemovedUnreadable = true;
        const corruptToolsFs: FileSystem.FileSystem = {
          ...fileSystem,
          readDirectory: (dirPath, options) =>
            dirPath === corruptUnreadableOtherTool ||
            (failRemovedUnreadable && dirPath === corruptUnreadableRemovedDir)
              ? fileSystem.readDirectory(corruptLegacyExe, options)
              : fileSystem.readDirectory(dirPath, options),
        };

        upstream = binaryAgent("2.0.0", archiveCUrl);
        const corruptResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: corruptDir,
          toolsDir: corruptToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, corruptToolsFs));
        yield* corruptResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(`${corruptBaselinesPath}.corrupt`)).toBe(
          "{not json",
        );
        expect(yield* fileSystem.readFileString(corruptRegistryPath)).toContain(archiveCUrl);
        const rebuiltBaselines = JSON.parse(
          yield* fileSystem.readFileString(corruptBaselinesPath),
        ) as Record<string, string>;
        const exampleSlotKey = "example-agent\u00001.0.0\u0000linux-x86_64";
        const otherSlotKey = "other-agent\u00001.0.0\u0000linux-x86_64";
        expect(rebuiltBaselines[exampleSlotKey]).toBe("unknown");
        // Readable removed-agent slots are discovered and marked unknown; unreadable extra
        // directories get an agent-level unknown sentinel so neither blocks recovery nor loses
        // unknown provenance if the directory becomes readable and the agent is later re-added.
        expect(rebuiltBaselines["removed-readable-agent\u00001.0.0\u0000linux-x86_64"]).toBe(
          "unknown",
        );
        expect(rebuiltBaselines["removed-unreadable-agent\u0000*"]).toBe("unknown");
        expect(rebuiltBaselines["chrome-headless-shell\u0000*"]).toBe("unknown");

        // Verify \0* sentinels are excluded from normal requiredAgentIds, honored on direct disk
        // and in-memory lookups and in recordDivergingInMemory, and pruned on uninstall.
        failRemovedUnreadable = false;
        upstream = binaryAgent("2.0.1", archiveCUrl);
        yield* corruptResolver.invalidateIndex();
        yield* corruptResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(corruptRegistryPath)).toContain("2.0.1");

        // Direct resolve without refreshIndex() verifies disk \0* check in isLegacyBinarySlotEligible,
        // and a second resolve on a second unreceipted version verifies memory \0* check.
        const corruptUnreadableV2Exe = path.join(
          corruptUnreadableRemovedDir,
          "2.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(corruptUnreadableV2Exe), { recursive: true });
        yield* fileSystem.writeFileString(corruptUnreadableV2Exe, "#!/bin/sh\necho legacy-v2\n");
        yield* fileSystem.chmod(corruptUnreadableV2Exe, 0o755);
        yield* fileSystem.writeFileString(
          corruptRegistryPath,
          JSON.stringify({
            version: "1.0.0",
            agents: [
              binaryAgent("2.0.1", archiveCUrl),
              { ...binaryAgent("1.0.0", archiveAUrl), id: "removed-unreadable-agent" },
            ],
          }),
        );
        const directDiskSentinelCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: corruptDir,
          toolsDir: corruptToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, corruptToolsFs));
        const resolvedDirectDiskSentinel = yield* directDiskSentinelCatalog.resolve(
          settings({ agentId: "removed-unreadable-agent" }),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedDirectDiskSentinel.spawn.command)).toBe(
          "#!/bin/sh\necho archive-a\n",
        );
        // Refreshing 1.0.0 -> 2.0.0 while 2.0.0 stays unreceipted persists a slot-specific
        // "unknown" baseline for 2.0.0 instead of attributing it to archiveA.
        extraUpstreamAgents = [
          { ...binaryAgent("2.0.0", archiveBUrl), id: "removed-unreadable-agent" },
        ];
        yield* directDiskSentinelCatalog.invalidateIndex();
        yield* directDiskSentinelCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const baselinesAfterDiverge = JSON.parse(
          yield* fileSystem.readFileString(corruptBaselinesPath),
        ) as Record<string, string>;
        expect(baselinesAfterDiverge["removed-unreadable-agent\u00002.0.0\u0000linux-x86_64"]).toBe(
          "unknown",
        );
        const resolvedSlotSentinel = yield* directDiskSentinelCatalog.resolve(
          settings({ agentId: "removed-unreadable-agent" }),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedSlotSentinel.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );
        // Resolve an unreceipted 3.0.0 legacy slot absent during the scan with the on-disk \0*
        // sentinel removed so ONLY the cached in-memory \0* sentinel can reject legacy reuse.
        extraUpstreamAgents = [
          { ...binaryAgent("3.0.0", archiveCUrl), id: "removed-unreadable-agent" },
        ];
        yield* directDiskSentinelCatalog.invalidateIndex();
        yield* directDiskSentinelCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const baselinesBeforeV3 = JSON.parse(
          yield* fileSystem.readFileString(corruptBaselinesPath),
        ) as Record<string, string>;
        expect(
          baselinesBeforeV3["removed-unreadable-agent\u00003.0.0\u0000linux-x86_64"],
        ).toBeUndefined();
        const {
          ["removed-unreadable-agent\u0000*"]: _droppedDiskSentinel,
          ...baselinesWithoutAgentSentinel
        } = baselinesBeforeV3;
        yield* fileSystem.writeFileString(
          corruptBaselinesPath,
          JSON.stringify(baselinesWithoutAgentSentinel),
        );
        const corruptUnreadableV3Exe = path.join(
          corruptUnreadableRemovedDir,
          "3.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(corruptUnreadableV3Exe), { recursive: true });
        yield* fileSystem.writeFileString(corruptUnreadableV3Exe, "#!/bin/sh\necho legacy-v3\n");
        yield* fileSystem.chmod(corruptUnreadableV3Exe, 0o755);
        const resolvedMemorySentinel = yield* directDiskSentinelCatalog.resolve(
          settings({ agentId: "removed-unreadable-agent" }),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedMemorySentinel.spawn.command)).toBe(
          "#!/bin/sh\necho archive-c\n",
        );
        // Restore the on-disk \0* sentinel to confirm uninstallManagedBinary prunes both keys.
        yield* fileSystem.writeFileString(
          corruptBaselinesPath,
          JSON.stringify(baselinesAfterDiverge),
        );
        expect(
          yield* directDiskSentinelCatalog.uninstallManagedBinary({
            agentId: "removed-unreadable-agent",
          }),
        ).toEqual({ agentId: "removed-unreadable-agent", removed: true });
        const baselinesAfterSentinelUninstall = JSON.parse(
          yield* fileSystem.readFileString(corruptBaselinesPath),
        ) as Record<string, string>;
        expect(baselinesAfterSentinelUninstall["removed-unreadable-agent\u0000*"]).toBeUndefined();
        expect(
          baselinesAfterSentinelUninstall["removed-unreadable-agent\u00002.0.0\u0000linux-x86_64"],
        ).toBeUndefined();
        expect(baselinesAfterSentinelUninstall["chrome-headless-shell\u0000*"]).toBe("unknown");
        extraUpstreamAgents = [];

        // Corrupt-baselines rebuild with ONLY an unreadable extra directory (zero readable legacy
        // slots) must still copy aside .corrupt and persist the agent-level unknown sentinel.
        const onlyUnscannedDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-only-unscanned-",
        });
        const onlyUnscannedTools = path.join(onlyUnscannedDir, "tools");
        const onlyUnscannedTool = path.join(onlyUnscannedTools, "chrome-headless-shell");
        const onlyUnscannedDummyFile = path.join(onlyUnscannedDir, "not-a-dir");
        const onlyUnscannedRegDir = path.join(onlyUnscannedDir, "acp-registry");
        const onlyUnscannedBaselines = path.join(onlyUnscannedRegDir, "legacy-baselines.json");
        yield* fileSystem.makeDirectory(onlyUnscannedTool, { recursive: true });
        yield* fileSystem.writeFileString(onlyUnscannedDummyFile, "x");
        yield* fileSystem.makeDirectory(onlyUnscannedRegDir, { recursive: true });
        yield* fileSystem.writeFileString(onlyUnscannedBaselines, "{only-unscanned");
        const onlyUnscannedFs: FileSystem.FileSystem = {
          ...fileSystem,
          readDirectory: (dirPath, options) =>
            dirPath === onlyUnscannedTool
              ? fileSystem.readDirectory(onlyUnscannedDummyFile, options)
              : fileSystem.readDirectory(dirPath, options),
        };
        const onlyUnscannedResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: onlyUnscannedDir,
          toolsDir: onlyUnscannedTools,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, onlyUnscannedFs));
        yield* onlyUnscannedResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(`${onlyUnscannedBaselines}.corrupt`)).toBe(
          "{only-unscanned",
        );
        expect(JSON.parse(yield* fileSystem.readFileString(onlyUnscannedBaselines))).toEqual({
          "chrome-headless-shell\u0000*": "unknown",
        });

        // Rolling back from C (2.0.0) to B (1.0.0) must install B instead of running legacy A as B.
        upstream = binaryAgent("1.0.0", archiveBUrl);
        yield* corruptResolver.invalidateIndex();
        yield* corruptResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const resolvedAfterRollback = yield* corruptResolver.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(resolvedAfterRollback.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // Same check on B -> B after restart with a corrupt baseline file.
        const unrecoverableDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-baseline-unrecoverable-",
        });
        const unrecoverableRegistryDir = `${unrecoverableDir}/acp-registry`;
        const unrecoverableBaselinesPath = `${unrecoverableRegistryDir}/legacy-baselines.json`;
        const unrecoverableLegacyExe = `${unrecoverableDir}/tools/example-agent/1.0.0/linux-x86_64/bin/example-agent`;
        yield* fileSystem.makeDirectory(path.dirname(unrecoverableLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(unrecoverableLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* fileSystem.chmod(unrecoverableLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(unrecoverableRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          `${unrecoverableRegistryDir}/registry.json`,
          makeRegistry(binaryAgent("1.0.0", archiveBUrl)),
        );
        yield* fileSystem.writeFileString(unrecoverableBaselinesPath, "{corrupt");

        upstream = binaryAgent("1.0.0", archiveBUrl);
        const unrecoverableResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: unrecoverableDir,
          toolsDir: `${unrecoverableDir}/tools`,
          registryUrl,
        });
        yield* unrecoverableResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* fileSystem.readFileString(`${unrecoverableBaselinesPath}.corrupt`)).toBe(
          "{corrupt",
        );
        const unknownBaselines = JSON.parse(
          yield* fileSystem.readFileString(unrecoverableBaselinesPath),
        ) as Record<string, string>;
        expect(unknownBaselines[exampleSlotKey]).toBe("unknown");
        const resolvedAfterCorruptRebuild = yield* unrecoverableResolver.resolve(
          settings(),
          "/workspace",
        );
        expect(yield* fileSystem.readFileString(resolvedAfterCorruptRebuild.spawn.command)).toBe(
          "#!/bin/sh\necho archive-b\n",
        );

        // Add another agent's baseline and launch-options sidecar entries, uninstall example-agent,
        // and verify only example-agent is pruned from both stores.
        rebuiltBaselines[otherSlotKey] = "other-baseline";
        yield* fileSystem.writeFileString(corruptBaselinesPath, JSON.stringify(rebuiltBaselines));
        const corruptSidecarPath = path.join(corruptRegistryDir, "binary-launch-options.json");
        const exampleSlotRoot = path.join(
          corruptDir,
          "tools",
          "example-agent",
          "1.0.0",
          "linux-x86_64",
        );
        const otherSlotRoot = path.join(
          corruptDir,
          "tools",
          "other-agent",
          "1.0.0",
          "linux-x86_64",
        );
        yield* fileSystem.writeFileString(
          corruptSidecarPath,
          JSON.stringify({
            [exampleSlotRoot]: {
              version: "1.0.0",
              archive: archiveBUrl,
              cmd: "./bin/example-agent",
              sha256: null,
              args: ["--old"],
              launchOptionsRevision: 1,
            },
            [otherSlotRoot]: {
              version: "1.0.0",
              archive: archiveAUrl,
              cmd: "./bin/other-agent",
              sha256: null,
              args: ["--keep"],
              launchOptionsRevision: 1,
            },
          }),
        );
        expect(yield* corruptResolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual(
          {
            agentId: "example-agent",
            removed: true,
          },
        );
        const prunedBaselines = JSON.parse(
          yield* fileSystem.readFileString(corruptBaselinesPath),
        ) as Record<string, string>;
        expect(prunedBaselines[exampleSlotKey]).toBeUndefined();
        expect(prunedBaselines[otherSlotKey]).toBe("other-baseline");
        const prunedSidecar = JSON.parse(
          yield* fileSystem.readFileString(corruptSidecarPath),
        ) as Record<string, unknown>;
        expect(prunedSidecar[exampleSlotRoot]).toBeUndefined();
        expect(prunedSidecar[otherSlotRoot]).toBeDefined();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    upstreamEmpty
                      ? JSON.stringify({ version: "1.0.0", agents: [] })
                      : extraUpstreamAgents.length > 0
                        ? JSON.stringify({
                            version: "1.0.0",
                            agents: [upstream, ...extraUpstreamAgents],
                          })
                        : makeRegistry(upstream),
                  ),
                ),
              );
            }
            if (countArchiveRequests) {
              archiveRequestsDuringLockedSlot += 1;
            }
            const bytes =
              request.url === archiveAUrl ? bytesA : request.url === archiveBUrl ? bytesB : bytesC;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
            );
          }),
        ),
      );
    },
  );

  it.effect(
    "enforces post-retry removal, archive extraction timeout, and pre-promotion concurrent slot checks",
    () => {
      const archiveV1Url = "https://registry.test/v1.bin";
      const archiveV2AUrl = "https://registry.test/v2-a.bin";
      const archiveV2BUrl = "https://registry.test/v2-b.bin";
      const archiveTarUrl = "https://registry.test/v3.tar.gz";
      const archivePlainUrl = "https://registry.test/v3-plain.bin";
      const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho ok\n");
      const binaryAgent = (version: string, archive: string, sha256Hex?: string) => ({
        ...makeAgent({
          binary: {
            "linux-x86_64": {
              archive,
              cmd: "./bin/example-agent",
              ...(sha256Hex ? { sha256: sha256Hex } : {}),
            },
          },
        }),
        version,
      });
      let upstreamAgents: ReadonlyArray<AcpRegistrySupport.AcpRegistryAgent> = [
        binaryAgent("1.0.0", archiveV1Url),
      ];
      let downloadGate: {
        readonly url: string;
        readonly started: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        // 1. Post-retry concurrent removal: initial A fails checksum_mismatch while the index
        // advances to B, then recheck-retry B fails checksum_mismatch while the agent is removed ->
        // resolve() rechecks after retry B and fails with agent_not_found instead of falling back.
        const removalDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-post-retry-remove-",
        });
        const removalResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: removalDir,
          toolsDir: `${removalDir}/tools`,
          registryUrl,
        });
        const v1Resolved = yield* removalResolver.resolve(settings(), "/workspace");
        expect(v1Resolved.agent?.version).toBe("1.0.0");

        upstreamAgents = [binaryAgent("2.0.0", archiveV2AUrl, "0".repeat(64))];
        yield* removalResolver.invalidateIndex();
        yield* removalResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const aGate = {
          url: archiveV2AUrl,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const bGate = {
          url: archiveV2BUrl,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        downloadGate = aGate;
        const resolveFiber = yield* removalResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(aGate.started);

        // Advance the index from A to B while A's download is in flight, then arm bGate.
        upstreamAgents = [binaryAgent("2.0.0", archiveV2BUrl, "0".repeat(64))];
        yield* removalResolver.invalidateIndex();
        yield* removalResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        downloadGate = bGate;
        yield* Deferred.succeed(aGate.release, undefined);
        yield* Deferred.await(bGate.started);

        // Concurrently remove the agent while the recheck's own retry B download is in flight.
        upstreamAgents = [];
        yield* removalResolver.invalidateIndex();
        yield* removalResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* Deferred.succeed(bGate.release, undefined);
        expect((yield* Fiber.join(resolveFiber)).reason).toBe("agent_not_found");

        // 1b. Multi-pass recheck retry: A fails checksum -> moves to B -> B fails checksum -> moves
        // to valid C -> resolve() retries through B to C and succeeds with C.
        upstreamAgents = [binaryAgent("2.0.0", archiveV2AUrl, "0".repeat(64))];
        yield* removalResolver.invalidateIndex();
        yield* removalResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const aGate2 = {
          url: archiveV2AUrl,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const bGate2 = {
          url: archiveV2BUrl,
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        downloadGate = aGate2;
        const multiRetryFiber = yield* removalResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(aGate2.started);
        upstreamAgents = [binaryAgent("2.0.0", archiveV2BUrl, "0".repeat(64))];
        yield* removalResolver.invalidateIndex();
        yield* removalResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        downloadGate = bGate2;
        yield* Deferred.succeed(aGate2.release, undefined);
        yield* Deferred.await(bGate2.started);
        upstreamAgents = [binaryAgent("2.0.0", archivePlainUrl)];
        yield* removalResolver.invalidateIndex();
        yield* removalResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* Deferred.succeed(bGate2.release, undefined);
        const multiRetried = yield* Fiber.join(multiRetryFiber);
        expect(multiRetried.fallback).toBeUndefined();
        expect(multiRetried.agent?.version).toBe("2.0.0");

        // 2. Both archive extraction and listing timeouts map to archive_invalid (falling back when
        // a prior receipted version exists, and surfacing archive_invalid while releasing locks
        // when none exists).
        let tarStartedGate: Deferred.Deferred<void> | null = null;
        let hangTarStage: "list" | "extract" = "extract";
        const hangingTarSpawner = ChildProcessSpawner.make((command) => {
          if (
            ChildProcess.isStandardCommand(command) &&
            (command.command === "tar" || command.command.endsWith("/tar"))
          ) {
            const firstArg = command.args[0];
            const isListing = typeof firstArg === "string" && firstArg.startsWith("-t");
            if (isListing && hangTarStage === "extract") {
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.make(new TextEncoder().encode("bin/example-agent\n")),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            }
            const gate = tarStartedGate;
            tarStartedGate = null;
            return (gate === null ? Effect.void : Deferred.succeed(gate, undefined)).pipe(
              Effect.as(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(1),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              ),
            );
          }
          return realSpawner.spawn(command);
        });
        const timeoutFallbackResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: removalDir,
          toolsDir: `${removalDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, hangingTarSpawner),
          Effect.provideService(SpawnExecutableResolution, (command) => command),
        );
        upstreamAgents = [binaryAgent("3.0.0", archiveTarUrl)];
        yield* timeoutFallbackResolver.invalidateIndex();
        yield* timeoutFallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        hangTarStage = "extract";
        tarStartedGate = yield* Deferred.make<void>();
        const tarWithFallback = tarStartedGate;
        const fallbackTimeoutFiber = yield* timeoutFallbackResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(tarWithFallback);
        yield* TestClock.adjust("5 minutes");
        const fallbackOnTimeout = yield* Fiber.join(fallbackTimeoutFiber);
        expect(fallbackOnTimeout.fallback).toBe(true);
        expect(fallbackOnTimeout.agent?.version).toBe("2.0.0");

        const noFallbackDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-extract-timeout-",
        });
        const noFallbackResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: noFallbackDir,
          toolsDir: `${noFallbackDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, hangingTarSpawner),
          Effect.provideService(SpawnExecutableResolution, (command) => command),
        );
        hangTarStage = "list";
        tarStartedGate = yield* Deferred.make<void>();
        const tarWithoutFallback = tarStartedGate;
        const noFallbackTimeoutFiber = yield* noFallbackResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(tarWithoutFallback);
        yield* TestClock.adjust("5 minutes");
        expect((yield* Fiber.join(noFallbackTimeoutFiber)).reason).toBe("archive_invalid");

        // Locks and permits are released cleanly after extraction timeout so a later install succeeds.
        upstreamAgents = [binaryAgent("3.0.0", archivePlainUrl)];
        yield* noFallbackResolver.invalidateIndex();
        yield* noFallbackResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const recoveredAfterTimeout = yield* noFallbackResolver.resolve(settings(), "/workspace");
        expect(recoveredAfterTimeout.agent?.version).toBe("3.0.0");

        // 3. Pre-promotion concurrentSlot recheck returns the sibling install without renaming again.
        const concurrentDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-pre-promote-",
        });
        upstreamAgents = [binaryAgent("1.2.3", archiveV1Url)];
        const baseSeedResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: concurrentDir,
          toolsDir: `${concurrentDir}/tools`,
          registryUrl,
        });
        yield* baseSeedResolver.resolve(settings(), "/workspace");

        upstreamAgents = [binaryAgent("1.2.3", archivePlainUrl)];
        let receiptGate: {
          readonly started: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const firstReceiptGate = receiptGate;
        let renameToArtifactCount = 0;
        const instrumentedFs: FileSystem.FileSystem = {
          ...fileSystem,
          writeFileString: (filePath, data, options) => {
            if (receiptGate !== null && filePath.endsWith("/.t3-artifact.json")) {
              const gate = receiptGate;
              receiptGate = null;
              return fileSystem.writeFileString(filePath, data, options).pipe(
                Effect.tap(() => Deferred.succeed(gate.started, undefined)),
                Effect.tap(() => Deferred.await(gate.release)),
              );
            }
            return fileSystem.writeFileString(filePath, data, options);
          },
          rename: (oldPath, newPath) => {
            if (/linux-x86_64-[0-9a-f]{12}$/u.test(newPath)) {
              renameToArtifactCount += 1;
            }
            return fileSystem.rename(oldPath, newPath);
          },
        };
        const installer1 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: concurrentDir,
          toolsDir: `${concurrentDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, instrumentedFs));
        const installer2 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: concurrentDir,
          toolsDir: `${concurrentDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, instrumentedFs));
        yield* installer1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* installer2.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });

        const firstInstallFiber = yield* installer1
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstReceiptGate.started);
        // Age installer1's lock and advance the clock past the 5-minute stale threshold explicitly
        // so this check is independent of earlier clock adjustments.
        yield* fileSystem.utimes(
          `${concurrentDir}/tools/example-agent/1.2.3/linux-x86_64.lock`,
          0,
          0,
        );
        yield* TestClock.adjust("6 minutes");
        const secondResult = yield* installer2.resolve(settings(), "/workspace");
        expect(renameToArtifactCount).toBe(1);

        yield* Deferred.succeed(firstReceiptGate.release, undefined);
        const firstResult = yield* Fiber.join(firstInstallFiber);
        expect(firstResult.spawn.command).toBe(secondResult.spawn.command);
        expect(renameToArtifactCount).toBe(1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ version: "1.0.0", agents: upstreamAgents })),
                ),
              );
            }
            const respond = Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(binaryBytes.buffer as ArrayBuffer)),
            );
            if (downloadGate !== null && request.url === downloadGate.url) {
              const gate = downloadGate;
              downloadGate = null;
              return Deferred.succeed(gate.started, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
                Effect.andThen(respond),
              );
            }
            return respond;
          }),
        ),
      );
    },
  );

  it.effect(
    "rejects reserved receipt command paths, ignores superseded broken primaries on inspect, persists launch options when receipt writes fail, and enforces interruptible token-owned locks",
    () => {
      const archiveAUrl = "https://registry.test/receipt-a.bin";
      const archiveBUrl = "https://registry.test/receipt-b.bin";
      const archiveFailUrl = "https://registry.test/receipt-fail.bin";
      const bytesA = new TextEncoder().encode("#!/bin/sh\necho receipt-a\n");
      const bytesB = new TextEncoder().encode("#!/bin/sh\necho receipt-b\n");
      const makeBinary = (
        version: string,
        target: {
          readonly archive: string;
          readonly cmd: string;
          readonly args?: ReadonlyArray<string>;
          readonly env?: Readonly<Record<string, string>>;
        },
      ) => ({
        ...makeAgent({ binary: { "linux-x86_64": target } }),
        version,
      });
      let upstream = makeBinary("1.0.0", { archive: archiveAUrl, cmd: ".t3-artifact.json" });
      let extraUpstream: ReturnType<typeof makeBinary> | null = null;

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Model POSIX mode bits in memory so Linux mode assertions work identically on Windows.
        const modeOverrides = new Map<string, number>();
        let failReceiptTempWrite = false;
        let failSidecarWrite = false;
        let failSidecarRead = false;
        let failSidecarReadWhileLockedPath: string | null = null;
        let corruptSidecarWhileLockedPath: string | null = null;
        let failReceiptReadWhileLockedPath: string | null = null;
        let injectedReceiptReadFailures = 0;
        let receiptRenameCount = 0;
        let onStatPath: {
          readonly matchPath: string;
          readonly onHit: () => void;
        } | null = null;
        const posixModeFs: FileSystem.FileSystem = {
          ...fileSystem,
          chmod: (filePath, mode) =>
            Effect.sync(() => {
              modeOverrides.set(filePath, mode);
            }).pipe(Effect.andThen(fileSystem.chmod(filePath, mode).pipe(Effect.ignore))),
          stat: (filePath) =>
            fileSystem.stat(filePath).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (onStatPath !== null && filePath === onStatPath.matchPath) {
                    onStatPath.onHit();
                  }
                }),
              ),
              Effect.map((info) => {
                const override = modeOverrides.get(filePath);
                return override === undefined
                  ? info
                  : { ...info, mode: (info.mode & ~0o777) | override };
              }),
            ),
          readFileString: (filePath, encoding) => {
            const base = path.basename(filePath);
            if (base === "binary-launch-options.json") {
              if (failSidecarRead) {
                return fileSystem.readFileString(path.dirname(filePath), encoding);
              }
              if (corruptSidecarWhileLockedPath !== null) {
                const lockPath = corruptSidecarWhileLockedPath;
                return fileSystem.exists(lockPath).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((locked) =>
                    locked
                      ? Effect.succeed("{corrupt-under-lock")
                      : fileSystem.readFileString(filePath, encoding),
                  ),
                );
              }
              if (failSidecarReadWhileLockedPath !== null) {
                const lockPath = failSidecarReadWhileLockedPath;
                return fileSystem.exists(lockPath).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((locked) =>
                    locked
                      ? fileSystem.readFileString(path.dirname(filePath), encoding)
                      : fileSystem.readFileString(filePath, encoding),
                  ),
                );
              }
            }
            if (base === ".t3-artifact.json" && failReceiptReadWhileLockedPath !== null) {
              const lockPath = failReceiptReadWhileLockedPath;
              return fileSystem.exists(lockPath).pipe(
                Effect.orElseSucceed(() => false),
                Effect.flatMap((locked) =>
                  locked
                    ? Effect.sync(() => {
                        injectedReceiptReadFailures += 1;
                      }).pipe(
                        Effect.andThen(fileSystem.readFileString(path.dirname(filePath), encoding)),
                      )
                    : fileSystem.readFileString(filePath, encoding),
                ),
              );
            }
            return fileSystem.readFileString(filePath, encoding);
          },
          writeFileString: (filePath, data, options) =>
            (failReceiptTempWrite && path.basename(filePath).startsWith(".t3-artifact.json.")) ||
            (failSidecarWrite &&
              path.basename(filePath).startsWith("binary-launch-options.json.") &&
              filePath.endsWith(".tmp"))
              ? fileSystem.readFileString(path.dirname(filePath)).pipe(Effect.asVoid)
              : fileSystem.writeFileString(filePath, data, options),
          rename: (oldPath, newPath) =>
            Effect.sync(() => {
              if (path.basename(newPath) === ".t3-artifact.json") {
                receiptRenameCount += 1;
              }
            }).pipe(Effect.andThen(fileSystem.rename(oldPath, newPath))),
        };

        // 1. A raw binary declaring .t3-artifact.json as its command fails with archive_invalid
        // instead of letting the receipt overwrite the staged executable.
        const reservedDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-reserved-receipt-",
        });
        const reservedResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: reservedDir,
          toolsDir: `${reservedDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const reservedError = yield* reservedResolver
          .resolve(settings(), "/workspace")
          .pipe(Effect.flip);
        expect(reservedError.reason).toBe("archive_invalid");

        // 2. Unchanged no-env binaries skip receipt rewrites; updating args/env syncs the receipt;
        // failed receipt writes persist in binary-launch-options.json across restarts without
        // letting stale sidecar entries shadow newer receipts or dropping other slots on read errors.
        const noEnvDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-no-env-skip-",
        });
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1"],
        });
        const noEnvResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: noEnvDir,
          toolsDir: path.join(noEnvDir, "tools"),
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* noEnvResolver.resolve(settings(), "/workspace");
        receiptRenameCount = 0;
        yield* noEnvResolver.resolve(settings(), "/workspace");
        yield* noEnvResolver.resolve(settings(), "/workspace");
        expect(receiptRenameCount).toBe(0);
        // After populating syncedLaunchOptionsBySlotRoot for a no-env binary, subsequent resolves
        // with the same args and omitted env must hit the memory fast path without rewriting.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--v2"],
        });
        yield* noEnvResolver.invalidateIndex();
        yield* noEnvResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* noEnvResolver.resolve(settings(), "/workspace");
        receiptRenameCount = 0;
        yield* noEnvResolver.resolve(settings(), "/workspace");
        yield* noEnvResolver.resolve(settings(), "/workspace");
        expect(receiptRenameCount).toBe(0);

        const supersededDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-superseded-inspect-",
        });
        const supersededToolsDir = path.join(supersededDir, "tools");
        const supersededSidecarPath = path.join(
          supersededDir,
          "acp-registry",
          "binary-launch-options.json",
        );
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1"],
          env: { STAGE: "initial" },
        });
        const supersededResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const installedA = yield* supersededResolver.resolve(settings(), "/workspace");
        expect(installedA.spawn.args).toEqual(["--v1"]);
        expect(installedA.spawn.env?.STAGE).toBe("initial");

        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--updated"],
          env: { STAGE: "updated" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const syncedA = yield* supersededResolver.resolve(settings(), "/workspace");
        expect(syncedA.spawn.command).toBe(installedA.spawn.command);
        expect(syncedA.spawn.args).toEqual(["--v1", "--updated"]);
        expect(syncedA.spawn.env?.STAGE).toBe("updated");

        // Failed receipt write persists --sidecar; reverting back to the receipt's --updated in the
        // SAME process must update/clear the sidecar so fallback does not resurrect --sidecar.
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--sidecar"],
          env: { STAGE: "sidecar" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const sidecarSyncedA = yield* supersededResolver.resolve(settings(), "/workspace");
        expect(sidecarSyncedA.spawn.args).toEqual(["--v1", "--sidecar"]);
        expect(sidecarSyncedA.spawn.env?.STAGE).toBe("sidecar");

        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--updated"],
          env: { STAGE: "updated" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const sameProcessRevertFallback = yield* supersededResolver.resolve(
          settings(),
          "/workspace",
        );
        expect(sameProcessRevertFallback.fallback).toBe(true);
        expect(sameProcessRevertFallback.spawn.args).toEqual(["--v1", "--updated"]);
        expect(sameProcessRevertFallback.spawn.env?.STAGE).toBe("updated");

        // Write --sidecar to the sidecar again, restart, and verify fallback restores --sidecar.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--sidecar"],
          env: { STAGE: "sidecar" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;

        // A transient read failure on binary-launch-options.json must leave existing sidecar
        // entries intact instead of replacing the file with an empty/partial map.
        const preserveSlotKey = path.join(
          supersededToolsDir,
          "other-agent",
          "1.0.0",
          "linux-x86_64",
        );
        const sidecarBeforeIo = JSON.parse(
          yield* fileSystem.readFileString(supersededSidecarPath),
        ) as Record<string, unknown>;
        yield* fileSystem.writeFileString(
          supersededSidecarPath,
          JSON.stringify({
            ...sidecarBeforeIo,
            [preserveSlotKey]: {
              version: "1.0.0",
              archive: archiveBUrl,
              cmd: "./bin/other-agent",
              sha256: null,
              args: ["--preserve"],
              launchOptionsRevision: 1,
            },
          }),
        );
        failReceiptTempWrite = true;
        failSidecarRead = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--sidecar-io"],
          env: { STAGE: "sidecar-io" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarRead = false;
        const sidecarAfterIo = JSON.parse(
          yield* fileSystem.readFileString(supersededSidecarPath),
        ) as Record<string, unknown>;
        expect(sidecarAfterIo[preserveSlotKey]).toBeDefined();

        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const restartedSuperseded = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* restartedSuperseded.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackA = yield* restartedSuperseded.resolve(settings(), "/workspace");
        expect(fallbackA.fallback).toBe(true);
        expect(fallbackA.agent?.version).toBe("1.0.0");
        expect(fallbackA.spawn.args).toEqual(["--v1", "--sidecar"]);
        expect(fallbackA.spawn.env?.STAGE).toBe("sidecar");

        // After storage recovers, re-resolving the SAME --sidecar-io options on supersededResolver
        // (which only held them in memory when both receipt and sidecar writes failed) must retry
        // persistence so a fresh catalog restores --sidecar-io on fallback.
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--sidecar-io"],
          env: { STAGE: "sidecar-io" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const recoveredIoCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* recoveredIoCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackRecoveredIo = yield* recoveredIoCatalog.resolve(settings(), "/workspace");
        expect(fallbackRecoveredIo.fallback).toBe(true);
        expect(fallbackRecoveredIo.spawn.args).toEqual(["--v1", "--sidecar-io"]);
        expect(fallbackRecoveredIo.spawn.env?.STAGE).toBe("sidecar-io");

        // A second catalog writing a newer sidecar revision must win over catalog A's older
        // in-memory cached launch options during fallback AND must invalidate catalog A's skip path.
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--cat-a"],
          env: { STAGE: "cat-a" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--cat-b"],
          env: { STAGE: "cat-b" },
        });
        yield* recoveredIoCatalog.invalidateIndex();
        yield* recoveredIoCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* recoveredIoCatalog.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackSeesCatB = yield* supersededResolver.resolve(settings(), "/workspace");
        expect(fallbackSeesCatB.fallback).toBe(true);
        expect(fallbackSeesCatB.spawn.args).toEqual(["--v1", "--cat-b"]);
        expect(fallbackSeesCatB.spawn.env?.STAGE).toBe("cat-b");
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--cat-a"],
          env: { STAGE: "cat-a" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* recoveredIoCatalog.invalidateIndex();
        yield* recoveredIoCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackSeesNewerCatA = yield* recoveredIoCatalog.resolve(settings(), "/workspace");
        expect(fallbackSeesNewerCatA.fallback).toBe(true);
        expect(fallbackSeesNewerCatA.spawn.args).toEqual(["--v1", "--cat-a"]);
        expect(fallbackSeesNewerCatA.spawn.env?.STAGE).toBe("cat-a");

        // If the sidecar cache file disappears (e.g. cache directory cleared), resolving the
        // same --cat-a options on supersededResolver must re-persist them instead of trusting memory.
        yield* fileSystem.remove(supersededSidecarPath, { force: true });
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--cat-a"],
          env: { STAGE: "cat-a" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const afterCacheWipeCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* afterCacheWipeCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackAfterCacheWipe = yield* afterCacheWipeCatalog.resolve(
          settings(),
          "/workspace",
        );
        expect(fallbackAfterCacheWipe.fallback).toBe(true);
        expect(fallbackAfterCacheWipe.spawn.args).toEqual(["--v1", "--cat-a"]);
        expect(fallbackAfterCacheWipe.spawn.env?.STAGE).toBe("cat-a");

        // A concurrent higher RECEIPT revision written by another catalog must also invalidate
        // supersededResolver's memory cache when upstream returns to --cat-a.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--receipt-cat-b"],
          env: { STAGE: "receipt-cat-b" },
        });
        yield* recoveredIoCatalog.invalidateIndex();
        yield* recoveredIoCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* recoveredIoCatalog.resolve(settings(), "/workspace");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--cat-a"],
          env: { STAGE: "cat-a" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const afterReceiptBumpCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* afterReceiptBumpCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackAfterReceiptBump = yield* afterReceiptBumpCatalog.resolve(
          settings(),
          "/workspace",
        );
        expect(fallbackAfterReceiptBump.fallback).toBe(true);
        expect(fallbackAfterReceiptBump.spawn.args).toEqual(["--v1", "--cat-a"]);
        expect(fallbackAfterReceiptBump.spawn.env?.STAGE).toBe("cat-a");

        // Restore --updated to the receipt before testing corrupt-sidecar repair on both the
        // matching-receipt path and the failed-receipt-write path.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--updated"],
          env: { STAGE: "updated" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        yield* fileSystem.writeFileString(supersededSidecarPath, "{corrupt-match");
        const repairOnMatchCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* repairOnMatchCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* repairOnMatchCatalog.resolve(settings(), "/workspace");
        expect(yield* fileSystem.readFileString(`${supersededSidecarPath}.corrupt`)).toBe(
          "{corrupt-match",
        );
        expect(JSON.parse(yield* fileSystem.readFileString(supersededSidecarPath))).toEqual({});

        // A corrupt binary-launch-options.json is copied aside and repaired cleanly on write.
        yield* fileSystem.writeFileString(supersededSidecarPath, "{corrupt-sidecar");
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--repaired-sidecar"],
          env: { STAGE: "repaired" },
        });
        yield* supersededResolver.invalidateIndex();
        yield* supersededResolver.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* supersededResolver.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        expect(yield* fileSystem.readFileString(`${supersededSidecarPath}.corrupt`)).toBe(
          "{corrupt-sidecar",
        );
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const repairedSidecarCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* repairedSidecarCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackRepairedSidecar = yield* repairedSidecarCatalog.resolve(
          settings(),
          "/workspace",
        );
        expect(fallbackRepairedSidecar.fallback).toBe(true);
        expect(fallbackRepairedSidecar.spawn.args).toEqual(["--v1", "--repaired-sidecar"]);
        expect(fallbackRepairedSidecar.spawn.env?.STAGE).toBe("repaired");
        // Restore preserveSlotKey before the revert check below.
        const repairedSidecarEntries = JSON.parse(
          yield* fileSystem.readFileString(supersededSidecarPath),
        ) as Record<string, unknown>;
        yield* fileSystem.writeFileString(
          supersededSidecarPath,
          JSON.stringify({
            ...repairedSidecarEntries,
            [preserveSlotKey]: {
              version: "1.0.0",
              archive: archiveBUrl,
              cmd: "./bin/other-agent",
              sha256: null,
              args: ["--preserve"],
              launchOptionsRevision: 1,
            },
          }),
        );

        // Reverting upstream back to the receipt's earlier args/env after restart prunes the
        // sidecar and persists the new generation; verify with ANOTHER fresh catalog instance.
        const exampleSlotRootSuperseded = path.join(
          supersededToolsDir,
          "example-agent",
          "1.0.0",
          path.basename(path.dirname(path.dirname(installedA.spawn.command))),
        );
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--updated"],
          env: { STAGE: "updated" },
        });
        yield* restartedSuperseded.invalidateIndex();
        yield* restartedSuperseded.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const revertedA = yield* restartedSuperseded.resolve(settings(), "/workspace");
        expect(revertedA.spawn.args).toEqual(["--v1", "--updated"]);
        expect(revertedA.spawn.env?.STAGE).toBe("updated");
        const sidecarAfterRevert = JSON.parse(
          yield* fileSystem.readFileString(supersededSidecarPath),
        ) as Record<string, unknown>;
        expect(sidecarAfterRevert[exampleSlotRootSuperseded]).toBeUndefined();
        expect(sidecarAfterRevert[preserveSlotKey]).toBeDefined();
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const afterRevertCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* afterRevertCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackAfterRevert = yield* afterRevertCatalog.resolve(settings(), "/workspace");
        expect(fallbackAfterRevert.fallback).toBe(true);
        expect(fallbackAfterRevert.spawn.args).toEqual(["--v1", "--updated"]);
        expect(fallbackAfterRevert.spawn.env?.STAGE).toBe("updated");

        // A newer receipt write followed by a failed sidecar prune must still win over the older
        // unpruned sidecar entry after restart.
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--stale-sidecar"],
          env: { STAGE: "stale-sidecar" },
        });
        yield* afterRevertCatalog.invalidateIndex();
        yield* afterRevertCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* afterRevertCatalog.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1", "--newer-receipt"],
          env: { STAGE: "newer-receipt" },
        });
        yield* afterRevertCatalog.invalidateIndex();
        yield* afterRevertCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* afterRevertCatalog.resolve(settings(), "/workspace");
        failSidecarWrite = false;
        // Confirm the stale sidecar entry is still present on disk while the receipt has higher rev.
        const unprunedSidecar = JSON.parse(
          yield* fileSystem.readFileString(supersededSidecarPath),
        ) as Record<string, { readonly args?: ReadonlyArray<string> }>;
        expect(unprunedSidecar[exampleSlotRootSuperseded]?.args).toEqual([
          "--v1",
          "--stale-sidecar",
        ]);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const newerReceiptCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: supersededDir,
          toolsDir: supersededToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* newerReceiptCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackNewerReceipt = yield* newerReceiptCatalog.resolve(settings(), "/workspace");
        expect(fallbackNewerReceipt.fallback).toBe(true);
        expect(fallbackNewerReceipt.spawn.args).toEqual(["--v1", "--newer-receipt"]);
        expect(fallbackNewerReceipt.spawn.env?.STAGE).toBe("newer-receipt");

        // Uninstalling clears in-memory launch options too so reinstalling uses the new receipt.
        expect(
          yield* afterRevertCatalog.uninstallManagedBinary({ agentId: "example-agent" }),
        ).toEqual({ agentId: "example-agent", removed: true });
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fresh-after-uninstall"],
        });
        yield* afterRevertCatalog.invalidateIndex();
        yield* afterRevertCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const reinstalledA = yield* afterRevertCatalog.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* afterRevertCatalog.invalidateIndex();
        yield* afterRevertCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fallbackAfterReinstall = yield* afterRevertCatalog.resolve(settings(), "/workspace");
        expect(fallbackAfterReinstall.fallback).toBe(true);
        expect(fallbackAfterReinstall.spawn.args).toEqual(["--fresh-after-uninstall"]);

        // Reinstalling a broken slot in place must supersede/prune stale in-memory and sidecar
        // launch options at that slot root so fallback uses the fresh install's options both
        // in-process and after restart.
        const inPlaceDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-inplace-reinstall-",
        });
        const inPlaceToolsDir = path.join(inPlaceDir, "tools");
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
          args: ["--b1"],
        });
        const inPlaceCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: inPlaceDir,
          toolsDir: inPlaceToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* inPlaceCatalog.resolve(settings(), "/workspace");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a1"],
        });
        yield* inPlaceCatalog.invalidateIndex();
        yield* inPlaceCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const inPlaceSlotA = yield* inPlaceCatalog.resolve(settings(), "/workspace");
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a2"],
        });
        yield* inPlaceCatalog.invalidateIndex();
        yield* inPlaceCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* inPlaceCatalog.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        // Break slot A's executable, then resolve A with new args --a3 while sidecar reads fail
        // so it reinstalls in place without being able to read or prune binary-launch-options.json;
        // the fresh installId must still beat the old sidecar/memory --a2 entry in-process & restart.
        yield* fileSystem.remove(inPlaceSlotA.spawn.command, { force: true });
        failSidecarRead = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a3"],
        });
        yield* inPlaceCatalog.invalidateIndex();
        yield* inPlaceCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const reinstalledInPlace = yield* inPlaceCatalog.resolve(settings(), "/workspace");
        failSidecarRead = false;
        expect(reinstalledInPlace.spawn.command).toBe(inPlaceSlotA.spawn.command);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* inPlaceCatalog.invalidateIndex();
        yield* inPlaceCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const inProcessFallbackA3 = yield* inPlaceCatalog.resolve(settings(), "/workspace");
        expect(inProcessFallbackA3.fallback).toBe(true);
        expect(inProcessFallbackA3.spawn.args).toEqual(["--a3"]);
        const restartedInPlaceCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: inPlaceDir,
          toolsDir: inPlaceToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* restartedInPlaceCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const restartedFallbackA3 = yield* restartedInPlaceCatalog.resolve(
          settings(),
          "/workspace",
        );
        expect(restartedFallbackA3.fallback).toBe(true);
        expect(restartedFallbackA3.spawn.args).toEqual(["--a3"]);

        // Reinstalling a different artifact at the same primary path via another catalog must not
        // let catalog A's cached memory entry for the old artifact skip updating the new receipt.
        const swapPrimaryDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-swap-primary-",
        });
        const swapPrimaryToolsDir = path.join(swapPrimaryDir, "tools");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--v1"],
        });
        const swapCatA = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: swapPrimaryDir,
          toolsDir: swapPrimaryToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const swapCatB = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: swapPrimaryDir,
          toolsDir: swapPrimaryToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* swapCatA.resolve(settings(), "/workspace");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--shared-opt"],
        });
        yield* swapCatA.invalidateIndex();
        yield* swapCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* swapCatA.resolve(settings(), "/workspace");
        // Catalog B uninstalls artifact A and installs artifact B with --other-opt at the same primary path.
        yield* swapCatB.uninstallManagedBinary({ agentId: "example-agent" });
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
          args: ["--other-opt"],
        });
        yield* swapCatB.invalidateIndex();
        yield* swapCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* swapCatB.resolve(settings(), "/workspace");
        // Catalog A now resolves artifact B with --shared-opt (matching its stale memory entry for A).
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
          args: ["--shared-opt"],
        });
        yield* swapCatA.invalidateIndex();
        yield* swapCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* swapCatA.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const swapVerifyCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: swapPrimaryDir,
          toolsDir: swapPrimaryToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* swapVerifyCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const swapFallback = yield* swapVerifyCatalog.resolve(settings(), "/workspace");
        expect(swapFallback.fallback).toBe(true);
        expect(swapFallback.spawn.args).toEqual(["--shared-opt"]);

        // Concurrent launch-option syncs on the same slot serialize revision allocation under the
        // sidecar lock so a receipt write (rev 1) followed by a sidecar write gets rev 2 and wins,
        // fallback reads the sidecar before receipts so concurrent receipt+prune never restores an
        // older receipt, and uninstall prunes the sidecar before releasing the agent permit.
        const coordDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-coord-sync-",
        });
        const coordToolsDir = path.join(coordDir, "tools");
        const coordSidecarPath = path.join(coordDir, "acp-registry", "binary-launch-options.json");
        const coordSidecarLockPath = `${coordSidecarPath}.lock`;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--init"],
        });
        const coordSeed = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coordDir,
          toolsDir: coordToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const coordInitial = yield* coordSeed.resolve(settings(), "/workspace");
        const coordSlotRoot = path.join(
          coordToolsDir,
          "example-agent",
          "1.0.0",
          path.basename(path.dirname(path.dirname(coordInitial.spawn.command))),
        );
        const coordReceiptPath = path.join(coordSlotRoot, ".t3-artifact.json");

        // (a) Catalog 1 pauses during its rev-1 receipt write while Catalog 2 starts with --c2
        //     (whose receipt write fails); Catalog 2 waits on the sidecar lock, reads rev-1 receipt,
        //     and writes sidecar rev 2 (--c2) so fallback selects --c2 over rev-1 --c1.
        const cat1WriteStarted = yield* Deferred.make<void>();
        const releaseCat1Write = yield* Deferred.make<void>();
        const cat2LockWaited = yield* Deferred.make<void>();
        let gateCat1Receipt = true;
        const coordCat1Fs: FileSystem.FileSystem = {
          ...posixModeFs,
          writeFileString: (filePath, data, options) => {
            if (gateCat1Receipt && path.basename(filePath).startsWith(".t3-artifact.json.")) {
              gateCat1Receipt = false;
              return Deferred.succeed(cat1WriteStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCat1Write)),
                Effect.andThen(posixModeFs.writeFileString(filePath, data, options)),
              );
            }
            return posixModeFs.writeFileString(filePath, data, options);
          },
        };
        const coordCat2Fs: FileSystem.FileSystem = {
          ...posixModeFs,
          stat: (filePath) =>
            posixModeFs
              .stat(filePath)
              .pipe(
                Effect.tap(() =>
                  filePath === coordSidecarLockPath
                    ? Deferred.succeed(cat2LockWaited, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
          writeFileString: (filePath, data, options) =>
            path.basename(filePath).startsWith(".t3-artifact.json.")
              ? fileSystem.readFileString(path.dirname(filePath)).pipe(Effect.asVoid)
              : posixModeFs.writeFileString(filePath, data, options),
        };
        const coordCat1 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coordDir,
          toolsDir: coordToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, coordCat1Fs));
        const coordCat2 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coordDir,
          toolsDir: coordToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, coordCat2Fs));
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--c1"],
        });
        yield* coordCat1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--c2"],
        });
        yield* coordCat2.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const cat1Fiber = yield* coordCat1
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(cat1WriteStarted);
        const cat2Fiber = yield* coordCat2
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(cat2LockWaited);
        yield* Deferred.succeed(releaseCat1Write, undefined);
        yield* Fiber.join(cat1Fiber);
        yield* TestClock.adjust("100 millis");
        yield* Fiber.join(cat2Fiber);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const coordVerify = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coordDir,
          toolsDir: coordToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* coordVerify.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const coordFallbackC2 = yield* coordVerify.resolve(settings(), "/workspace");
        expect(coordFallbackC2.fallback).toBe(true);
        expect(coordFallbackC2.spawn.args).toEqual(["--c2"]);

        // (b) Fallback reads the sidecar BEFORE receipts: pausing fallback right before it reads
        //     .t3-artifact.json while another writer publishes rev-3 --c3 to the receipt and prunes
        //     the sidecar must still yield --c3 (never the older rev-1 receipt).
        const fbReceiptGateStarted = yield* Deferred.make<void>();
        const releaseFbReceiptGate = yield* Deferred.make<void>();
        let fbSawSidecar = false;
        let gateFbReceipt = true;
        const coordFallbackFs: FileSystem.FileSystem = {
          ...posixModeFs,
          readFileString: (filePath, encoding) => {
            if (filePath === coordSidecarPath) {
              fbSawSidecar = true;
            }
            if (gateFbReceipt && fbSawSidecar && filePath === coordReceiptPath) {
              gateFbReceipt = false;
              return Deferred.succeed(fbReceiptGateStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFbReceiptGate)),
                Effect.andThen(posixModeFs.readFileString(filePath, encoding)),
              );
            }
            return posixModeFs.readFileString(filePath, encoding);
          },
        };
        const coordFallbackReader = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coordDir,
          toolsDir: coordToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, coordFallbackFs));
        yield* coordFallbackReader.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const fbReaderFiber = yield* coordFallbackReader
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(fbReceiptGateStarted);
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--c3"],
        });
        yield* coordSeed.invalidateIndex();
        yield* coordSeed.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* coordSeed.resolve(settings(), "/workspace");
        yield* Deferred.succeed(releaseFbReceiptGate, undefined);
        const coordFallbackC3 = yield* Fiber.join(fbReaderFiber);
        expect(coordFallbackC3.fallback).toBe(true);
        expect(coordFallbackC3.spawn.args).toEqual(["--c3"]);

        // (c) Uninstall finishes sidecar cleanup before releasing the agent permit so a concurrent
        //     reinstall cannot enter install I/O or write a sidecar entry before cleanup runs.
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--pre-uninstall"],
        });
        yield* coordSeed.invalidateIndex();
        yield* coordSeed.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* coordSeed.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        const uninstallBeforeLockStarted = yield* Deferred.make<void>();
        const releaseUninstallBeforeLock = yield* Deferred.make<void>();
        let gateUninstallExists = true;
        let reinstallEnteredInstall = false;
        const markReinstallToolsTouch = (filePath: string) => {
          if (!gateUninstallExists && filePath.startsWith(coordToolsDir)) {
            reinstallEnteredInstall = true;
          }
        };
        const coordUninstallFs: FileSystem.FileSystem = {
          ...posixModeFs,
          exists: (filePath) => {
            // Pause uninstall BEFORE it takes the sidecar lock so an early permit release would
            // let reinstall enter installBinary while cleanup is paused.
            if (gateUninstallExists && filePath === coordSidecarPath) {
              gateUninstallExists = false;
              return Deferred.succeed(uninstallBeforeLockStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUninstallBeforeLock)),
                Effect.andThen(posixModeFs.exists(filePath)),
              );
            }
            markReinstallToolsTouch(filePath);
            return posixModeFs.exists(filePath);
          },
          readFileString: (filePath, encoding) =>
            Effect.sync(() => markReinstallToolsTouch(filePath)).pipe(
              Effect.andThen(posixModeFs.readFileString(filePath, encoding)),
            ),
          readDirectory: (dirPath, options) =>
            Effect.sync(() => markReinstallToolsTouch(dirPath)).pipe(
              Effect.andThen(posixModeFs.readDirectory(dirPath, options)),
            ),
          stat: (filePath) =>
            Effect.sync(() => markReinstallToolsTouch(filePath)).pipe(
              Effect.andThen(posixModeFs.stat(filePath)),
            ),
          makeDirectory: (dirPath, options) =>
            Effect.sync(() => markReinstallToolsTouch(dirPath)).pipe(
              Effect.andThen(posixModeFs.makeDirectory(dirPath, options)),
            ),
        };
        const uninstallSchedulerDispatcher = new Scheduler.MixedScheduler("async").makeDispatcher();
        const uninstallScheduler: Scheduler.Scheduler = {
          executionMode: "async",
          shouldYield: () => false,
          makeDispatcher: () => uninstallSchedulerDispatcher,
        };
        const coordPermitCatalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: coordDir,
          toolsDir: coordToolsDir,
          registryUrl,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, coordUninstallFs),
          Effect.provideService(Scheduler.Scheduler, uninstallScheduler),
        );
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--after-uninstall"],
        });
        yield* coordPermitCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const uninstallFiber = yield* coordPermitCatalog
          .uninstallManagedBinary({ agentId: "example-agent" })
          .pipe(
            Effect.provideService(Scheduler.Scheduler, uninstallScheduler),
            Effect.forkScoped({ startImmediately: true }),
          );
        yield* Deferred.await(uninstallBeforeLockStarted);
        // Start reinstall on the same catalog while uninstall is paused BEFORE its sidecar lock;
        // flush the scheduler and assert reinstall has NOT entered installBinary (blocked on permit).
        const reinstallFiber = yield* coordPermitCatalog
          .resolve(settings(), "/workspace")
          .pipe(
            Effect.provideService(Scheduler.Scheduler, uninstallScheduler),
            Effect.forkScoped({ startImmediately: true }),
          );
        uninstallSchedulerDispatcher.flush();
        expect(reinstallEnteredInstall).toBe(false);
        yield* Deferred.succeed(releaseUninstallBeforeLock, undefined);
        expect(yield* Fiber.join(uninstallFiber)).toEqual({
          agentId: "example-agent",
          removed: true,
        });
        const reinstalledAfterPermit = yield* Fiber.join(reinstallFiber);
        expect(reinstallEnteredInstall).toBe(true);
        expect(reinstalledAfterPermit.spawn.args).toEqual(["--after-uninstall"]);

        // (d) Sidecar io_error neither rewrites matching receipts nor allocates below unreadable
        //     sidecars; pending options stay separate from committed revisions; lock timeouts
        //     observe fast-path sidecar revisions for in-process fallback.
        const edgeSyncDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-edge-sync-",
        });
        const edgeSyncToolsDir = path.join(edgeSyncDir, "tools");
        const edgeSyncSidecarPath = path.join(
          edgeSyncDir,
          "acp-registry",
          "binary-launch-options.json",
        );
        const edgeSyncSidecarLockPath = `${edgeSyncSidecarPath}.lock`;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--edge-init"],
        });
        const edgeCatA = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: edgeSyncDir,
          toolsDir: edgeSyncToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const edgeCatB = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: edgeSyncDir,
          toolsDir: edgeSyncToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* edgeCatA.resolve(settings(), "/workspace");
        // Write rev 1 and rev 2 to sidecar while receipt stays at rev 0 (--edge-init).
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--edge-sidecar-1"],
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatA.resolve(settings(), "/workspace");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--edge-sidecar-2"],
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatA.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        // 1) Matching receipt + sidecar io_error must NOT rewrite the receipt on every resolve.
        failSidecarRead = true;
        receiptRenameCount = 0;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--edge-init"],
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatB.resolve(settings(), "/workspace");
        yield* edgeCatB.resolve(settings(), "/workspace");
        expect(receiptRenameCount).toBe(0);
        // 1b) Reverting to matching receipt (--edge-init rev 0) after observing newer sidecar rev 2
        //     on the fast path, then hitting io_error while locked, keeps --edge-init pending.
        failSidecarRead = false;
        failSidecarReadWhileLockedPath = edgeSyncSidecarLockPath;
        yield* edgeCatB.resolve(settings(), "/workspace");
        failSidecarReadWhileLockedPath = null;
        expect(receiptRenameCount).toBe(0);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* edgeCatB.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--edge-init",
        ]);
        // 2) Different target + sidecar io_error does not allocate below sidecar rev 2 and keeps
        //    launch usable via pending options while the sidecar is STILL unreadable.
        failSidecarRead = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--edge-after-io"],
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatB.resolve(settings(), "/workspace");
        expect(receiptRenameCount).toBe(0);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* edgeCatB.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--edge-after-io",
        ]);
        // Once reads recover, retrying the same target allocates rev 3 (> sidecar rev 2) cleanly.
        failSidecarRead = false;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--edge-after-io"],
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatB.resolve(settings(), "/workspace");
        expect(receiptRenameCount).toBe(1);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        const edgeVerifyAfterIo = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: edgeSyncDir,
          toolsDir: edgeSyncToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* edgeVerifyAfterIo.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* edgeVerifyAfterIo.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--edge-after-io",
        ]);
        // 3) Repeated failed writes do not inflate committed revisions, and a transient locked
        //    receipt reread error keeps pending --fail-2 until another catalog commits rev 4.
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fail-1"],
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatA.resolve(settings(), "/workspace");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fail-2"],
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatA.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        // Transient locked receipt reread failure must preserve pending --fail-2.
        injectedReceiptReadFailures = 0;
        failReceiptReadWhileLockedPath = edgeSyncSidecarLockPath;
        yield* edgeCatA.resolve(settings(), "/workspace");
        failReceiptReadWhileLockedPath = null;
        expect(injectedReceiptReadFailures).toBe(1);
        // Before catalog B commits a newer rev, edgeCatA's in-process fallback uses pending --fail-2.
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* edgeCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--fail-2",
        ]);
        // Now catalog B commits rev 4 (--commit-b); edgeCatA's fallback must prefer committed --commit-b.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--commit-b"],
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatB.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* edgeCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--commit-b",
        ]);
        // 4) Lock timeout preserves pending base rev 7; retrying with unreadable sidecars keeps
        //    base rev 7 so unchanged rev 7 does not override pending, while rev 8 still wins.
        failReceiptTempWrite = true;
        for (const arg of ["--s5", "--s6", "--s7"]) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* edgeCatB.invalidateIndex();
          yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* edgeCatB.resolve(settings(), "/workspace");
        }
        failReceiptTempWrite = false;
        const lockTimeoutCat = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: edgeSyncDir,
          toolsDir: edgeSyncToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* fileSystem.writeFileString(edgeSyncSidecarLockPath, "external-holder");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--lock-c"],
        });
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        let nextLockStat = yield* Deferred.make<void>();
        onStatPath = {
          matchPath: edgeSyncSidecarLockPath,
          onHit: () => {
            Deferred.doneUnsafe(nextLockStat, Exit.void);
          },
        };
        const lockTimeoutFiber = yield* lockTimeoutCat
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        for (let step = 0; step < 20; step += 1) {
          yield* Deferred.await(nextLockStat);
          nextLockStat = yield* Deferred.make<void>();
          yield* TestClock.adjust("100 millis");
        }
        onStatPath = null;
        yield* Fiber.join(lockTimeoutFiber);
        yield* fileSystem.remove(edgeSyncSidecarLockPath, { force: true });
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* lockTimeoutCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--lock-c",
        ]);
        // Retry with unreadable sidecar keeps baseDurableRevision=7 (not downgraded to receipt rev 4)
        // across sidecar io_error, locked receipt reread failure, and a second lock timeout.
        failSidecarRead = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--lock-c-retry"],
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* lockTimeoutCat.resolve(settings(), "/workspace");
        failSidecarRead = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* lockTimeoutCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--lock-c-retry",
        ]);
        // Locked receipt reread error while sidecar is unreadable also preserves base rev 7.
        injectedReceiptReadFailures = 0;
        failSidecarRead = true;
        failReceiptReadWhileLockedPath = edgeSyncSidecarLockPath;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--lock-c-reread"],
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* lockTimeoutCat.resolve(settings(), "/workspace");
        failReceiptReadWhileLockedPath = null;
        failSidecarRead = false;
        expect(injectedReceiptReadFailures).toBe(1);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* lockTimeoutCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--lock-c-reread",
        ]);
        // A second lock timeout while sidecar is unreadable also preserves base rev 7.
        failSidecarRead = true;
        yield* fileSystem.writeFileString(edgeSyncSidecarLockPath, "external-holder-2");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--lock-c-timeout2"],
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        let nextLockStat2 = yield* Deferred.make<void>();
        onStatPath = {
          matchPath: edgeSyncSidecarLockPath,
          onHit: () => {
            Deferred.doneUnsafe(nextLockStat2, Exit.void);
          },
        };
        const lockTimeoutFiber2 = yield* lockTimeoutCat
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        for (let step = 0; step < 20; step += 1) {
          yield* Deferred.await(nextLockStat2);
          nextLockStat2 = yield* Deferred.make<void>();
          yield* TestClock.adjust("100 millis");
        }
        onStatPath = null;
        yield* Fiber.join(lockTimeoutFiber2);
        yield* fileSystem.remove(edgeSyncSidecarLockPath, { force: true });
        failSidecarRead = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* lockTimeoutCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--lock-c-timeout2",
        ]);
        // Corrupt sidecar repaired by a fresh catalog (via sidecar OR receipt OR matching receipt)
        // must outrank older higher-base pending entries via launchOptionsRecoveryId / receipt rev.
        const savedSidecarBeforeCorrupt = yield* fileSystem.readFileString(edgeSyncSidecarPath);
        const makeEdgePendingCat = () =>
          AcpRegistrySupport.makeAcpRegistryCatalog({
            cacheDir: edgeSyncDir,
            toolsDir: edgeSyncToolsDir,
            registryUrl,
          }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const staleSidecarCat = yield* makeEdgePendingCat();
        const staleSidecarNormalCat = yield* makeEdgePendingCat();
        const staleReceiptCat = yield* makeEdgePendingCat();
        const freshRepairCat = yield* makeEdgePendingCat();
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        for (const [cat, arg] of [
          [staleSidecarCat, "--stale-sidecar-pending"],
          [staleSidecarNormalCat, "--stale-sidecar-normal"],
          [staleReceiptCat, "--stale-receipt-pending"],
        ] as const) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* cat.invalidateIndex();
          yield* cat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* cat.resolve(settings(), "/workspace");
        }
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        // (i) Sidecar repair (rev 5 < pending base 7) and subsequent normal write (rev 6 < 7).
        yield* fileSystem.writeFileString(edgeSyncSidecarPath, "{corrupt-sidecar");
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fresh-b-sidecar-repair"],
        });
        yield* freshRepairCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* freshRepairCat.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* staleSidecarCat.invalidateIndex();
        yield* staleSidecarCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* staleSidecarCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--fresh-b-sidecar-repair",
        ]);
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fresh-b-sidecar-rev6"],
        });
        yield* freshRepairCat.invalidateIndex();
        yield* freshRepairCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* freshRepairCat.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* staleSidecarNormalCat.invalidateIndex();
        yield* staleSidecarNormalCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* staleSidecarNormalCat.resolve(settings(), "/workspace")).spawn.args).toEqual(
          ["--fresh-b-sidecar-rev6"],
        );
        // (ii) Receipt repair (rev 5 < pending base 7) and matching-receipt repair on corrupt file.
        yield* fileSystem.writeFileString(edgeSyncSidecarPath, "{corrupt-sidecar");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fresh-b-receipt-repair"],
        });
        yield* freshRepairCat.invalidateIndex();
        yield* freshRepairCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const freshReceiptResolved = yield* freshRepairCat.resolve(settings(), "/workspace");
        const edgeReceiptPath = path.join(
          path.dirname(path.dirname(freshReceiptResolved.spawn.command)),
          ".t3-artifact.json",
        );
        const afterReceiptRepair = JSON.parse(
          yield* fileSystem.readFileString(edgeReceiptPath),
        ) as { readonly launchOptionsRevision?: number };
        expect(afterReceiptRepair.launchOptionsRevision).toBe(5);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* staleReceiptCat.invalidateIndex();
        yield* staleReceiptCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* staleReceiptCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--fresh-b-receipt-repair",
        ]);
        yield* fileSystem.writeFileString(edgeSyncSidecarPath, "{corrupt-sidecar-match");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fresh-b-receipt-repair"],
        });
        yield* freshRepairCat.invalidateIndex();
        yield* freshRepairCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* freshRepairCat.resolve(settings(), "/workspace");
        const afterMatchRepair = JSON.parse(yield* fileSystem.readFileString(edgeReceiptPath)) as {
          readonly launchOptionsRevision?: number;
        };
        expect(afterMatchRepair.launchOptionsRevision).toBe(6);
        // Corrupt sidecar while lockTimeoutCat holds pending base rev 7 must allocate rev 8 (> 7).
        yield* fileSystem.writeFileString(edgeSyncSidecarPath, "{corrupt-sidecar");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--after-corrupt-rev8"],
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* lockTimeoutCat.resolve(settings(), "/workspace");
        const afterCorruptReceipt = JSON.parse(
          yield* fileSystem.readFileString(edgeReceiptPath),
        ) as { readonly launchOptionsRevision?: number };
        expect(afterCorruptReceipt.launchOptionsRevision).toBe(8);
        // Restore sidecar at rev 7 (lower than rev 8) and confirm rev 8 receipt wins cleanly.
        yield* fileSystem.writeFileString(edgeSyncSidecarPath, savedSidecarBeforeCorrupt);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* lockTimeoutCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--after-corrupt-rev8",
        ]);
        // A newer committed rev 9 (--commit-8) still outranks everything cleanly.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--commit-8"],
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatB.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* lockTimeoutCat.invalidateIndex();
        yield* lockTimeoutCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* lockTimeoutCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--commit-8",
        ]);
        // Fresh catalog (no pending entry) that observes sidecar rev 10 on the fast path, then
        // encounters a corrupt sidecar under the lock, allocates rev 11 (> observedDiskRev 10).
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--sidecar-rev10"],
        });
        yield* edgeCatB.invalidateIndex();
        yield* edgeCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        const observedRevCat = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: edgeSyncDir,
          toolsDir: edgeSyncToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--commit-8"],
        });
        yield* observedRevCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        corruptSidecarWhileLockedPath = edgeSyncSidecarLockPath;
        yield* observedRevCat.resolve(settings(), "/workspace");
        corruptSidecarWhileLockedPath = null;
        const afterObservedRev = JSON.parse(yield* fileSystem.readFileString(edgeReceiptPath)) as {
          readonly launchOptionsRevision?: number;
        };
        expect(afterObservedRev.launchOptionsRevision).toBe(11);

        // (e) Recovery-ID edge cases: unreadable/corrupt sidecar fallback keeps pending options
        //     after a sidecar repair, unreadable-sidecar retries preserve the recovery ID, another
        //     slot's or uninstall's corrupt repair invalidates stale pending options, and receipt
        //     advances never pair stale pre-repair revisions with post-repair observations.
        const recoveryEdgeDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-recovery-edge-",
        });
        const recoveryEdgeToolsDir = path.join(recoveryEdgeDir, "tools");
        const recoveryEdgeSidecarPath = path.join(
          recoveryEdgeDir,
          "acp-registry",
          "binary-launch-options.json",
        );
        const recoveryEdgeLockPath = `${recoveryEdgeSidecarPath}.lock`;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--init"],
        });
        const recCatA = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: recoveryEdgeDir,
          toolsDir: recoveryEdgeToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* recCatA.resolve(settings(), "/workspace");
        // 1) Corrupt sidecar repaired via sidecar gets a recovery ID; pending options recorded over
        //    it must survive unreadable or corrupt sidecar fallbacks instead of reverting to --init.
        failReceiptTempWrite = true;
        yield* fileSystem.writeFileString(recoveryEdgeSidecarPath, "{corrupt-rec");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--repaired"],
        });
        yield* recCatA.invalidateIndex();
        yield* recCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* recCatA.resolve(settings(), "/workspace");
        const savedRepairedSidecar = yield* fileSystem.readFileString(recoveryEdgeSidecarPath);
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--pending"],
        });
        yield* recCatA.invalidateIndex();
        yield* recCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* recCatA.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* recCatA.invalidateIndex();
        yield* recCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* recCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--pending",
        ]);
        failSidecarRead = true;
        expect((yield* recCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--pending",
        ]);
        failSidecarRead = false;
        yield* fileSystem.writeFileString(recoveryEdgeSidecarPath, "{corrupt-after-pending");
        expect((yield* recCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--pending",
        ]);
        // 2) Fast-path observation of a repaired sidecar's recovery ID survives locked io_error,
        //    subsequent both-unreadable io_error retries, and locked receipt reread errors; a
        //    corrupt+matching-receipt sync when both writes fail clears stale pending options.
        yield* fileSystem.writeFileString(recoveryEdgeSidecarPath, savedRepairedSidecar);
        const ioChainCat = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: recoveryEdgeDir,
          toolsDir: recoveryEdgeToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--fast-path-io"],
        });
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        failSidecarReadWhileLockedPath = recoveryEdgeLockPath;
        yield* ioChainCat.resolve(settings(), "/workspace");
        failSidecarReadWhileLockedPath = null;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* ioChainCat.invalidateIndex();
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* ioChainCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--fast-path-io",
        ]);
        failSidecarRead = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--both-io-retry"],
        });
        yield* ioChainCat.invalidateIndex();
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* ioChainCat.resolve(settings(), "/workspace");
        injectedReceiptReadFailures = 0;
        failReceiptReadWhileLockedPath = recoveryEdgeLockPath;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--reread-io-retry"],
        });
        yield* ioChainCat.invalidateIndex();
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* ioChainCat.resolve(settings(), "/workspace");
        failReceiptReadWhileLockedPath = null;
        failSidecarRead = false;
        expect(injectedReceiptReadFailures).toBe(1);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* ioChainCat.invalidateIndex();
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* ioChainCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--reread-io-retry",
        ]);
        yield* fileSystem.writeFileString(recoveryEdgeSidecarPath, "{corrupt-match-both-fail");
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--init"],
        });
        yield* ioChainCat.invalidateIndex();
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* ioChainCat.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* ioChainCat.invalidateIndex();
        yield* ioChainCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* ioChainCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--init",
        ]);

        // 3) Corrupt sidecar repaired by a DIFFERENT agent (or uninstall) wipes example-agent's
        //    entry; catalog B's rev-1 write gets a fresh recovery ID and beats catalog A's pending.
        const otherSlotDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-other-slot-repair-",
        });
        const otherSlotToolsDir = path.join(otherSlotDir, "tools");
        const otherSlotSidecarPath = path.join(
          otherSlotDir,
          "acp-registry",
          "binary-launch-options.json",
        );
        const otherSettings = () => settings({ agentId: "other-agent" });
        const makeOtherBinary = (version: string, args?: ReadonlyArray<string>) => ({
          ...makeBinary(version, {
            archive: archiveBUrl,
            cmd: "./bin/other-agent",
            ...(args ? { args } : {}),
          }),
          id: "other-agent",
          name: "Other Agent",
        });
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--init"],
        });
        extraUpstream = makeOtherBinary("1.0.0", ["--other-init"]);
        const otherCatA = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: otherSlotDir,
          toolsDir: otherSlotToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const otherCatB = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: otherSlotDir,
          toolsDir: otherSlotToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        yield* otherCatA.resolve(settings(), "/workspace");
        yield* otherCatA.resolve(otherSettings(), "/workspace");
        failReceiptTempWrite = true;
        for (const arg of ["--a1", "--a2", "--a3"]) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* otherCatA.invalidateIndex();
          yield* otherCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* otherCatA.resolve(settings(), "/workspace");
        }
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-pending"],
        });
        yield* otherCatA.invalidateIndex();
        yield* otherCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* otherCatA.resolve(settings(), "/workspace");
        failSidecarWrite = false;
        // Sidecar corrupts; catalog B repairs it while syncing other-agent, wiping example-agent.
        yield* fileSystem.writeFileString(otherSlotSidecarPath, "{corrupt-other-slot");
        extraUpstream = makeOtherBinary("1.0.0", ["--other-repair"]);
        yield* otherCatB.invalidateIndex();
        yield* otherCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* otherCatB.resolve(otherSettings(), "/workspace");
        expect(yield* fileSystem.readFileString(`${otherSlotSidecarPath}.corrupt`)).toBe(
          "{corrupt-other-slot",
        );
        const repairedByOtherEntries = JSON.parse(
          yield* fileSystem.readFileString(otherSlotSidecarPath),
        ) as Record<string, { readonly args?: ReadonlyArray<string> }>;
        expect(
          Object.keys(repairedByOtherEntries).every((key) => key.includes("other-agent")),
        ).toBe(true);
        expect(Object.values(repairedByOtherEntries).map((entry) => entry.args)).toEqual([
          ["--other-repair"],
        ]);
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--b-newer"],
        });
        yield* otherCatB.invalidateIndex();
        yield* otherCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* otherCatB.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* otherCatA.invalidateIndex();
        yield* otherCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* otherCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--b-newer",
        ]);
        // Same check when uninstall of other-agent repairs the corrupt sidecar.
        for (const arg of ["--a4", "--a5"]) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* otherCatA.invalidateIndex();
          yield* otherCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* otherCatA.resolve(settings(), "/workspace");
        }
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-pending2"],
        });
        yield* otherCatA.invalidateIndex();
        yield* otherCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* otherCatA.resolve(settings(), "/workspace");
        failSidecarWrite = false;
        yield* fileSystem.writeFileString(otherSlotSidecarPath, "{corrupt-uninstall-repair");
        yield* otherCatB.uninstallManagedBinary({ agentId: "other-agent" });
        expect(yield* fileSystem.readFileString(`${otherSlotSidecarPath}.corrupt`)).toBe(
          "{corrupt-uninstall-repair",
        );
        expect(JSON.parse(yield* fileSystem.readFileString(otherSlotSidecarPath))).toEqual({});
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--b-after-uninstall"],
        });
        yield* otherCatB.invalidateIndex();
        yield* otherCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* otherCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* otherCatA.invalidateIndex();
        yield* otherCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* otherCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--b-after-uninstall",
        ]);
        extraUpstream = null;

        // 4) When another catalog advances the receipt after a corrupt sidecar and writes a newer
        //    sidecar, an unreadable-sidecar retry (and locked receipt reread) in catalog A must
        //    NOT carry stale pre-repair baseDurableRevision; same-chain newer sidecar writes beat
        //    and retire pending options, and a receipt advance resets lockedPendingBase cleanly.
        const obsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-obs-pair-",
        });
        const obsToolsDir = path.join(obsDir, "tools");
        const obsSidecarPath = path.join(obsDir, "acp-registry", "binary-launch-options.json");
        const obsLockPath = `${obsSidecarPath}.lock`;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--init"],
        });
        const makeObsCat = () =>
          AcpRegistrySupport.makeAcpRegistryCatalog({
            cacheDir: obsDir,
            toolsDir: obsToolsDir,
            registryUrl,
          }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const obsCatA = yield* makeObsCat();
        const obsCatA2 = yield* makeObsCat();
        const obsCatB = yield* makeObsCat();
        yield* obsCatA.resolve(settings(), "/workspace");
        // Same-chain newer sidecar write beats and retires catalog A's pending entry (so a later
        // unreadable sidecar cannot resurrect the retired pending entry).
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--same-chain-1"],
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatA.resolve(settings(), "/workspace");
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-stale-same-chain"],
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatA.resolve(settings(), "/workspace");
        failSidecarWrite = false;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--b-newer-same-chain"],
        });
        yield* obsCatB.invalidateIndex();
        yield* obsCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* obsCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--b-newer-same-chain",
        ]);
        failSidecarRead = true;
        expect((yield* obsCatA.resolve(settings(), "/workspace")).spawn.args).toEqual(["--init"]);
        failSidecarRead = false;
        // Receipt advance pruning the sidecar resets lockedPendingBase when both writes later fail.
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-before-r-prune"],
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatA.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--r1"],
        });
        yield* obsCatB.invalidateIndex();
        yield* obsCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-after-r-prune"],
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatA.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* obsCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--a-after-r-prune",
        ]);
        // Build sidecar revs on top of receipt rev 3, record pending on BOTH obsCatA and obsCatA2,
        // then let B repair receipt + write a lower-rev sidecar; test io_error and receipt reread.
        failReceiptTempWrite = true;
        for (const arg of ["--s2", "--s3", "--s4"]) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* obsCatA.invalidateIndex();
          yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* obsCatA.resolve(settings(), "/workspace");
        }
        failSidecarWrite = true;
        for (const [cat, arg] of [
          [obsCatA, "--a-old"],
          [obsCatA2, "--a-old-2"],
        ] as const) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* cat.invalidateIndex();
          yield* cat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* cat.resolve(settings(), "/workspace");
        }
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        // Corrupt sidecar; B repairs receipt to rev 4 and writes sidecar rev 5 (< A's old base 6).
        yield* fileSystem.writeFileString(obsSidecarPath, "{corrupt-obs");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--b-r2"],
        });
        yield* obsCatB.invalidateIndex();
        yield* obsCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--b-s3"],
        });
        yield* obsCatB.invalidateIndex();
        yield* obsCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        // (i) Locked sidecar io_error path on obsCatA: verify pending is recorded while unreadable,
        //     then superseded by --b-s3 once sidecar reads recover.
        failSidecarRead = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-io-after-r2"],
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatA.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* obsCatA.invalidateIndex();
        yield* obsCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* obsCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--a-io-after-r2",
        ]);
        failSidecarRead = false;
        expect((yield* obsCatA.resolve(settings(), "/workspace")).spawn.args).toEqual(["--b-s3"]);
        // (ii) Locked receipt-reread path on obsCatA2: verify fault count, pending recording while
        //      unreadable, and --b-s3 once sidecar reads recover.
        failSidecarRead = true;
        injectedReceiptReadFailures = 0;
        failReceiptReadWhileLockedPath = obsLockPath;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--a-reread-after-r2"],
        });
        yield* obsCatA2.invalidateIndex();
        yield* obsCatA2.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* obsCatA2.resolve(settings(), "/workspace");
        failReceiptReadWhileLockedPath = null;
        expect(injectedReceiptReadFailures).toBe(1);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* obsCatA2.invalidateIndex();
        yield* obsCatA2.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* obsCatA2.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--a-reread-after-r2",
        ]);
        failSidecarRead = false;
        expect((yield* obsCatA2.resolve(settings(), "/workspace")).spawn.args).toEqual(["--b-s3"]);

        // (f) Cross-chain sidecar repair: fallback retires old-chain pending on recovery-ID
        //     mismatch, and retries on the new chain (both locked write failure and fast-path ok +
        //     locked io_error) adopt the new chain's revision and recovery ID without old-chain base.
        const xcDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-cross-chain-",
        });
        const xcToolsDir = path.join(xcDir, "tools");
        const xcSidecarPath = path.join(xcDir, "acp-registry", "binary-launch-options.json");
        const xcLockPath = `${xcSidecarPath}.lock`;
        const makeXcCat = () =>
          AcpRegistrySupport.makeAcpRegistryCatalog({
            cacheDir: xcDir,
            toolsDir: xcToolsDir,
            registryUrl,
          }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const xcCatB = yield* makeXcCat();
        const xcRetireCat = yield* makeXcCat();
        const xcLockedCat = yield* makeXcCat();
        const xcUnreadableCat = yield* makeXcCat();
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--xc-init"],
        });
        yield* xcCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = true;
        for (const arg of ["--xc-y1", "--xc-y2", "--xc-y3", "--xc-y4"]) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* xcCatB.invalidateIndex();
          yield* xcCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* xcCatB.resolve(settings(), "/workspace");
        }
        failSidecarWrite = true;
        for (const [cat, arg] of [
          [xcRetireCat, "--xc-stale-retire"],
          [xcLockedCat, "--xc-stale-locked"],
          [xcUnreadableCat, "--xc-stale-unreadable"],
        ] as const) {
          upstream = makeBinary("1.0.0", {
            archive: archiveAUrl,
            cmd: "./bin/example-agent",
            args: [arg],
          });
          yield* cat.invalidateIndex();
          yield* cat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          yield* cat.resolve(settings(), "/workspace");
        }
        failSidecarWrite = false;
        // Prove old-chain pending options are active on all three catalogs while chain Y is readable.
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        for (const [cat, arg] of [
          [xcRetireCat, "--xc-stale-retire"],
          [xcLockedCat, "--xc-stale-locked"],
          [xcUnreadableCat, "--xc-stale-unreadable"],
        ] as const) {
          yield* cat.invalidateIndex();
          yield* cat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
          expect((yield* cat.resolve(settings(), "/workspace")).spawn.args).toEqual([arg]);
        }
        // Corrupt sidecar and repair into chain Z at rev 1 (< old chain Y base rev 4).
        yield* fileSystem.writeFileString(xcSidecarPath, "{corrupt-xc");
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--xc-b-z1"],
        });
        yield* xcCatB.invalidateIndex();
        yield* xcCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* xcCatB.resolve(settings(), "/workspace");
        // Retire-chain variant: recovery-ID mismatch retires stale pending so unreadable fallback
        // cannot resurrect --xc-stale-retire.
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* xcRetireCat.invalidateIndex();
        yield* xcRetireCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* xcRetireCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--xc-b-z1",
        ]);
        failSidecarRead = true;
        expect((yield* xcRetireCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--xc-init",
        ]);
        failSidecarRead = false;
        // Locked-write-failure and fast-path-ok/locked-io_error retries adopt chain Z (rev 1, Z).
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--xc-a-locked-on-z"],
        });
        yield* xcLockedCat.invalidateIndex();
        yield* xcLockedCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* xcLockedCat.resolve(settings(), "/workspace");
        failSidecarWrite = false;
        failSidecarReadWhileLockedPath = xcLockPath;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--xc-a-unreadable-on-z"],
        });
        yield* xcUnreadableCat.invalidateIndex();
        yield* xcUnreadableCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* xcUnreadableCat.resolve(settings(), "/workspace");
        failSidecarReadWhileLockedPath = null;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* xcLockedCat.invalidateIndex();
        yield* xcLockedCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* xcLockedCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--xc-a-locked-on-z",
        ]);
        yield* xcUnreadableCat.invalidateIndex();
        yield* xcUnreadableCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* xcUnreadableCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--xc-a-unreadable-on-z",
        ]);
        // B writes chain Z rev 2 (< old chain Y rev 4) -> beats both catalogs' rev-1 pending entries.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--xc-b-z2"],
        });
        yield* xcCatB.invalidateIndex();
        yield* xcCatB.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* xcCatB.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* xcLockedCat.invalidateIndex();
        yield* xcLockedCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* xcLockedCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--xc-b-z2",
        ]);
        yield* xcUnreadableCat.invalidateIndex();
        yield* xcUnreadableCat.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* xcUnreadableCat.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--xc-b-z2",
        ]);
        // Restore upstream to --commit-8 before step 5 below.
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--commit-8"],
        });
        // 5) Fast-path hasMatchingPending gating: reverting to matching receipt --commit-8 clears
        //    earlier pending options instead of short-circuiting and leaving them active.
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--pending-stale"],
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatA.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        upstream = makeBinary("1.0.0", {
          archive: archiveAUrl,
          cmd: "./bin/example-agent",
          args: ["--commit-8"],
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* edgeCatA.resolve(settings(), "/workspace");
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* edgeCatA.invalidateIndex();
        yield* edgeCatA.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* edgeCatA.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--commit-8",
        ]);

        // 3. A superseded primary executable that lost execute permission must not fail inspect()
        // when the registry selects a different same-version artifact.
        yield* posixModeFs.chmod(reinstalledA.spawn.command, 0o644);
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
        });
        yield* afterRevertCatalog.invalidateIndex();
        yield* afterRevertCatalog.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect(yield* afterRevertCatalog.inspect(settings())).toMatchObject({
          status: "ready",
          version: "1.0.0",
        });
        const installedB = yield* afterRevertCatalog.resolve(settings(), "/workspace");
        expect(installedB.spawn.command).not.toBe(reinstalledA.spawn.command);
        expect(yield* fileSystem.readFileString(installedB.spawn.command)).toBe(
          "#!/bin/sh\necho receipt-b\n",
        );

        // 4. Waiting on a busy install lock is interruptible during sleep instead of blocking 30s.
        const lockDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-lock-interrupt-",
        });
        const versionDir = path.join(lockDir, "tools", "example-agent", "1.0.0");
        yield* fileSystem.makeDirectory(versionDir, { recursive: true });
        const lockFile = path.join(versionDir, "linux-x86_64.lock");
        yield* fileSystem.writeFileString(lockFile, "other-holder-token");
        const lockResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: lockDir,
          toolsDir: path.join(lockDir, "tools"),
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, posixModeFs));
        const lockFirstStat = yield* Deferred.make<void>();
        const lockSecondStat = yield* Deferred.make<void>();
        let lockStatHits = 0;
        onStatPath = {
          matchPath: lockFile,
          onHit: () => {
            lockStatHits += 1;
            if (lockStatHits === 1) {
              Deferred.doneUnsafe(lockFirstStat, Exit.void);
            } else if (lockStatHits === 2) {
              Deferred.doneUnsafe(lockSecondStat, Exit.void);
            }
          },
        };
        const waitingPrepare = yield* lockResolver
          .prepare({ agentId: "example-agent" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(lockFirstStat);
        yield* TestClock.adjust("100 millis");
        yield* Deferred.await(lockSecondStat);
        onStatPath = null;
        expect(waitingPrepare.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(waitingPrepare);
        // Interrupting while waiting must leave the other holder's lock intact.
        expect(yield* fileSystem.readFileString(lockFile)).toBe("other-holder-token");

        // 5. A stale lock holder neither overwrites a newer holder's baselines or launch-options
        // sidecar nor deletes the newer holder's lock file on release (for both refresh & uninstall).
        const fenceDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-baseline-fence-",
        });
        const fenceRegistryDir = path.join(fenceDir, "acp-registry");
        const fenceRegistryPath = path.join(fenceRegistryDir, "registry.json");
        const fenceBaselinesPath = path.join(fenceRegistryDir, "legacy-baselines.json");
        const fenceLockPath = `${fenceBaselinesPath}.lock`;
        const fenceSidecarPath = path.join(fenceRegistryDir, "binary-launch-options.json");
        const fenceSidecarLockPath = `${fenceSidecarPath}.lock`;
        const fenceToolsDir = path.join(fenceDir, "tools");
        const fenceLegacyExe = path.join(
          fenceToolsDir,
          "example-agent",
          "1.0.0",
          "linux-x86_64",
          "bin",
          "example-agent",
        );
        yield* fileSystem.makeDirectory(path.dirname(fenceLegacyExe), { recursive: true });
        yield* fileSystem.writeFileString(fenceLegacyExe, "#!/bin/sh\necho legacy-a\n");
        yield* posixModeFs.chmod(fenceLegacyExe, 0o755);
        yield* fileSystem.makeDirectory(fenceRegistryDir, { recursive: true });
        yield* fileSystem.writeFileString(
          fenceRegistryPath,
          makeRegistry(makeBinary("1.0.0", { archive: archiveAUrl, cmd: "./bin/example-agent" })),
        );
        const holder1Entered = yield* Deferred.make<void>();
        const releaseHolder1 = yield* Deferred.make<void>();
        let gatedHolder1 = true;
        let baselinesReadCount = 0;
        let sidecarFenceGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
          readonly requireLocked?: boolean;
        } | null = null;
        let uninstallFenceGate: {
          readonly entered: Deferred.Deferred<void>;
          readonly release: Deferred.Deferred<void>;
        } | null = null;
        const fencedFs: FileSystem.FileSystem = {
          ...posixModeFs,
          readFileString: (filePath, encoding) => {
            if (gatedHolder1 && filePath === fenceBaselinesPath) {
              baselinesReadCount += 1;
              if (baselinesReadCount === 2) {
                gatedHolder1 = false;
                return Deferred.succeed(holder1Entered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseHolder1)),
                  Effect.andThen(posixModeFs.readFileString(filePath, encoding)),
                );
              }
            }
            if (uninstallFenceGate !== null && filePath === fenceBaselinesPath) {
              const gate = uninstallFenceGate;
              uninstallFenceGate = null;
              return Deferred.succeed(gate.entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
                Effect.andThen(posixModeFs.readFileString(filePath, encoding)),
              );
            }
            if (sidecarFenceGate !== null && filePath === fenceSidecarPath) {
              const gate = sidecarFenceGate;
              if (gate.requireLocked === true) {
                return fileSystem.exists(fenceSidecarLockPath).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((locked) => {
                    if (!locked || sidecarFenceGate !== gate) {
                      return posixModeFs.readFileString(filePath, encoding);
                    }
                    sidecarFenceGate = null;
                    return Deferred.succeed(gate.entered, undefined).pipe(
                      Effect.andThen(Deferred.await(gate.release)),
                      Effect.andThen(posixModeFs.readFileString(filePath, encoding)),
                    );
                  }),
                );
              }
              sidecarFenceGate = null;
              return Deferred.succeed(gate.entered, undefined).pipe(
                Effect.andThen(Deferred.await(gate.release)),
                Effect.andThen(posixModeFs.readFileString(filePath, encoding)),
              );
            }
            return posixModeFs.readFileString(filePath, encoding);
          },
        };
        upstream = makeBinary("1.0.0", { archive: archiveBUrl, cmd: "./bin/example-agent" });
        const holder1 = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir: fenceDir,
          toolsDir: fenceToolsDir,
          registryUrl,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fencedFs));
        const holder1Refresh = yield* holder1
          .refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(holder1Entered);
        // Simulate another holder taking over the stale lock and writing its own baseline map.
        yield* fileSystem.writeFileString(fenceLockPath, "holder-2-token");
        yield* fileSystem.writeFileString(
          fenceBaselinesPath,
          JSON.stringify({ "keep-agent\u00001.0.0\u0000linux-x86_64": "holder-2-value" }),
        );
        yield* Deferred.succeed(releaseHolder1, undefined);
        yield* Fiber.join(holder1Refresh);
        expect(yield* fileSystem.readFileString(fenceLockPath)).toBe("holder-2-token");
        expect(JSON.parse(yield* fileSystem.readFileString(fenceBaselinesPath))).toEqual({
          "keep-agent\u00001.0.0\u0000linux-x86_64": "holder-2-value",
        });

        // Sidecar lock-ownership fence: losing the lock leaves holder-2 intact while recording
        // pending options in memory, and reverting to the matching receipt clears stale pending
        // options even if the prune loses the lock.
        yield* fileSystem.remove(fenceLockPath, { force: true });
        const fenceInstalledB = yield* holder1.resolve(settings(), "/workspace");
        const fenceSlotRoot = path.dirname(path.dirname(fenceInstalledB.spawn.command));
        failReceiptTempWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
          args: ["--fenced-sidecar"],
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const sidecarHolder1Entered = yield* Deferred.make<void>();
        const releaseSidecarHolder1 = yield* Deferred.make<void>();
        sidecarFenceGate = { entered: sidecarHolder1Entered, release: releaseSidecarHolder1 };
        const fencedSidecarResolve = yield* holder1
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(sidecarHolder1Entered);
        yield* fileSystem.writeFileString(fenceSidecarLockPath, "sidecar-holder-2");
        yield* fileSystem.writeFileString(
          fenceSidecarPath,
          JSON.stringify({
            "keep-slot": {
              version: "1.0.0",
              archive: archiveAUrl,
              cmd: "./bin/keep",
              sha256: null,
              args: ["--holder-2"],
              launchOptionsRevision: 1,
            },
          }),
        );
        yield* Deferred.succeed(releaseSidecarHolder1, undefined);
        yield* Fiber.join(fencedSidecarResolve);
        failReceiptTempWrite = false;
        expect(yield* fileSystem.readFileString(fenceSidecarLockPath)).toBe("sidecar-holder-2");
        expect(
          Object.keys(JSON.parse(yield* fileSystem.readFileString(fenceSidecarPath)) as object),
        ).toEqual(["keep-slot"]);
        // Verify lock-lost resolve recorded pending --fenced-sidecar for in-process fallback.
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* holder1.resolve(settings(), "/workspace")).spawn.args).toEqual([
          "--fenced-sidecar",
        ]);
        // Reverting to the receipt's no-args target clears stale pending options even on lock loss
        // (for both stale rev-0 sidecar entries and corrupt sidecar files).
        yield* fileSystem.remove(fenceSidecarLockPath, { force: true });
        yield* fileSystem.writeFileString(
          fenceSidecarPath,
          JSON.stringify({
            [fenceSlotRoot]: {
              version: "1.0.0",
              archive: archiveBUrl,
              cmd: "./bin/example-agent",
              sha256: null,
              args: ["--stale-rev0"],
              launchOptionsRevision: 0,
            },
          }),
        );
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const revertEntered = yield* Deferred.make<void>();
        const releaseRevert = yield* Deferred.make<void>();
        sidecarFenceGate = {
          entered: revertEntered,
          release: releaseRevert,
          requireLocked: true,
        };
        const fencedRevertResolve = yield* holder1
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(revertEntered);
        yield* fileSystem.writeFileString(fenceSidecarLockPath, "sidecar-holder-3");
        yield* Deferred.succeed(releaseRevert, undefined);
        yield* Fiber.join(fencedRevertResolve);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* holder1.resolve(settings(), "/workspace")).spawn.args).toEqual([]);
        // Same lock-lost revert check on a corrupt sidecar file.
        yield* fileSystem.remove(fenceSidecarLockPath, { force: true });
        failReceiptTempWrite = true;
        failSidecarWrite = true;
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
          args: ["--fenced-before-corrupt"],
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        yield* holder1.resolve(settings(), "/workspace");
        failReceiptTempWrite = false;
        failSidecarWrite = false;
        yield* fileSystem.writeFileString(fenceSidecarPath, "{corrupt-fence");
        upstream = makeBinary("1.0.0", {
          archive: archiveBUrl,
          cmd: "./bin/example-agent",
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        const corruptRevertEntered = yield* Deferred.make<void>();
        const releaseCorruptRevert = yield* Deferred.make<void>();
        sidecarFenceGate = {
          entered: corruptRevertEntered,
          release: releaseCorruptRevert,
          requireLocked: true,
        };
        const fencedCorruptRevert = yield* holder1
          .resolve(settings(), "/workspace")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(corruptRevertEntered);
        yield* fileSystem.writeFileString(fenceSidecarLockPath, "sidecar-holder-4");
        yield* Deferred.succeed(releaseCorruptRevert, undefined);
        yield* Fiber.join(fencedCorruptRevert);
        upstream = makeBinary("2.0.0", {
          archive: archiveFailUrl,
          cmd: "./bin/example-agent",
        });
        yield* holder1.invalidateIndex();
        yield* holder1.refreshIndex({ maxAgeMs: 0, failureBackoffMs: 0 });
        expect((yield* holder1.resolve(settings(), "/workspace")).spawn.args).toEqual([]);

        // Uninstall baselines prune lock-ownership fence: losing the lock leaves holder-2 intact.
        yield* fileSystem.remove(fenceSidecarLockPath, { force: true });
        yield* fileSystem.writeFileString(
          fenceBaselinesPath,
          JSON.stringify({
            "example-agent\u00001.0.0\u0000linux-x86_64": "stale-value",
            "keep-agent\u00001.0.0\u0000linux-x86_64": "holder-2-value",
          }),
        );
        const uninstallEntered = yield* Deferred.make<void>();
        const releaseUninstall = yield* Deferred.make<void>();
        uninstallFenceGate = { entered: uninstallEntered, release: releaseUninstall };
        const fencedUninstall = yield* holder1
          .uninstallManagedBinary({ agentId: "example-agent" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(uninstallEntered);
        yield* fileSystem.writeFileString(fenceLockPath, "uninstall-holder-2");
        yield* fileSystem.writeFileString(
          fenceBaselinesPath,
          JSON.stringify({
            "example-agent\u00001.0.0\u0000linux-x86_64": "holder-2-new-value",
            "keep-agent\u00001.0.0\u0000linux-x86_64": "holder-2-value",
          }),
        );
        yield* Deferred.succeed(releaseUninstall, undefined);
        yield* Fiber.join(fencedUninstall);
        expect(yield* fileSystem.readFileString(fenceLockPath)).toBe("uninstall-holder-2");
        expect(JSON.parse(yield* fileSystem.readFileString(fenceBaselinesPath))).toEqual({
          "example-agent\u00001.0.0\u0000linux-x86_64": "holder-2-new-value",
          "keep-agent\u00001.0.0\u0000linux-x86_64": "holder-2-value",
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    extraUpstream === null
                      ? makeRegistry(upstream)
                      : JSON.stringify({ version: "1.0.0", agents: [upstream, extraUpstream] }),
                  ),
                ),
              );
            }
            if (request.url === archiveFailUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
              );
            }
            const bytes = request.url === archiveAUrl ? bytesA : bytesB;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(bytes.buffer as ArrayBuffer)),
            );
          }),
        ),
      );
    },
  );
});

describe("acpRegistryManagedBinaryDirectories", () => {
  it.effect("lists managed package and binary command directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-bins-",
      });
      const install = (agent: string, version: string, target: string, commandDirectory = "") =>
        fileSystem.makeDirectory(
          path.join(cacheDir, "tools", agent, version, target, commandDirectory),
          { recursive: true },
        );
      yield* install("kimi", "1.49.0", "linux-x86_64", "bin");
      yield* install("kimi", "1.50.0", "linux-x86_64", "cmd");
      yield* install("kimi", "1.50.0", "darwin-aarch64");
      yield* install("other-agent", "0.2.0", "darwin-aarch64");
      const globalBin = path.join(cacheDir, "tools", "gemini", "0.56.0", "npm", "bin");
      const geminiCommand = path.join(globalBin, "gemini");
      const receiptsDirectory = path.join(cacheDir, "acp-registry", "package-installs");
      yield* fileSystem.makeDirectory(globalBin, { recursive: true });
      yield* fileSystem.makeDirectory(receiptsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(geminiCommand, "#!/bin/sh\n");
      yield* fileSystem.chmod(geminiCommand, 0o755);
      yield* fileSystem.writeFileString(
        path.join(receiptsDirectory, "gemini.json"),
        encodeUnknownJson({
          agentId: "gemini",
          agentVersion: "0.56.0",
          distribution: "npx",
          packageSpec: "@google/gemini-cli@0.56.0",
          managerPath: "/usr/bin/npm",
          binDirectory: globalBin,
          executablePath: geminiCommand,
          packageRoot: path.join(
            cacheDir,
            "tools",
            "gemini",
            "0.56.0",
            "npm",
            "lib",
            "node_modules",
            "@google",
            "gemini-cli",
          ),
          packageVersion: "0.56.0",
        }),
      );
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              ...makeAgent({
                binary: {
                  "linux-x86_64": { archive: archiveUrl, cmd: "bin/kimi" },
                },
              }),
              id: "kimi",
              name: "Kimi",
              version: "1.49.0",
            },
            {
              ...makeAgent({
                binary: {
                  "linux-x86_64": { archive: archiveUrl, cmd: "cmd/kimi" },
                },
              }),
              id: "kimi",
              name: "Kimi",
              version: "1.50.0",
            },
          ],
        }),
      );

      const directories = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
        cacheDir,
        toolsDir: path.join(cacheDir, "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(directories).toEqual([
        globalBin,
        path.join(cacheDir, "tools", "kimi", "1.50.0", "linux-x86_64", "cmd"),
        path.join(cacheDir, "tools", "kimi", "1.49.0", "linux-x86_64", "bin"),
      ]);

      const missing = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
        cacheDir: path.join(cacheDir, "does-not-exist"),
        toolsDir: path.join(cacheDir, "does-not-exist", "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(missing).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
