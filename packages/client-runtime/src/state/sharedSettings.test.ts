import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "../connection/presentation.ts";
import {
  describeRejectedSettingsWrites,
  findSharedSettingsMismatches,
  pickSharedServerSettings,
  splitSharedServerPatch,
  supportsSharedSettings,
} from "./sharedSettings.ts";

const primaryId = EnvironmentId.make("env-primary");
const laptopId = EnvironmentId.make("env-laptop");
const boxId = EnvironmentId.make("env-box");

describe("splitSharedServerPatch", () => {
  it("routes preference keys to the shared patch and machine keys to the local patch", () => {
    const { sharedPatch, localPatch } = splitSharedServerPatch({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      enableAgentBrowserAccess: false,
    });
    expect(sharedPatch).toEqual({ sidebarAutoSettleAfterDays: 7, sidebarAutoSettleOnMerge: false });
    expect(localPatch).toEqual({ enableAgentBrowserAccess: false });
  });
});

describe("pickSharedServerSettings", () => {
  it("returns only the shared keys", () => {
    expect(Object.keys(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS)).sort()).toEqual([
      "defaultThreadEnvMode",
      "newWorktreesStartFromOrigin",
      "sidebarAutoSettleAfterDays",
      "sidebarAutoSettleOnMerge",
      "sourceControlWritingStyle",
    ]);
  });
});

describe("findSharedSettingsMismatches", () => {
  const primarySettings = { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 7 };

  it("compares nested shared keys by value so an applied write clears the mismatch", () => {
    const environments = [
      {
        environmentId: boxId,
        label: "Remote Box",
        connected: true,
        settings: {
          ...primarySettings,
          sourceControlWritingStyle: { ...primarySettings.sourceControlWritingStyle },
        },
      },
    ];
    expect(
      findSharedSettingsMismatches({
        primaryEnvironmentId: primaryId,
        primarySettings,
        environments,
      }),
    ).toEqual([]);
    expect(
      findSharedSettingsMismatches({
        primaryEnvironmentId: primaryId,
        primarySettings: {
          ...primarySettings,
          sourceControlWritingStyle: {
            ...primarySettings.sourceControlWritingStyle,
            customInstructions: "Keep it short.",
          },
        },
        environments,
      }),
    ).toEqual([{ environmentId: boxId, label: "Remote Box" }]);
  });

  it("lists connected environments whose shared settings differ", () => {
    const mismatches = findSharedSettingsMismatches({
      primaryEnvironmentId: primaryId,
      primarySettings,
      environments: [
        { environmentId: primaryId, label: "Desktop", connected: true, settings: primarySettings },
        { environmentId: laptopId, label: "Laptop", connected: true, settings: primarySettings },
        {
          environmentId: boxId,
          label: "Remote Box",
          connected: true,
          settings: DEFAULT_SERVER_SETTINGS,
        },
      ],
    });
    expect(mismatches).toEqual([{ environmentId: boxId, label: "Remote Box" }]);
  });

  it("ignores machine-only differences", () => {
    const mismatches = findSharedSettingsMismatches({
      primaryEnvironmentId: primaryId,
      primarySettings,
      environments: [
        {
          environmentId: boxId,
          label: "Remote Box",
          connected: true,
          settings: { ...primarySettings, enableAgentBrowserAccess: false },
        },
      ],
    });
    expect(mismatches).toEqual([]);
  });

  it("reports nothing until the primary environment's settings are loaded", () => {
    const environments = [
      { environmentId: boxId, label: "Remote Box", connected: true, settings: primarySettings },
    ];
    expect(
      findSharedSettingsMismatches({ primaryEnvironmentId: null, primarySettings, environments }),
    ).toEqual([]);
    expect(
      findSharedSettingsMismatches({
        primaryEnvironmentId: primaryId,
        primarySettings: null,
        environments,
      }),
    ).toEqual([]);
  });

  it("skips offline environments and environments without a loaded config", () => {
    const mismatches = findSharedSettingsMismatches({
      primaryEnvironmentId: primaryId,
      primarySettings,
      environments: [
        {
          environmentId: laptopId,
          label: "Laptop",
          connected: false,
          settings: DEFAULT_SERVER_SETTINGS,
        },
        { environmentId: boxId, label: "Remote Box", connected: true, settings: null },
      ],
    });
    expect(mismatches).toEqual([]);
  });
});

describe("supportsSharedSettings", () => {
  const target = new BearerConnectionTarget({
    environmentId: boxId,
    label: "Remote Box",
    connectionId: "connection-1",
  });
  const entry: ConnectionCatalogEntry = {
    target,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: target.connectionId,
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
      }),
    ),
  };
  const presentation = (
    phase: EnvironmentConnectionPhase,
    threadAutoSettlement: boolean | null,
  ): EnvironmentPresentation => ({
    entry,
    connection: { phase, error: null, traceId: null },
    serverConfig:
      threadAutoSettlement === null
        ? null
        : ({
            environment: { capabilities: { repositoryIdentity: true, threadAutoSettlement } },
            settings: DEFAULT_SERVER_SETTINGS,
          } as ServerConfig),
  });

  it("requires a live connection to a server that holds every shared key", () => {
    expect(supportsSharedSettings(presentation("connected", true))).toBe(true);
    expect(supportsSharedSettings(presentation("connecting", true))).toBe(false);
    expect(supportsSharedSettings(presentation("connected", false))).toBe(false);
    expect(supportsSharedSettings(presentation("connected", null))).toBe(false);
  });
});

describe("describeRejectedSettingsWrites", () => {
  it("keeps each environment's own reason", () => {
    expect(
      describeRejectedSettingsWrites([
        { label: "Laptop", error: new Error("Laptop is not connected.") },
        { label: "Remote Box", error: { _tag: "EnvironmentAuthorizationError" } },
      ]),
    ).toBe("Laptop: Laptop is not connected.\nRemote Box: The server rejected the change.");
  });
});
