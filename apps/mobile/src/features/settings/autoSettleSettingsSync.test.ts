import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planAutoSettleSettingsSync } from "./autoSettleSettingsSync";

const reference = {
  environmentId: EnvironmentId.make("reference"),
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    sidebarAutoSettleAfterDays: 7,
    sidebarAutoSettleOnMerge: true,
    newWorktreesStartFromOrigin: false,
    continueThreadsAfterServerUpdate: false,
  },
};

describe("auto-settle settings sync", () => {
  it("ignores differences in independently configured environment settings", () => {
    const target = {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      settings: {
        ...reference.settings,
        newWorktreesStartFromOrigin: true,
        continueThreadsAfterServerUpdate: true,
        sourceControlWritingStyle: {
          ...reference.settings.sourceControlWritingStyle,
          customInstructions: "Keep this environment's writing instructions.",
        },
      },
    };

    const plan = planAutoSettleSettingsSync(reference, [target]);

    expect(plan.mismatches).toEqual([]);
    expect(plan.patch).toEqual({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: true,
    });
  });

  it("applies only auto-settle defaults when another environment differs", () => {
    const target = {
      environmentId: EnvironmentId.make("remote"),
      label: "Remote",
      settings: {
        ...reference.settings,
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        newWorktreesStartFromOrigin: true,
        continueThreadsAfterServerUpdate: true,
        sourceControlWritingStyle: {
          ...reference.settings.sourceControlWritingStyle,
          customInstructions: "Preserve these instructions.",
        },
      },
    };

    const plan = planAutoSettleSettingsSync(reference, [target]);
    const updated = { ...target.settings, ...plan.patch };

    expect(plan.mismatches).toEqual([target]);
    expect(updated.sidebarAutoSettleAfterDays).toBe(7);
    expect(updated.sidebarAutoSettleOnMerge).toBe(true);
    expect(updated.newWorktreesStartFromOrigin).toBe(true);
    expect(updated.continueThreadsAfterServerUpdate).toBe(true);
    expect(updated.sourceControlWritingStyle).toEqual(target.settings.sourceControlWritingStyle);
  });

  it("does not compare the reference or a target without loaded settings", () => {
    const plan = planAutoSettleSettingsSync(reference, [
      { ...reference, label: "Reference" },
      { environmentId: EnvironmentId.make("loading"), label: "Loading", settings: null },
    ]);

    expect(plan.mismatches).toEqual([]);
  });
});
