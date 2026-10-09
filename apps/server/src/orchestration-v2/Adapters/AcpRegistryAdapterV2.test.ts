import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import * as ServerSettings from "../../serverSettings.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "../../provider/acp/AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "../../provider/acp/AcpRegistrySupport.ts";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import {
  ACP_REGISTRY_PROVIDER,
  AcpRegistryAdapterV2Driver,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
} from "./AcpRegistryAdapterV2.ts";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = layerTestProviderHost().pipe(Layer.provide(NodeServices.layer));

const layerRegistry = Layer.succeed(
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

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  describe("the agent's own mode picker", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames T3 must send (and the agent's answers) to apply the
    // user's stored pick from the agent's mode picker.
    const openWithStoredModePick = Effect.fn("openWithStoredModePick")(function* (input: {
      readonly setup: unknown;
      readonly modeFrames: ReadonlyArray<Frame>;
      readonly storedModePick: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-mode-pick-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-mode-pick",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.modeFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-mode-pick");
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        childProcessSpawner,
        resolver: { resolve: () => Effect.die("the runtime is injected") },
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      });
      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-acp-registry-mode-pick"),
          providerSessionId: ProviderSessionId.make("provider-session-mode-pick"),
          modelSelection: {
            instanceId,
            model: "default",
            options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }],
          },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(Effect.scoped);
      // Closing the session stops the agent, which writes its replay status in
      // the same tick as its last answer. The script must be consumed exactly.
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredModePick({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        modeFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredModePick({
        setup: { configOptions: [permissionModeOption("ask")] },
        modeFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          childProcessSpawner,
          resolver: { resolve: () => Effect.die("the runtime is injected") },
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                  authMethodId: "test",
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: host.paths.providerStatusCacheDir,
        toolsDir: host.paths.baseDir + "/tools",
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
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
        childProcessSpawner,
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
          withSessionMutation: (effect) => effect,
          clearAvailableCommands: () => Effect.void,
          publishAvailableCommands: (publishedInstanceId, commands) =>
            Deferred.succeed(commandsPublished, {
              instanceId: publishedInstanceId,
              commands,
            }).pipe(Effect.asVoid),
          getAvailableCommands: () => Effect.succeed(Option.none()),
          watchAvailableCommands: () => Effect.never,
          clearLiveConfiguration: () => Effect.void,
          publishLiveConfiguration: (_publishedInstanceId, configuration) =>
            Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
          getLiveConfiguration: () => Effect.succeed(Option.none()),
          watchLiveConfiguration: () => Effect.never,
          requestUrlAuthentication: () => Effect.succeed(false),
          acceptUrlAuthentication: () => Effect.succeed(false),
          getUrlAuthAction: () => Effect.succeed(Option.none()),
          watchUrlAuthAction: () => Effect.never,
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
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
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
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
