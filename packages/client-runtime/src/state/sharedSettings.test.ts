import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  filterSharedServerPatch,
  findSharedSettingsMismatches,
  pickSharedServerSettings,
  splitSharedServerPatch,
  supportsSharedSettingsSync,
} from "./sharedSettings.ts";

const primaryId = EnvironmentId.make("env-primary");
const laptopId = EnvironmentId.make("env-laptop");
const boxId = EnvironmentId.make("env-box");
const restartCapabilities = { threadRestartContinuation: true };

describe("supportsSharedSettingsSync", () => {
  it("accepts only connected servers that advertise the shared-settings capability", () => {
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
      }),
    ).toBe(true);
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: {} } },
      }),
    ).toBe(false);
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "reconnecting" },
        serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
      }),
    ).toBe(false);
  });
});

describe("splitSharedServerPatch", () => {
  it.each([
    {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      options: [{ id: "effort", value: "high" }],
    },
    DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
  ])("shares the text generation model and options, including reset (%j)", (selection) => {
    const patch = { textGenerationModelSelection: selection };
    expect(splitSharedServerPatch(patch)).toEqual({ sharedPatch: patch, localPatch: {} });
    expect(pickSharedServerSettings({ ...DEFAULT_SERVER_SETTINGS, ...patch })).toMatchObject(patch);
    const environment = {
      environmentId: boxId,
      label: "Remote Box",
      syncEligible: true,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: { ...selection, model: "different-model" },
      },
    };
    const input = {
      primaryEnvironmentId: primaryId,
      primarySettings: { ...DEFAULT_SERVER_SETTINGS, ...patch },
      environments: [environment],
    };
    expect(findSharedSettingsMismatches(input)).toEqual([
      { environmentId: boxId, label: "Remote Box" },
    ]);
    expect(
      findSharedSettingsMismatches({
        ...input,
        environments: [{ ...environment, settings: input.primarySettings }],
      }),
    ).toEqual([]);
  });

  it("routes preference keys to the shared patch and machine keys to the local patch", () => {
    const { sharedPatch, localPatch } = splitSharedServerPatch({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      continueThreadsAfterServerUpdate: true,
      enableAgentBrowserAccess: false,
      defaultThreadEnvMode: "worktree",
      newWorktreesStartFromOrigin: true,
    });
    expect(sharedPatch).toEqual({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      continueThreadsAfterServerUpdate: true,
      newWorktreesStartFromOrigin: true,
    });
    expect(localPatch).toEqual({
      enableAgentBrowserAccess: false,
      defaultThreadEnvMode: "worktree",
    });
  });
});

describe("pickSharedServerSettings", () => {
  it("returns only the shared keys", () => {
    expect(
      Object.keys(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, restartCapabilities)).sort(),
    ).toEqual([
      "continueThreadsAfterServerUpdate",
      "newWorktreesStartFromOrigin",
      "sidebarAutoSettleAfterDays",
      "sidebarAutoSettleOnMerge",
      "sourceControlWritingStyle",
      "textGenerationModelSelection",
    ]);
  });
});

describe("filterSharedServerPatch", () => {
  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, undefined, settings, settings, targetIsSource)).toEqual(
        {
          ...(targetIsSource
            ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
            : {}),
          sidebarAutoSettleAfterDays: 7,
        },
      );
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, restartCapabilities, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
      const primarySettings = {
        ...sourceSettings,
        textGenerationModelSelection: selection,
      };
      expect(
        findSharedSettingsMismatches({
          primaryEnvironmentId: primaryId,
          primarySettings,
          environments: [
            { environmentId: boxId, label: "Remote Box", syncEligible: true, settings },
          ],
        }),
      ).toEqual(availability === "enabled" ? [{ environmentId: boxId, label: "Remote Box" }] : []);
    },
  );

  it.each([true, false])("preserves supported restart preference %s", (enabled) => {
    const patch = { continueThreadsAfterServerUpdate: enabled, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, restartCapabilities)).toEqual(patch);
  });

  it.each([undefined, {}, { threadRestartContinuation: false }])(
    "omits only the unsupported restart preference with capabilities %j",
    (capabilities) => {
      expect(
        filterSharedServerPatch(
          { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 },
          capabilities,
        ),
      ).toEqual({ sidebarAutoSettleAfterDays: 7 });
      expect(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, capabilities)).not.toHaveProperty(
        "continueThreadsAfterServerUpdate",
      );
    },
  );
});

