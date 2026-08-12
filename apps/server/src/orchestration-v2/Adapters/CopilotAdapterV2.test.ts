import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import type { AcpAdapterV2RuntimeInput } from "./AcpAdapterV2.ts";
import {
  COPILOT_DRIVER_KIND,
  CopilotAdapterV2Driver,
  makeCopilotAdapterV2,
  makeCopilotAcpAdapterFlavor,
  type CopilotAdapterV2Options,
} from "./CopilotAdapterV2.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-copilot-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));

const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

function makeMockRuntime(input: {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly mockAgentPath: string;
}) {
  return (runtimeInput: AcpAdapterV2RuntimeInput) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          spawn: {
            command: process.execPath,
            args: [input.mockAgentPath],
            cwd: runtimeInput.cwd,
            env: { T3_ACP_SESSION_LIFECYCLE: "1" },
          },
          authMethodId: "test",
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      return runtime;
    });
}

describe("CopilotAdapterV2", () => {
  it("is registered with Copilot schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(COPILOT_DRIVER_KIND));
    assert.equal(CopilotAdapterV2Driver.driverKind, COPILOT_DRIVER_KIND);
    assert.deepEqual(CopilotAdapterV2Driver.defaultConfig(), {
      enabled: true,
      binaryPath: "copilot",
      customModels: [],
    });
  });

  it.effect("keeps Copilot in agent mode even for a plan interaction request", () =>
    Effect.gen(function* () {
      const selectedModes: Array<string> = [];
      const instanceId = ProviderInstanceId.make("copilot-mode-fixture");
      const flavor = makeCopilotAcpAdapterFlavor({
        makeRuntime: () => Effect.never,
      } as unknown as CopilotAdapterV2Options);
      const runtime = {
        getConfigOptions: Effect.succeed([]),
        getModeState: Effect.succeed({
          currentModeId: "plan",
          availableModes: [
            { id: "agent", name: "Agent" },
            { id: "plan", name: "Plan" },
          ],
        }),
        setConfigOption: () => Effect.succeed({ configOptions: [] }),
        setMode: (modeId: string) =>
          Effect.sync(() => {
            selectedModes.push(modeId);
            return {};
          }),
        setModel: () => Effect.void,
      } as unknown as AcpSessionRuntime.AcpSessionRuntime["Service"];
      const configureSession = flavor.configureSession;
      if (configureSession === undefined) {
        return yield* Effect.die("Expected Copilot ACP session configuration");
      }

      yield* configureSession({
        runtime,
        startResult: {} as AcpSessionRuntime.AcpSessionRuntimeStartResult,
        modelSelection: { instanceId, model: "auto" },
        runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "plan",
          cwd: process.cwd(),
        }),
      });

      assert.deepEqual(selectedModes, ["agent"]);
      assert.isFalse(flavor.capabilities.planning.emitsProposedPlan);
    }),
  );

  it.effect("opens a Copilot V2 session through the shared ACP adapter", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("copilot-fixture");
      const adapter = makeCopilotAdapterV2({
        instanceId,
        settings: {
          enabled: true,
          binaryPath: "copilot",
          customModels: [],
        },
        environment: {},
        childProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        makeRuntime: makeMockRuntime({
          childProcessSpawner,
          mockAgentPath,
        }),
      });
      const threadId = ThreadId.make("thread-copilot-fixture");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "plan",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-copilot-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "copilot");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
