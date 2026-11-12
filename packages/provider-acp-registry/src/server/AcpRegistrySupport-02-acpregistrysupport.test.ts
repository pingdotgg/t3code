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
});

