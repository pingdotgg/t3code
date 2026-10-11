import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findOrphanedProjectIds } from "./ProjectSettingsOverrideSweep.ts";

const liveProjectId = ProjectId.make("project-live");
const deletedProjectId = ProjectId.make("project-deleted");

function settingsWith(overrides: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...overrides };
}

describe("findOrphanedProjectIds", () => {
  it("reports a project override whose project is no longer live", () => {
    const settings = settingsWith({
      projectSettingsOverrides: {
        [liveProjectId]: { providerInstances: {} },
        [deletedProjectId]: { providerInstances: {} },
      },
    });

    const orphaned = findOrphanedProjectIds(settings, new Set([liveProjectId]));

    expect(orphaned).toEqual([deletedProjectId]);
  });

  it("reports nothing when every override's project is still live", () => {
    const settings = settingsWith({
      projectSettingsOverrides: {
        [liveProjectId]: { providerInstances: {} },
      },
    });

    const orphaned = findOrphanedProjectIds(settings, new Set([liveProjectId]));

    expect(orphaned).toEqual([]);
  });

  it("reports nothing when there are no overrides at all", () => {
    const settings = settingsWith({ projectSettingsOverrides: {} });

    const orphaned = findOrphanedProjectIds(settings, new Set([liveProjectId]));

    expect(orphaned).toEqual([]);
  });
});
