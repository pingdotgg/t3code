import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import {
  HERMES_ACP_DRIVER_KIND,
  HermesAcpAdapterV2Driver,
  HermesAcpProviderCapabilitiesV2,
  makeHermesAcpAdapterV2,
} from "./HermesAcpAdapterV2.ts";

const decodeSettings = Schema.decodeUnknownEffect(HermesAcpAdapterV2Driver.configSchema);
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-hermes-acp-adapter-",
  }).pipe(Layer.provide(NodeServices.layer)),
);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe("HermesAcpAdapterV2", () => {
  it("registers a session family distinct from the Hermes Work gateway", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(HERMES_ACP_DRIVER_KIND));
    assert.equal(HermesAcpAdapterV2Driver.driverKind, "hermesAcp");
    assert.isTrue(HermesAcpProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.deepEqual(HermesAcpAdapterV2Driver.defaultConfig(), {
      enabled: true,
      binaryPath: "hermes",
      customModels: [],
    });
  });

  it.effect("opens a standard ACP child process and negotiates Hermes capabilities", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-hermes-acp-command-",
      });
      const hermesPath = path.join(directory, "hermes");
      yield* fileSystem.writeFileString(
        hermesPath,
        [
          "#!/bin/sh",
          'if [ "$1" != "acp" ]; then exit 9; fi',
          `exec ${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)}`,
          "",
        ].join("\n"),
      );
      yield* fileSystem.chmod(hermesPath, 0o755);
      const instanceId = ProviderInstanceId.make("hermes-code-test");
      const settings = yield* decodeSettings({
        binaryPath: hermesPath,
      });
      const adapter = makeHermesAcpAdapterV2({
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
        },
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        crypto: yield* Crypto.Crypto,
        fileSystem,
        idAllocator: yield* IdAllocatorV2,
        serverConfig: yield* ServerConfig,
      });
      const threadId = ThreadId.make("thread-hermes-acp");
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-hermes-acp"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "hermesAcp");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.isTrue(runtime.providerSession.capabilities.tools.supportsMcpTools);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
