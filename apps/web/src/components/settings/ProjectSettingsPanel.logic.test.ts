import { describe, expect, it } from "vite-plus/test";

import {
  buildArchivedProjectRemovalPlans,
  getArchivedProjectRemovalWarning,
  projectGroupTitleNeedsUpdate,
} from "./ProjectSettingsPanel.logic";

describe("archived project removal", () => {
  it("derives archived-bundle command scope from each project member's threads", () => {
    const members = [
      { environmentId: "environment-live", id: "grouped-project" },
      { environmentId: "environment-archived", id: "grouped-project" },
    ];
    const projectThreads = [
      {
        environmentId: "environment-live",
        projectId: "grouped-project",
        id: "thread-live",
      },
    ];

    expect(
      buildArchivedProjectRemovalPlans(members, projectThreads).map((plan) => ({
        environmentId: plan.member.environmentId,
        threadIds: plan.memberThreads.map((thread) => thread.id),
        options: plan.commandOptions,
      })),
    ).toEqual([
      {
        environmentId: "environment-live",
        threadIds: ["thread-live"],
        options: { force: true },
      },
      {
        environmentId: "environment-archived",
        threadIds: [],
        options: { deleteArchivedThreads: true },
      },
    ]);
  });

  it("describes archived deletion for standalone and grouped removals", () => {
    expect(
      getArchivedProjectRemovalWarning({
        memberCount: 1,
        hasLiveThreads: true,
      }),
    ).toBe(
      "This permanently clears conversation history for those threads and any archived conversations in this project.",
    );
    expect(
      getArchivedProjectRemovalWarning({
        memberCount: 1,
        hasLiveThreads: false,
      }),
    ).toBe(
      "If this project has archived conversations, their history will also be permanently deleted.",
    );
    expect(
      getArchivedProjectRemovalWarning({
        memberCount: 2,
        hasLiveThreads: true,
      }),
    ).toBe(
      "This permanently clears conversation history for those threads and any archived conversations in these projects.",
    );
    expect(
      getArchivedProjectRemovalWarning({
        memberCount: 2,
        hasLiveThreads: false,
      }),
    ).toBe(
      "If these projects have archived conversations, their history will also be permanently deleted.",
    );
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
