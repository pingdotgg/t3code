import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import type { AcpRegistryAvailableCommands } from "../../provider/acp/AcpRegistryProbe.ts";
import { makeAcpRegistryCatalog } from "../../provider/acp/AcpRegistrySupport.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import {
  ACP_REGISTRY_DRIVER_KIND,
  AcpRegistryAdapterV2Driver,
  makeAcpRegistryAdapterV2,
} from "./AcpRegistryAdapterV2.ts";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-registry-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const registryLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  serverConfigLayer,
  registryLayer,
);

describe("AcpRegistryAdapterV2", () => {
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_DRIVER_KIND));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_DRIVER_KIND);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* makeAcpRegistryCatalog({
        cacheDir: serverConfig.providerStatusCacheDir,
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const adapter = makeAcpRegistryAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
        childProcessSpawner,
        fileSystem,
        idAllocator,
        runtimeCoordinator: {
          withForegroundStartup: (agentId, effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                assert.equal(agentId, "fixture-agent");
                startupActive = true;
                startupCount += 1;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  startupActive = false;
                }),
            ),
          runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
          clearAvailableCommands: () => Effect.void,
          publishAvailableCommands: (publishedInstanceId, commands) =>
            Deferred.succeed(commandsPublished, {
              instanceId: publishedInstanceId,
              commands,
            }).pipe(Effect.asVoid),
          getAvailableCommands: () => Effect.succeed(Option.none()),
          watchAvailableCommands: () => Effect.never,
        },
        resolver: {
          resolve: (configuredSettings, cwd, environment) =>
            Effect.sync(() => assert.isTrue(startupActive)).pipe(
              Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
              Effect.map((resolved) => ({
                ...resolved,
                spawn: {
                  ...resolved.spawn,
                  args: [mockAgentPath],
                },
              })),
            ),
        },
        serverConfig,
      });
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
