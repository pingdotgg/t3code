import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveOrchestrationV2DebugProviderSnapshots } from "./orchestrationV2DebugProviders";

const acpRegistry = ProviderDriverKind.make("acpRegistry");
const instanceId = ProviderInstanceId.make("acpRegistry_example");

const unavailable: ServerProvider = {
  instanceId,
  driver: acpRegistry,
  displayName: "Example ACP",
  enabled: false,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  availability: "unavailable",
  unavailableReason: "Driver is not registered in the V1 runtime.",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("deriveOrchestrationV2DebugProviderSnapshots", () => {
  it("replaces the V1 unavailable shadow for a configured registry agent", () => {
    const providerInstances = {
      [instanceId]: {
        driver: acpRegistry,
        enabled: true,
        displayName: "Example ACP",
        config: {
          agentId: "example-agent",
          customModels: ["model-one"],
        },
      },
    } satisfies ProviderInstanceConfigMap;

    expect(
      deriveOrchestrationV2DebugProviderSnapshots({
        providers: [unavailable],
        providerInstances,
      }),
    ).toEqual([
      expect.objectContaining({
        instanceId,
        driver: acpRegistry,
        displayName: "Example ACP",
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        models: [
          expect.objectContaining({ slug: "default", isCustom: false }),
          expect.objectContaining({ slug: "model-one", isCustom: true }),
        ],
      }),
    ]);
  });

  it("does not make an incomplete registry instance selectable", () => {
    const providerInstances = {
      [instanceId]: {
        driver: acpRegistry,
        config: { agentId: "" },
      },
    } satisfies ProviderInstanceConfigMap;

    expect(
      deriveOrchestrationV2DebugProviderSnapshots({
        providers: [unavailable],
        providerInstances,
      }),
    ).toEqual([unavailable]);
  });
});