describe("findSharedSettingsMismatches", () => {
  const primarySettings = { ...DEFAULT_SERVER_SETTINGS, sidebarAutoSettleAfterDays: 7 };

  it.each([true, false])(
    "detects remote restart continuation drift when the preference is %s",
    (enabled) => {
      const settings = { ...primarySettings, continueThreadsAfterServerUpdate: enabled };
      const remoteSettings = { ...settings, continueThreadsAfterServerUpdate: !enabled };
      const environment = {
        environmentId: boxId,
        label: "Remote Box",
        syncEligible: true,
        settings: remoteSettings,
        capabilities: restartCapabilities,
      };
      expect(
        findSharedSettingsMismatches({
          primaryEnvironmentId: primaryId,
          primarySettings: settings,
          primaryCapabilities: restartCapabilities,
          environments: [environment],
        }),
      ).toEqual([{ environmentId: boxId, label: "Remote Box" }]);
      expect(
        findSharedSettingsMismatches({
          primaryEnvironmentId: primaryId,
          primarySettings: settings,
          primaryCapabilities: restartCapabilities,
          environments: [
            {
              ...environment,
              settings: Object.assign(
                {},
                remoteSettings,
                pickSharedServerSettings(settings, restartCapabilities),
              ),
            },
          ],
        }),
      ).toEqual([]);
    },
  );

  it.each([
    [undefined, restartCapabilities],
    [restartCapabilities, undefined],
    [undefined, undefined],
  ])(
    "ignores restart drift unless both servers support it (%j, %j)",
    (primaryCapabilities, capabilities) => {
      const environment = {
        environmentId: boxId,
        label: "Remote Box",
        syncEligible: true,
        capabilities,
        settings: { ...primarySettings, continueThreadsAfterServerUpdate: true },
      };
      const input = {
        primaryEnvironmentId: primaryId,
        primarySettings,
        primaryCapabilities,
        environments: [environment],
      };
      expect(findSharedSettingsMismatches(input)).toEqual([]);
      expect(
        findSharedSettingsMismatches({
          ...input,
          environments: [
            {
              ...environment,
              settings: { ...environment.settings, sidebarAutoSettleAfterDays: 14 },
            },
          ],
        }),
      ).toEqual([{ environmentId: boxId, label: "Remote Box" }]);
    },
  );

  it("lists sync-eligible environments whose shared settings differ", () => {
    const mismatches = findSharedSettingsMismatches({
      primaryEnvironmentId: primaryId,
      primarySettings,
      environments: [
        {
          environmentId: primaryId,
          label: "Desktop",
          syncEligible: true,
          settings: primarySettings,
        },
        {
          environmentId: laptopId,
          label: "Laptop",
          syncEligible: true,
          settings: primarySettings,
        },
        {
          environmentId: boxId,
          label: "Remote Box",
          syncEligible: true,
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
          syncEligible: true,
          settings: {
            ...primarySettings,
            enableAgentBrowserAccess: false,
            defaultThreadEnvMode:
              primarySettings.defaultThreadEnvMode === "local" ? "worktree" : "local",
          },
        },
      ],
    });
    expect(mismatches).toEqual([]);
  });

  it("reports nothing until the primary environment's settings are loaded", () => {
    const environments = [
      {
        environmentId: boxId,
        label: "Remote Box",
        syncEligible: true,
        settings: primarySettings,
      },
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

  it("skips ineligible environments and environments without a loaded config", () => {
    const mismatches = findSharedSettingsMismatches({
      primaryEnvironmentId: primaryId,
      primarySettings,
      environments: [
        {
          environmentId: laptopId,
          label: "Laptop",
          syncEligible: false,
          settings: DEFAULT_SERVER_SETTINGS,
        },
        { environmentId: boxId, label: "Remote Box", syncEligible: true, settings: null },
      ],
    });
    expect(mismatches).toEqual([]);
  });
});
