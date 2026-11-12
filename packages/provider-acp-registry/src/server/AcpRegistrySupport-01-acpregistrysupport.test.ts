import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
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
  return {
    environment: {
      ...process.env,
      PATH: `${toolchainBin}:${process.env.PATH ?? ""}`,
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
  return {
    environment: {
      ...process.env,
      PATH: `${toolchainBin}:${process.env.PATH ?? ""}`,
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
          Effect.provideService(SpawnExecutableResolution, () => `C:\\bin\\dsh${extension}`),
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
  it.effect("installs and reuses a registry binary in the managed cache", () => {
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    const agent = makeAgent({
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
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          const response =
            request.url === registryUrl
              ? new Response(makeRegistry(agent))
              : new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(binaryBytes.slice(0, 8));
                      controller.enqueue(binaryBytes.slice(8));
                      controller.close();
                    },
                  }),
                );
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
      ),
    );
  });
});

