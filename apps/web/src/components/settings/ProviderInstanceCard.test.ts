import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  buildProviderSetupChecklist,
  deriveProviderModelsForDisplay,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("buildProviderSetupChecklist", () => {
  it("treats installed Hermes with CLI-managed auth as ready for a test message", () => {
    const checklist = buildProviderSetupChecklist({
      displayName: "Hermes",
      isHermesDriver: true,
      isPiDriver: false,
      enabled: true,
      configuredBinaryPath: "hermes",
      configuredPiBinaryPath: null,
      modelCount: 1,
      liveProvider: {
        driver: ProviderDriverKind.make("hermes"),
        instanceId: ProviderInstanceId.make("hermes"),
        displayName: "Hermes",
        enabled: true,
        installed: true,
        version: "0.11.0",
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: new Date().toISOString(),
        models: [],
        slashCommands: [],
        skills: [],
      },
    });

    expect(checklist.map((item) => [item.label, item.state])).toEqual([
      ["Enabled", "complete"],
      ["CLI detected", "complete"],
      ["Authentication", "complete"],
      ["Model visible", "complete"],
    ]);
  });

  it("points Pi users at login and model setup when auth and models are missing", () => {
    const checklist = buildProviderSetupChecklist({
      displayName: "Pi",
      isHermesDriver: false,
      isPiDriver: true,
      enabled: true,
      configuredBinaryPath: "pi-acp",
      configuredPiBinaryPath: null,
      modelCount: 0,
      liveProvider: {
        driver: ProviderDriverKind.make("pi"),
        instanceId: ProviderInstanceId.make("pi"),
        displayName: "Pi",
        enabled: true,
        installed: true,
        version: "0.73.1",
        status: "error",
        auth: { status: "unauthenticated" },
        checkedAt: new Date().toISOString(),
        models: [],
        slashCommands: [],
        skills: [],
      },
    });

    expect(checklist.map((item) => [item.label, item.state])).toEqual([
      ["Enabled", "complete"],
      ["Adapter detected", "complete"],
      ["Pi binary", "pending"],
      ["Authentication", "action"],
      ["Model visible", "action"],
    ]);
  });
});
