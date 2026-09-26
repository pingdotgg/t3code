import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
  type WorktreeBaseRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SettingsTarget } from "./settings-environment-filter";
import {
  mobileSettingsAreMixed,
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
} from "./settings-scoped-server";

const firstId = "first" as EnvironmentId;
const secondId = "second" as EnvironmentId;
const firstProject = "first-project" as ProjectId;
const secondProject = "second-project" as ProjectId;

function environment(environmentId: EnvironmentId, settings: ServerSettings): SettingsTarget {
  return {
    environmentId,
    serverConfig: {
      settings,
      environment: { capabilities: { projectSettingsOverrides: true } },
    },
  } as SettingsTarget;
}

describe("mobile project settings scope", () => {
  it.each<[WorktreeBaseRef, WorktreeBaseRef, boolean]>([
    [{ mode: "last-used" }, { mode: "last-used" }, false],
    [{ mode: "last-used" }, "last-used", true],
    [{ mode: "last-used" }, null, true],
    [null, null, false],
    ["dev", "dev", false],
    ["dev", "main", true],
  ])("compares base refs by value: %j and %j", (first, second, mixed) => {
    const targets = resolveMobileSettingsTargets(
      [
        environment(firstId, { ...DEFAULT_SERVER_SETTINGS, defaultWorktreeBaseRef: first }),
        environment(secondId, { ...DEFAULT_SERVER_SETTINGS, defaultWorktreeBaseRef: second }),
      ],
      null,
    );
    expect(mobileSettingsAreMixed(targets, "defaultWorktreeBaseRef")).toBe(mixed);
  });

  it("has no uniform value when no environments are selected", () => {
    expect(mobileSettingsAreMixed([], "defaultWorktreeBaseRef")).toBe(true);
  });

  it("edits each checkout's own override without changing either environment default", () => {
    const firstSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "paragraph",
      projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } },
    };
    const secondSettings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      responseStreamingMode: "token",
      projectSettingsOverrides: {},
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, firstSettings), environment(secondId, secondSettings)],
      [
        { environmentId: firstId, id: firstProject },
        { environmentId: secondId, id: secondProject },
      ],
    );

    const writes = planMobileScopedSettingsPatch(targets, true, {
      responseStreamingMode: "turn",
    });
    expect(writes).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
          },
        },
      },
      {
        environmentId: secondId,
        patch: { projectSettingsOverrides: { [secondProject]: { responseStreamingMode: "turn" } } },
      },
    ]);
    expect(firstSettings.responseStreamingMode).toBe("paragraph");
    expect(secondSettings.responseStreamingMode).toBe("token");
  });

  it("removes a project override when a picker sends null for a key that cannot store it", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultThreadEnvMode: "worktree", defaultAutoPull: true },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultThreadEnvMode: null })).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(planMobileScopedSettingsPatch(targets, true, { defaultModelSelection: null })).toEqual([
      {
        environmentId: firstId,
        patch: {
          projectSettingsOverrides: {
            [firstProject]: {
              defaultThreadEnvMode: "worktree",
              defaultAutoPull: true,
              defaultModelSelection: null,
            },
          },
        },
      },
    ]);
  });

  it("keeps an explicit repository default separate from inheriting the environment base", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultWorktreeBaseRef: "origin/dev",
      projectSettingsOverrides: { [firstProject]: { defaultWorktreeBaseRef: "release" } },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );
    expect(planMobileScopedSettingsPatch(targets, true, { defaultWorktreeBaseRef: null })).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultWorktreeBaseRef: null } } },
      },
    ]);
    expect(planMobileScopedSettingsClear(targets, ["defaultWorktreeBaseRef"])).toEqual([
      { environmentId: firstId, patch: { projectSettingsOverrides: { [firstProject]: null } } },
    ]);
  });

  it("resets only the selected page's override and rejects environment-wide writes", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [firstProject]: { defaultAutoPull: true, responseStreamingMode: "turn" },
      },
    };
    const targets = resolveMobileSettingsTargets(
      [environment(firstId, settings)],
      [{ environmentId: firstId, id: firstProject }],
    );

    expect(planMobileScopedSettingsClear(targets, ["responseStreamingMode"])).toEqual([
      {
        environmentId: firstId,
        patch: { projectSettingsOverrides: { [firstProject]: { defaultAutoPull: true } } },
      },
    ]);
    expect(
      planMobileScopedSettingsPatch(targets, true, { enableProviderUpdateChecks: false }),
    ).toEqual([]);
  });
});
