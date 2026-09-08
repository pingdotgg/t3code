import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  projectBooleanOverrideTargets,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";

describe("projectBooleanOverrideTargets", () => {
  const laptop = EnvironmentId.make("laptop");
  const remote = EnvironmentId.make("remote");
  const first = { environmentId: laptop, id: ProjectId.make("first") };
  const second = { environmentId: laptop, id: ProjectId.make("second") };
  const third = { environmentId: remote, id: ProjectId.make("third") };

  it("resets every selected override without including unselected checkouts", () => {
    expect(projectBooleanOverrideTargets([first, second, third], undefined)).toEqual([
      { environmentId: laptop, overrides: { first: null, second: null } },
      { environmentId: remote, overrides: { third: null } },
    ]);
    expect(projectBooleanOverrideTargets([second], undefined)).toEqual([
      { environmentId: laptop, overrides: { second: null } },
    ]);
  });

  it("writes false as an explicit override rather than deleting it", () => {
    expect(projectBooleanOverrideTargets([first, third], false)).toEqual([
      { environmentId: laptop, overrides: { first: false } },
      { environmentId: remote, overrides: { third: false } },
    ]);
  });
});

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(["local-title", "remote-title"], "Repository name", true),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate(["repo-slug", "repo-slug"], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(projectGroupTitleNeedsUpdate(["Shared name", "Shared name"], "Shared name", true)).toBe(
      false,
    );
  });
});
