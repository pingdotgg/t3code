import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { layerTestProviderHost, TestProviderHostSettings } from "@t3tools/provider-testing/host";

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
    layerTestProviderHost().pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessArchitecture, "x64"),
    Layer.succeed(HostProcessEnvironment, environment),
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
  it("preserves the registry failure when translating it for clients", () => {
    const cause = new Error("registry unavailable");
    const failure = new AcpRegistrySupport.AcpRegistryError({
      reason: "registry_unavailable",
      detail: "Could not load the ACP Registry.",
      cause,
    });

    expect(AcpRegistrySupport.toAcpRegistryOperationError(failure)).toMatchObject({
      reason: "registry_unavailable",
      message: "Could not load the ACP Registry.",
      cause: failure,
    });
  });

  it("maps supported Node platforms to ACP Registry target keys", () => {
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("darwin", "arm64")).toBe(
      "darwin-aarch64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("linux", "x64")).toBe(
      "linux-x86_64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("win32", "arm64")).toBe(
      "windows-aarch64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("freebsd", "x64")).toBeUndefined();
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("linux", "ia32")).toBeUndefined();
  });

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
      }).pipe(Effect.provideService(HostProcessEnvironment, hostEnvironment));
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
      }).pipe(Effect.provideService(HostProcessEnvironment, environment));
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
          Effect.provideService(HostProcessPlatform, "win32"),
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
      }).pipe(Effect.provideService(HostProcessEnvironment, toolchain.environment));

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
      }).pipe(Effect.provideService(HostProcessEnvironment, environment));

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

  it.effect("installs into T3 home a uv tool and launches its exposed command", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==V0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-global-uv-tool-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      const resolved = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--acp"],
        env: { PATH: expect.stringMatching(new RegExp(`^${toolchain.globalBin}:`, "u")) },
      });
      expect(yield* fileSystem.readFileString(toolchain.logPath)).toContain(
        "tool install --force fast-agent-acp==V0.10.1",
      );
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
        Effect.provideService(HostProcessPlatform, "win32"),
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
          // SHA-256 of binaryBytes.
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
            // SHA-256 of binaryBytes.
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
        }).pipe(Effect.provideService(HostProcessEnvironment, environment));
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

  it.effect("installs a tar archive containing a root directory entry", () => {
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
          layerTestProviderHost().pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessArchitecture, "x64"),
    );
  });

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

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-search-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "codex" });

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

  it.effect("refreshes explicit searches and coalesces concurrent refreshes", () => {
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

  it.effect("installs into T3 home package recipes during preparation", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3", args: ["--stdio"] } });
    const requests: string[] = [];

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcessEnvironment, toolchain.environment));
      const prepared = yield* resolver.prepare({ agentId: agent.id });
      expect(prepared).toEqual({
        agentId: "example-agent",
        version: "1.2.3",
        distribution: "npx",
        prepared: true,
      });
      expect(yield* fileSystem.exists(toolchain.executablePath)).toBe(true);
      expect(yield* fileSystem.exists(toolchain.environment.FAKE_NPM_PREFIX)).toBe(false);
      expect(yield* fileSystem.readFileString(toolchain.logPath)).toContain(
        "install --global @example/acp@1.2.3",
      );
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }, process.env),
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
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cold-inspect-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const inspection = yield* resolver.inspect(settings());

      expect(inspection).toMatchObject({ status: "ready", agentId: agent.id });
      expect(requests).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("fails a cold inspection immediately when no local registry is available", () => {
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-empty-inspect-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(error.reason).toBe("registry_unavailable");
      expect(requests).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused")));
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
        const hostSettings = yield* TestProviderHostSettings;
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

        const hostSettings = yield* TestProviderHostSettings;
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

  it.effect("expires an abandoned prepared-binary reservation", () => {
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
        prefix: "t3-acp-registry-uninstall-expiry-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      yield* resolver.prepare({ agentId: agent.id });
      yield* TestClock.adjust("31 seconds");
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
        fileSystem,
        path,
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
        fileSystem,
        path,
        cacheDir: path.join(cacheDir, "does-not-exist"),
        toolsDir: path.join(cacheDir, "does-not-exist", "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(missing).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
