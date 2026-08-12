import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ProviderOrchestrationAdapterInfrastructureLive } from "../Layers/ProviderOrchestrationAdapterInfrastructure.ts";
import { CopilotDriver } from "./CopilotDriver.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const BackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});
const TestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "1.0.79" }))),
  ),
);
const baseLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "copilot-driver-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyAlwaysRun),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClient),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);
const testLayer = ProviderOrchestrationAdapterInfrastructureLive.pipe(
  Layer.provideMerge(baseLayer),
);

describe("CopilotDriver", () => {
  it.effect("registers a disabled Copilot instance through the provider driver SPI", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("copilot");
      const configMap: ProviderInstanceConfigMap = {
        [instanceId]: {
          driver: ProviderDriverKind.make("copilot"),
          enabled: false,
          config: {
            enabled: false,
            binaryPath: "copilot",
            customModels: [],
          },
        },
      };
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CopilotDriver],
        configMap,
      });
      const instance = yield* registry.getInstance(instanceId);
      expect(instance?.driverKind).toBe("copilot");
      expect(instance?.orchestrationAdapter.driver).toBe("copilot");
      expect((yield* instance!.snapshot.getSnapshot).displayName).toBe("GitHub Copilot");
    }).pipe(Effect.provide(testLayer)),
  );
});
