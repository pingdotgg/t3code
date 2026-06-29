import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  makeAcpRegistryResolver,
  resolveAcpRegistryDistribution,
  resolveAcpRegistryPlatformTarget,
  type AcpRegistryAgent,
} from "./AcpRegistrySupport.ts";

const registryUrl = "https://registry.test/registry.json";
const archiveUrl = "https://registry.test/example-agent.bin";
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

function makeAgent(distribution: AcpRegistryAgent["distribution"]): AcpRegistryAgent {
  return {
    id: "example-agent",
    name: "Example Agent",
    version: "1.2.3",
    description: "ACP Registry test agent",
    distribution,
  };
}

function makeRegistry(agent: AcpRegistryAgent): string {
  return JSON.stringify({ version: "1.0.0", agents: [agent] });
}

function settings(input: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    agentId: "example-agent",
    ...input,
  });
}

function resolverLayer(execute: Parameters<typeof HttpClient.make>[0]) {
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(HostProcessPlatform, "linux"),
    Layer.succeed(HostProcessArchitecture, "x64"),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
  );
}

describe("AcpRegistrySupport", () => {
  it("maps supported Node platforms to ACP Registry target keys", () => {
    expect(resolveAcpRegistryPlatformTarget("darwin", "arm64")).toBe("darwin-aarch64");
    expect(resolveAcpRegistryPlatformTarget("linux", "x64")).toBe("linux-x86_64");
    expect(resolveAcpRegistryPlatformTarget("win32", "arm64")).toBe("windows-aarch64");
    expect(resolveAcpRegistryPlatformTarget("freebsd", "x64")).toBeUndefined();
    expect(resolveAcpRegistryPlatformTarget("linux", "ia32")).toBeUndefined();
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
      resolveAcpRegistryDistribution({
        agent,
        preference: "auto",
        platformTarget: "linux-x86_64",
      }),
    ).toMatchObject({ kind: "binary", args: ["acp"] });
    expect(
      resolveAcpRegistryDistribution({
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
      resolveAcpRegistryDistribution({
        agent,
        preference: "binary",
        platformTarget: "darwin-aarch64",
      }),
    ).toBeUndefined();
  });

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
      const resolver = yield* makeAcpRegistryResolver({ cacheDir, registryUrl });
      const resolved = yield* resolver.resolve(
        settings({ commandPath: "/opt/example-agent" }),
        "/workspace",
        { HOST_VALUE: "host", OVERRIDE_ME: "host" },
      );

      expect(resolved.distribution).toBe("binary");
      expect(resolved.spawn).toEqual({
        command: "/opt/example-agent",
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
        resolverLayer((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("installs and reuses a registry binary in the managed cache", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp"],
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-install-",
      });
      const resolver = yield* makeAcpRegistryResolver({ cacheDir, registryUrl });
      const first = yield* resolver.resolve(settings(), "/workspace");
      const second = yield* resolver.resolve(settings(), "/workspace");

      expect(first.spawn.command).toBe(second.spawn.command);
      expect(first.spawn.command).toContain(
        "/acp-registry/agents/example-agent/1.2.3/linux-x86_64/bin/example-agent",
      );
      expect(yield* fileSystem.readFileString(first.spawn.command)).toBe(
        "#!/bin/sh\necho example\n",
      );
      expect(requests).toEqual([registryUrl, archiveUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        resolverLayer((request) => {
          requests.push(request.url);
          const response =
            request.url === registryUrl
              ? new Response(makeRegistry(agent))
              : new Response(binaryBytes.buffer as ArrayBuffer);
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
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
      const resolver = yield* makeAcpRegistryResolver({ cacheDir, registryUrl });
      const resolved = yield* resolver.resolve(settings(), "/workspace");

      expect(resolved.spawn).toMatchObject({
        command: "npx",
        args: ["--yes", "@example/acp@1.2.3", "--stdio"],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        resolverLayer((request) =>
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
      const resolver = yield* makeAcpRegistryResolver({ cacheDir, registryUrl });
      const error = yield* resolver.resolve(settings(), "/workspace").pipe(Effect.flip);

      expect(error.reason).toBe("archive_invalid");
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        resolverLayer((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });
});
