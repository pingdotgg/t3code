import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sandboxSettingsSeed } from "./settingsSeed.ts";

const sandboxSettingsSeedPatch = (
  input: Omit<Parameters<typeof sandboxSettingsSeed>[0], "harnesses">,
) => sandboxSettingsSeed({ ...input, harnesses: ["claudeCode", "codex"] }).patch;

const settings = (overrides: Partial<ServerSettings>): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...overrides,
});
const providers = new Set(["codex"]);
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" };
const other = { instanceId: ProviderInstanceId.make("elsewhere"), model: "gpt-test" };

describe("sandboxSettingsSeed", () => {
  it("copies preferences the user changed locally", () => {
    const patch = sandboxSettingsSeedPatch({
      local: settings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        defaultProjectScripts: [],
        branchNamePrefix: "me/",
      }),
      sandbox: settings({}),
      sandboxProviderInstanceIds: providers,
    });
    expect(patch).toEqual({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnMerge: false,
      branchNamePrefix: "me/",
    });
  });

  it("never touches a value the Sandbox already changed", () => {
    const patch = sandboxSettingsSeedPatch({
      local: settings({ branchNamePrefix: "me/", sidebarAutoSettleAfterDays: null }),
      sandbox: settings({ branchNamePrefix: "sandbox/" }),
      sandboxProviderInstanceIds: providers,
    });
    expect(patch).toEqual({ sidebarAutoSettleAfterDays: null });
  });

  it("leaves out keys outside the project-scoped list", () => {
    const patch = sandboxSettingsSeedPatch({
      local: settings({ enableDeviceSupport: true, deviceOnboardingCompleted: true }),
      sandbox: settings({}),
      sandboxProviderInstanceIds: providers,
    });
    expect(patch).toEqual({});
  });

  it("leaves out what the Sandbox's managed policy locks or disallows", () => {
    const pi = { instanceId: ProviderInstanceId.make("pi"), model: "gateway/model" };
    const seed = sandboxSettingsSeed({
      local: settings({
        branchNamePrefix: "me/",
        sidebarAutoSettleOnMerge: false,
        defaultModelSelection: pi,
      }),
      sandbox: settings({}),
      sandboxProviderInstanceIds: providers,
      harnesses: ["claudeCode", "pi"],
      sandboxPolicy: {
        organization: "Example Corp",
        lockedSettings: ["branchNamePrefix"],
        limits: { providers: { allowedDrivers: [ProviderDriverKind.make("codex")] } },
      },
    });
    expect(seed).toEqual({ patch: { sidebarAutoSettleOnMerge: false } });
  });

  it("turns on Linked environments when it is on here, so this computer can link the Sandbox", () => {
    const patch = (local: boolean, sandboxPolicy?: { lockedSettings: Array<string> }) =>
      sandboxSettingsSeedPatch({
        local: settings({ linkedEnvironmentsEnabled: local }),
        sandbox: settings({}),
        sandboxProviderInstanceIds: providers,
        ...(sandboxPolicy === undefined
          ? {}
          : { sandboxPolicy: { organization: "Example Corp", ...sandboxPolicy } }),
      });
    expect(patch(true)).toEqual({ linkedEnvironmentsEnabled: true });
    expect(patch(false)).toEqual({});
    expect(patch(true, { lockedSettings: ["linkedEnvironmentsEnabled"] })).toEqual({});
  });

  it("compares structurally, so equal objects produce an empty patch", () => {
    const local = settings({
      defaultProjectScripts: structuredClone(DEFAULT_SERVER_SETTINGS.defaultProjectScripts),
      sourceControlWritingStyle: structuredClone(DEFAULT_SERVER_SETTINGS.sourceControlWritingStyle),
    });
    expect(
      sandboxSettingsSeedPatch({
        local,
        sandbox: settings({}),
        sandboxProviderInstanceIds: providers,
      }),
    ).toEqual({});
  });

  it("copies a model selection only for a provider instance the Sandbox has", () => {
    const patch = (selection: typeof codex, ids: ReadonlySet<string>) =>
      sandboxSettingsSeedPatch({
        local: settings({ defaultModelSelection: selection }),
        sandbox: settings({}),
        sandboxProviderInstanceIds: ids,
      });
    expect(patch(codex, providers)).toEqual({ defaultModelSelection: codex });
    expect(patch(other, providers)).toEqual({});
    expect(patch(codex, new Set())).toEqual({});
  });

  it("turns on Pi when the Sandbox has agentctl's Pi harness", () => {
    const pi = { instanceId: ProviderInstanceId.make("pi"), model: "gateway/model" };
    const seed = sandboxSettingsSeed({
      local: settings({ defaultModelSelection: pi }),
      sandbox: settings({}),
      sandboxProviderInstanceIds: providers,
      harnesses: ["claudeCode", "pi"],
    });
    expect(seed).toEqual({
      patch: { defaultModelSelection: pi },
      providerInstanceMutation: {
        operation: "create",
        instanceId: "pi",
        instance: { driver: "pi", enabled: true },
      },
    });
  });

  it("copies a Pi model selection only when the harness turns Pi on", () => {
    const pi = { instanceId: ProviderInstanceId.make("pi"), model: "gateway/model" };
    const patch = (harnesses: ReadonlyArray<string>) =>
      sandboxSettingsSeed({
        local: settings({ defaultModelSelection: pi }),
        sandbox: settings({}),
        sandboxProviderInstanceIds: providers,
        harnesses,
      }).patch;
    expect(patch(["claudeCode", "pi"])).toEqual({ defaultModelSelection: pi });
    expect(patch(["claudeCode"])).toEqual({});
  });

  it("leaves Pi alone without the harness or once the Sandbox has a Pi entry", () => {
    const seed = (harnesses: ReadonlyArray<string>, sandbox: ServerSettings) =>
      sandboxSettingsSeed({
        local: settings({}),
        sandbox,
        sandboxProviderInstanceIds: providers,
        harnesses,
      });
    const disabledPi = settings({
      providerInstances: {
        [ProviderInstanceId.make("pi")]: { driver: ProviderDriverKind.make("pi"), enabled: false },
      },
    });
    expect(seed(["claudeCode"], settings({}))).toEqual({ patch: {} });
    expect(seed(["pi"], disabledPi)).toEqual({ patch: {} });
  });
});
